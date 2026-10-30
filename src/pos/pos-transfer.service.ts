import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PosJwtPayload } from './pos-auth';
import { PosService } from './pos.service';
import { paymentLogText } from './payment-log';
import { BachsProvider } from './bachs-provider';
import { SquadClient } from './squad.client';
import { PaymentEvidence, PaymentProvider, PaymentProviderId, ProviderFailure, TRANSFER_NEEDS_REVIEW, TRANSFER_STAFF_EMAIL_REQUIRED } from './payment-provider';

const UNRESOLVED = ['initializing', 'awaiting', 'expired', 'review'];

@Injectable()
export class PosTransferService {
  private readonly logger = new Logger(PosTransferService.name);
  constructor(
    @InjectModel('PosTransfer') private readonly transfers: Model<any>,
    private readonly pos: PosService,
    @InjectModel('Hub') private readonly hubs: Model<any>,
    @InjectModel('User') private readonly users: Model<any>,
    @InjectModel('Customer') private readonly customers: Model<any>,
  ) {}

  private provider(id: PaymentProviderId): PaymentProvider {
    if (id === 'squad' && process.env.SQUAD_DVA_APPROVED === 'true' && process.env.SQUAD_CONTRACT_VERIFIED === 'true' && process.env.SQUAD_SECRET_KEY) return new SquadClient(process.env.SQUAD_SECRET_KEY);
    if (id === 'bachs' && process.env.BACHS_API_KEY) return new BachsProvider(process.env.BACHS_API_KEY, process.env.BACHS_WEBHOOK_SECRET || '');
    throw new ServiceUnavailableException('This payment provider is not available');
  }

  async options(user: PosJwtPayload) {
    await this.scope(user, { hub: user.hubId, cashier: user.sub });
    const hub = await this.hubs.findById(user.hubId).lean();
    const providers: Array<{ id: PaymentProviderId; name: string }> = [];
    if (process.env.POS_PAYMENT_RESERVATIONS_ENABLED === 'true' && await this.rolloutReady()) {
      if (process.env.BACHS_API_KEY) providers.push({ id: 'bachs', name: 'Bachs' });
      if (process.env.SQUAD_DVA_APPROVED === 'true' && process.env.SQUAD_CONTRACT_VERIFIED === 'true' && process.env.SQUAD_SECRET_KEY) providers.push({ id: 'squad', name: 'Squad' });
    }
    return { providers, manualConfirmationEnabled: hub?.pos_manual_payment_confirmation === true };
  }

  private async scope(user: PosJwtPayload, row: any) {
    if (String(row.hub) !== user.hubId || (user.role !== 'manager' && String(row.cashier) !== user.sub)) throw new ForbiddenException('This payment is not assigned to you at this location');
    const actor = await this.users.findById(user.sub).populate('role').lean();
    const hub = await this.hubs.findById(user.hubId).lean();
    if (!actor || actor.is_active === false || actor.role?.name !== (user.role === 'manager' ? 'hub_manager' : 'cashier') || !hub || hub.is_active === false
      || (String(actor.hub) !== user.hubId && !(user.role === 'manager' && String(hub.hub_manager) === user.sub))) {
      throw new ForbiddenException('Your account is not currently assigned to this location');
    }
  }

  private async rolloutReady() {
    const marker = await this.transfers.db.collection('pos_payment_rollout').findOne({ _id: 'reservations-v1' as any });
    return marker?.ready === true;
  }

  private async view(row: any, user?: PosJwtPayload) {
    const hub = user ? await this.hubs.findById(user.hubId).lean() : null;
    const unresolved = UNRESOLVED.includes(row.status);
    return { clientSaleId: row.client_sale_id, checkoutId: row.checkout_id || '', provider: row.provider || 'bachs',
      status: row.status, bankName: row.bank_name || '', accountName: row.account_name || '', accountNumber: row.account_number || '',
      payableKobo: row.payable_kobo, cartTotalKobo: row.cart_total_kobo, feeKobo: row.fee_kobo ?? null, currency: row.currency,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null, sale: row.sale_payload,
      reservationState: row.reservation_state || 'needs_review', reconciliationReason: row.reconciliation_reason || null,
      canConfirmReceived: Boolean(user && unresolved && row.reservation_state === 'held' && row.checkout_id && hub?.pos_manual_payment_confirmation === true && (user.role === 'manager' || String(row.cashier) === user.sub)),
      canCancel: Boolean(user && unresolved), confirmationSource: row.confirmation_source || null };
  }

