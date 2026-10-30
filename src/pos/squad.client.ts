import { createHmac, timingSafeEqual } from 'crypto';
import { PaymentEvidence, PaymentProvider, ProviderFailure, TRANSFER_STAFF_EMAIL_REQUIRED, TransferInstructions } from './payment-provider';
import { nairaToKobo } from './bachs.client';

// DVA v2 contract: https://squadinc.gitbook.io/virtual-accounts/reference/dynamic-virtual-account-v2
// Activation requires explicit merchant profiling and contract verification.
export class SquadClient implements PaymentProvider {
  constructor(private readonly key: string, private readonly baseUrl = key.startsWith('sandbox_')
    ? 'https://sandbox-api-d.squadco.com' : 'https://api-d.squadco.com') {}

  private async request(path: string, body?: unknown): Promise<any> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch { throw new ProviderFailure('Squad response is unknown. Stock remains held; check this payment before trying again.', false); }
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.success) {
      // Timeouts, server errors and duplicate-reference responses do not prove failure.
      throw new ProviderFailure('Squad could not create or retrieve this transfer.', [400, 401, 403, 404, 422].includes(response.status));
    }
    return result.data;
  }

  async open(input: { clientSaleId: string; amountKobo: number; email?: string }): Promise<TransferInstructions> {
    if (!input.email) throw new ProviderFailure(TRANSFER_STAFF_EMAIL_REQUIRED, true);
    const data = await this.request('/virtual-account/initiate-dynamic-virtual-account', {
      amount: input.amountKobo, duration: 7200, email: input.email,
      transaction_ref: input.clientSaleId, pass_charge: true,
    });
    const payableKobo = nairaToKobo(data.expected_amount);
    if (data.transaction_reference !== input.clientSaleId || data.currency !== 'NGN'
      || !data.account_number || !Number.isSafeInteger(payableKobo) || payableKobo < input.amountKobo) {
      throw new ProviderFailure('Squad returned incomplete payment or fee details. Stock remains held for reconciliation.', false);
    }
    return { checkoutId: data.transaction_reference, bankName: data.bank, accountName: data.account_name,
      accountNumber: data.account_number, payableKobo, currency: data.currency, expiresAt: data.expires_at };
  }

  async check(reference: string): Promise<PaymentEvidence> {
    const data = await this.request(`/virtual-account/get-dynamic-virtual-account-transactions/${encodeURIComponent(reference)}`);
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    const success = rows.find((row: any) => row.transaction_status === 'SUCCESS' && (row.merchant_reference || row.transaction_reference) === reference);
    if (success) {
      // Some DVA query responses omit amount/currency. Never infer receipt from status alone.
      return { reference, eventId: `poll:${reference}`, status: 'paid',
        amountKobo: success.amount_received == null ? undefined : nairaToKobo(success.amount_received),
        currency: success.currency };
    }
    return { reference, eventId: `poll:${reference}`, status: rows.some((r: any) => r.transaction_status === 'EXPIRED') ? 'expired' : 'awaiting' };
  }

  webhook(raw: string, headers: Record<string, string | string[] | undefined>): PaymentEvidence | null {
    const body = JSON.parse(raw);
    const signature = headers['x-squad-encrypted-body'];
    const signed = JSON.stringify({ transaction_reference: body.transaction_reference,
      amount_received: body.amount_received, merchant_reference: body.merchant_reference });
    const expected = createHmac('sha512', this.key).update(signed).digest();
    if (typeof signature !== 'string' || !/^[a-f0-9]{128}$/i.test(signature)
      || !timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Error('Invalid Squad webhook signature');
    if (!body.merchant_reference || !body.transaction_reference) return null;
    return { reference: body.merchant_reference, eventId: body.transaction_reference,
      status: body.transaction_status === 'SUCCESS' ? 'paid' : 'review',
      amountKobo: nairaToKobo(body.amount_received),
      // DVA is NGN-only; the signed v2 payload does not contain a currency field.
      currency: body.currency || 'NGN' };
  }
}
