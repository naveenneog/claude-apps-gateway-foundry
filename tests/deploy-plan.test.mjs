import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addressInside, assertTesterCidr, buildApplication, cidrContains, configVariables, coveringCidr, deployWithPreview, deploymentBody,
  foundryAccountIds, keyPlan, newSecret, promotionError, redact, redirectUriFor, secretEndDate, supersededKeys, whatIfLines, withFoundryTarget,
} from '../infra/azure-test/lib/plan.mjs';

test('tester CIDR: accepts a public, aligned range of /24 or narrower and normalises it', () => {
  assert.equal(assertTesterCidr('203.0.113.0/26'), '203.0.113.0/26');
  assert.equal(assertTesterCidr(' 203.0.113.25/32 '), '203.0.113.25/32');
  assert.equal(assertTesterCidr('20.1.2.3/32'), '20.1.2.3/32', 'a public address outside the documentation ranges');
});

test('tester CIDR: refuses ranges that would open the gateway or lock the tester out', () => {
  const refused = {
    '0.0.0.0/0': /\/24 or narrower/,
    '203.0.0.0/16': /\/24 or narrower/,
    '203.0.113.5/26': /network address/,
    '10.1.2.0/24': /private or reserved/,
    '100.64.1.0/24': /private or reserved/,
    '127.0.0.1/32': /private or reserved/,
    '203.0.113.0': /CIDR/,
    '203.0.113.0/33': /CIDR/,
    '203.0.256.0/24': /IPv4/,
    '203.0.113.0/24;rm': /CIDR/,
    '': /CIDR/,
  };
  for (const [input, message] of Object.entries(refused)) {
    assert.throws(() => assertTesterCidr(input), message, `refuses ${JSON.stringify(input)}`);
  }
});

test('cidrContains checks membership, including the range edges', () => {
  assert.ok(cidrContains('203.0.113.0/26', '203.0.113.0'));
  assert.ok(cidrContains('203.0.113.0/26', '203.0.113.63'));
  assert.ok(!cidrContains('203.0.113.0/26', '203.0.113.64'));
  assert.ok(!cidrContains('203.0.113.0/26', '203.0.114.1'), 'the next /24: only the third octet differs');
});

test('coveringCidr returns the smallest aligned range holding every sample', () => {
  assert.equal(coveringCidr(['203.0.113.25', '203.0.113.32']), '203.0.113.0/26');
  assert.equal(coveringCidr(['203.0.113.25', '203.0.113.30']), '203.0.113.24/29');
  assert.equal(coveringCidr(['203.0.113.26']), '203.0.113.26/32');
  assert.throws(() => coveringCidr([]), /at least one/);
});

test('redirect URI is the HTTPS callback on a plain host name, nothing else', () => {
  assert.equal(redirectUriFor('ca-claude-gw.blue-sky-1234.eastus2.azurecontainerapps.io'),
    'https://ca-claude-gw.blue-sky-1234.eastus2.azurecontainerapps.io/oauth/callback');
  for (const bad of ['evil.example/path', 'a b.example', 'Upper.example', 'x.example:8443', '', 'localhost', '-x.example']) {
    assert.throws(() => redirectUriFor(bad), /host name/, `refuses ${JSON.stringify(bad)}`);
  }
});

const manifest = () => ({
  signInAudience: 'AzureADMyOrg',
  web: { implicitGrantSettings: { enableIdTokenIssuance: false, enableAccessTokenIssuance: false } },
  appRoles: [{ value: 'Gateway.Standard' }],
});

test('buildApplication sets the name, the single redirect URI and the tags without changing the manifest', () => {
  const source = manifest();
  const app = buildApplication(source, { displayName: 'gw', redirectUri: 'https://h.example/oauth/callback', tags: ['t'] });
  assert.deepEqual(app.web.redirectUris, ['https://h.example/oauth/callback']);
  assert.equal(app.displayName, 'gw');
  assert.deepEqual(app.tags, ['t']);
  assert.equal(app.web.implicitGrantSettings.enableIdTokenIssuance, false);
  assert.equal(source.web.redirectUris, undefined, 'the input manifest is not modified');
});