  private validEmail(value: unknown) {
    const email = String(value || '').trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
  }

  private async buyerIdentity(payload: Record<string, any>, user: PosJwtPayload) {
    const customer = payload.customerId && Types.ObjectId.isValid(payload.customerId)
      ? await this.customers.findOne({ _id: payload.customerId, customer_location: user.hubId }).lean()
      : null;
    const staff = await this.users.findById(user.sub).lean();
    const email = this.validEmail(customer?.customer_email || customer?.email) || this.validEmail(staff?.email);
    if (!email) throw new BadRequestException(TRANSFER_STAFF_EMAIL_REQUIRED);
    const name = String(payload.customerName || customer?.customer_name || staff?.full_name || email).trim();
    return { email, name };
  }

  async start(user: PosJwtPayload, payload: Record<string, any>) {
    let stage = 'validation';
    const context = { provider: payload.provider === 'squad' ? 'squad' : 'bachs',
      clientSaleId: paymentLogText(payload.clientSaleId), hubId: user.hubId, deviceId: user.deviceId,
      lineCount: Array.isArray(payload.lines) ? payload.lines.length : 0 };
    const started = Date.now();
    this.logger.log({ event: 'transfer.start', ...context });
    try {
    const clientSaleId = String(payload.clientSaleId || '').trim();
    if (!clientSaleId) throw new BadRequestException('clientSaleId is required');
    if (!user.deviceId || (payload.deviceId && payload.deviceId !== user.deviceId)) throw new ForbiddenException('Session is scoped to another till');
    if ((payload.hubId || payload.storeId || user.hubId) !== user.hubId) throw new ForbiddenException('This till is bound to another location');
    stage = 'authorization';
    await this.scope(user, { hub: user.hubId, cashier: user.sub });
    stage = 'existing_payment';
    const existing = await this.transfers.findOne({ client_sale_id: clientSaleId });
    if (existing) { await this.scope(user, existing); return this.view(existing, user); }
    stage = 'rollout_preflight';
    if (process.env.POS_PAYMENT_RESERVATIONS_ENABLED !== 'true' || !await this.rolloutReady()) throw new ServiceUnavailableException('Reserved payments are not ready. Run the inventory reservation preflight and backfill first.');
    const providerId: PaymentProviderId = payload.provider || 'bachs';
    stage = 'provider_configuration';
    const provider = this.provider(providerId);
    const identity = await this.buyerIdentity(payload, user);
    stage = 'quote';
    await this.pos.quoteSale(user, payload);
    stage = 'reservation';
    let row: any;
    try {
      row = await this.pos.inventoryTransaction(async () => {
        const reservation = await this.pos.reservePayment(user, payload);
        const [created] = await this.transfers.create([{
          client_sale_id: clientSaleId, provider: providerId, hub: new Types.ObjectId(user.hubId), device_id: user.deviceId,
          cashier: new Types.ObjectId(user.sub), cashier_name: payload.cashierName, status: 'initializing',
          cart_total_kobo: reservation.snapshot.total, payable_kobo: reservation.snapshot.total, currency: 'NGN',
          reservation_state: 'held', allocations: reservation.allocations, priced_snapshot: reservation.snapshot,
          sale_payload: { ...payload, hubId: user.hubId, deviceId: user.deviceId, total: reservation.snapshot.total },
        }]);
        return created;
      });
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      const duplicate = await this.transfers.findOne({ client_sale_id: clientSaleId });
      if (!duplicate) throw error;
      await this.scope(user, duplicate); return this.view(duplicate, user);
    }
    try {
      // Never hold a MongoDB transaction open across a provider network call.
      stage = 'provider_open';
      this.logger.log({ event: 'transfer.provider_open', ...context, amountKobo: row.cart_total_kobo });
      const opened = await provider.open({ clientSaleId, amountKobo: row.cart_total_kobo, hubId: user.hubId, deviceId: user.deviceId!, email: identity.email, name: identity.name });
      if (opened.currency !== 'NGN' || !Number.isSafeInteger(opened.payableKobo) || opened.payableKobo < row.cart_total_kobo) throw new ProviderFailure('Provider returned invalid amount or currency; reconcile this payment.', false);
      stage = 'save_instructions';
      const updated = await this.pos.inventoryTransaction(async () => {
        const current = await this.lock(clientSaleId);
        current.checkout_id = opened.checkoutId;
        current.bank_name = opened.bankName; current.account_name = opened.accountName;
        current.account_number = opened.accountNumber; current.payable_kobo = opened.payableKobo;
        current.fee_kobo = opened.payableKobo - current.cart_total_kobo;
        current.expires_at = opened.expiresAt ? new Date(opened.expiresAt) : undefined;
        if (current.status === 'initializing') current.status = 'awaiting';
        await current.save(); return current;
      });
      // A webhook can arrive before the account-creation response. Replay it after
      // the expected amount is known, retaining cancelled transactions for review.
      stage = 'reconcile';
      this.logger.log({ event: 'transfer.ready', ...context, elapsedMs: Date.now() - started });
      for (const pending of updated.reconciliation_events || []) await this.applyEvidence(clientSaleId, pending);
      return this.view(await this.transfers.findById(row._id), user);
    } catch (error) {
      const definite = error instanceof ProviderFailure && error.definite;
      this.logger.warn({ event: 'transfer.provider_failed', ...context, stage,
        exception: error instanceof Error ? error.constructor.name : 'UnknownError',
        reason: paymentLogText(error instanceof Error ? error.message : 'Unknown failure'),
        definite, elapsedMs: Date.now() - started });
      const cashierReason = context.provider === 'bachs'
        ? (definite && error instanceof Error ? error.message : TRANSFER_NEEDS_REVIEW)
        : (error instanceof Error ? error.message : 'Provider result unknown');
      await this.pos.inventoryTransaction(async () => {
        const current = await this.lock(row.client_sale_id);
        if (current.status !== 'initializing') return;
        if (definite) {
          await this.pos.releasePayment(current.allocations); current.reservation_state = 'released'; current.status = 'cancelled';
        } else current.status = 'review';
        current.reconciliation_reason = cashierReason;
        await current.save();
      });
      if (context.provider === 'bachs' && definite) throw new BadRequestException(cashierReason);
      return this.view(await this.transfers.findById(row._id), user);
    }
    } catch (error) {
      this.logger.warn({ event: 'transfer.rejected', ...context, stage,
        exception: error instanceof Error ? error.constructor.name : 'UnknownError',
        httpStatus: error instanceof HttpException ? error.getStatus() : 500,
        reason: paymentLogText(error instanceof Error ? error.message : 'Unknown failure'),
        elapsedMs: Date.now() - started });
      throw error;
    }
  }

