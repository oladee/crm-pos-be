import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { paymentLogError, paymentLogText, paymentLogValidationFields } from './payment-log';
import { ProviderFailure, TRANSFER_INSTRUCTIONS_MISSING, TRANSFER_STAFF_EMAIL_REQUIRED, TRANSFER_START_REJECTED } from './payment-provider';

export type BachsInstructions = {
  checkoutId: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  payableKobo: number;
  currency: string;
  expiresAt?: string;
  status: string;
};

type Json = Record<string, unknown>;

export function bachsBaseUrl(apiKey: string) {
  if (apiKey.startsWith('sk_live_')) return 'https://api.bachs.io';
  if (apiKey.startsWith('sk_sandbox_')) return 'https://sandbox-api.bachs.io';
  throw new ServiceUnavailableException('BACHS_API_KEY must start with sk_sandbox_ or sk_live_');
}

export function nairaToKobo(amount: string | number) {
  const naira = typeof amount === 'number' ? amount : Number(String(amount).replace(/,/g, ''));
  if (!Number.isFinite(naira)) return 0;
  return Math.round(naira * 100);
}

export function koboToNairaString(kobo: number) {
  return (Math.round(kobo) / 100).toFixed(2);
}

function walk(value: unknown, visit: (row: Json) => void) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visit));
    return;
  }
  const row = value as Json;
  visit(row);
  for (const nested of Object.values(row)) walk(nested, visit);
}

export function readTransferInstructions(payload: Json, fallbackKobo: number): Omit<BachsInstructions, 'checkoutId'> & { checkoutId?: string } {
  let accountNumber = '';
  let bankName = '';
  let accountName = '';
  let payableKobo = 0;
  let currency = 'NGN';
  let expiresAt = '';
  let status = '';
  let checkoutId = '';

  walk(payload, (row) => {
    const number = String(row.account_number || row.accountNumber || '');
    if (number && !accountNumber) accountNumber = number;
    const bank = String(row.bank_name || row.bankName || '');
    if (bank && !bankName) bankName = bank;
    const name = String(row.account_name || row.accountName || '');
    if (name && !accountName) accountName = name;
    const amount = row.amount ?? row.payable_amount;
    if (amount != null && !payableKobo) payableKobo = nairaToKobo(amount as string | number);
    if (row.currency && !currency) currency = String(row.currency);
    const exp = row.expires_at || row.expiresAt || row.quote_expires_at;
    if (exp && !expiresAt) expiresAt = String(exp);
    if (row.payment_status || row.status) status = String(row.payment_status || row.status);
    if (row.checkout_id && !checkoutId) checkoutId = String(row.checkout_id);
  });

  return {
    checkoutId: checkoutId || undefined,
    bankName,
    accountName,
    accountNumber,
    payableKobo: payableKobo || fallbackKobo,
    currency: currency || 'NGN',
    expiresAt: expiresAt || undefined,
    status,
  };
}

export function isPaidStatus(status: string) {
  return ['succeeded', 'success', 'paid', 'complete', 'completed'].includes(status.toLowerCase());
}

export class BachsClient {
  private readonly logger = new Logger(BachsClient.name);
  constructor(private readonly apiKey: string, private readonly origin = bachsBaseUrl(apiKey)) {}

