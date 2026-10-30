import { BachsClient, isPaidStatus, nairaToKobo, readTransferInstructions } from './bachs.client';
import { verifyBachsSignature } from './bachs-signature';
import { PaymentEvidence, PaymentProvider } from './payment-provider';
export class BachsProvider implements PaymentProvider {
  constructor(private readonly key: string, private readonly secret: string) {}
  open(input: { clientSaleId: string; amountKobo: number; hubId: string; deviceId: string; email?: string; name?: string }) {
    return new BachsClient(this.key).openBankTransfer(input);
  }
  async check(reference: string): Promise<PaymentEvidence> {
    const result = await new BachsClient(this.key).getCheckout(reference);
    const data = (result.data || result) as Record<string, any>;
    const read = readTransferInstructions(result, 0);
    const amount = data.amount_received ?? data.paid_amount;
    return { reference: String(data.checkout_id || data.id || data.reference || ''), eventId: `poll:${reference}`,
      status: isPaidStatus(read.status) ? 'paid' : read.status.toLowerCase() === 'expired' ? 'expired' : 'awaiting',
      amountKobo: amount == null ? undefined : nairaToKobo(amount), currency: data.currency };
  }
  webhook(raw: string, headers: Record<string, string | string[] | undefined>): PaymentEvidence | null {
    if (!this.secret || !verifyBachsSignature(raw, headers, this.secret)) throw new Error('Invalid webhook signature');
    const event = JSON.parse(raw), data = event.data || {};
    const reference = String(data.checkout_id || data.reference || '');
    if (!event.id || !reference) return null;
    if (event.type === 'checkout.expired') return { reference, eventId: event.id, status: 'expired' };
    if (!['collection.succeeded', 'checkout.completed'].includes(event.type) || (data.status && !isPaidStatus(data.status))) return null;
    return { reference, eventId: String(event.id), status: 'paid', amountKobo: nairaToKobo(data.amount), currency: data.currency };
  }
}
