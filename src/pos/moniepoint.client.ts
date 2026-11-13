import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { ProviderFailure } from './payment-provider';
import { MoniepointAccount, settingMilliseconds } from './checkout-config';
import { auditedPspFetch, type AuditHttp } from './psp-audit';

export type TerminalEvidence = {
  reference: string; transactionReference?: string; eventId: string;
  status: 'paid' | 'failed' | 'pending' | 'review'; amountKobo?: number;
  businessId?: string; businessOwnerId?: string; terminalSerial?: string;
  method?: 'Card' | 'Transfer'; currency?: string; paidAt?: string;
};

function outcome(row: any, polling: boolean): TerminalEvidence['status'] {
  const state = String(polling ? row.processingStatus : row.transactionStatus).toUpperCase();
  const code = String(row.responseCode || '');
  if ((polling ? state === 'PROCESSED' : ['COMPLETED', 'APPROVED'].includes(state)) && ['00', '20000'].includes(code)) return 'paid';
  if (['CANCELLED', 'FAILED', 'DECLINED'].includes(state)) return 'failed';
  return ['PENDING', 'PROCESSING', ''].includes(state) ? 'pending' : 'review';
}

function providerReference(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function verifiedPaidAt(row: any, polling: boolean) {
  const value = row.paidAt;
  return outcome(row, polling) === 'paid' && typeof value === 'string' &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : undefined;
}

export class MoniepointClient {
  private static readonly tokens = new Map<string, { token?: string; expiresAt: number; pending?: Promise<string> }>();
  constructor(private readonly account: MoniepointAccount, private readonly baseUrl: string, private readonly audit?: AuditHttp) {}

  private async bearer(): Promise<string> {
    const secret = process.env[this.account.apiKeyEnv] || '';
    if (!this.account.clientIdEnv) return secret;
    const clientId = process.env[this.account.clientIdEnv];
    if (!clientId || !secret) throw new ProviderFailure('Moniepoint client credentials are missing. No payment request was sent.', true);
    const key = createHash('sha256').update(JSON.stringify([this.baseUrl, clientId, secret])).digest('hex');
    const cached = MoniepointClient.tokens.get(key);
    if (cached?.pending) return cached.pending;
    if (cached?.token && cached.expiresAt > Date.now()) return cached.token;
    const entry: { token?: string; expiresAt: number; pending?: Promise<string> } = { expiresAt: 0 };
    entry.pending = (async () => {
      try {
        const audit = this.audit ? { context: this.audit.context, write: (row: Record<string, unknown>) => this.audit!.write({ ...row, operation: 'authentication' }) } : undefined;
        const response = await auditedPspFetch(`${this.baseUrl}/v1/auth`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
          body: JSON.stringify({ clientId, clientSecret: secret }),
          signal: AbortSignal.timeout(settingMilliseconds('MONIEPOINT_HTTP_TIMEOUT_MS', 10_000)),
        }, audit);
        const body = await response.json().catch(() => null);
        if (!response.ok || typeof body?.accessToken !== 'string' || !body.accessToken || /\s/.test(body.accessToken)
          || typeof body.expiresIn !== 'number' || !Number.isFinite(body.expiresIn) || body.expiresIn <= 0) throw new Error('Authentication failed');
        entry.token = body.accessToken;
        entry.expiresAt = Date.now() + Math.max(0, body.expiresIn * 1000 - Math.min(30_000, body.expiresIn * 100));
        return entry.token!;
      } catch {
        MoniepointClient.tokens.delete(key);
        // Authentication cannot create a charge: the payment HTTP request has not started.
        throw new ProviderFailure('Moniepoint authentication failed. No payment request was sent.', true);
      } finally { entry.pending = undefined; }
    })();
    if (MoniepointClient.tokens.size >= 128) MoniepointClient.tokens.delete(MoniepointClient.tokens.keys().next().value!);
    MoniepointClient.tokens.set(key, entry);
    return entry.pending;
  }

  private async request(path: string, body?: unknown) {
    const bearer = await this.bearer();
    let response: Response;
    try {
      response = await auditedPspFetch(`${this.baseUrl}${path}`, {
        method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, redirect: 'error',
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(settingMilliseconds('MONIEPOINT_HTTP_TIMEOUT_MS', 10_000)),
      }, this.audit);
    } catch (error) { if (error instanceof ProviderFailure) throw error; throw new ProviderFailure('Moniepoint result is unknown. Check the existing payment before retrying.', false); }
    const data = await response.json().catch(() => null);
    if (response.status === 401 && this.account.clientIdEnv) {
      for (const [key, entry] of MoniepointClient.tokens) if (entry.token === bearer) MoniepointClient.tokens.delete(key);
    }
    if (!response.ok) throw new ProviderFailure('Moniepoint could not accept or retrieve the payment.', [401, 403, 422].includes(response.status));
    return data;
  }

  async open(reference: string, terminalSerial: string, amountKobo: number) {
    const row = await this.request('/v1/transactions', { terminalSerial, amount: amountKobo, merchantReference: reference,
      transactionType: 'PURCHASE', paymentMethod: 'ANY' });
    return row?.merchantReference === reference ? providerReference(row.transactionReference) : undefined;
  }

  async check(reference: string): Promise<TerminalEvidence> {
    const row = await this.request(`/v1/transactions/merchants/${encodeURIComponent(reference)}`);
    if (!row || row.merchantReference !== reference) throw new ProviderFailure('Moniepoint returned an unrelated payment.', false);
    return { reference, eventId: `poll:${reference}`, status: outcome(row, true), transactionReference: providerReference(row.transactionReference),
      amountKobo: row.actualAmount, businessOwnerId: String(row.businessOwnerId ?? ''), terminalSerial: row.terminalSerial,
      method: row.actualPaymentMethod === 'CARD_PURCHASE' ? 'Card' : row.actualPaymentMethod === 'POS_TRANSFER' ? 'Transfer' : undefined,
      currency: row.currency || 'NGN', paidAt: verifiedPaidAt(row, true) };
  }

  webhook(raw: string, headers: Record<string, any>): TerminalEvidence | null {
    const id = headers['moniepoint-webhook-id'], timestamp = headers['moniepoint-webhook-timestamp'], signature = headers['moniepoint-webhook-signature'];
    const secret = process.env[this.account.webhookSecretEnv];
    if (!secret || typeof id !== 'string' || typeof timestamp !== 'string' || !/^\d+$/.test(timestamp) || typeof signature !== 'string') throw new Error('Invalid signature');
    const expected = createHmac('sha256', secret).update(`${id}__${timestamp}__${raw}`).digest();
    const actual = Buffer.from(signature, 'base64');
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw new Error('Invalid signature');
    const body = JSON.parse(raw), row = body.data;
    if (!['V1_POS_PURCHASE_TRANSACTION', 'V1_POS_TRANSFER_TRANSACTION'].includes(body.eventType)) return null;
    if (!row || String(row.businessId) !== this.account.businessId || String(row.businessOwnerId) !== this.account.businessOwnerId) throw new Error('Unexpected business');
    return { reference: String(row.merchantReference || ''), transactionReference: providerReference(row.transactionReference), eventId: id,
      status: outcome(row, false), amountKobo: row.amount, businessId: String(row.businessId), businessOwnerId: String(row.businessOwnerId),
      terminalSerial: row.terminalSerial, currency: row.currency || 'NGN', paidAt: verifiedPaidAt(row, false),
      method: body.eventType === 'V1_POS_PURCHASE_TRANSACTION' ? 'Card' : 'Transfer' };
  }
}