  private async lock(clientSaleId: string) {
    const row = await this.transfers.findOneAndUpdate({ client_sale_id: clientSaleId }, { $inc: { __v: 1 } }, { new: true });
    if (!row) throw new NotFoundException('Transfer not found');
    return row;
  }

  async list(user: PosJwtPayload, _deviceId?: string) {
    await this.scope(user, { hub: user.hubId, cashier: user.sub });
    const filter: any = { hub: user.hubId, status: { $in: UNRESOLVED } };
    if (user.role !== 'manager') filter.cashier = user.sub;
    else { delete filter.status; filter.$or = [{ status: { $in: UNRESOLVED } }, { status: 'cancelled', 'reconciliation_events.0': { $exists: true } }]; }
    const rows = await this.transfers.find(filter).sort({ createdAt: -1 });
    return { data: await Promise.all(rows.map(row => this.view(row, user))) };
  }

  async status(user: PosJwtPayload, clientSaleId: string, refresh: boolean) {
    const row = await this.transfers.findOne({ client_sale_id: clientSaleId });
    if (!row) throw new NotFoundException('Transfer not found');
    await this.scope(user, row);
    if (refresh && UNRESOLVED.includes(row.status) && row.checkout_id) await this.applyEvidence(row.client_sale_id, await this.provider(row.provider || 'bachs').check(row.checkout_id, row.payable_kobo));
    return this.view(await this.transfers.findById(row._id), user);
  }

  async cancel(user: PosJwtPayload, clientSaleId: string) {
    return this.pos.inventoryTransaction(async () => {
      const row = await this.lock(clientSaleId); await this.scope(user, row);
      if (row.status === 'paid') throw new ConflictException('Payment already confirmed; this transfer cannot be cancelled');
      if (row.status !== 'cancelled') {
        if (row.reservation_state === 'held') await this.pos.releasePayment(row.allocations);
        row.status = 'cancelled'; row.reservation_state = 'released'; await row.save();
      }
      return this.view(row, user);
    });
  }

