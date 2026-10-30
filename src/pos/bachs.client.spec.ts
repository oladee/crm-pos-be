import { createServer, Server } from 'http';
import { Logger } from '@nestjs/common';
import { BachsClient } from './bachs.client';
import { TRANSFER_INSTRUCTIONS_MISSING, TRANSFER_STAFF_EMAIL_REQUIRED, TRANSFER_START_REJECTED } from './payment-provider';

describe('Bachs checkout through real HTTP', () => {
  let server: Server, client: BachsClient, requests: any[], warns: any[];
  let reply: (req: { method?: string; path: string }) => { httpStatus?: number; body: any };
  const open = (input: { email?: string; name?: string } = {}) => client.openBankTransfer({
    clientSaleId: 'sale-1', amountKobo: 10000, hubId: 'hub-1', deviceId: 'device-1',
    email: 'cashier@example.com', name: 'Ada', ...input,
  });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const path = req.url || '';
      requests.push({ method: req.method, path, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const next = reply({ method: req.method, path });
      res.writeHead(next.httpStatus || 200, { 'Content-Type': 'application/json', 'x-request-id': 'req-1' });
      res.end(JSON.stringify(next.body));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    client = new BachsClient('sk_sandbox_test', `http://127.0.0.1:${(server.address() as any).port}`);
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  beforeEach(() => {
    requests = []; warns = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: any) => { warns.push(message); });
    reply = ({ path }) => {
      if (path === '/v1/checkout-sessions') return { body: { checkout_id: 'chk_1' } };
      if (path.endsWith('/confirm')) return { body: { account_number: '0123456789', bank_name: 'Test Bank', account_name: 'Store', amount: '100.00', currency: 'NGN' } };
      return { body: { checkout_id: 'chk_1' } };
    };
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends customer identity and NGN base currency on create', async () => {
    await open();
    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/checkout-sessions',
      body: {
        ui_mode: 'custom',
        pricing: { base_currency: 'NGN', amount: '100.00' },
        customer: { email: 'cashier@example.com', name: 'Ada' },
        payment_method_types: ['NGN_BANK_TRANSFER'],
      },
    });
  });

  it('does not contact Bachs without an email', async () => {
    await expect(open({ email: '' })).rejects.toMatchObject({ definite: true, message: TRANSFER_STAFF_EMAIL_REQUIRED });
    expect(requests).toHaveLength(0);
  });

  it('keeps nested Bachs 400 details in logs and throws a cashier message', async () => {
    reply = () => ({ httpStatus: 400, body: { error: { message: 'pricing.amount is invalid', details: 'amount must be a string' }, code: 'invalid_request' } });
    await expect(open()).rejects.toMatchObject({ definite: true, message: TRANSFER_START_REJECTED });
    const failed = warns.find((row) => row?.event === 'bachs.response_failed');
    expect(failed).toMatchObject({ path: '/v1/checkout-sessions', httpStatus: 400, operation: 'create_checkout', env: 'sandbox' });
    expect(failed.providerError).toContain('pricing.amount is invalid');
    expect(failed.providerError).toContain('amount must be a string');
  });

  it('treats a 2xx response without a bank account as a definite cashier error', async () => {
    reply = ({ path }) => path === '/v1/checkout-sessions'
      ? { body: { checkout_id: 'chk_1' } }
      : { body: { checkout_id: 'chk_1', status: 'requires_payment_method' } };
    await expect(open()).rejects.toMatchObject({ definite: true, message: TRANSFER_INSTRUCTIONS_MISSING });
    expect(warns.find((row) => row?.event === 'bachs.instructions_missing')).toMatchObject({
      operation: 'confirm_checkout', hasCheckoutId: true, hasAccountNumber: false,
    });
  });

  it('does not treat a 503 as a definite rejection', async () => {
    reply = () => ({ httpStatus: 503, body: { message: 'upstream unavailable' } });
    await expect(open()).rejects.toMatchObject({ definite: false, message: TRANSFER_START_REJECTED });
    expect(warns.find((row) => row?.event === 'bachs.response_failed').providerError).toContain('upstream unavailable');
  });
});
