import { createServer, Server } from 'http';
import { createHmac } from 'crypto';
import { SquadClient } from './squad.client';
import { ProviderFailure, TRANSFER_STAFF_EMAIL_REQUIRED } from './payment-provider';

describe('Squad DVA contract through real HTTP', () => {
  let server: Server, client: SquadClient, requests: any[];
  let reply: any;
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.writeHead(reply.httpStatus || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    client = new SquadClient('sandbox_test_secret', `http://127.0.0.1:${(server.address() as any).port}`);
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  beforeEach(() => { requests = []; reply = { body: { success: true, data: { transaction_reference: 'sale-1', expected_amount: '102.50', currency: 'NGN', bank: 'GTBank', account_name: 'Store', account_number: '0123456789' } } }; });
  it('passes charges to the customer, sends kobo, and uses the provider expected amount', async () => {
    const result = await client.open({ clientSaleId: 'sale-1', amountKobo: 10000, email: 'buyer@example.com' });
    expect(result.payableKobo).toBe(10250);
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/virtual-account/initiate-dynamic-virtual-account', authorization: 'Bearer sandbox_test_secret', body: { amount: 10000, pass_charge: true, email: 'buyer@example.com', transaction_ref: 'sale-1' } });
  });
  it('requires email before contacting the provider', async () => {
    await expect(client.open({ clientSaleId: 'sale-1', amountKobo: 10000 })).rejects.toMatchObject({ definite: true, message: TRANSFER_STAFF_EMAIL_REQUIRED });
    expect(requests).toHaveLength(0);
  });
  it.each([{ expected_amount: undefined }, { currency: 'USD' }, { transaction_reference: 'other-sale' }, { expected_amount: '1.00' }])('retains stock for an incomplete or inconsistent provider response: %j', async change => {
    Object.assign(reply.body.data, change);
    await expect(client.open({ clientSaleId: 'sale-1', amountKobo: 10000, email: 'buyer@example.com' })).rejects.toMatchObject({ definite: false });
  });
  it('distinguishes definitive rejection from an ambiguous server failure', async () => {
    reply = { httpStatus: 403, body: { success: false } };
    await expect(client.open({ clientSaleId: 'sale-1', amountKobo: 10000, email: 'buyer@example.com' })).rejects.toMatchObject({ definite: true });
    reply.httpStatus = 503;
    await expect(client.open({ clientSaleId: 'sale-1', amountKobo: 10000, email: 'buyer@example.com' })).rejects.toMatchObject({ definite: false });
  });
  it('never fabricates amount or currency when a status query omits them', async () => {
    reply.body.data = { rows: [{ transaction_status: 'SUCCESS', transaction_reference: 'sale-1' }] };
    expect(await client.check('sale-1')).toMatchObject({ status: 'paid', amountKobo: undefined, currency: undefined });
  });
  it('validates the documented DVA signature and rejects tampering', () => {
    const body = { transaction_reference: 'event-1', amount_received: '102.50', merchant_reference: 'sale-1', transaction_status: 'SUCCESS' };
    const signature = createHmac('sha512', 'sandbox_test_secret').update(JSON.stringify({ transaction_reference: body.transaction_reference, amount_received: body.amount_received, merchant_reference: body.merchant_reference })).digest('hex');
    expect(client.webhook(JSON.stringify(body), { 'x-squad-encrypted-body': signature })).toMatchObject({ reference: 'sale-1', amountKobo: 10250, currency: 'NGN' });
    expect(() => client.webhook(JSON.stringify({ ...body, amount_received: '1.00' }), { 'x-squad-encrypted-body': signature })).toThrow(/signature/);
    expect(() => client.webhook(JSON.stringify(body), {})).toThrow(/signature/);
  });
});
