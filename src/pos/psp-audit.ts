import { createHash, randomUUID } from 'crypto';
import { ProviderFailure } from './payment-provider';

export type AuditContext = {
  provider_id: 'moniepoint' | 'squad' | 'bachs'; account_key: string;
  location_id?: string; device_id?: string; cashier_id?: string; checkout_id?: string;
  attempt_id?: string; merchant_reference?: string; provider_transaction_id?: string; correlation_id?: string;
  terminal_serial?: string; business_id?: string; business_owner_id?: string; amount_kobo?: number;
};
export type AuditWriter = (record: Record<string, unknown>) => Promise<void>;
export type AuditHttp = { context: AuditContext; write: AuditWriter };
export type WebhookTrace = { correlationId?: string; verified: (evidence?: Record<string, any> | null) => void; rejected: (reason: string) => void };
export const bodyHash = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
const normalize = (key: string) => key.replace(/[^a-z0-9]/gi, '').toLowerCase();
const sensitive = /authorization|cookie|signature|encryptedbody|secret|password|token|apikey|card|pan$|cvv|cvc|pin|track|cryptogram|email|phone|address|customer|payer|sender|beneficiary|accountname|fullname/i;
const allowed = new Set(('id eventId eventType type data result response rows transactions transaction pricing metadata errors error code responseCode status success currency amount requestedAmount requestAmount actualAmount amountReceived paidAmount payableAmount expectedAmount amountPaid fee charges providerFee baseCurrency terminalSerial businessId businessOwnerId merchantId merchantCode providerId merchantReference merchant_reference transactionReference transaction_ref reference checkoutId checkout_id processingStatus transactionStatus transactionType paymentMethod requestPaymentMethod actualPaymentMethod transaction_status duration expiresAt expires_in_minutes expiresAt timestamp bank bankName accountNumber account_number passCharge').split(' ').map(normalize));

export function scrubText(value: string) {
  return value.replace(/\bBearer\s+\S+/gi, '[REDACTED]').replace(/\b(?:sk_(?:live|sandbox|test)_|sandbox_)[\w-]+/gi, '[REDACTED]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[REDACTED]').slice(0, 300);
}

/** Explicit financial-field allowlist: never persist arbitrary provider/customer objects. */
export function sanitizePspPayload(value: unknown, depth = 0): any {
  if (depth > 10) return '[DEPTH_LIMIT]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizePspPayload(item, depth + 1));
  if (typeof value !== 'object') return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    const field = normalize(key);
    if (sensitive.test(field)) { output[key] = '[REDACTED]'; continue; }
    if (!allowed.has(field)) continue;
    if (field === 'accountnumber') { output[key] = typeof item === 'string' ? '****' + item.slice(-4) : '[REDACTED]'; continue; }
    // Error text is free-form and can contain customer/card data. Keep structured codes only.
    if ((field === 'error' || field === 'errors') && typeof item === 'string') continue;
    output[key] = sanitizePspPayload(item, depth + 1);
  }
  return output;
}

export function auditBody(raw: string | Buffer) {
  let payload: unknown, payload_format = 'json';
  try { payload = sanitizePspPayload(JSON.parse(raw.toString())); } catch { payload = {}; payload_format = 'non_json'; }
  if (JSON.stringify(payload).length > 65536) { payload = {}; payload_format = 'sanitized_size_limit'; }
  return { payload, payload_format, body_sha256: bodyHash(raw), body_bytes: Buffer.byteLength(raw) };
}

/** Persist intent before I/O; append the outcome without altering the provider response. */
export async function auditedPspFetch(url: string, init: RequestInit, audit?: AuditHttp): Promise<Response> {
  if (!audit) return fetch(url, init); // Standalone provider unit tests; production factories always supply it.
  const exchange_id = randomUUID(), started = Date.now(), endpoint = new URL(url);
  const common = { ...audit.context, exchange_id, direction: 'outbound', method: init.method || 'GET',
    endpoint: endpoint.origin + endpoint.pathname, operation: init.method === 'GET' ? 'status_lookup' : 'payment_request' };
  try { await audit.write({ ...common, stage: 'request_intent', ...auditBody(typeof init.body === 'string' ? init.body : '') }); }
  catch { throw new ProviderFailure('Payment audit storage is unavailable. No provider request was sent.', true); }
  let response: Response;
  try { response = await fetch(url, init); }
  catch (error) {
    try { await audit.write({ ...common, stage: 'transport_error', elapsed_ms: Date.now() - started,
      error_code: error instanceof Error && ['TimeoutError', 'AbortError', 'TypeError'].includes(error.name) ? error.name : 'TransportError' }); }
    catch { /* The durable intent remains unresolved; never pretend the provider failed definitively. */ }
    throw error;
  }
  try {
    const raw = Buffer.from(await response.clone().arrayBuffer());
    let parsed: any; try { parsed = JSON.parse(raw.toString('utf8')); } catch { /* A malformed response is still audited by hash and size. */ }
    const data = parsed?.data || parsed;
    await audit.write({ ...common, stage: 'http_response', elapsed_ms: Date.now() - started, http_status: response.status,
      provider_request_id: scrubText(response.headers.get('x-request-id') || response.headers.get('request-id') || ''),
      provider_transaction_id: data?.transactionReference || data?.transaction_reference || audit.context.provider_transaction_id,
      ...auditBody(raw) });
  } catch { throw new ProviderFailure('Provider response could not be audited. The payment result is unknown; check the original request.', false); }
  return response;
}
