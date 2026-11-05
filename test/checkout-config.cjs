const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkoutConfiguration } = require('../dist/pos/checkout-config');

test('configuration diagnostics reject malformed profiles and conflicting mappings without leaking credentials', () => {
  process.env.TEST_KEY = 'private-api-value'; process.env.TEST_SECRET = 'private-secret-value';
  process.env.MONIEPOINT_ACCOUNTS_JSON = JSON.stringify({ lagos: { businessId: '100', businessOwnerId: '101', apiKeyEnv: 'TEST_KEY', webhookSecretEnv: 'TEST_SECRET' } });
  const mapping = { hubId: '123456789012345678901234', accountKey: 'lagos', terminalSerial: 'terminal' };
  process.env.MONIEPOINT_TERMINALS_JSON = JSON.stringify({ first: mapping, second: mapping });
  let result = checkoutConfiguration();
  assert.match(result.errors.join(' '), /assigned more than once/);
  assert.ok(!JSON.stringify(result).includes('private-'));
  process.env.MONIEPOINT_TERMINALS_JSON = JSON.stringify({ first: { ...mapping, accountKey: 'unknown' } });
  assert.match(checkoutConfiguration().errors.join(' '), /Invalid terminal mapping/);
  process.env.MONIEPOINT_ACCOUNTS_JSON = 'broken-json';
  assert.match(checkoutConfiguration().errors.join(' '), /must be a JSON object/);
  process.env.MONIEPOINT_ACCOUNTS_JSON = '{}'; process.env.MONIEPOINT_TERMINALS_JSON = '{}';
  result = checkoutConfiguration(); assert.deepEqual(result.errors, []);
});
