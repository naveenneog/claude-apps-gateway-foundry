import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseLocationFor, databaseRegions } from '../infra/azure-test/lib/plan.mjs';
import { isRegionRefusal, missingDeployments, regionCapability, runPreflight } from '../infra/azure-test/lib/preflight.mjs';
import { createDatabaseFirst } from '../infra/azure-test/lib/database.mjs';

// The shape of GET .../providers/Microsoft.DBforPostgreSQL/locations/{region}/capabilities?api-version=2024-08-01,
// trimmed from the Contoso subscription on 2026-11-03 (eastus restricted, eastus2 open).
const OPEN = { value: [{ name: 'FlexibleServerCapabilities', restricted: 'Disabled', supportedServerVersions: [{ name: '15' }, { name: '16' }],
  supportedServerEditions: [{ name: 'Burstable', supportedServerSkus: [{ name: 'Standard_B1ms' }, { name: 'Standard_B2s' }] }] }] };
const RESTRICTED = { value: [{ name: 'FlexibleServerCapabilities', restricted: 'Enabled', supportedServerVersions: [], supportedServerEditions: [] }] };
const NO_B1MS = { value: [{ restricted: 'Disabled', supportedServerVersions: [{ name: '16' }], supportedServerEditions: [{ name: 'Burstable', supportedServerSkus: [{ name: 'Standard_B2s' }] }] }] };

test('T-158 databaseRegions: a comma-separated list of region names, else the install region', () => {
  assert.deepEqual(databaseRegions('eastus, centralus,westus3', 'eastus2'), ['eastus', 'centralus', 'westus3']);
  assert.deepEqual(databaseRegions(undefined, 'eastus2'), ['eastus2']);
  assert.deepEqual(databaseRegions('eastus,eastus', 'x'), ['eastus'], 'a repeated region is tried once');
  assert.throws(() => databaseRegions('East US', 'eastus2'), /region name/);
  assert.throws(() => databaseRegions('eastus,,centralus', 'eastus2'), /region name/);
});

test('T-158 databaseLocationFor: a list keeps a recorded server in its region if the list names it, and refuses one it does not', () => {
  assert.equal(databaseLocationFor({ option: 'eastus,centralus', state: 'centralus', location: 'eastus2' }), 'centralus');
  assert.equal(databaseLocationFor({ option: 'eastus,centralus', state: undefined, location: 'eastus2' }), 'eastus');
  assert.equal(databaseLocationFor({ option: undefined, state: 'westus3', location: 'eastus2' }), 'westus3');
  assert.throws(() => databaseLocationFor({ option: 'eastus,westus', state: 'centralus', location: 'eastus2' }), /already in centralus/);
});

test('T-158 regionCapability: a restricted region, or one without Burstable Standard_B1ms or PostgreSQL 16, is not usable, with the reason', () => {
  assert.deepEqual(regionCapability(OPEN), { ok: true, reason: 'PostgreSQL 16, Burstable Standard_B1ms offered' });
  assert.equal(regionCapability(RESTRICTED).ok, false);
  assert.match(regionCapability(RESTRICTED).reason, /restricted/);
  assert.match(regionCapability(NO_B1MS).reason, /Standard_B1ms/);
  assert.match(regionCapability({ value: [{ restricted: 'Disabled', supportedServerVersions: [{ name: '15' }], supportedServerEditions: OPEN.value[0].supportedServerEditions }] }).reason, /PostgreSQL 16/);
  assert.equal(regionCapability({ value: [] }).ok, false);
});

test('T-159 isRegionRefusal: capacity, quota and region refusals move to the next region; anything else stops', () => {
  for (const message of [
    'deployment claude-gw-db Failed:\n  Microsoft.DBforPostgreSQL/flexibleServers: {"code":"SkuNotAvailable","message":"x"}',
    'Provisioning is restricted in this region. Please choose a different region.',
    "Location 'eastus' is not accepting creation of new Azure Database for PostgreSQL Flexible servers for the subscription 's' at this time",
    'Operation could not be completed as it results in exceeding approved Standard BS Family Cores quota.',
    'Subscriptions are restricted from provisioning in this region.',
    'Specified SKU is not supported in this region. Please choose a different SKU.',
    'Your subscription does not have access to create a server in the selected region.',
    // A direct PUT in a region whose capabilities say restricted: Enabled (Contoso, eastus, 2026-11-03, U-135).
    '{"code":"ParameterOutOfRange","message":"The value of the \'Version\' should be in: []. Verify that the specified parameter value is correct."}',
  ]) assert.equal(isRegionRefusal(message), true, message);
  for (const message of ['{"code":"InvalidParameterValue","message":"bad password"}', 'AuthorizationFailed', 'deployment claude-gw-db still Running after 45 minutes']) {
    assert.equal(isRegionRefusal(message), false, message);
  }
});

