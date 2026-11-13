import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { PosService } from './pos.service';
import { PosJwtPayload } from './pos-auth';
import { bullmqReconciliationEnabled, checkoutConfiguration, queuedPaymentDispatchEnabled, settingMilliseconds } from './checkout-config';
import { MoniepointClient, TerminalEvidence } from './moniepoint.client';
import { SquadClient } from './squad.client';
import { ProviderFailure } from './payment-provider';
import type { PspAuditService } from './psp-audit.service';
import type { WebhookTrace } from './psp-audit';
import { eventLog } from '../events/event-jobs';
import { isEventId } from '../events/event-outbox';
import { paymentReconciliationQueue } from '../events/payment-reconciliation';
import { saveLiveNotice } from '../events/live-notices';

const ACTIVE = ['queued', 'pending', 'unknown', 'review'];
const paymentLease = () => new Date(Date.now() + Math.max(90_000, settingMilliseconds('MONIEPOINT_HTTP_TIMEOUT_MS', 10_000) + 30_000));
const activeLease = (owner: string) => ({ lease_owner: owner, lease_until: { $gt: new Date() } });
const money = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new BadRequestException('Amount must be a non-negative integer in kobo');
  return value;
};
const kobo = (value: unknown) => Math.round(Number(value || 0) * 100);
const creditStatus = (balance: number, due: Date) => balance === 0 ? 'Clear' : new Date(due).getTime() < Date.now() ? 'Overdue' : 'Pending';

