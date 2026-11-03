import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  addressInside, assertTesterCidr, buildApplication, cidrContains, configVariables, coveringCidr, deployWithPreview, deploymentBody,
  foundryAccountIds, keyPlan, newSecret, credentialMonths, emailDomainFor, promotionError, redact, redirectUriFor, secretDays, secretEndDate, supersededKeys, unmanagedAppSettings,
  unsetConfigVariables, whatIfLines, withFoundryTarget, databaseOf, templateForDatabase, templateForConsole, consoleConfig, databasePassword, firewallPlan, databaseLocationFor,
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

test('P-39 T-152 --client-secret-days is a whole number of days from 1 to 365, 365 when absent; --credential-months 1 to 24, 12 when absent', () => {
  // ADR-0016 (amended 2026-11-03): up to a year, renewed by the job 30 days before the end.
  assert.equal(secretDays(undefined), 365);
  assert.equal(secretDays('30'), 30);
  assert.equal(secretDays('365'), 365);
  assert.equal(secretDays('1'), 1);
  for (const bad of ['0', '366', '7.5', 'seven', '', ' 7', '1e1']) assert.throws(() => secretDays(bad), /1 to 365/, bad);
  assert.equal(credentialMonths(undefined), 12);
  assert.equal(credentialMonths('24'), 24);
  for (const bad of ['0', '25', '6.5', 'x']) assert.throws(() => credentialMonths(bad), /1 to 24/, bad);
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

// A Container App template with the given secret names and gateway variables, and a sidecar with one of its own.
const appTemplate = (secrets, env) => ({ resources: [{ type: 'Microsoft.App/containerApps', properties: {
  configuration: { secrets: secrets.map((name) => ({ name, value: `[parameters('${name}')]` })) },
  template: { containers: [{ name: 'gateway', env: env.map((name) => ({ name })) }, { name: 'postgres', env: [{ name: 'POSTGRES_USER' }] }] },
} }] });

test('unmanagedAppSettings names each live secret and gateway variable a redeploy of the template would delete (P-34, U-80)', () => {
  const template = appTemplate(['jwt-secret', 'gateway-config'], ['GATEWAY_JWT_SECRET', 'AZURE_CLIENT_ID']);
  assert.deepEqual(unmanagedAppSettings({ secretNames: ['jwt-secret', 'gateway-config'], gatewayEnv: ['AZURE_CLIENT_ID', 'GATEWAY_JWT_SECRET'] }, template), []);
  assert.deepEqual(unmanagedAppSettings({ secretNames: [], gatewayEnv: [] }, template), [], 'an app that does not exist yet holds nothing');
  // The Contoso deployment's hand-added cross-tenant Foundry credential (docs/UNKNOWNS.md, U-80).
  assert.deepEqual(unmanagedAppSettings({ secretNames: ['jwt-secret', 'azure-client-secret-crosstenant'],
    gatewayEnv: ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_CLIENT_SECRET'] }, template),
  ['secret azure-client-secret-crosstenant', 'environment variable AZURE_TENANT_ID', 'environment variable AZURE_CLIENT_SECRET']);
  assert.deepEqual(unmanagedAppSettings({ secretNames: [], gatewayEnv: ['POSTGRES_USER'] }, template), ['environment variable POSTGRES_USER'],
    'a variable only the sidecar defines is not the gateway container\'s');
});

test('unsetConfigVariables names each ${VAR} a configuration references that the template does not set on the gateway (P-34)', () => {
  const template = appTemplate([], ['GATEWAY_PUBLIC_URL', 'GATEWAY_JWT_SECRET']);
  assert.deepEqual(unsetConfigVariables('a: "${GATEWAY_PUBLIC_URL}"\nb: "${GATEWAY_JWT_SECRET}"\n', template), []);
  assert.deepEqual(unsetConfigVariables('a: "${GATEWAY_PUBLIC_URL}"\nkey: "${GATEWAY_ADMIN_WRITE_KEY}"  # ${COMMENTED}\nc: "${POSTGRES_USER}"\n', template),
    ['GATEWAY_ADMIN_WRITE_KEY', 'POSTGRES_USER']);
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

// T-114 (ADR-0012): the deploy script's choices for the test topology's database.
const sidecarYaml = 'store:\n  postgres_url: postgres://gateway@127.0.0.1:5432/gateway\n';
const managedYaml = 'store:\n  postgres_url: "postgres://gateway@${GATEWAY_PG_HOST}:5432/gateway?sslmode=require"\n';

test('T-114 databaseOf reads the choice from the rendered store, so the admin file stays the one source', () => {
  assert.equal(databaseOf(sidecarYaml), 'sidecar');
  assert.equal(databaseOf(managedYaml), 'managed');
  assert.equal(databaseOf('# postgres_url: "postgres://gateway@${GATEWAY_PG_HOST}"\n' + sidecarYaml), 'sidecar', 'a comment does not count');
});

const miniTemplate = () => ({ resources: [
  { type: 'Microsoft.DBforPostgreSQL/flexibleServers', name: 's' },
  { type: 'Microsoft.App/containerApps', properties: { template: {
    containers: [
      { name: 'gateway', volumeMounts: [{ volumeName: 'gateway-config', mountPath: '/etc/claude' }] },
      { name: 'postgres', volumeMounts: [{ volumeName: 'pgdata', mountPath: '/var/lib/postgresql/data' }] },
    ],
    volumes: [{ name: 'gateway-config', storageType: 'Secret' }, { name: 'pgdata', storageType: 'EmptyDir' }],
  } } },
] });

test('P-39 after an admin-ui save, the app step keeps the gateway-admin-file secret and CONFIG_UPDATED_AT instead of refusing (ADR-0010)', () => {
  const t = JSON.parse(fs.readFileSync(new URL('../infra/azure-test/gateway-test.json', import.meta.url), 'utf8'));
  const before = structuredClone(t);
  assert.deepEqual(templateForConsole(t, false), before);
  const owned = templateForConsole(t, true);
  assert.deepEqual(t, before, 'the input template is not changed');
  const saved = { secretNames: ['jwt-secret', 'gateway-config', 'gateway-admin-file'], gatewayEnv: ['AZURE_CLIENT_ID', 'CONFIG_UPDATED_AT'] };
  assert.deepEqual(unmanagedAppSettings(saved, t), ['secret gateway-admin-file', 'environment variable CONFIG_UPDATED_AT'], 'the template alone would delete them');
  assert.deepEqual(unmanagedAppSettings(saved, owned), []);
  assert.deepEqual(unmanagedAppSettings({ ...saved, secretNames: [...saved.secretNames, 'azure-client-secret-crosstenant'] }, owned),
    ['secret azure-client-secret-crosstenant'], 'a secret added by hand is still refused');
  assert.equal(owned.parameters.gatewayAdminFile.type, 'securestring');
  assert.equal(owned.parameters.configUpdatedAt.type, 'string');
});

test('P-39 consoleConfig deploys the configuration admin-ui saved, not the local file, once the app holds the admin file', () => {
  assert.equal(consoleConfig({ secrets: { 'gateway-config': 'a: 1\n' } }), null, 'never saved from the console');
  assert.equal(consoleConfig({ secrets: {} }), null, 'an app that does not exist yet');
  assert.deepEqual(consoleConfig({ secrets: { 'gateway-config': 'models: []\n', 'gateway-admin-file': '{"roles":[]}' }, configUpdatedAt: '2026-10-25T10:00:00Z' }),
    { yaml: 'models: []\n', adminFile: '{"roles":[]}', stamp: '2026-10-25T10:00:00Z' });
  assert.deepEqual(consoleConfig({ secrets: { 'gateway-config': 'x', 'gateway-admin-file': '{}' } }).stamp, '');
  assert.throws(() => consoleConfig({ secrets: { 'gateway-admin-file': '{}' } }), /gateway-config/);
});

test('T-114 templateForDatabase removes the postgres container and pgdata volume for "managed" only, without changing its input', () => {
  const t = miniTemplate();
  const before = structuredClone(t);
  assert.deepEqual(templateForDatabase(t, 'sidecar'), before);
  const managed = templateForDatabase(t, 'managed');
  assert.deepEqual(t, before, 'the input is not changed');
  const app = managed.resources.find((r) => r.type === 'Microsoft.App/containerApps').properties.template;
  assert.deepEqual(app.containers.map((c) => c.name), ['gateway']);
  assert.deepEqual(app.volumes.map((v) => v.name), ['gateway-config']);
  // The image's entrypoint waits for the sidecar on 127.0.0.1:5432 (U-35); with no sidecar it would never start the
  // gateway, so the managed app runs the gateway directly (found live on Contoso, revision ca-claude-gw--0000008).
  assert.deepEqual(app.containers[0].command, ['/usr/local/bin/claude']);
  assert.deepEqual(app.containers[0].args, ['gateway', '--config', '/etc/claude/gateway.yaml']);
  assert.equal(templateForDatabase(t, 'sidecar').resources[1].properties.template.containers[0].command, undefined, 'the sidecar keeps the entrypoint');
  assert.throws(() => templateForDatabase(t, 'azurefiles'), /sidecar or managed/);
});

test('T-114 databaseLocationFor keeps the region a server was created in, so a later deployment never moves it', () => {
  assert.equal(databaseLocationFor({ option: undefined, state: undefined, location: 'eastus2' }), 'eastus2');
  assert.equal(databaseLocationFor({ option: 'eastus', state: undefined, location: 'eastus2' }), 'eastus');
  assert.equal(databaseLocationFor({ option: undefined, state: 'eastus', location: 'eastus2' }), 'eastus');
  assert.throws(() => databaseLocationFor({ option: 'centralus', state: 'eastus', location: 'eastus2' }), /already in eastus/);
  assert.throws(() => databaseLocationFor({ option: 'East US', state: undefined, location: 'eastus2' }), /region name/);
});

test('T-114 databasePassword adds a capital letter only when there is none, so a second deployment keeps the same password', () => {
  const hex = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);
  const once = databasePassword(hex);
  assert.equal(once, `${hex}A`);
  assert.equal(databasePassword(once), once);
  assert.equal(databasePassword('Abc123'), 'Abc123');
  assert.throws(() => databasePassword(''), /empty/);
});

test('T-114 firewallPlan adds a rule per outbound address and removes only stale aca-outbound rules', () => {
  const rules = [
    { name: 'aca-outbound-192-0-2-10', properties: { startIpAddress: '192.0.2.10', endIpAddress: '192.0.2.10' } },
    { name: 'aca-outbound-203-0-113-1', properties: { startIpAddress: '203.0.113.1', endIpAddress: '203.0.113.1' } },
    { name: 'someone-else', properties: { startIpAddress: '192.0.2.4', endIpAddress: '192.0.2.4' } },
  ];
  assert.deepEqual(firewallPlan(rules, ['192.0.2.10', '198.51.100.9']), {
    add: [{ name: 'aca-outbound-198-51-100-9', ip: '198.51.100.9' }],
    remove: ['aca-outbound-203-0-113-1'],
  });
  assert.deepEqual(firewallPlan(rules.slice(0, 1), ['192.0.2.10']), { add: [], remove: [] });
  assert.throws(() => firewallPlan([], []), /no outbound address/);
  assert.throws(() => firewallPlan([], ['10.0.0.300']), /not an IPv4 address/);
  assert.throws(() => firewallPlan([], ['0.0.0.0']), /0\.0\.0\.0/, 'never the allow-all-Azure rule');
});

// T-157 (ADR-0017): the gateway's ingress range. -GatewayAllowAnyAddress is 0.0.0.0/0, which assertTesterCidr refuses.
test('T-157 ingressRange: any address gives 0.0.0.0/0; a range is checked as before; both or neither are refused', async () => {
  const { ingressRange } = await import('../infra/azure-test/lib/plan.mjs');
  assert.equal(ingressRange({ anyAddress: true }), '0.0.0.0/0');
  assert.equal(ingressRange({ testerCidr: '198.51.100.0/26' }), '198.51.100.0/26');
  assert.throws(() => ingressRange({ testerCidr: '0.0.0.0/0' }), /too wide/, 'the wide range still needs the explicit option');
  assert.throws(() => ingressRange({ anyAddress: true, testerCidr: '198.51.100.0/26' }), /either/);
  assert.throws(() => ingressRange({}), /--tester-cidr <range> or --any-address/);
});

test('emailDomainFor: --email-domain, else the mail address\'s domain, else the sign-in name\'s, said so; neither refuses', () => {
  assert.deepEqual(emailDomainFor({ option: 'contoso.example', mail: 'dev@fabrikam.example', upn: 'dev@contoso.example' }), { domain: 'contoso.example', from: 'option' });
  assert.deepEqual(emailDomainFor({ mail: 'dev@fabrikam.example', upn: 'dev@contoso.example' }), { domain: 'fabrikam.example', from: 'mail' });
  assert.deepEqual(emailDomainFor({ mail: null, upn: 'admin@contoso.example' }), { domain: 'contoso.example', from: 'userPrincipalName' });
  assert.throws(() => emailDomainFor({ mail: null, upn: 'x#EXT#' }), /-EmailDomain/);
});