test('buildApplication refuses a manifest that carries credentials or its own redirect URIs', () => {
  const args = { displayName: 'gw', redirectUri: 'https://h.example/oauth/callback', tags: [] };
  assert.throws(() => buildApplication({ ...manifest(), passwordCredentials: [{}] }, args), /credentials/);
  assert.throws(() => buildApplication({ ...manifest(), keyCredentials: [{}] }, args), /credentials/);
  assert.throws(() => buildApplication({ ...manifest(), web: { redirectUris: ['https://other/cb'] } }, args), /redirect/);
});

test('secret end date is 7 days out by default and never beyond the tenant limit of 30', () => {
  const now = new Date('2026-09-23T10:00:00.000Z');
  assert.equal(secretEndDate(now), '2026-09-30T10:00:00.000Z');
  assert.equal(secretEndDate(now, 30), '2026-10-23T10:00:00.000Z');
  assert.throws(() => secretEndDate(now, 31), /1 to 30/);
  assert.throws(() => secretEndDate(now, 0), /1 to 30/);
});

test('newSecret draws at least 32 random bytes and encodes them as hex', () => {
  const a = newSecret();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, newSecret());
  assert.match(newSecret(48), /^[0-9a-f]{96}$/);
  assert.throws(() => newSecret(16), /32 bytes/);
  assert.equal(newSecret(32, (n) => Buffer.alloc(n, 0xab)), 'ab'.repeat(32));
});

test('deploymentBody wraps each parameter as {value} and embeds the template unchanged', () => {
  const template = { resources: [{ type: 'x', properties: { cpu: "[json('0.75')]" } }] };
  const body = JSON.parse(deploymentBody(template, { a: 'b', n: 1, flag: false }));
  assert.equal(body.properties.mode, 'Incremental');
  assert.deepEqual(body.properties.template, template);
  assert.deepEqual(body.properties.parameters, { a: { value: 'b' }, n: { value: 1 }, flag: { value: false } });
});

test('configVariables lists ${VAR} references outside comments, and skips ${file:...}', () => {
  const yaml = [
    'listen:',
    '  public_url: "${GATEWAY_PUBLIC_URL}"   # ${NOT_THIS}',
    '# ${NOR_THIS}',
    '  secret: ${file:/run/x}',
    '  pair: "${A}-${B}"',
  ].join('\n');
  assert.deepEqual(configVariables(yaml), ['A', 'B', 'GATEWAY_PUBLIC_URL']);
});

test('redact replaces every secret of 8 or more characters, wherever it appears', () => {
  const secret = 'abcdef0123456789';
  assert.equal(redact(`token ${secret} and again ${secret}.`, [secret, 'short', '']), 'token [redacted] and again [redacted].');
  assert.equal(redact('nothing here', [secret]), 'nothing here');
  assert.equal(redact('a.b*c', ['a.b*c-literal']), 'a.b*c', 'secrets are literal text, not patterns');
});

test('addressInside returns an address inside the range, for the forged X-Forwarded-For probe', () => {
  for (const cidr of ['203.0.113.0/26', '203.0.113.64/26', '203.0.113.24/29', '203.0.113.26/32', '203.0.113.30/31']) {
    const ip = addressInside(cidr);
    assert.ok(cidrContains(cidr, ip), `${ip} lies in ${cidr}`);
  }
  assert.equal(addressInside('203.0.113.64/26'), '203.0.113.65');
});

const DAY = 86_400_000;
const now = Date.parse('2026-09-23T12:00:00Z');
const OWN = 'gateway-test run-1';
const credential = (keyId, daysLeft, { hint = `${keyId}h`, displayName = OWN } = {}) =>
  ({ keyId, hint: hint.slice(0, 3), displayName, endDateTime: new Date(now + daysLeft * DAY).toISOString() });
const installed = (keyId, hint = `${keyId}h`) => ({ keyId, hint: hint.slice(0, 3) });

