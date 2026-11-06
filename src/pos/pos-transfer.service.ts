import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { PspAuditService } from './psp-audit.service';
import type { WebhookTrace } from './psp-audit';
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
    @Inject('PSP_AUDIT') private readonly audit?: PspAuditService,
  ) {}

  private provider(id: PaymentProviderId, row?: any): PaymentProvider {
    if (!this.audit) throw new ServiceUnavailableException('Payment audit storage is unavailable');
    const audit = this.audit.http({ provider_id: id, account_key: id, ...(row ? {
      location_id: String(row.hub), device_id: row.device_id, cashier_id: String(row.cashier),
      merchant_reference: row.client_sale_id, checkout_id: row.checkout_id, amount_kobo: row.cart_total_kobo,
    } : {}) });
    if (id === 'squad' && process.env.SQUAD_DVA_APPROVED === 'true' && process.env.SQUAD_CONTRACT_VERIFIED === 'true' && process.env.SQUAD_SECRET_KEY) return new SquadClient(process.env.SQUAD_SECRET_KEY, undefined, audit);
    if (id === 'bachs' && process.env.BACHS_API_KEY) return new BachsProvider(process.env.BACHS_API_KEY, process.env.BACHS_WEBHOOK_SECRET || '', audit);
    throw new ServiceUnavailableException('This payment provider is not available');
  }

  async options(user: PosJwtPayload) {
    await this.scope(user, { hub: user.hubId, cashier: user.sub });
    const hub = await this.hubs.findById(user.hubId).lean();
    const providers: Array<{ id: PaymentProviderId; name: string }> = [];
    if (process.env.POS_PAYMENT_RESERVATIONS_ENABLED === 'true' && await this.rolloutReady()) {
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
      canCancel: Boolean(user && unresolved), confirmationSource: row.confirmation_source || null,
      confirmedAt: row.confirmed_at ? new Date(row.confirmed_at).toISOString() : null };
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
    const clientSaleId = String(payload.clientSaleId || '').trim();
    if (!clientSaleId) throw new BadRequestException('clientSaleId is required');
    if (!user.deviceId || (payload.deviceId && payload.deviceId !== user.deviceId)) throw new ForbiddenException('Session is scoped to another till');
    await this.scope(user, { hub: user.hubId, cashier: user.sub });
    const existing = await this.transfers.findOne({ client_sale_id: clientSaleId });
    if (existing) { await this.scope(user, existing); return this.view(existing, user); }
    throw new ConflictException('Use the customer checkout flow to start a new payment');
  }

  private async lock(clientSaleId: string) {
    const row = await this.transfers.findOneAndUpdate({ client_sale_id: clientSaleId }, { $inc: { __v: 1 } }, { returnDocument: 'after' });
    if (!row) throw new NotFoundException('Transfer not found');
    return row;
  }

  async list(user: PosJwtPayload, _deviceId?: string, includePaid = false) {
    await this.scope(user, { hub: user.hubId, cashier: user.sub });
    const filter: any = { hub: user.hubId, status: { $in: UNRESOLVED } };
    if (user.role !== 'manager') filter.cashier = user.sub;
    else { delete filter.status; filter.$or = [{ status: { $in: UNRESOLVED } }, { status: 'cancelled', 'reconciliation_events.0': { $exists: true } }]; }
    // Receipt recovery is limited to the authenticated till, never a caller-supplied device.
    if (includePaid && user.deviceId) {
      const pending = filter.$or || [{ status: filter.status }];
      delete filter.status;
      filter.$or = [...pending, { status: 'paid', device_id: user.deviceId }];
    }
    const rows = await this.transfers.find(filter).sort({ createdAt: -1 });
    return { data: await Promise.all(rows.map(row => this.view(row, user))) };
  }

  async status(user: PosJwtPayload, clientSaleId: string, refresh: boolean) {
    const row = await this.transfers.findOne({ client_sale_id: clientSaleId });
    if (!row) throw new NotFoundException('Transfer not found');
    await this.scope(user, row);
    if (refresh && UNRESOLVED.includes(row.status) && row.checkout_id) await this.applyEvidence(row.client_sale_id, await this.provider(row.provider || 'bachs', row).check(row.checkout_id, row.payable_kobo));
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

  async handleWebhook(raw: string, headers: Record<string, string | string[] | undefined>, providerId: PaymentProviderId = 'bachs', trace?: WebhookTrace) {
    let evidence: PaymentEvidence | null;
    try { evidence = this.provider(providerId).webhook(raw, headers); }
    catch { trace?.rejected('invalid_signature_or_payload'); throw new BadRequestException('Invalid payment webhook'); }
    trace?.verified(evidence);
    if (!evidence) return { received: true };
    const providerFilter = providerId === 'bachs' ? { $or: [{ provider: 'bachs' }, { provider: { $exists: false } }] } : { provider: providerId };
    const row = await this.transfers.findOne({ $and: [providerFilter, { $or: [{ checkout_id: evidence.reference }, { client_sale_id: evidence.reference }] }] });
    if (row) {
      if (providerId === 'squad' && evidence.status === 'paid') {
        // DVA v2 signs reference and amount but not status. Cross-check status.
        const checked = await this.provider('squad', row).check(evidence.reference, row.payable_kobo);
        if (checked.status !== 'paid') evidence = { ...evidence, status: 'review' };
      }
      await this.applyEvidence(row.client_sale_id, evidence);
    }
    return { received: true };
  }
}
