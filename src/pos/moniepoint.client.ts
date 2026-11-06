import { createHmac, timingSafeEqual } from 'crypto';
import { ProviderFailure } from './payment-provider';
import { MoniepointAccount, settingMilliseconds } from './checkout-config';
import { auditedPspFetch, type AuditHttp } from './psp-audit';

export type TerminalEvidence = {
  reference: string; transactionReference?: string; eventId: string;
  status: 'paid' | 'failed' | 'pending' | 'review'; amountKobo?: number;
  businessId?: string; businessOwnerId?: string; terminalSerial?: string;
  method?: 'Card' | 'Transfer'; currency?: string;
};

function outcome(row: any, polling: boolean): TerminalEvidence['status'] {
  const state = String(polling ? row.processingStatus : row.transactionStatus).toUpperCase();
  const code = String(row.responseCode || '');
  if ((polling ? state === 'PROCESSED' : ['COMPLETED', 'APPROVED'].includes(state)) && ['00', '20000'].includes(code)) return 'paid';
  if (['CANCELLED', 'FAILED', 'DECLINED'].includes(state)) return 'failed';
  return ['PENDING', 'PROCESSING', ''].includes(state) ? 'pending' : 'review';
}

export class MoniepointClient {
  constructor(private readonly account: MoniepointAccount, private readonly baseUrl: string, private readonly audit?: AuditHttp) {}

  private async request(path: string, body?: unknown) {
    let response: Response;
    try {
      response = await auditedPspFetch(`${this.baseUrl}${path}`, {
        method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${process.env[this.account.apiKeyEnv] || ''}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(settingMilliseconds('MONIEPOINT_HTTP_TIMEOUT_MS', 10_000)),
      }, this.audit);
    } catch (error) { if (error instanceof ProviderFailure) throw error; throw new ProviderFailure('Moniepoint result is unknown. Check the existing payment before retrying.', false); }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new ProviderFailure('Moniepoint could not accept or retrieve the payment.', [401, 403, 422].includes(response.status));
    return data;
  }

  async open(reference: string, terminalSerial: string, amountKobo: number, method: 'card' | 'transfer') {
    await this.request('/v1/transactions', { terminalSerial, amount: amountKobo, merchantReference: reference,
      transactionType: 'PURCHASE', paymentMethod: method === 'card' ? 'CARD_PURCHASE' : 'POS_TRANSFER' });
  }

  async check(reference: string): Promise<TerminalEvidence> {
    const row = await this.request(`/v1/transactions/merchants/${encodeURIComponent(reference)}`);
    if (!row || row.merchantReference !== reference) throw new ProviderFailure('Moniepoint returned an unrelated payment.', false);
    return { reference, eventId: `poll:${reference}`, status: outcome(row, true), transactionReference: row.transactionReference || undefined,
      amountKobo: row.actualAmount, businessOwnerId: String(row.businessOwnerId ?? ''), terminalSerial: row.terminalSerial,
      method: row.actualPaymentMethod === 'CARD_PURCHASE' ? 'Card' : row.actualPaymentMethod === 'POS_TRANSFER' ? 'Transfer' : undefined,
      currency: row.currency || 'NGN' };
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
    return { reference: String(row.merchantReference || ''), transactionReference: row.transactionReference || undefined, eventId: id,
      status: outcome(row, false), amountKobo: row.amount, businessId: String(row.businessId), businessOwnerId: String(row.businessOwnerId),
      terminalSerial: row.terminalSerial, currency: row.currency || 'NGN',
      method: body.eventType === 'V1_POS_PURCHASE_TRANSACTION' ? 'Card' : 'Transfer' };
  }
}