@Injectable()
export class CheckoutService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private working = false;
  constructor(@InjectConnection() private readonly db: Connection, private readonly pos: PosService, @Inject('PSP_AUDIT') private readonly audit: PspAuditService) {}
  private auditHttp(attempt: any) {
    return this.audit.http({ provider_id: attempt.provider, account_key: attempt.account_key, attempt_id: String(attempt._id),
      checkout_id: String(attempt.checkout), merchant_reference: attempt.merchant_reference, terminal_serial: attempt.terminal_serial,
      location_id: String(attempt.audit_location || ''), device_id: attempt.audit_device, cashier_id: attempt.audit_cashier,
      business_id: attempt.account_snapshot?.businessId, business_owner_id: attempt.account_snapshot?.businessOwnerId, amount_kobo: attempt.amount_kobo,
      correlation_id: attempt.audit_correlation_id });
  }
  private async auditedAttempt(attempt: any, correlationId?: string) {
    const checkout = await this.model('PosCheckout').findById(attempt.checkout).lean();
    return { ...(attempt.toObject ? attempt.toObject() : attempt), audit_location: checkout?.hub,
      audit_device: checkout?.device_id, audit_cashier: checkout?.cashier ? String(checkout.cashier) : undefined, audit_correlation_id: correlationId };
  }
  private model(name: string): Model<any> { return this.db.model(name) as unknown as Model<any>; }
  private atomic<T>(work: () => Promise<T>): Promise<T> { return this.pos.inventoryTransaction(work); }

  onModuleInit() {
    if (process.env.POS_PAYMENT_WORKER_ENABLED === 'false' || bullmqReconciliationEnabled()) return;
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, 1000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async actor(user: Omit<PosJwtPayload, 'role'> & { role?: PosJwtPayload['role'] }, row?: any) {
    const staff = await this.model('User').findById(user.sub).populate('role').lean();
    const hub = await this.model('Hub').findById(user.hubId).lean();
    const device = await this.model('PosDevice').findOne({ device_id: user.deviceId, hub: user.hubId, revoked: { $ne: true } }).lean();
    const role = user.role ?? (staff?.role?.name === 'hub_manager' ? 'manager' : 'cashier');
    if (!staff || staff.is_active === false || !hub || hub.is_active === false || !device ||
      staff.role?.name !== (role === 'manager' ? 'hub_manager' : 'cashier') ||
      (String(staff.hub) !== user.hubId && !(role === 'manager' && String(hub.hub_manager) === user.sub))) throw new ForbiddenException('Your till or location assignment is not active');
    if (row && (String(row.hub) !== user.hubId || (role !== 'manager' && String(row.cashier) !== user.sub))) throw new ForbiddenException('This checkout is not assigned to you');
    return { staff, device };
  }

  private async customer(user: PosJwtPayload, id: unknown) {
    if (typeof id !== 'string' || !Types.ObjectId.isValid(id)) throw new BadRequestException('Select a registered customer');
    const customer = await this.model('Customer').findOne({ _id: id, customer_location: user.hubId }).lean();
    if (!customer?.customer_name?.trim()) throw new BadRequestException('Select a named customer at this location');
    return customer;
  }

  async options(user: PosJwtPayload) {
    await this.actor(user);
    const config = checkoutConfiguration(), mapping = config.terminals[user.deviceId || ''];
    const moniepoint = process.env.MONIEPOINT_ENABLED === 'true' && !config.errors.length && mapping?.hubId === user.hubId;
    const squad = process.env.SQUAD_ENABLED === 'true' && process.env.SQUAD_DVA_APPROVED === 'true' && process.env.SQUAD_CONTRACT_VERIFIED === 'true' && Boolean(process.env.SQUAD_SECRET_KEY);
    const moniepointReason = !mapping || mapping.hubId !== user.hubId ? 'No Moniepoint terminal configured for this till.' :
      config.errors.length ? 'Moniepoint configuration needs attention.' : process.env.MONIEPOINT_ENABLED !== 'true' ? 'Moniepoint is currently disabled.' : null;
    const squadReason = !process.env.SQUAD_SECRET_KEY || process.env.SQUAD_DVA_APPROVED !== 'true' || process.env.SQUAD_CONTRACT_VERIFIED !== 'true' ?
      'Squad is not configured.' : process.env.SQUAD_ENABLED !== 'true' ? 'Squad is currently disabled.' : null;
    return { enabled: true, methods: [
      { id: 'moniepoint', name: 'Moniepoint', available: Boolean(moniepoint), reason: moniepointReason },
      { id: 'squad', name: 'Squad', available: squad, reason: squadReason }, { id: 'manual', name: 'Confirm payment received', available: true, reason: null },
    ] };
  }

  private async row(user: PosJwtPayload, id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Checkout not found');
    const row = await this.model('PosCheckout').findById(id);
    if (!row) throw new NotFoundException('Checkout not found');
    await this.actor(user, row); return row;
  }

  private async lock(id: any) {
    const row = await this.model('PosCheckout').findOneAndUpdate({ _id: id }, { $inc: { __v: 1 } }, { returnDocument: 'after' });
    if (!row) throw new NotFoundException('Checkout not found');
    return row;
  }

  async create(user: PosJwtPayload, input: any, repayment = false) {
    const { staff } = await this.actor(user);
    const customer = await this.customer(user, input.customerId);
    const clientSaleId = String(input.clientSaleId || '').trim();
    if (!clientSaleId || clientSaleId.length > 150) throw new BadRequestException('A valid clientSaleId is required');
    const existing = await this.model('PosCheckout').findOne({ client_sale_id: clientSaleId });
    if (existing) { await this.actor(user, existing); return this.view(existing); }
    let row: any;
    try {
      row = await this.atomic(async () => {
        const marker = await this.db.collection('pos_payment_rollout').findOne({ _id: 'reservations-v1' as any });
        if (!repayment && (process.env.POS_PAYMENT_RESERVATIONS_ENABLED !== 'true' || marker?.ready !== true)) throw new ServiceUnavailableException('Inventory reservation rollout is not ready');
        let total: number, due: number, snapshot: any, allocations: any, credit: any;
        const mode = repayment ? 'full_payment' : input.paymentMode;
        if (!['full_payment', 'partial_credit', 'full_credit'].includes(mode)) throw new BadRequestException('Choose a payment mode');
        let dueDate: Date | undefined;
        if (mode !== 'full_payment') {
          if (typeof input.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) throw new BadRequestException('Choose a repayment due date');
          dueDate = new Date(`${input.dueDate}T23:59:59+01:00`);
          if (!Number.isFinite(+dueDate) || +dueDate < Date.now()) throw new BadRequestException('Due date cannot be in the past');
        }
        if (repayment) {
          if (!Types.ObjectId.isValid(input.creditId)) throw new BadRequestException('Choose an outstanding credit');
          credit = await this.model('CreditRecord').findOne({ _id: input.creditId, customer: customer._id, status: { $in: ['Pending', 'Overdue'] } });
          due = money(input.amountKobo); total = due;
          if (!credit || due <= 0 || due > kobo(credit.amount_owed)) throw new BadRequestException('Amount exceeds the outstanding credit');
        } else {
          const reservation = await this.pos.reservePayment(user, { ...input, hubId: user.hubId, deviceId: user.deviceId });
          snapshot = reservation.snapshot; allocations = reservation.allocations; total = money(snapshot.total);
          if (total <= 0) throw new BadRequestException('Checkout total must be positive');
          due = mode === 'full_credit' ? 0 : mode === 'partial_credit' ? money(input.upfrontKobo) : total;
          if (mode === 'partial_credit' && (due <= 0 || due >= total)) throw new BadRequestException('Upfront amount must be greater than zero and less than the sale total');
        }
        const [created] = await this.model('PosCheckout').create([{
          client_sale_id: clientSaleId, kind: repayment ? 'repayment' : 'sale', hub: user.hubId, device_id: user.deviceId,
          cashier: user.sub, cashier_name: staff.full_name, customer: customer._id, customer_name: customer.customer_name,
          credit: credit?._id, mode, total_kobo: total, due_kobo: due, credit_kobo: total - due, due_date: dueDate,
          status: 'awaiting', reservation_state: repayment ? 'none' : 'held', snapshot, allocations,
          sale_payload: { ...input, customerId: String(customer._id), customerName: customer.customer_name, cashierName: staff.full_name, deviceId: user.deviceId, hubId: user.hubId },
        }]);
        if (due === 0) await this.complete(created, undefined, 'credit');
        return created;
      });
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      row = await this.model('PosCheckout').findOne({ client_sale_id: clientSaleId });
      if (!row) throw error;
      await this.actor(user, row);
    }
    return this.view(row);
  }

  async view(row: any) {
    const attempts = await this.model('PosPaymentAttempt').find({ checkout: row._id }).sort({ createdAt: 1 }).lean();
    return { id: String(row._id), clientSaleId: row.client_sale_id, kind: row.kind, customerId: String(row.customer), customerName: row.customer_name,
      status: row.status, paymentMode: row.mode, totalKobo: row.total_kobo, dueKobo: row.due_kobo, creditKobo: row.credit_kobo,
      dueDate: row.due_date, receipt: row.receipt || null, reviewReason: row.review_reason || null, createdAt: row.createdAt,
      canConfirmReceived: ['awaiting', 'review'].includes(row.status) && row.due_kobo > 0,
      attempts: attempts.map(a => ({ id: String(a._id), clientAttemptId: a.client_attempt_id, reference: a.merchant_reference, providerReference: a.provider_reference, providerPaidAt: a.provider_paid_at, provider: a.provider,
        method: a.method, status: a.status, amountKobo: a.amount_kobo, payableKobo: a.payable_kobo ?? null,
        feeKobo: a.fee_kobo ?? null, instructions: a.instructions || null, reviewReason: a.review_reason || null })) };
  }

  async get(user: PosJwtPayload, id: string, refresh = false) {
    const row = await this.row(user, id);
    if (refresh && !bullmqReconciliationEnabled()) {
      const attempts = await this.model('PosPaymentAttempt').find({ checkout: row._id, status: { $in: ACTIVE } });
      for (const attempt of attempts) await this.poll(attempt);
    }
    return this.view(await this.model('PosCheckout').findById(id));
  }

  async list(user: PosJwtPayload, before?: string) {
    await this.actor(user);
    const filter: any = { hub: user.hubId, ...(user.role === 'manager' ? {} : { cashier: user.sub }) };
    if (before && Types.ObjectId.isValid(before)) filter._id = { $lt: new Types.ObjectId(before) };
    const rows = await this.model('PosCheckout').find(filter).sort({ _id: -1 }).limit(50);
    return { data: await Promise.all(rows.map(row => this.view(row))), nextCursor: rows.length === 50 ? String(rows[49]._id) : null };
  }

  async attempt(user: PosJwtPayload, id: string, input: any) {
    const checkout = await this.row(user, id);
    const provider = input.provider, method = input.method;
    if (!['moniepoint', 'squad'].includes(provider) || !['card', 'transfer', 'any'].includes(method) || (provider === 'squad' && method !== 'transfer')) throw new BadRequestException('Choose a supported payment provider and method');
    const clientId = String(input.clientAttemptId || '').trim();
    if (!clientId || clientId.length > 150) throw new BadRequestException('clientAttemptId is required');
    const findPrevious = async () => {
      const previous = await this.model('PosPaymentAttempt').findOne({ checkout: checkout._id, client_attempt_id: clientId }).select('provider method').lean();
      if (previous && (previous.provider !== provider || previous.method !== method)) throw new ConflictException('This attempt ID belongs to another provider or method');
      return previous;
    };
    if (await findPrevious()) return this.view(await this.model('PosCheckout').findById(id));
    const options = await this.options(user);
    if (!options.methods.find(m => m.id === provider)?.available) throw new ServiceUnavailableException('This provider is not configured for this till');
    const config = checkoutConfiguration(), mapping = config.terminals[user.deviceId!];
    const queuedDispatch = queuedPaymentDispatchEnabled();
    const created = await this.atomic(async () => {
      const row = await this.lock(checkout._id);
      if (await findPrevious()) return false;
      if (!['awaiting', 'review'].includes(row.status)) throw new ConflictException('Checkout is already closed');
      const active = await this.model('PosPaymentAttempt').exists({ checkout: row._id, status: { $in: ACTIVE } });
      if (active && input.acknowledgeDuplicateRisk !== true) throw new ConflictException('An earlier payment may still arrive. Confirm the duplicate-payment warning before switching.');
      const attemptId = new Types.ObjectId();
      await this.model('PosPaymentAttempt').create([{
        _id: attemptId, checkout: row._id, client_attempt_id: clientId, merchant_reference: `MP-${attemptId}`,
        provider, method, account_key: provider === 'moniepoint' ? mapping.accountKey : 'squad',
        account_snapshot: provider === 'moniepoint' ? config.accounts[mapping.accountKey] : undefined,
        terminal_serial: provider === 'moniepoint' ? mapping.terminalSerial : undefined,
        dispatch_actor: user.sub, dispatch_role: user.role, dispatch_device: user.deviceId,
        amount_kobo: row.due_kobo, payable_kobo: provider === 'moniepoint' ? row.due_kobo : undefined,
        fee_kobo: provider === 'moniepoint' ? 0 : undefined, status: 'queued',
        next_check: new Date(Date.now() + (bullmqReconciliationEnabled() && !queuedDispatch ? 15_000 : 0)),
      }]);
      return true;
    }).catch(async error => {
      if (error?.code === 11000 && await findPrevious()) return false;
      throw error;
    });
    const attempt = created ? await this.model('PosPaymentAttempt').findOne({ checkout: checkout._id, client_attempt_id: clientId }) : null;
    if (attempt && !queuedDispatch) await this.dispatch(attempt);
    else if (attempt) eventLog('info', 'payment_dispatch_queued', {
      queue: paymentReconciliationQueue, provider, attemptId: String(attempt._id),
      correlationId: String(attempt._id), checkoutId: id, hubId: user.hubId,
    });
    return this.view(await this.model('PosCheckout').findById(id));
  }

  private async dispatch(attempt: any, correlationId?: string) {
    const owner = randomUUID();
    const claimed = await this.atomic(async () => {
      const row = await this.lock(attempt.checkout);
      if (['completed', 'cancelled'].includes(row.status)) {
        await this.closeUnsentAttempts(row._id);
        return null;
      }
      const filter = { _id: attempt._id, status: 'queued',
        ...(correlationId != null ? { next_check: attempt.next_check ?? null, lease_until: attempt.lease_until ?? null } : {}) };
      const queued = await this.model('PosPaymentAttempt').findOne(filter).lean();
      if (!queued) return null;
      const ineligible = await this.dispatchIneligibility(row, queued);
      if (ineligible) {
        await this.closeUnsentAttempt(queued, ineligible);
        return null;
      }
      return this.model('PosPaymentAttempt').findOneAndUpdate(filter,
        { $set: { status: 'pending', lease_owner: owner, lease_until: paymentLease(), next_check: new Date(Date.now() + 15_000) } }, { returnDocument: 'after' });
    });
    if (!claimed) return 'stale';
    try {
      if (claimed.provider === 'moniepoint') {
        const providerReference = await new MoniepointClient(claimed.account_snapshot, checkoutConfiguration().baseUrl, this.auditHttp(await this.auditedAttempt(claimed, correlationId))).open(claimed.merchant_reference, claimed.terminal_serial, claimed.amount_kobo);
        if (providerReference) await this.model('PosPaymentAttempt').updateOne(
          { _id: claimed._id, provider_reference: { $exists: false } },
          { $set: { provider_reference: providerReference } },
        );
      } else {
        const row = await this.model('PosCheckout').findById(claimed.checkout);
        const staff = await this.model('User').findById(row.cashier).lean();
        const customer = await this.model('Customer').findById(row.customer).lean();
        const email = customer?.customer_email || customer?.email || staff?.email;
        const opened = await this.squad(await this.auditedAttempt(claimed, correlationId)).open({ clientSaleId: claimed.merchant_reference, amountKobo: claimed.amount_kobo, email });
        const instructions = { instructions: opened, payable_kobo: opened.payableKobo, fee_kobo: opened.payableKobo - claimed.amount_kobo };
        // This is verified evidence from the original request. It can fill missing
        // fees after a lease expires without changing reconciliation state.
        await this.model('PosPaymentAttempt').updateOne({
          _id: claimed._id, status: { $in: ['pending', 'unknown', 'review'] }, payable_kobo: null, instructions: null,
        }, { $set: instructions });
      }
    } catch (error) {
      const definite = error instanceof ProviderFailure && error.definite;
      await this.atomic(async () => {
        const result = await this.model('PosPaymentAttempt').updateOne({
          _id: claimed._id, status: { $in: ACTIVE }, ...activeLease(owner),
        }, { $set: {
          status: definite ? 'failed' : 'unknown',
          review_reason: definite ? 'Provider declined this request. Use another method.' : 'Result unknown. Check the payment or confirm actual receipt before retrying.',
        } });
        if (result.matchedCount && definite && claimed.terminal_lock) {
          await this.model('PosTerminalLock').deleteOne({ _id: claimed.terminal_lock, attempt: claimed._id });
        }
      });
    } finally {
      await this.model('PosPaymentAttempt').updateOne({ _id: claimed._id, ...activeLease(owner) }, { $unset: { lease_owner: '', lease_until: '' } });
    }
    return 'dispatched';
  }

  private async dispatchIneligibility(row: any, attempt: any) {
    const hubId = String(row.hub);
    const deviceId = attempt.dispatch_device || row.device_id;
    const actorId = String(attempt.dispatch_actor || row.cashier);
    try {
      await this.actor({ sub: actorId, role: attempt.dispatch_role, hubId, deviceId }, row);
      if (actorId !== String(row.cashier) || deviceId !== row.device_id) {
        await this.actor({ sub: String(row.cashier), hubId, deviceId: row.device_id }, row);
      }
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      return 'The till, staff or location assignment changed before this payment request was sent.';
    }
    if (attempt.provider === 'squad') {
      return process.env.SQUAD_ENABLED === 'true' && process.env.SQUAD_DVA_APPROVED === 'true' &&
        process.env.SQUAD_CONTRACT_VERIFIED === 'true' && process.env.SQUAD_SECRET_KEY
        ? null : 'Squad was disabled or its configuration changed before this payment request was sent.';
    }
    const config = checkoutConfiguration();
    const mapping = config.terminals[deviceId];
    const account = mapping && config.accounts[mapping.accountKey];
    const snapshot = attempt.account_snapshot;
    if (process.env.MONIEPOINT_ENABLED !== 'true' || config.errors.length || mapping?.hubId !== hubId ||
      mapping.terminalSerial !== attempt.terminal_serial || mapping.accountKey !== attempt.account_key ||
      !account || !snapshot || account.businessId !== snapshot.businessId || account.businessOwnerId !== snapshot.businessOwnerId ||
      account.apiKeyEnv !== snapshot.apiKeyEnv || account.clientIdEnv !== snapshot.clientIdEnv || account.webhookSecretEnv !== snapshot.webhookSecretEnv) {
      return 'Moniepoint was disabled or its account or terminal assignment changed before this payment request was sent.';
    }
    return null;
  }

  private squad(attempt?: any) { return new SquadClient(process.env.SQUAD_SECRET_KEY || '', process.env.SQUAD_API_BASE_URL || undefined,
    attempt ? this.auditHttp(attempt) : this.audit.http({ provider_id: 'squad', account_key: 'squad' })); }

  async receiveMoniepoint(accountKey: string, raw: string, headers: Record<string, any>, trace?: WebhookTrace) {
    const config = checkoutConfiguration(), account = config.accounts[accountKey];
    if (!account) { trace?.rejected('unknown_account'); throw new BadRequestException('Unknown payment subscription'); }
    let evidence: TerminalEvidence | null;
    try { evidence = new MoniepointClient(account, config.baseUrl).webhook(raw, headers); }
    catch { trace?.rejected('invalid_signature_or_business'); throw new BadRequestException('Invalid payment webhook'); }
    trace?.verified(evidence);
    if (evidence) await this.enqueue('moniepoint', accountKey, evidence, trace?.correlationId);
    return { received: true };
  }

  async receiveSquad(raw: string, headers: Record<string, any>, trace?: WebhookTrace): Promise<boolean> {
    let event;
    try { event = this.squad().webhook(raw, headers); } catch { trace?.rejected('invalid_signature'); throw new BadRequestException('Invalid payment webhook'); }
    trace?.verified(event);
    if (!event) return true;
    if (!await this.model('PosPaymentAttempt').exists({ provider: 'squad', merchant_reference: event.reference }) &&
      await this.model('PosTransfer').exists({ provider: 'squad', $or: [{ client_sale_id: event.reference }, { checkout_id: event.reference }] })) return false;
    await this.enqueue('squad', 'squad', { ...event, transactionReference: event.eventId, status: event.status === 'paid' ? 'paid' : 'review', method: 'Transfer' }, trace?.correlationId);
    return true;
  }

  private async enqueue(provider: string, account: string, evidence: any, correlationId?: string) {
    const attempt = evidence.reference ? await this.model('PosPaymentAttempt').findOne({ provider, account_key: account, merchant_reference: evidence.reference }) : null;
    const checkout = attempt ? await this.model('PosCheckout').findById(attempt.checkout) : null;
    // An unmatched Moniepoint event can still be scoped to its registered terminal.
    const mapping = Object.values(checkoutConfiguration().terminals).find(t => t.accountKey === account && t.terminalSerial === evidence.terminalSerial);
    try {
      const [saved] = await this.model('PosWebhookInbox').create([{ provider, account_key: account, event_id: evidence.eventId,
        evidence, correlation_id: isEventId(correlationId) ? correlationId : undefined,
        hub: checkout?.hub || mapping?.hubId, state: 'pending' }], { w: 'majority' });
      if (bullmqReconciliationEnabled()) eventLog('info', 'payment_webhook_persisted', {
        queue: paymentReconciliationQueue, provider, inboxId: String(saved._id),
        correlationId: saved.correlation_id || String(saved._id),
        hubId: saved.hub ? String(saved.hub) : undefined,
      });
    }
    catch (error: any) { if (error?.code !== 11000) throw error; }
  }

  async poll(attempt: any, correlationId?: string) {
    const scheduled = correlationId != null;
    if (attempt.status === 'queued') return this.dispatch(attempt, correlationId);
    const owner = randomUUID();
    const claimed = await this.model('PosPaymentAttempt').findOneAndUpdate({ _id: attempt._id, status: { $in: ACTIVE },
      ...(scheduled ? { next_check: attempt.next_check ?? null, lease_until: attempt.lease_until ?? null } : {}),
      $or: [{ lease_until: null }, { lease_until: { $lte: new Date() } }] },
      { $set: { lease_owner: owner, lease_until: paymentLease() } }, { returnDocument: 'after' });
    if (!claimed) return 'stale';
    try {
      let event: any;
      if (claimed.provider === 'moniepoint') event = await new MoniepointClient(claimed.account_snapshot, checkoutConfiguration().baseUrl, this.auditHttp(await this.auditedAttempt(claimed, correlationId))).check(claimed.merchant_reference);
      else {
        const checked = await this.squad(await this.auditedAttempt(claimed, correlationId)).check(claimed.merchant_reference);
        event = { ...checked, status: checked.status === 'paid' ? 'paid' : checked.status === 'expired' ? 'review' : 'pending', method: 'Transfer' };
        // A query result without a stable transaction ID cannot consume a payment twice.
        if (event.status === 'paid' && !event.transactionReference) event.status = 'review';
      }
      const reason = await this.apply(claimed, event, owner);
      const resetFailures = () => this.model('PosPaymentAttempt').updateOne(
        { _id: claimed._id, ...activeLease(owner) }, { $set: { failures: 0 } });
      if (reason) {
        return await this.atomic(async () => {
          if (!(await resetFailures()).matchedCount) return 'stale';
          const checkout = await this.model('PosCheckout').findById(claimed.checkout);
          await this.storePollReview(claimed, checkout?.hub, event, reason);
          return 'review';
        });
      }
      return (await resetFailures()).matchedCount ? 'checked' : 'stale';
    } catch {
      const result = await this.model('PosPaymentAttempt').updateOne({ _id: claimed._id, status: { $in: ACTIVE }, ...activeLease(owner) },
        { $inc: { failures: 1 }, $set: { status: 'unknown', review_reason: 'Provider status is unavailable. The original request may still complete.' } });
      return result.matchedCount ? 'deferred' : 'stale';
    } finally {
      const backoff = Math.min(300_000, settingMilliseconds('MONIEPOINT_STATUS_POLL_INTERVAL_MS', 15_000) * 2 ** Math.min(claimed.failures || 0, 5));
      await this.model('PosPaymentAttempt').updateOne({ _id: claimed._id, ...activeLease(owner) }, { $set: { next_check: new Date(Date.now() + backoff) }, $unset: { lease_owner: '', lease_until: '' } });
    }
  }

  private async storePollReview(attempt: any, hub: Types.ObjectId | undefined, event: TerminalEvidence, reason: string) {
    const result = await this.model('PosWebhookInbox').updateOne({
      provider: attempt.provider, account_key: attempt.account_key,
      event_id: `poll:${attempt.merchant_reference}:${event.transactionReference || 'review'}`,
    }, { $setOnInsert: { evidence: event, hub, state: 'review', review_reason: reason } }, { upsert: true });
    if (result.upsertedId && hub) await this.notifyReview(result.upsertedId, hub);
  }

  private notifyReview(id: unknown, hub: Types.ObjectId) {
    return saveLiveNotice(this.db, { sourceKey: `payment-review:${id}`,
      audience: { kind: 'location-role', hubId: String(hub), role: 'pos-admin' },
      kind: 'payment-review', title: 'Payment needs review' });
  }

  private async apply(attempt: any, event: TerminalEvidence, pollOwner?: string): Promise<string | null> {
    return this.atomic(async () => {
      const row = await this.lock(attempt.checkout);
      const current = await this.model('PosPaymentAttempt').findById(attempt._id);
      if (!current) return 'Payment attempt is missing';
      if (event.reference !== current.merchant_reference || (current.provider === 'moniepoint' &&
        (event.terminalSerial !== current.terminal_serial || event.businessOwnerId !== current.account_snapshot.businessOwnerId ||
        (event.businessId != null && event.businessId !== current.account_snapshot.businessId)))) return 'Payment reference, business or terminal does not match';
      if (current.provider === 'moniepoint' && event.transactionReference && !current.provider_reference) {
        await this.model('PosPaymentAttempt').updateOne(
          { _id: current._id, provider_reference: { $exists: false } },
          { $set: { provider_reference: event.transactionReference } },
        );
      }
      if (event.status === 'pending') return null;
      const updateNonSettlement = (changes: Record<string, unknown>) => this.model('PosPaymentAttempt').updateOne(
        { _id: current._id, ...(pollOwner ? activeLease(pollOwner) : {}) }, { $set: changes });
      if (event.status === 'failed') {
        if (current.status === 'paid' || !(await updateNonSettlement({ status: 'failed' })).matchedCount) return null;
        if (current.terminal_lock) await this.model('PosTerminalLock').deleteOne({ _id: current.terminal_lock, attempt: current._id });
        return null;
      }
      if (event.status !== 'paid' || current.payable_kobo == null || event.currency !== 'NGN' || !Number.isSafeInteger(event.amountKobo) || event.amountKobo !== current.payable_kobo || !event.transactionReference || !event.method) {
        const reason = 'Payment needs amount, reference or status reconciliation';
        const updated = await updateNonSettlement({ status: current.status === 'paid' ? 'paid' : 'review', review_reason: reason });
        return updated.matchedCount ? reason : null;
      }
      const paidReview = async (reason: string) => {
        // Valid paid evidence remains durable even if the poll lease expired.
        if (pollOwner) await this.storePollReview(current, row.hub, event, reason);
        return reason;
      };
      if (current.provider === 'moniepoint' && event.paidAt) {
        await this.model('PosPaymentAttempt').updateOne(
          { _id: current._id, provider_paid_at: { $exists: false } },
          { $set: { provider_paid_at: event.paidAt } },
        );
      }
      const unique = { provider: current.provider, account_key: current.account_key, transaction_reference: event.transactionReference };
      const previous = await this.model('PosProviderTransaction').findOne(unique);
      if (previous && String(previous.checkout) !== String(row._id)) return paidReview('Payment was already allocated to another checkout');
      const otherTransaction = await this.model('PosProviderTransaction').exists({ provider: current.provider, account_key: current.account_key,
        merchant_reference: current.merchant_reference, transaction_reference: { $ne: event.transactionReference } });
      if (!previous) await this.model('PosProviderTransaction').create([{ ...unique, checkout: row._id, merchant_reference: event.reference, amount_kobo: event.amountKobo }]);
      current.status = 'paid'; await current.save();
      if (current.terminal_lock) await this.model('PosTerminalLock').deleteOne({ _id: current.terminal_lock, attempt: current._id });
      if (otherTransaction) return paidReview('More than one provider transaction paid the same request');
      if (row.status === 'completed') {
        if (row.settled_attempt === String(current._id)) return null;
        return paidReview('Additional payment arrived after another collection completed this checkout');
      }
      if (row.status === 'cancelled') return paidReview('Payment arrived after cancellation');
      if (row.kind === 'repayment') {
        const credit = await this.model('CreditRecord').findById(row.credit);
        if (!credit || ['Clear', 'Voided'].includes(credit.status) || kobo(credit.amount_owed) < row.due_kobo) return paidReview('Outstanding credit changed before this payment arrived');
      }
      await this.complete(row, current, 'provider', event.method);
      return null;
    });
  }

  async manual(user: PosJwtPayload, id: string, input: any) {
    await this.row(user, id);
    const received = money(input.amountKobo);
    if (input.confirmed !== true || !['Card', 'Transfer', 'Cash', 'Other'].includes(input.actualMethod) ||
      !String(input.account || '').trim() || !String(input.reason || '').trim()) throw new BadRequestException('Confirm the amount, actual method/account and reason');
    await this.atomic(async () => {
      const row = await this.lock(id);
      if (row.status === 'completed') return;
      if (!['awaiting', 'review'].includes(row.status) || row.due_kobo <= 0) throw new ConflictException('This checkout cannot be confirmed');
      let attempt: any;
      if (input.attemptId) {
        if (!Types.ObjectId.isValid(input.attemptId)) throw new BadRequestException('Invalid payment attempt');
        attempt = await this.model('PosPaymentAttempt').findOne({ _id: input.attemptId, checkout: row._id });
        if (!attempt || attempt.status === 'queued' || attempt.payable_kobo == null) throw new BadRequestException('This attempt is not ready for confirmation; choose another account if money arrived elsewhere');
        const expectedMethod = attempt.method === 'card' ? 'Card' : 'Transfer';
        if (input.actualMethod !== expectedMethod) throw new BadRequestException('The received method does not match this attempt; choose another account');
      }
      if (received !== (attempt?.payable_kobo ?? row.due_kobo)) throw new BadRequestException('Received amount must match the amount due now');
      row.manual = { actor: user.sub, actualMethod: input.actualMethod, account: String(input.account).trim(), reason: String(input.reason).trim(),
        externalReference: String(input.externalReference || '').trim(), amountKobo: received, at: new Date(), attemptId: attempt ? String(attempt._id) : null };
      await this.complete(row, attempt, 'manual', input.actualMethod);
    });
    return this.view(await this.model('PosCheckout').findById(id));
  }

  private async complete(row: any, attempt: any, source: string, method: string = 'Credit') {
    if (row.status === 'completed') return;
    const payments: any[] = row.due_kobo ? [{ method, amount: row.due_kobo, reference: attempt?.merchant_reference || row.manual?.externalReference }] : [];
    if (row.credit_kobo > 0) payments.push({ method: 'Credit', amount: row.credit_kobo });
    if (row.kind === 'sale') {
      if (row.reservation_state !== 'held') throw new ConflictException('Stock reservation needs reconciliation');
      await this.pos.releasePayment(row.allocations);
      const actor: PosJwtPayload = { sub: String(row.cashier), role: 'cashier', hubId: String(row.hub), deviceId: row.device_id };
      const created = await this.pos.createSale(actor, { ...row.sale_payload, createdAt: row.createdAt.toISOString(), clientSaleId: row.client_sale_id, payments }, row.snapshot);
      row.sale_id = created.data._id;
      await this.model('Sale').updateOne({ _id: row.sale_id }, { $set: { payment_mode: row.mode === 'full_payment' ? 'Full Payment' : row.mode === 'partial_credit' ? 'Partial Credit' : 'Full Credit',
        amount_paid: row.due_kobo / 100, status: row.credit_kobo ? 'Pending' : 'Paid', due_date: row.due_date } });
      if (row.credit_kobo) {
        const [credit] = await this.model('CreditRecord').create([{ customer: row.customer, customer_name: row.customer_name, sale: row.sale_id,
          sale_reference: String(row.sale_id), amount_owed: row.credit_kobo / 100, original_amount: row.credit_kobo / 100,
          date_issued: new Date(), due_date: row.due_date, status: creditStatus(row.credit_kobo, row.due_date) }]);
        row.credit = credit._id;
        await this.model('Sale').updateOne({ _id: row.sale_id }, { $set: { credit_record: credit._id } });
      }
      await this.model('Customer').updateOne({ _id: row.customer }, { $inc: { total_orders: 1, total_spent: row.total_kobo / 100 } });
      row.reservation_state = 'consumed';
    } else {
      // Write fence serializes with CRM's transaction-backed repayment path.
      const credit = await this.model('CreditRecord').findOneAndUpdate({ _id: row.credit }, { $inc: { __v: 1 } }, { returnDocument: 'after' });
      if (!credit || ['Clear', 'Voided'].includes(credit.status) || kobo(credit.amount_owed) < row.due_kobo) throw new ConflictException('Outstanding credit changed; reconcile this payment');
      const balance = kobo(credit.amount_owed) - row.due_kobo;
      credit.amount_owed = balance / 100; credit.status = creditStatus(balance, credit.due_date); credit.last_payment_date = new Date();
      credit.payments.push({ date: new Date(), amount: row.due_kobo / 100, method, recorded_by: row.cashier, recorded_by_name: row.cashier_name,
        note: source === 'manual' ? row.manual.reason : 'POS payment', reference_id: `pos:${row._id}`, balance_after: balance / 100 });
      if (balance === 0) credit.repayment_timelines.push(Math.max(0, Math.floor((Date.now() - new Date(credit.date_issued).getTime()) / 86400000)));
      await credit.save(); row.credit_kobo = balance;
    }
    const snap = row.snapshot;
    const now = new Date();
    const originHub = await this.model('Hub').findById(row.hub).lean();
    const originDevice = await this.model('PosDevice').findOne({ device_id: row.device_id, hub: row.hub }).lean();
    row.receipt = {
      origin: { storeName: originHub?.hub_name, deviceLabel: originDevice?.label },
      id: row.client_sale_id, deviceId: row.device_id, storeId: String(row.hub), hubId: String(row.hub), cashierId: String(row.cashier), cashierName: row.cashier_name,
      customerId: String(row.customer), customerName: row.customer_name, shiftId: row.sale_payload.shiftId,
      kind: row.kind, paymentMode: row.mode, creditBalanceKobo: row.credit_kobo, dueDate: row.due_date, creditId: row.credit ? String(row.credit) : undefined,
      lines: snap ? snap.lines.map((line: any) => ({ productId: String(line.product._id), name: line.name, sku: line.product.sku,
        unit: line.saleUnit, saleUnit: line.saleUnit, qty: line.quantity, unitPrice: line.unitPriceKobo, discount: line.discountKobo,
        lineTotal: Math.round(line.unitPriceKobo * line.quantity) - line.discountKobo, batchNumber: line.batchNumber,
        saleWeightKg: line.saleWeightKg })) : [],
      subtotal: snap?.subtotal ?? row.total_kobo, discount: snap?.discount || 0, tax: snap?.tax || 0,
      taxRatePct: snap?.taxRatePct, taxInclusive: snap?.taxInclusive, total: row.total_kobo, payments, change: 0, status: 'completed', createdAt: row.createdAt || now, syncState: 'synced',
      receiptPayment: { provider: attempt?.provider || (source === 'credit' ? 'credit' : 'manual'), checkoutReference: attempt?.merchant_reference || row.manual?.externalReference,
        feeKobo: attempt?.fee_kobo ?? 0, paidKobo: row.due_kobo + (attempt?.fee_kobo || 0), confirmedAt: now.toISOString(), confirmationSource: source,
        actualMethod: method, account: row.manual?.account },
    };
    row.status = 'completed'; row.settled_attempt = attempt ? String(attempt._id) : undefined; row.confirmed_at = now; row.confirmation_source = source;
    await row.save();
    await this.closeUnsentAttempts(row._id);
    if (row.due_kobo > 0 && (source === 'provider' || source === 'manual')) await saveLiveNotice(this.db, {
      sourceKey: `payment-confirmed:${row._id}`, audience: { kind: 'till', hubId: String(row.hub), tillId: row.device_id },
      kind: 'payment-confirmed', title: 'Payment confirmed', reference: row.client_sale_id,
    });
  }

  async cancel(user: PosJwtPayload, id: string) {
    await this.row(user, id);
    await this.atomic(async () => {
      const row = await this.lock(id);
      if (row.status === 'cancelled') return;
      if (row.status === 'completed') throw new ConflictException('Completed checkout cannot be cancelled');
      if (await this.model('PosPaymentAttempt').exists({ checkout: row._id, status: { $in: ['pending', 'unknown', 'review', 'paid'] } })) throw new ConflictException('A payment may still arrive. Check the provider before cancelling.');
      await this.closeUnsentAttempts(row._id);
      if (row.reservation_state === 'held') { await this.pos.releasePayment(row.allocations); row.reservation_state = 'released'; }
      row.status = 'cancelled'; await row.save();
    });
    return this.view(await this.model('PosCheckout').findById(id));
  }

  private async closeUnsentAttempts(checkout: Types.ObjectId) {
    const queued = await this.model('PosPaymentAttempt').find({ checkout, status: 'queued' }).select('_id terminal_lock');
    for (const attempt of queued) {
      await this.closeUnsentAttempt(attempt, 'Checkout closed before this payment request was sent.');
    }
  }

  private async closeUnsentAttempt(attempt: { _id: Types.ObjectId; terminal_lock?: string }, reason: string) {
    const closed = await this.model('PosPaymentAttempt').updateOne({ _id: attempt._id, status: 'queued' }, {
      $set: { status: 'failed', review_reason: reason },
    });
    if (closed.matchedCount && attempt.terminal_lock) await this.model('PosTerminalLock').deleteOne({ _id: attempt.terminal_lock, attempt: attempt._id });
  }

  async credits(user: PosJwtPayload, customerId: string) {
    await this.actor(user); const customer = await this.customer(user, customerId);
    const rows = await this.model('CreditRecord').find({ customer: customer._id, status: { $in: ['Pending', 'Overdue'] }, amount_owed: { $gt: 0 } }).sort({ due_date: 1 }).lean();
    return { data: rows.map(r => ({ id: String(r._id), saleReference: r.sale_reference, amountKobo: kobo(r.amount_owed), dueDate: r.due_date, status: r.status })) };
  }

  async reviews(user: PosJwtPayload) {
    await this.actor(user); if (user.role !== 'manager') throw new ForbiddenException('Manager access required');
    const rows = await this.model('PosWebhookInbox').find({ hub: user.hubId, state: 'review' }).sort({ received_at: -1 }).limit(100).lean();
    return { data: rows.map(r => ({ id: String(r._id), provider: r.provider, reference: r.evidence?.reference, amountKobo: r.evidence?.amountKobo, reason: r.review_reason, receivedAt: r.received_at })) };
  }

  async processInbox(scheduled?: { _id: Types.ObjectId; lease_until?: Date }, correlationId?: string) {
    const owner = randomUUID();
    const event = await this.model('PosWebhookInbox').findOneAndUpdate({ state: 'pending',
      ...(scheduled ? { _id: scheduled._id, lease_until: scheduled.lease_until ?? null } : {}),
      $or: [{ lease_until: null }, { lease_until: { $lte: new Date() } }] },
      { $set: { lease_owner: owner, lease_until: paymentLease() } }, { returnDocument: 'after' });
    if (!event) return 'empty';
    try {
      const attempt = await this.model('PosPaymentAttempt').findOne({ provider: event.provider, account_key: event.account_key, merchant_reference: event.evidence.reference });
      if (attempt?.provider === 'squad' && event.evidence.status === 'paid') {
        const checked = await this.squad(await this.auditedAttempt(attempt, correlationId)).check(attempt.merchant_reference);
        if (checked.status !== 'paid') throw new Error('Await provider query confirmation');
      }
      // Do not consume early Squad evidence until the account-creation response confirms fees.
      if (attempt && attempt.payable_kobo == null && attempt.status === 'pending') throw new Error('Await provider instructions');
      const reason = attempt ? await this.apply(attempt, event.evidence) : 'No matching payment reference';
      const state = reason ? 'review' : 'done';
      await this.atomic(async () => {
        const result = await this.model('PosWebhookInbox').updateOne({ _id: event._id, ...activeLease(owner) },
          { $set: { state, review_reason: reason || undefined }, $unset: { lease_owner: '', lease_until: '' } });
        if (result.matchedCount && reason && event.hub) await this.notifyReview(event._id, event.hub);
      });
      return state;
    } catch {
      await this.model('PosWebhookInbox').updateOne({ _id: event._id, lease_owner: owner },
        { $set: { lease_until: new Date(Date.now() + 15_000) }, $unset: { lease_owner: '' } });
      return 'deferred';
    }
  }

  async tick() {
    if (bullmqReconciliationEnabled()) return;
    if (this.working) return; this.working = true;
    try {
      for (let i = 0; i < 10; i++) {
        if (await this.processInbox() === 'empty') break;
      }
      const attempts = await this.model('PosPaymentAttempt').find({ status: { $in: ACTIVE }, next_check: { $lte: new Date() } }).limit(10);
      for (const attempt of attempts) await this.poll(attempt);
    } finally { this.working = false; }
  }
}
