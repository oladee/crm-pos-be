export type PaymentProviderId = 'bachs' | 'squad';
export type TransferInstructions = {
  checkoutId: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  payableKobo: number;
  currency: string;
  expiresAt?: string;
};
export type PaymentEvidence = {
  reference: string;
  eventId: string;
  status: 'paid' | 'expired' | 'awaiting' | 'review';
  amountKobo?: number;
  currency?: string;
};
export const TRANSFER_START_REJECTED = 'This bank transfer could not be started. Try again or use another payment method.';
export const TRANSFER_INSTRUCTIONS_MISSING = 'Bank account details were not returned. Try again or use another payment method.';
export const TRANSFER_NEEDS_REVIEW = 'This payment needs checking before you retry. Do not start a new transfer for the same sale.';

export class ProviderFailure extends Error {
  constructor(message: string, public readonly definite: boolean) { super(message); }
}
export interface PaymentProvider {
  open(input: { clientSaleId: string; amountKobo: number; hubId: string; deviceId: string; email?: string }): Promise<TransferInstructions>;
  check(reference: string, expectedKobo: number): Promise<PaymentEvidence>;
  webhook(raw: string, headers: Record<string, string | string[] | undefined>): PaymentEvidence | null;
}