  async confirmReceived(user: PosJwtPayload, clientSaleId: string) {
    return this.pos.inventoryTransaction(async () => {
      const row = await this.lock(clientSaleId); await this.scope(user, row);
      const hub = await this.hubs.findById(user.hubId).lean();
      if (hub?.pos_manual_payment_confirmation !== true) throw new ForbiddenException('Manual payment confirmation is disabled at this location');
      if (row.status === 'paid') return this.view(row, user);
      if (!UNRESOLVED.includes(row.status) || !row.checkout_id || row.reservation_state !== 'held') throw new ConflictException('This payment needs reconciliation before it can be confirmed');
      await this.complete(row, 'manual', user.sub, row.payable_kobo);
      return this.view(row, user);
    });
  }

  private async complete(row: any, source: string, actor: string, amount: number, eventId?: string) {
    if (row.reservation_state !== 'held' || !row.priced_snapshot) throw new ConflictException('Reconcile the stock reservation before completing this payment');
    await this.pos.releasePayment(row.allocations);
    await this.pos.createSale({ sub: String(row.cashier), role: 'cashier', hubId: String(row.hub), deviceId: row.device_id }, {
      ...row.sale_payload, clientSaleId: row.client_sale_id, hubId: String(row.hub), deviceId: row.device_id,
      total: row.cart_total_kobo, payments: [{ method: 'Transfer', amount: row.cart_total_kobo, reference: row.checkout_id }],
    }, row.priced_snapshot);
    row.status = 'paid'; row.reservation_state = 'consumed'; row.paid_at = new Date();
    row.confirmation_source = source; row.confirmed_by = actor; row.confirmed_at = new Date(); row.confirmed_amount_kobo = amount;
    if (eventId) row.event_ids.addToSet(eventId);
    await row.save();
  }

  private async applyEvidence(clientSaleId: string, evidence: PaymentEvidence) {
    await this.pos.inventoryTransaction(async () => {
      const row = await this.lock(clientSaleId);
      if (row.event_ids?.includes(evidence.eventId) || row.status === 'paid') return;
      const referenceMatches = evidence.reference === row.checkout_id || evidence.reference === row.client_sale_id;
      const valid = referenceMatches && evidence.currency === row.currency && Number.isSafeInteger(evidence.amountKobo) && evidence.amountKobo! >= row.payable_kobo;
      if (evidence.status === 'paid' && valid && UNRESOLVED.includes(row.status) && row.reservation_state === 'held' && row.checkout_id) {
        await this.complete(row, 'provider', String(row.cashier), evidence.amountKobo!, evidence.eventId); return;
      }
      if (evidence.status === 'expired' && UNRESOLVED.includes(row.status)) row.status = 'expired';
      if (evidence.status === 'paid' || evidence.status === 'review') {
        row.reconciliation_reason = row.status === 'cancelled' ? 'Payment received after cancellation; stock was released' : 'Provider evidence needs amount, currency, reference or reservation reconciliation';
        row.reconciliation_events.push({ ...evidence, receivedAt: new Date() });
        if (row.status !== 'cancelled' && row.status !== 'initializing') row.status = 'review';
      }
      if (row.checkout_id && !evidence.eventId.startsWith('poll:') && evidence.status !== 'awaiting') row.event_ids.addToSet(evidence.eventId);
      await row.save();
    });
  }

  async handleWebhook(raw: string, headers: Record<string, string | string[] | undefined>, providerId: PaymentProviderId = 'bachs') {
    let evidence: PaymentEvidence | null;
    try { evidence = this.provider(providerId).webhook(raw, headers); }
    catch { throw new BadRequestException('Invalid payment webhook'); }
    if (!evidence) return { received: true };
    const providerFilter = providerId === 'bachs' ? { $or: [{ provider: 'bachs' }, { provider: { $exists: false } }] } : { provider: providerId };
    const row = await this.transfers.findOne({ $and: [providerFilter, { $or: [{ checkout_id: evidence.reference }, { client_sale_id: evidence.reference }] }] });
    if (row) {
      if (providerId === 'squad' && evidence.status === 'paid') {
        // DVA v2 signs reference and amount but not status. Cross-check status.
        const checked = await this.provider('squad').check(evidence.reference, row.payable_kobo);
        if (checked.status !== 'paid') evidence = { ...evidence, status: 'review' };
      }
      await this.applyEvidence(row.client_sale_id, evidence);
    }
    return { received: true };
  }
}
