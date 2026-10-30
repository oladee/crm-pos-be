// Dependency-free regression checks against the actual enrollment method body.
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
const source = readFileSync(resolve(__dirname, '../src/pos/pos-passkey.service.ts'), 'utf8');
const start = source.indexOf('    const id = input.deviceId.trim();', source.indexOf('  async enroll('));
const end = source.indexOf('\n  async authenticationOptions', start);
const body = source.slice(start, end).replace(/\n  }\s*$/, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const enroll = new AsyncFunction('input', 'verifyRegistrationResponse', 'isoBase64URL', 'ForbiddenException', 'BadRequestException', body);
(async () => {
  for (const revoked of [true, false]) {
    const existing = { hub: 'old-location', revoked, credential_id: 'old-key', public_key: 'old-public-key' };
    let written;
    let cleared;
    const service = {
      liveCode: async () => ({ hub: 'new-location' }),
      takeChallenge: async () => 'challenge',
      origins: () => ['https://pos.example.com'], rpID: () => 'pos.example.com',
      claimCode: async () => ({ hub: 'new-location' }),
      tillLabel: async () => 'Till 2',
      deviceModel: {
        findOne: async () => existing,
        findOneAndUpdate: async (_filter, update) => { written = update.$set; return written; },
      },
      challengeModel: { deleteMany: async (filter) => { cleared = filter; } },
    };
    const run = () => enroll.call(service, { deviceId: 'device-1', code: 'CODE', response: {} },
      async () => ({ verified: true, registrationInfo: { credential: { id: 'new-key', publicKey: 'new-public-key', counter: 0, transports: ['internal'] } } }),
      { fromBuffer: value => value }, Error, Error);
    if (!revoked) {
      await assert.rejects(run, /already registered to another location/);
      assert.equal(written, undefined);
      continue;
    }
    const result = await run();
    assert.equal(result.hubId, 'new-location');
    assert.equal(result.credentialId, 'new-key');
    assert.equal(written.public_key, 'new-public-key');
    assert.equal(written.revoked, false);
    assert.deepEqual(cleared, { device_id: 'device-1', kind: 'authentication' });
  }
  console.log('Passed: revoked till moves locations, old credentials are replaced, old challenges cleared, active location binding protected.');
})().catch(error => { console.error(error); process.exitCode = 1; });
