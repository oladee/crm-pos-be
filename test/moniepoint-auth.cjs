const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { MoniepointClient } = require('../dist/pos/moniepoint.client');
const { checkoutConfiguration } = require('../dist/pos/checkout-config');

test('client authentication through HTTP: caching, refresh, audit redaction and safe failures', async () => {
  let authCalls = 0, pushes = 0, mode = 'ok', expire = false;
  const records = [];
  process.env.AUTH_TEST_ID = 'client-1'; process.env.AUTH_TEST_SECRET = 'client-secret-private';
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/auth') {
      authCalls++;
      assert.equal(req.headers.authorization, undefined);
      assert.deepEqual(JSON.parse(raw), { clientId: 'client-1', clientSecret: 'client-secret-private' });
      await new Promise(resolve => setTimeout(resolve, 10));
      if (mode === 'deny') { res.statusCode = 401; return res.end('{"message":"invalid credentials"}'); }
      if (mode === 'malformed') return res.end('{"accessToken":"bad"}');
      return res.end(JSON.stringify({ accessToken: `access-private-${authCalls}`, expiresIn: expire ? 0.001 : 3600 }));
    }
    if (req.method === 'POST') pushes++;
    assert.match(req.headers.authorization, /^Bearer (access-private-\d+|client-secret-private)$/);
    if (mode === 'reject-token') { res.statusCode = 401; return res.end('{}'); }
    res.end(JSON.stringify({ merchantReference: 'ref', processingStatus: 'PENDING' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const account = { businessId: '1', businessOwnerId: '2', apiKeyEnv: 'AUTH_TEST_SECRET', webhookSecretEnv: 'UNUSED', clientIdEnv: 'AUTH_TEST_ID' };
  const audit = { context: { provider_id: 'moniepoint', account_key: 'test' }, write: async row => { records.push(row); } };
  const client = () => new MoniepointClient(account, base, audit);
  const clear = () => MoniepointClient.tokens.clear();
  try {
    await Promise.all([client().check('ref'), client().check('ref')]);
    assert.equal(authCalls, 1); assert.equal(pushes, 0);
    assert.ok(records.some(row => row.operation === 'authentication' && row.stage === 'http_response'));
    assert.ok(!JSON.stringify(records).includes('client-secret-private')); assert.ok(!JSON.stringify(records).includes('access-private-'));
    mode = 'reject-token'; await assert.rejects(client().check('ref')); mode = 'ok';
    await client().check('ref'); assert.equal(authCalls, 2);
    clear(); expire = true; await client().check('ref'); await new Promise(resolve => setTimeout(resolve, 10));
    await client().check('ref'); assert.equal(authCalls, 4); expire = false;
    for (mode of ['deny', 'malformed']) {
      clear(); await assert.rejects(client().open('ref', 'terminal', 100, 'card'), error => error.definite === true);
      assert.equal(pushes, 0);
    }
    mode = 'ok'; clear();
    const failingAudit = { ...audit, write: async row => { if (row.stage === 'http_response') throw Error('audit offline'); } };
    await assert.rejects(new MoniepointClient(account, base, failingAudit).open('ref', 'terminal', 100, 'card'), error => error.definite === true);
    assert.equal(pushes, 0);
    const direct = { ...account }; delete direct.clientIdEnv; const before = authCalls;
    await new MoniepointClient(direct, base, audit).check('ref'); assert.equal(authCalls, before);
    process.env.MONIEPOINT_ACCOUNTS_JSON = JSON.stringify({ test: { ...account, clientIdEnv: 'MISSING_CLIENT_ID' } });
    process.env.MONIEPOINT_TERMINALS_JSON = '{}';
    assert.ok(checkoutConfiguration().errors.some(error => error.includes('clientIdEnv')));
  } finally { clear(); await new Promise(resolve => server.close(resolve)); }
});