test('T-160 missingDeployments: admin-file models whose deployment the Foundry account does not hold', () => {
  const listed = { value: [{ name: 'claude-sonnet-5' }, { name: 'gpt-5' }] };
  assert.deepEqual(missingDeployments(listed, [{ id: 'claude-sonnet-5', deployment: 'claude-sonnet-5' }, { id: 'opus', deployment: 'claude-opus-5' }]), ['claude-opus-5']);
  assert.deepEqual(missingDeployments(listed, []), []);
});

function fakeArm(routes) {
  const calls = [];
  const arm = async (method, path, body, { ok = [200] } = {}) => {
    calls.push(`${method} ${path.split('?')[0]}`);
    if (method !== 'GET') throw new Error(`preflight must not ${method}`);
    const hit = Object.entries(routes).find(([k]) => path.split('?')[0].endsWith(k));
    const [status, json] = hit ? hit[1] : [404, { error: { code: 'NotFound' } }];
    if (!ok.includes(status)) { const e = new Error(`${status}`); e.status = status; throw e; }
    return { status, json };
  };
  return { arm, calls };
}
const SUB = '/subscriptions/s';
const INPUT = {
  subscriptionPath: SUB, groupPath: `${SUB}/resourceGroups/rg-gw`, group: 'rg-gw', state: {}, useExisting: true, location: 'eastus',
  foundry: { resourceGroup: 'rg-ai', account: 'ai-x' }, models: [{ id: 'claude-sonnet-5', deployment: 'claude-sonnet-5' }], database: 'managed', databaseOption: 'eastus,centralus',
};
const PG = '/providers/Microsoft.DBforPostgreSQL';
const ROUTES = {
  '/resourceGroups/rg-gw': [200, { location: 'eastus', tags: {} }],
  '/resourceGroups/rg-gw/resources': [200, { value: [{ type: 'Microsoft.CognitiveServices/accounts', name: 'ai-x', tags: {} }] }],
  '/accounts/ai-x': [200, { id: 'x' }],
  '/accounts/ai-x/deployments': [200, { value: [{ name: 'claude-sonnet-5' }] }],
  [`${PG}`]: [200, { registrationState: 'Registered' }],
  [`${PG}/locations/eastus/capabilities`]: [200, RESTRICTED],
  [`${PG}/locations/centralus/capabilities`]: [200, OPEN],
};

test('T-160 runPreflight: read-only checks, one line each; a restricted first region passes when a later one is usable', async () => {
  const { arm, calls } = fakeArm(ROUTES);
  const r = await runPreflight({ arm, ...INPUT });
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.ok(calls.every((c) => c.startsWith('GET ')), 'GET only');
  const text = r.lines.join('\n');
  assert.match(text, /PASS +resource group rg-gw: exists; the installer adds its resources next to the 1 already there/);
  assert.match(text, /PASS +Foundry account ai-x: holds claude-sonnet-5/);
  assert.match(text, /WARN +database region eastus: .*restricted/);
  assert.match(text, /PASS +database region centralus/);
  assert.equal(r.databaseRegions.join(','), 'centralus', 'only usable regions are passed on');
});

test('T-160 runPreflight fails, naming the fix, on a missing deployment, an untagged group without the option, a clash, or no usable region', async () => {
  const cases = [
    [{ ...ROUTES, '/accounts/ai-x/deployments': [200, { value: [] }] }, {}, /FAIL +Foundry account ai-x: no deployment named claude-sonnet-5/],
    [ROUTES, { useExisting: false }, /FAIL +resource group rg-gw: .*-UseExistingResourceGroup/],
    [{ ...ROUTES, '/resourceGroups/rg-gw/resources': [200, { value: [{ type: 'Microsoft.App/containerApps', name: 'ca-claude-gw', tags: {} }] }] }, {}, /FAIL +resource group rg-gw: .*ca-claude-gw/],
    [{ ...ROUTES, [`${PG}/locations/centralus/capabilities`]: [200, RESTRICTED] }, {}, /FAIL +database: no region in eastus, centralus offers/],
    [{ ...ROUTES, '/accounts/ai-x': [404, {}] }, {}, /FAIL +Foundry account ai-x: not found in rg-ai/],
  ];
  for (const [routes, extra, pattern] of cases) {
    const r = await runPreflight({ arm: fakeArm(routes).arm, ...INPUT, ...extra });
    assert.equal(r.ok, false, String(pattern));
    assert.match(r.lines.join('\n'), pattern);
  }
});

