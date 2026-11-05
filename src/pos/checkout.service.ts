import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { PosService } from './pos.service';
import { PosJwtPayload } from './pos-auth';
import { checkoutConfiguration, settingMilliseconds } from './checkout-config';
import { MoniepointClient, TerminalEvidence } from './moniepoint.client';
import { SquadClient } from './squad.client';
import { ProviderFailure } from './payment-provider';

const ACTIVE = ['queued', 'pending', 'unknown', 'review'];
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
  private readonly worker = randomUUID();
  constructor(@InjectConnection() private readonly db: Connection, private readonly pos: PosService) {}
  private model(name: string): Model<any> { return this.db.model(name) as unknown as Model<any>; }
  private atomic<T>(work: () => Promise<T>): Promise<T> { return this.pos.inventoryTransaction(work); }
  private enabled() { if (process.env.POS_CHECKOUT_V2_ENABLED !== 'true') throw new ServiceUnavailableException('New checkout is not enabled'); }

  onModuleInit() {
    if (process.env.POS_PAYMENT_WORKER_ENABLED === 'false') return;
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, 1000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async actor(user: PosJwtPayload, row?: any) {
    const [staff, hub, device] = await Promise.all([
      this.model('User').findById(user.sub).populate('role').lean(), this.model('Hub').findById(user.hubId).lean(),
      this.model('PosDevice').findOne({ device_id: user.deviceId, hub: user.hubId, revoked: { $ne: true } }).lean(),
    ]);
    if (!staff || staff.is_active === false || !hub || hub.is_active === false || !device ||
      staff.role?.name !== (user.role === 'manager' ? 'hub_manager' : 'cashier') ||
      (String(staff.hub) !== user.hubId && !(user.role === 'manager' && String(hub.hub_manager) === user.sub))) throw new ForbiddenException('Your till or location assignment is not active');
    if (row && (String(row.hub) !== user.hubId || (user.role !== 'manager' && String(row.cashier) !== user.sub))) throw new ForbiddenException('This checkout is not assigned to you');
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
    return { enabled: process.env.POS_CHECKOUT_V2_ENABLED === 'true', methods: [
      { id: 'moniepoint', name: 'Moniepoint', available: Boolean(moniepoint) },
      { id: 'squad', name: 'Squad', available: squad }, { id: 'manual', name: 'Confirm payment received', available: true },
    ] };
  }

  private async row(user: PosJwtPayload, id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Checkout not found');
    const row = await this.model('PosCheckout').findById(id);
    if (!row) throw new NotFoundException('Checkout not found');
    await this.actor(user, row); return row;
  }

  private async lock(id: any) {
    const row = await this.model('PosCheckout').findOneAndUpdate({ _id: id }, { $inc: { __v: 1 } }, { new: true });
    if (!row) throw new NotFoundException('Checkout not found');
    return row;
  }

  async create(user: PosJwtPayload, input: any, repayment = false) {
    this.enabled();
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
      attempts: attempts.map(a => ({ id: String(a._id), clientAttemptId: a.client_attempt_id, reference: a.merchant_reference, provider: a.provider,
        method: a.method, status: a.status, amountKobo: a.amount_kobo, payableKobo: a.payable_kobo ?? null,
        feeKobo: a.fee_kobo ?? null, instructions: a.instructions || null, reviewReason: a.review_reason || null })) };
  }

  async get(user: PosJwtPayload, id: string, refresh = false) {
    const row = await this.row(user, id);
    if (refresh) {
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
    this.enabled(); const checkout = await this.row(user, id);
    const provider = input.provider, method = input.method;
    if (!['moniepoint', 'squad'].includes(provider) || !['card', 'transfer'].includes(method) || (provider === 'squad' && method !== 'transfer')) throw new BadRequestException('Choose a supported payment provider and method');
    const clientId = String(input.clientAttemptId || '').trim();
    if (!clientId || clientId.length > 150) throw new BadRequestException('clientAttemptId is required');
    const previous = await this.model('PosPaymentAttempt').findOne({ checkout: checkout._id, client_attempt_id: clientId });
    if (previous) {
      if (previous.provider !== provider || previous.method !== method) throw new ConflictException('This attempt ID belongs to another provider or method');
      return this.view(checkout);
    }
    const options = await this.options(user);
    if (!options.methods.find(m => m.id === provider)?.available) throw new ServiceUnavailableException('This provider is not configured for this till');
    const config = checkoutConfiguration(), mapping = config.terminals[user.deviceId!];
    await this.atomic(async () => {
      const row = await this.lock(checkout._id);
      if (await this.model('PosPaymentAttempt').exists({ checkout: row._id, client_attempt_id: clientId })) return;
      if (!['awaiting', 'review'].includes(row.status)) throw new ConflictException('Checkout is already closed');
      const active = await this.model('PosPaymentAttempt').exists({ checkout: row._id, status: { $in: ACTIVE } });
      if (active && input.acknowledgeDuplicateRisk !== true) throw new ConflictException('An earlier payment may still arrive. Confirm the duplicate-payment warning before switching.');
      const attemptId = new Types.ObjectId();
      const terminalLock = provider === 'moniepoint' ? `moniepoint:${mapping.terminalSerial}` : undefined;
      if (terminalLock) {
        try { await this.model('PosTerminalLock').create([{ _id: terminalLock, attempt: attemptId }]); }
        catch (error: any) { if (error?.code === 11000) throw new ConflictException('This terminal has an unresolved payment. Check it before sending another request.'); throw error; }
      }
      await this.model('PosPaymentAttempt').create([{
        _id: attemptId, checkout: row._id, client_attempt_id: clientId, merchant_reference: `MP-${attemptId}`,
        provider, method, account_key: provider === 'moniepoint' ? mapping.accountKey : 'squad',
        account_snapshot: provider === 'moniepoint' ? config.accounts[mapping.accountKey] : undefined,
        terminal_serial: terminalLock ? mapping.terminalSerial : undefined, terminal_lock: terminalLock,
        amount_kobo: row.due_kobo, payable_kobo: provider === 'moniepoint' ? row.due_kobo : undefined,
        fee_kobo: provider === 'moniepoint' ? 0 : undefined, status: 'queued', next_check: new Date(),
      }]);
    }).catch(async error => {
      if (error?.code === 11000 && await this.model('PosPaymentAttempt').exists({ checkout: checkout._id, client_attempt_id: clientId })) return;
      throw error;
    });
    const attempt = await this.model('PosPaymentAttempt').findOne({ checkout: checkout._id, client_attempt_id: clientId });
    if (attempt) await this.dispatch(attempt);
    return this.view(await this.model('PosCheckout').findById(id));
  }

  private async dispatch(attempt: any) {
    const claimed = await this.model('PosPaymentAttempt').findOneAndUpdate({ _id: attempt._id, status: 'queued' },
      { $set: { status: 'pending', lease_owner: this.worker, lease_until: new Date(Date.now() + 90_000), next_check: new Date(Date.now() + 15_000) } }, { new: true });
    if (!claimed) return;
    try {
      if (claimed.provider === 'moniepoint') {
        await new MoniepointClient(claimed.account_snapshot, checkoutConfiguration().baseUrl).open(claimed.merchant_reference, claimed.terminal_serial, claimed.amount_kobo, claimed.method);
      } else {
        const row = await this.model('PosCheckout').findById(claimed.checkout);
        const staff = await this.model('User').findById(row.cashier).lean();
        const customer = await this.model('Customer').findById(row.customer).lean();
        const email = customer?.customer_email || customer?.email || staff?.email;
        const opened = await this.squad().open({ clientSaleId: claimed.merchant_reference, amountKobo: claimed.amount_kobo, email });
        await this.model('PosPaymentAttempt').updateOne({ _id: claimed._id }, { $set: { instructions: opened, payable_kobo: opened.payableKobo, fee_kobo: opened.payableKobo - claimed.amount_kobo } });
      }
    } catch (error) {
      const definite = error instanceof ProviderFailure && error.definite;
      await this.atomic(async () => {
        const current = await this.model('PosPaymentAttempt').findById(claimed._id);
        if (!current || current.status === 'paid') return;
        current.status = definite ? 'failed' : 'unknown';
        current.review_reason = definite ? 'Provider declined this request. Use another method.' : 'Result unknown. Check the payment or confirm actual receipt before retrying.';
        await current.save();
        if (definite && current.terminal_lock) await this.model('PosTerminalLock').deleteOne({ _id: current.terminal_lock, attempt: current._id });
      });
    } finally {
      await this.model('PosPaymentAttempt').updateOne({ _id: claimed._id, lease_owner: this.worker }, { $unset: { lease_owner: '', lease_until: '' } });
    }
  }

  private squad() { return new SquadClient(process.env.SQUAD_SECRET_KEY || '', process.env.SQUAD_API_BASE_URL || undefined); }

  async receiveMoniepoint(accountKey: string, raw: string, headers: Record<string, any>) {
    const config = checkoutConfiguration(), account = config.accounts[accountKey];
    if (!account) throw new BadRequestException('Unknown payment subscription');
    let evidence: TerminalEvidence | null;
    try { evidence = new MoniepointClient(account, config.baseUrl).webhook(raw, headers); }
    catch { throw new BadRequestException('Invalid payment webhook'); }
    if (evidence) await this.enqueue('moniepoint', accountKey, evidence);
    return { received: true };
  }

  async receiveSquad(raw: string, headers: Record<string, any>): Promise<boolean> {
    let event;
    try { event = this.squad().webhook(raw, headers); } catch { throw new BadRequestException('Invalid payment webhook'); }
    if (!event) return true;
    if (!await this.model('PosPaymentAttempt').exists({ provider: 'squad', merchant_reference: event.reference }) &&
      await this.model('PosTransfer').exists({ provider: 'squad', $or: [{ client_sale_id: event.reference }, { checkout_id: event.reference }] })) return false;
    await this.enqueue('squad', 'squad', { ...event, transactionReference: event.eventId, status: event.status === 'paid' ? 'paid' : 'review', method: 'Transfer' });
    return true;
  }

  private async enqueue(provider: string, account: string, evidence: any) {
    const attempt = evidence.reference ? await this.model('PosPaymentAttempt').findOne({ provider, account_key: account, merchant_reference: evidence.reference }) : null;
    const checkout = attempt ? await this.model('PosCheckout').findById(attempt.checkout) : null;
    // An unmatched Moniepoint event can still be scoped to its registered terminal.
    const mapping = Object.values(checkoutConfiguration().terminals).find(t => t.accountKey === account && t.terminalSerial === evidence.terminalSerial);
    try { await this.model('PosWebhookInbox').create({ provider, account_key: account, event_id: evidence.eventId, evidence,
      hub: checkout?.hub || mapping?.hubId, state: 'pending' }); }
    catch (error: any) { if (error?.code !== 11000) throw error; }
  }

  async poll(attempt: any) {
    if (attempt.status === 'queued') return this.dispatch(attempt);
    const claimed = await this.model('PosPaymentAttempt').findOneAndUpdate({ _id: attempt._id, status: { $in: ACTIVE },
      $or: [{ lease_until: { $exists: false } }, { lease_until: { $lt: new Date() } }] },
      { $set: { lease_owner: this.worker, lease_until: new Date(Date.now() + 90_000) } }, { new: true });
    if (!claimed) return;
    try {
      let event: any;
      if (claimed.provider === 'moniepoint') event = await new MoniepointClient(claimed.account_snapshot, checkoutConfiguration().baseUrl).check(claimed.merchant_reference);
      else {
        const checked = await this.squad().check(claimed.merchant_reference);
        event = { ...checked, status: checked.status === 'paid' ? 'paid' : checked.status === 'expired' ? 'review' : 'pending', method: 'Transfer' };
        // A query result without a stable transaction ID cannot consume a payment twice.
        if (event.status === 'paid' && !event.transactionReference) event.status = 'review';
      }
      const reason = await this.apply(claimed, event);
      if (reason) {
        const checkout = await this.model('PosCheckout').findById(claimed.checkout);
        await this.model('PosWebhookInbox').updateOne({ provider: claimed.provider, account_key: claimed.account_key, event_id: `poll:${claimed.merchant_reference}:${event.transactionReference || 'review'}` },
          { $setOnInsert: { evidence: event, hub: checkout?.hub, state: 'review', review_reason: reason } }, { upsert: true });
      }
      await this.model('PosPaymentAttempt').updateOne({ _id: claimed._id }, { $set: { failures: 0 } });
    } catch {
      await this.model('PosPaymentAttempt').updateOne({ _id: claimed._id, status: { $in: ACTIVE } }, { $inc: { failures: 1 }, $set: { status: 'unknown', review_reason: 'Provider status is unavailable. The original request may still complete.' } });
    } finally {
      const backoff = Math.min(300_000, settingMilliseconds('MONIEPOINT_STATUS_POLL_INTERVAL_MS', 15_000) * 2 ** Math.min(claimed.failures || 0, 5));
      await this.model('PosPaymentAttempt').updateOne({ _id: claimed._id, lease_owner: this.worker }, { $set: { next_check: new Date(Date.now() + backoff) }, $unset: { lease_owner: '', lease_until: '' } });
    }
  }

  private async apply(attempt: any, event: TerminalEvidence): Promise<string | null> {
    return this.atomic(async () => {
      const row = await this.lock(attempt.checkout);
      const current = await this.model('PosPaymentAttempt').findById(attempt._id);
      if (!current) return 'Payment attempt is missing';
      if (event.reference !== current.merchant_reference || (current.provider === 'moniepoint' &&
        (event.terminalSerial !== current.terminal_serial || event.businessOwnerId !== current.account_snapshot.businessOwnerId ||
        (event.businessId != null && event.businessId !== current.account_snapshot.businessId)))) return 'Payment reference, business or terminal does not match';
      if (event.status === 'pending') return null;
      if (event.status === 'failed') {
        if (current.status !== 'paid') { current.status = 'failed'; await current.save(); }
        if (current.terminal_lock) await this.model('PosTerminalLock').deleteOne({ _id: current.terminal_lock, attempt: current._id });
        return null;
      }
      if (event.status !== 'paid' || current.payable_kobo == null || event.currency !== 'NGN' || !Number.isSafeInteger(event.amountKobo) || event.amountKobo !== current.payable_kobo || !event.transactionReference || !event.method) {
        current.status = current.status === 'paid' ? 'paid' : 'review'; current.review_reason = 'Payment needs amount, reference or status reconciliation'; await current.save();
        return current.review_reason;
      }
      const unique = { provider: current.provider, account_key: current.account_key, transaction_reference: event.transactionReference };
      const previous = await this.model('PosProviderTransaction').findOne(unique);
      if (previous && String(previous.checkout) !== String(row._id)) return 'Payment was already allocated to another checkout';
      const otherTransaction = await this.model('PosProviderTransaction').exists({ provider: current.provider, account_key: current.account_key,
        merchant_reference: current.merchant_reference, transaction_reference: { $ne: event.transactionReference } });
      if (!previous) await this.model('PosProviderTransaction').create([{ ...unique, checkout: row._id, merchant_reference: event.reference, amount_kobo: event.amountKobo }]);
      current.status = 'paid'; await current.save();
      if (current.terminal_lock) await this.model('PosTerminalLock').deleteOne({ _id: current.terminal_lock, attempt: current._id });
      if (otherTransaction) return 'More than one provider transaction paid the same request';
      if (row.status === 'completed') {
        if (row.settled_attempt === String(current._id)) return null;
        return 'Additional payment arrived after another collection completed this checkout';
      }
      if (row.status === 'cancelled') return 'Payment arrived after cancellation';
      if (row.kind === 'repayment') {
        const credit = await this.model('CreditRecord').findById(row.credit);
        if (!credit || ['Clear', 'Voided'].includes(credit.status) || kobo(credit.amount_owed) < row.due_kobo) return 'Outstanding credit changed before this payment arrived';
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
        if (!attempt || attempt.payable_kobo == null) throw new BadRequestException('Payment amount is not available; choose another account if money arrived elsewhere');
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
      const credit = await this.model('CreditRecord').findOneAndUpdate({ _id: row.credit }, { $inc: { __v: 1 } }, { new: true });
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
    row.receipt = {
      id: row.client_sale_id, deviceId: row.device_id, storeId: String(row.hub), hubId: String(row.hub), cashierId: String(row.cashier), cashierName: row.cashier_name,
      customerId: String(row.customer), customerName: row.customer_name, shiftId: row.sale_payload.shiftId,
      kind: row.kind, paymentMode: row.mode, creditBalanceKobo: row.credit_kobo, dueDate: row.due_date, creditId: row.credit ? String(row.credit) : undefined,
      lines: snap ? snap.lines.map((line: any) => ({ productId: String(line.product._id), name: line.name, sku: line.product.sku,
        unit: line.saleUnit, saleUnit: line.saleUnit, qty: line.quantity, unitPrice: line.unitPriceKobo, discount: line.discountKobo,
        lineTotal: Math.round(line.unitPriceKobo * line.quantity) - line.discountKobo, batchNumber: line.batchNumber })) : [],
      subtotal: snap?.subtotal ?? row.total_kobo, discount: snap?.discount || 0, tax: snap?.tax || 0,
      taxRatePct: snap?.taxRatePct, total: row.total_kobo, payments, change: 0, status: 'completed', createdAt: row.createdAt || now, syncState: 'synced',
      receiptPayment: { provider: attempt?.provider || (source === 'credit' ? 'credit' : 'manual'), checkoutReference: attempt?.merchant_reference || row.manual?.externalReference,
        feeKobo: attempt?.fee_kobo ?? 0, paidKobo: row.due_kobo + (attempt?.fee_kobo || 0), confirmedAt: now.toISOString(), confirmationSource: source,
        actualMethod: method, account: row.manual?.account },
    };
    row.status = 'completed'; row.settled_attempt = attempt ? String(attempt._id) : undefined; row.confirmed_at = now; row.confirmation_source = source;
    await row.save();
  }

  async cancel(user: PosJwtPayload, id: string) {
    await this.row(user, id);
    await this.atomic(async () => {
      const row = await this.lock(id);
      if (row.status === 'cancelled') return;
      if (row.status === 'completed') throw new ConflictException('Completed checkout cannot be cancelled');
      if (await this.model('PosPaymentAttempt').exists({ checkout: row._id, status: { $in: [...ACTIVE, 'paid'] } })) throw new ConflictException('A payment may still arrive. Check the provider before cancelling.');
      if (row.reservation_state === 'held') { await this.pos.releasePayment(row.allocations); row.reservation_state = 'released'; }
      row.status = 'cancelled'; await row.save();
    });
    return this.view(await this.model('PosCheckout').findById(id));
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

  async tick() {
    if (this.working) return; this.working = true;
    try {
      for (let i = 0; i < 10; i++) {
        const event = await this.model('PosWebhookInbox').findOneAndUpdate({ state: 'pending',
          $or: [{ lease_until: { $exists: false } }, { lease_until: { $lt: new Date() } }] },
          { $set: { lease_owner: this.worker, lease_until: new Date(Date.now() + 90_000) } }, { new: true });
        if (!event) break;
        try {
          const attempt = await this.model('PosPaymentAttempt').findOne({ provider: event.provider, account_key: event.account_key, merchant_reference: event.evidence.reference });
          if (attempt?.provider === 'squad' && event.evidence.status === 'paid') {
            const checked = await this.squad().check(attempt.merchant_reference);
            if (checked.status !== 'paid') throw new Error('Await provider query confirmation');
          }
          // Do not consume early Squad evidence until the account-creation response confirms fees.
          if (attempt && attempt.payable_kobo == null && attempt.status === 'pending') throw new Error('Await provider instructions');
          const reason = attempt ? await this.apply(attempt, event.evidence) : 'No matching payment reference';
          await this.model('PosWebhookInbox').updateOne({ _id: event._id, lease_owner: this.worker }, { $set: { state: reason ? 'review' : 'done', review_reason: reason || undefined }, $unset: { lease_owner: '', lease_until: '' } });
        } catch {
          await this.model('PosWebhookInbox').updateOne({ _id: event._id, lease_owner: this.worker }, { $set: { lease_until: new Date(Date.now() + 15_000) }, $unset: { lease_owner: '' } });
        }
      }
      const attempts = await this.model('PosPaymentAttempt').find({ status: { $in: ACTIVE }, next_check: { $lte: new Date() } }).limit(10);
      for (const attempt of attempts) await this.poll(attempt);
    } finally { this.working = false; }
  }
}