test('keyPlan reuses the installed secret only while its key is identified and has more than a day left', () => {
  assert.deepEqual(keyPlan({ credentials: [credential('a', 5)], ownName: OWN, installed: installed('a'), readyKeyId: 'a', now }),
    { action: 'reuse', keyId: 'a', removeNow: [] });
  assert.equal(keyPlan({ credentials: [credential('a', 0.5)], ownName: OWN, installed: installed('a'), readyKeyId: 'a', now }).action, 'rotate',
    'less than a day left');
  assert.deepEqual(keyPlan({ credentials: [credential('a', 5)], ownName: OWN, installed: null, readyKeyId: null, now }),
    { action: 'rotate', removeNow: ['a'] }, 'no app, so no key is in use');
});

test('keyPlan adopts a pending key that a crashed run already installed, and keeps the key the ready revision reads', () => {
  // The Architect's reproduction (round 2): ARM applied the new key, the process stopped before promotion.
  const credentials = [credential('old', 5), credential('new', 7)];
  assert.deepEqual(keyPlan({ credentials, ownName: OWN, installed: installed('new'), readyKeyId: 'old', now }),
    { action: 'reuse', keyId: 'new', removeNow: [] }, 'neither the installed nor the serving key is removed');
  assert.deepEqual(keyPlan({ credentials, ownName: OWN, installed: installed('old'), readyKeyId: 'old', now }),
    { action: 'reuse', keyId: 'old', removeNow: ['new'] }, 'a pending key that was never installed has no holder, so it goes');
});

test('keyPlan removes nothing while the installed secret matches no key by id and hint', () => {
  const credentials = [credential('a', 5), credential('b', 5)];
  for (const unknown of [installed(null, 'ahx'), installed('a', 'zzz'), installed('gone')]) {
    assert.deepEqual(keyPlan({ credentials, ownName: OWN, installed: unknown, readyKeyId: null, now }),
      { action: 'rotate', removeNow: [] }, JSON.stringify(unknown));
  }
});

test('keyPlan removes nothing while a ready revision reads a key it cannot name (Coder review, round 3)', () => {
  // A revision from before OIDC_CREDENTIAL_ID serves with some key; a newer key is installed.
  assert.deepEqual(keyPlan({ credentials: [credential('old', 5), credential('new', 7)], ownName: OWN, installed: installed('new'),
    readyRevision: 'legacy', readyKeyId: null, now }), { action: 'reuse', keyId: 'new', removeNow: [] });
  assert.deepEqual(keyPlan({ credentials: [credential('old', 5), credential('new', 7)], ownName: OWN, installed: installed('new'),
    readyRevision: null, readyKeyId: null, now }), { action: 'reuse', keyId: 'new', removeNow: ['old'] }, 'no ready revision holds any key');
});
test('keyPlan and supersededKeys touch only secrets this tool named for this run', () => {
  const foreign = credential('x', 5, { displayName: 'added by hand' });
  assert.deepEqual(keyPlan({ credentials: [credential('a', 5), credential('p', 7), foreign], ownName: OWN, installed: installed('a'), readyKeyId: 'a', now }),
    { action: 'reuse', keyId: 'a', removeNow: ['p'] });
  assert.deepEqual(supersededKeys({ credentials: [credential('old', 5), credential('new', 7), foreign], ownName: OWN, keyId: 'new' }), ['old']);
  assert.deepEqual(supersededKeys({ credentials: [credential('new', 7)], ownName: OWN, keyId: 'new' }), []);
});

test('keyPlan rotates on request, and still keeps the installed and serving keys', () => {
  assert.deepEqual(keyPlan({ credentials: [credential('a', 5), credential('p', 7)], ownName: OWN, installed: installed('a'), readyKeyId: 'a', now, minRemainingMs: Infinity }),
    { action: 'rotate', removeNow: ['p'] });
});