test('T-160 runPreflight: a missing group passes and is created; the sidecar database skips the region check', async () => {
  const routes = { ...ROUTES };
  delete routes['/resourceGroups/rg-gw'];
  delete routes['/resourceGroups/rg-gw/resources'];
  const { arm, calls } = fakeArm(routes);
  const r = await runPreflight({ arm, ...INPUT, useExisting: false, database: 'sidecar' });
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /PASS +resource group rg-gw: does not exist; the base stage creates it/);
  assert.ok(!calls.some((c) => c.includes('capabilities')));
});

test('T-159 createDatabaseFirst: tries regions in order, moves on only on a region refusal, cleans the failed server, records the one that worked', async () => {
  const tried = []; const deleted = [];
  const deploy = async (region) => {
    tried.push(region);
    if (region === 'eastus') throw new Error('deployment claude-gw-db Failed:\n  Microsoft.DBforPostgreSQL/flexibleServers: {"code":"SkuNotAvailable"}');
    return { pgServerName: `psql-claude-gw-abcd1234-${region}` };
  };
  const remove = async (region) => { deleted.push(region); };
  const r = await createDatabaseFirst({ regions: ['eastus', 'centralus', 'westus3'], existing: null, deploy, remove, say: () => {} });
  assert.deepEqual(r, { databaseLocation: 'centralus', pgServerName: 'psql-claude-gw-abcd1234-centralus' });
  assert.deepEqual(tried, ['eastus', 'centralus']);
  assert.deepEqual(deleted, ['eastus']);
  await assert.rejects(createDatabaseFirst({ regions: ['eastus'], existing: null, deploy, remove, say: () => {} }), /no region .* eastus/);
  await assert.rejects(createDatabaseFirst({ regions: ['westus'], existing: null, deploy: async () => { throw new Error('{"code":"InvalidParameterValue"}'); }, remove, say: () => {} }), /InvalidParameterValue/,
    'any other error stops at once');
  const existing = { name: 'psql-claude-gw-abcd1234-westus3', location: 'westus3' };
  tried.length = 0;
  const kept = await createDatabaseFirst({ regions: ['eastus', 'westus3'], existing, deploy, remove, say: () => {} });
  assert.deepEqual(kept, { databaseLocation: 'westus3', pgServerName: 'psql-claude-gw-abcd1234-westus3' }, 'an existing server is kept, with no deployment');
  assert.deepEqual(tried, []);
  await assert.rejects(createDatabaseFirst({ regions: ['eastus'], existing, deploy, remove, say: () => {} }), /already in westus3/);
});

test('T-158 code review: with Microsoft.DBforPostgreSQL not registered, the region checks answer 409; preflight warns and keeps the regions to try instead of failing', async () => {
  const routes = { ...ROUTES, [`${PG}`]: [200, { registrationState: 'NotRegistered' }],
    [`${PG}/locations/eastus/capabilities`]: [409, { error: { code: 'MissingSubscriptionRegistration' } }],
    [`${PG}/locations/centralus/capabilities`]: [409, { error: { code: 'MissingSubscriptionRegistration' } }] };
  const r = await runPreflight({ arm: fakeArm(routes).arm, ...INPUT });
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /WARN +database: Microsoft\.DBforPostgreSQL is NotRegistered/);
  assert.match(r.lines.join('\n'), /WARN +database region eastus: not checked/);
  assert.deepEqual(r.databaseRegions, ['eastus', 'centralus'], 'tried in order by the base stage, which registers the provider first');
});
test('T-158 live finding 2026-11-04: an installing account with no e-mail address and no deployment.emailClaim fails preflight, naming the fix', async () => {
  const base = { arm: fakeArm(ROUTES).arm, ...INPUT };
  const noMail = await runPreflight({ ...base, signedIn: { mail: null, upn: 'admin@contoso.example' }, emailClaim: undefined });
  assert.equal(noMail.ok, false);
  assert.match(noMail.lines.join('\n'), /FAIL +sign-in: .*admin@contoso\.example has no e-mail address.*"emailClaim": "preferred_username"/);
  const fixed = await runPreflight({ ...base, signedIn: { mail: null, upn: 'admin@contoso.example' }, emailClaim: 'preferred_username' });
  assert.equal(fixed.ok, true, fixed.lines.join('\n'));
  assert.match(fixed.lines.join('\n'), /PASS +sign-in: the gateway reads preferred_username/);
  const withMail = await runPreflight({ ...base, signedIn: { mail: 'admin@contoso.example', upn: 'admin@contoso.example' } });
  assert.equal(withMail.ok, true);
  assert.match(withMail.lines.join('\n'), /PASS +sign-in: the gateway reads the email claim/);
});