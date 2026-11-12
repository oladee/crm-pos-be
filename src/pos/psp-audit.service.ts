import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { auditBody, AuditContext, AuditHttp, bodyHash, sanitizePspPayload, scrubText, WebhookTrace } from './psp-audit';
import { checkoutConfiguration } from './checkout-config';

@Injectable()
export class PspAuditService {
  constructor(@InjectConnection() private readonly db: Connection) {}

  async append(input: Record<string, unknown>) {
    // Explicit metadata schema; no caller-supplied headers, errors or arbitrary objects.
    const fields = ['exchange_id', 'correlation_id', 'provider_id', 'account_key', 'location_id', 'device_id', 'cashier_id', 'checkout_id', 'attempt_id',
      'merchant_reference', 'provider_transaction_id', 'provider_request_id', 'terminal_serial', 'business_id', 'business_owner_id',
      'amount_kobo', 'direction', 'operation', 'stage', 'method', 'endpoint', 'event_type', 'delivery_id', 'verification_result',
      'outcome', 'http_status', 'elapsed_ms', 'error_code', 'body_sha256', 'body_bytes', 'payload_format'];
    const record: any = { event_id: randomUUID(), schema_version: 1, recorded_at: new Date() };
    for (const field of fields) if (input[field] != null && ['string', 'number', 'boolean'].includes(typeof input[field])) record[field] = typeof input[field] === 'string' ? scrubText(String(input[field])) : input[field];
    if (input.payload != null) record.payload = sanitizePspPayload(input.payload);
    record.record_sha256 = bodyHash(JSON.stringify(record));
    // Native collection keeps audit writes independent of application transaction rollback.
    await this.db.db!.collection('pos_psp_audit').insertOne(record, { writeConcern: { w: 'majority' } });
    return record.event_id as string;
  }

  http(context: AuditContext): AuditHttp { return { context, write: record => this.append(record).then(() => undefined) }; }

  private async scoped(provider: AuditContext['provider_id'], account: string, evidence: any): Promise<Partial<AuditContext>> {
    const reference = evidence?.reference;
    const attempt = reference ? await this.db.db!.collection('pos_payment_attempts').findOne({ provider, account_key: account, merchant_reference: reference }) : null;
    if (attempt) {
      const checkout = await this.db.db!.collection('pos_checkouts').findOne({ _id: attempt.checkout });
      if (checkout) return { location_id: String(checkout.hub), device_id: checkout.device_id, cashier_id: String(checkout.cashier),
        checkout_id: String(checkout._id), attempt_id: String(attempt._id), merchant_reference: attempt.merchant_reference,
        terminal_serial: attempt.terminal_serial, business_id: attempt.account_snapshot?.businessId,
        business_owner_id: attempt.account_snapshot?.businessOwnerId, amount_kobo: attempt.amount_kobo };
    }
    const providerFilter = provider === 'bachs' ? { $or: [{ provider: 'bachs' }, { provider: { $exists: false } }] } : { provider };
    const legacy = reference ? await this.db.db!.collection('pos_transfers').findOne({ $and: [providerFilter, { $or: [{ client_sale_id: reference }, { checkout_id: reference }] }] }) : null;
    if (legacy) return { location_id: String(legacy.hub), device_id: legacy.device_id, cashier_id: String(legacy.cashier), merchant_reference: legacy.client_sale_id, amount_kobo: legacy.cart_total_kobo };
    if (provider === 'moniepoint') {
      const mapping = Object.values(checkoutConfiguration().terminals).find(item => item.accountKey === account && item.terminalSerial === evidence?.terminalSerial);
      if (mapping) return { location_id: mapping.hubId, terminal_serial: mapping.terminalSerial, merchant_reference: reference };
    }
    return { merchant_reference: reference };
  }

  async webhook<T>(provider: AuditContext['provider_id'], account: string, raw: string | Buffer, headers: Record<string, any>, work: (trace: WebhookTrace) => Promise<T>) {
    const exchange_id = randomUUID(), started = Date.now();
    let eventType: unknown; try { const parsed = JSON.parse(raw.toString()); eventType = parsed.eventType || parsed.type; } catch { /* Retain malformed body hash only. */ }
    const common = { provider_id: provider, account_key: account, exchange_id, direction: 'inbound', operation: 'webhook', method: 'POST',
      delivery_id: typeof headers['moniepoint-webhook-id'] === 'string' ? headers['moniepoint-webhook-id'].slice(0, 160) : undefined,
      event_type: typeof eventType === 'string' ? eventType : undefined,
      ...auditBody(raw) };
    try { await this.append({ ...common, stage: 'webhook_received' }); }
    catch { throw new ServiceUnavailableException('Payment audit storage unavailable; webhook not acknowledged'); }
    let verification_result = 'unverified', evidence: any;
    const trace: WebhookTrace = { correlationId: exchange_id, verified: next => { verification_result = 'valid'; evidence = next; }, rejected: reason => { verification_result = reason; } };
    let result: T;
    try { result = await work(trace); }
    catch (error) {
      await this.append({ ...common, stage: 'webhook_result', verification_result, outcome: 'rejected',
        http_status: typeof error?.getStatus === 'function' ? error.getStatus() : 500, elapsed_ms: Date.now() - started,
        ...(verification_result === 'valid' ? await this.scoped(provider, account, evidence) : {}) });
      throw error;
    }
    try {
      await this.append({ ...common, stage: 'webhook_result', verification_result, outcome: evidence ? 'accepted' : 'ignored',
        http_status: 201, elapsed_ms: Date.now() - started, ...(await this.scoped(provider, account, evidence)),
        provider_transaction_id: evidence?.transactionReference || evidence?.eventId });
    } catch { throw new ServiceUnavailableException('Payment audit storage unavailable; webhook not acknowledged'); }
    return result;
  }

  async list(location: string, query: Record<string, string>) {
    const filter: any = { location_id: location };
    if (query.provider) { if (!['moniepoint', 'squad', 'bachs'].includes(query.provider)) throw new BadRequestException('Invalid provider'); filter.provider_id = query.provider; }
    if (query.reference) {
      if (typeof query.reference !== 'string' || query.reference.length > 160) throw new BadRequestException('Invalid reference');
      filter.$or = [{ merchant_reference: query.reference }, { provider_transaction_id: query.reference }, { exchange_id: query.reference }, { correlation_id: query.reference }];
    }
    if (query.before) { if (typeof query.before !== 'string' || !Types.ObjectId.isValid(query.before)) throw new BadRequestException('Invalid cursor'); filter._id = { $lt: new Types.ObjectId(query.before) }; }
    const rows = await this.db.db!.collection('pos_psp_audit').find(filter).sort({ _id: -1 }).limit(51).toArray();
    const page = rows.slice(0, 50);
    return { data: page, nextCursor: rows.length > 50 ? String(page[49]._id) : null };
  }
}