test('promotionError: no other secret goes until the ready revision and the app both hold the deployed key', () => {
  const after = { readyRevision: 'r2', readyKeyId: 'k2', installedKeyId: 'k2' };
  assert.equal(promotionError({ revision: 'r2', after, keyId: 'k2' }), null);
  assert.match(promotionError({ revision: 'r2', after: { ...after, readyKeyId: 'k1' }, keyId: 'k2' }), /reads key k1/);
  assert.match(promotionError({ revision: 'r2', after: { ...after, installedKeyId: 'k1' }, keyId: 'k2' }), /app holds k1/);
  assert.match(promotionError({ revision: 'r2', after: { ...after, readyRevision: 'r3' }, keyId: 'k2' }), /revision r3/);
});
test('Foundry targets accumulate, so teardown looks at every account a base deployment used', () => {
  const a = { resourceGroup: 'rg-a', account: 'ai-a' };
  const b = { resourceGroup: 'rg-b', account: 'ai-b' };
  assert.deepEqual(withFoundryTarget(withFoundryTarget([], a), a), [a]);
  assert.deepEqual(withFoundryTarget([a], b), [a, b]);
  const state = { subscriptionId: 's', foundryTargets: [a, b], foundry: { resourceGroup: 'RG-A', account: 'AI-A' },
    foundryRoleAssignmentId: '/subscriptions/s/resourceGroups/rg-c/providers/Microsoft.CognitiveServices/accounts/ai-c/providers/Microsoft.Authorization/roleAssignments/r' };
  assert.deepEqual(foundryAccountIds(state), [
    '/subscriptions/s/resourceGroups/rg-a/providers/Microsoft.CognitiveServices/accounts/ai-a',
    '/subscriptions/s/resourceGroups/rg-b/providers/Microsoft.CognitiveServices/accounts/ai-b',
    '/subscriptions/s/resourceGroups/rg-c/providers/Microsoft.CognitiveServices/accounts/ai-c',
  ], 'the legacy single target and the recorded grant are included, case-insensitively once');
  assert.deepEqual(foundryAccountIds({ subscriptionId: 's' }), []);
  assert.deepEqual(foundryAccountIds({ subscriptionId: 's', foundry: { resourceGroup: 'rg-l', account: 'ai-l' } }),
    ['/subscriptions/s/resourceGroups/rg-l/providers/Microsoft.CognitiveServices/accounts/ai-l'], 'a state file written before foundryTargets');
});

test('deployWithPreview validates, reports the what-if, and only then deploys', async () => {
  const calls = [];
  const steps = {
    validate: async () => calls.push('validate'),
    whatIf: async () => { calls.push('whatIf'); return [{ changeType: 'Modify' }]; },
    report: (changes) => calls.push(`report:${changes.length}`),
    run: async () => { calls.push('run'); return 'done'; },
  };
  assert.equal(await deployWithPreview({ ...steps, previewOnly: false }), 'done');
  assert.deepEqual(calls, ['validate', 'whatIf', 'report:1', 'run']);
  calls.length = 0;
  assert.equal(await deployWithPreview({ ...steps, previewOnly: true }), null);
  assert.deepEqual(calls, ['validate', 'whatIf', 'report:1']);
  calls.length = 0;
  await assert.rejects(deployWithPreview({ ...steps, whatIf: async () => { throw new Error('what-if failed'); }, previewOnly: false }), /what-if failed/);
  assert.deepEqual(calls, ['validate'], 'no deployment without a preview');
});

test('whatIfLines lists each changed property path of a Modify, never a value, and skips no-effect changes', () => {
  const changes = [
    { changeType: 'NoChange', resourceId: '/subscriptions/s/resourceGroups/g/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id' },
    { changeType: 'Modify', resourceId: '/subscriptions/s/resourceGroups/g/providers/Microsoft.App/containerApps/ca', delta: [
      { path: 'properties.template.containers', propertyChangeType: 'Array', children: [
        { path: '0', propertyChangeType: 'Modify', children: [{ path: 'image', propertyChangeType: 'Modify', before: 'old-secret-looking', after: 'new' }] }] },
      { path: 'properties.configuration.secrets', propertyChangeType: 'NoEffect', before: 'x', after: 'y' },
      { path: 'tags.note', propertyChangeType: 'Delete', before: 'gone' },
    ] },
  ];
  assert.deepEqual(whatIfLines(changes), [
    'NoChange  Microsoft.ManagedIdentity/userAssignedIdentities/id',
    'Modify    Microsoft.App/containerApps/ca',
    '            Modify  properties.template.containers.0.image',
    '            Delete  tags.note',
  ]);
  assert.ok(!whatIfLines(changes).join('\n').includes('secret-looking'));
});