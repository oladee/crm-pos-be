import { auditBody, auditedPspFetch, bodyHash, sanitizePspPayload } from './psp-audit';

describe('PSP audit sanitization and transport', () => {
  afterEach(() => jest.restoreAllMocks());

  it('retains financial evidence while removing credentials and personal/card data', () => {
    const result = sanitizePspPayload({ providerId: 'provider-1', merchantReference: 'order-1', data: {
      amount: 12345, fee: 100, currency: 'NGN', status: 'SUCCESS', account_number: '0123456789',
      apiKey: 'secret-value', authorization: 'Bearer abc', card: { number: '4111111111111111', cvv: '123' },
      customer: { name: 'Buyer', phone: '08012345678' }, other: 'unknown-secret', error: 'Unsafe error with PII',
    } });
    expect(result.providerId).toBe('provider-1'); expect(result.data.amount).toBe(12345);
    expect(result.data.account_number).toBe('****6789');
    const json = JSON.stringify(result);
    for (const secret of ['secret-value', 'Bearer abc', '4111111111111111', 'Buyer', '08012345678', 'unknown-secret', 'Unsafe error']) expect(json).not.toContain(secret);
  });

  it('hashes exact original bytes and identifies malformed responses without saving them', () => {
    const raw = 'not JSON and contains a password';
    expect(auditBody(raw)).toEqual({ payload: {}, payload_format: 'non_json', body_sha256: bodyHash(raw), body_bytes: Buffer.byteLength(raw) });
    expect(auditBody(' {"amount":1}').body_sha256).not.toBe(auditBody('{"amount":1}').body_sha256);
    const invalidUtf8 = Buffer.from([0xff, 0xfe]);
    expect(auditBody(invalidUtf8).body_sha256).toBe(bodyHash(invalidUtf8));
    expect(auditBody(invalidUtf8).body_bytes).toBe(2);
  });

  it('persists intent before HTTP and captures a non-success response without consuming its body', async () => {
    const records: any[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      expect(records[0].stage).toBe('request_intent');
      return new Response('{"data":{"transactionReference":"txn-1","amount":100},"secret":"no"}', { status: 503 });
    });
    const response = await auditedPspFetch('https://example.test/payment?apiKey=secret', { method: 'POST', body: '{"amount":100}' },
      { context: { provider_id: 'moniepoint', account_key: 'agege' }, write: async row => { records.push(row); } });
    expect(response.status).toBe(503); expect(await response.json()).toHaveProperty('data');
    expect(records[1].provider_transaction_id).toBe('txn-1'); expect(records[1].http_status).toBe(503);
    expect(records[0].endpoint).toBe('https://example.test/payment'); expect(records[1].exchange_id).toBe(records[0].exchange_id);
    expect(JSON.stringify(records)).not.toContain('apiKey=secret'); expect(JSON.stringify(records)).not.toContain('"secret":"no"');
  });

  it('sends no request if the initial durable write fails', async () => {
    const fetch = jest.spyOn(global, 'fetch');
    await expect(auditedPspFetch('https://example.test', {}, { context: { provider_id: 'squad', account_key: 'squad' },
      write: async () => { throw new Error('database offline'); } })).rejects.toMatchObject({ definite: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps an uncertain outcome when response auditing fails', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{"status":"success"}'));
    let count = 0;
    await expect(auditedPspFetch('https://example.test', {}, { context: { provider_id: 'squad', account_key: 'squad' },
      write: async () => { if (++count === 2) throw new Error('database offline'); } })).rejects.toMatchObject({ definite: false });
  });

  it('records network failure classes without copying unsafe error messages', async () => {
    const records: any[] = [];
    jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('secret-key and customer details'));
    await expect(auditedPspFetch('https://example.test', {}, { context: { provider_id: 'bachs', account_key: 'bachs' },
      write: async row => { records.push(row); } })).rejects.toBeInstanceOf(TypeError);
    expect(records[1]).toMatchObject({ stage: 'transport_error', error_code: 'TypeError' });
    expect(JSON.stringify(records)).not.toContain('secret-key');
  });
});