  private async request(method: string, path: string, body?: Json, idempotencyKey?: string) {
    const started = Date.now();
    const operation = method === 'PATCH' ? 'select_payment_method' : path.endsWith('/confirm') ? 'confirm_checkout' : method === 'GET' ? 'get_checkout' : 'create_checkout';
    const pricing = body?.pricing && typeof body.pricing === 'object' ? body.pricing as Json : undefined;
    const context = {
      provider: 'bachs',
      operation,
      method,
      path,
      env: this.apiKey.startsWith('sk_live_') ? 'live' : 'sandbox',
      reference: paymentLogText(idempotencyKey || path.split('/')[3] || ''),
      ...(pricing?.amount != null ? { amountNaira: paymentLogText(pricing.amount as string | number) } : {}),
    };
    this.logger.log({ event: 'bachs.request', ...context });
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (body) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let res: Response;
    try {
      res = await fetch(`${this.origin}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      this.logger.warn({ event: 'bachs.network_failed', ...context, elapsedMs: Date.now() - started,
        errorType: error instanceof Error ? error.name : 'UnknownError' });
      throw new ProviderFailure(TRANSFER_START_REJECTED, false);
    }
    const json = (await res.json().catch(() => ({}))) as Json;
    const responseKeys = Object.keys(json).slice(0, 30).map(paymentLogText);
    const responseContext = { ...context, httpStatus: res.status, elapsedMs: Date.now() - started,
      providerRequestId: paymentLogText(res.headers.get('x-request-id') || res.headers.get('request-id') || ''),
      responseKeys, hasCheckoutId: Boolean(json.checkout_id || json.id) };
    if (!res.ok) {
      this.logger.warn({ event: 'bachs.response_failed', ...responseContext,
        providerError: paymentLogError(json),
        validationFields: paymentLogValidationFields(json.errors) });
      throw new ProviderFailure(TRANSFER_START_REJECTED, [400, 401, 403, 404, 422].includes(res.status));
    }
    this.logger.log({ event: 'bachs.response_ok', ...responseContext });
    return json;
  }

  async openBankTransfer(input: { clientSaleId: string; amountKobo: number; hubId: string; deviceId: string; email?: string; name?: string }) {
    const email = String(input.email || '').trim();
    const name = String(input.name || email).trim();
    if (!email) throw new ProviderFailure(TRANSFER_STAFF_EMAIL_REQUIRED, true);
    const created = await this.request('POST', '/v1/checkout-sessions', {
      ui_mode: 'custom',
      pricing: { base_currency: 'NGN', amount: koboToNairaString(input.amountKobo) },
      customer: { email, name },
      payment_method_types: ['NGN_BANK_TRANSFER'],
      reference: input.clientSaleId,
      expires_in_minutes: 120,
      metadata: { hubId: input.hubId, deviceId: input.deviceId, clientSaleId: input.clientSaleId },
    }, input.clientSaleId);
    const checkoutId = String(created.checkout_id || created.id || '');
    if (!checkoutId) {
      this.logger.warn({ event: 'bachs.instructions_missing', provider: 'bachs', operation: 'create_checkout',
        responseKeys: Object.keys(created).slice(0, 30).map(paymentLogText),
        hasCheckoutId: false, hasAccountNumber: false, hasBankName: false });
      throw new ProviderFailure(TRANSFER_INSTRUCTIONS_MISSING, true);
    }

    const priced = await this.request('PATCH', `/v1/checkout-sessions/${checkoutId}`, {
      payment_method: 'NGN_BANK_TRANSFER',
      currency: 'NGN',
      payment_rail: 'bank_transfer_ng',
    });
    const confirmed = await this.request('POST', `/v1/checkout-sessions/${checkoutId}/confirm`, {});
    const instructions = readTransferInstructions({ ...priced, ...confirmed }, input.amountKobo);
    if (!instructions.accountNumber) {
      this.logger.warn({ event: 'bachs.instructions_missing', provider: 'bachs', operation: 'confirm_checkout',
        responseKeys: Object.keys({ ...priced, ...confirmed }).slice(0, 30).map(paymentLogText),
        hasCheckoutId: true, hasAccountNumber: false, hasBankName: Boolean(instructions.bankName) });
      throw new ProviderFailure(TRANSFER_INSTRUCTIONS_MISSING, true);
    }
    return { ...instructions, checkoutId };
  }

  async getCheckout(checkoutId: string) {
    return this.request('GET', `/v1/checkout-sessions/${checkoutId}`);
  }
}
