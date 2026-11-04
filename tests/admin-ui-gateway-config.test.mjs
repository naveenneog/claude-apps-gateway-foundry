// T-98: admin-ui/server/gateway-config.mjs - reads, previews and writes the gateway's configuration through Azure
// Resource Manager (ADR-0010). The fake app below has the shape of the live Contoso gateway app read on 2026-10-24
// (secret names, the gateway-config secret volume, a postgres container on an EmptyDir volume); values are invented.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { adminVersion, createConfigStore, describeChanges } from '../admin-ui/server/gateway-config.mjs';

const root = path.join(import.meta.dirname, '..');
const contosoAdmin = JSON.parse(fs.readFileSync(path.join(root, 'config', 'gateway-admin.azure-contoso.json'), 'utf8'));
const contosoYaml = fs.readFileSync(path.join(root, 'config', 'gateway.azure-contoso.yaml'), 'utf8').replace(/\r\n/g, '\n');
const ID = '/subscriptions/sub-1/resourceGroups/rg-gw/providers/Microsoft.App/containerApps/ca-claude-gw';
const KNOWN = ['Gateway.Standard', 'Gateway.Premium', 'Gateway.Trial'];

test('T-167 review names Desktop capability-only changes', () => {
  const before = { policies: [{ role: 'Gateway.Premium', models: ['claude-sonnet-5'], desktop: true }] };
  const after = structuredClone(before);
  after.policies[0].desktopSettings = { userPluginUploadsEnabled: true, claudeAiImport: { enabled: true } };
  const changes = describeChanges(before, after);
  assert.ok(changes.some((line) => /Gateway.Premium.*userPluginUploadsEnabled.*true/.test(line)), changes.join('\n'));
  assert.ok(changes.some((line) => /Gateway.Premium.*claudeAiImport.*enabled/.test(line)), changes.join('\n'));
  assert.equal(describeChanges(after, after).length, 0);
});

function fakeApp({ adminFile, temporaryDatabase = true } = {}) {
  const secrets = { 'pg-password': 'pg-secret', 'azure-client-secret-crosstenant': 'xt-secret', 'admin-write-key': 'awk', 'gateway-config': contosoYaml, 'jwt-secret': 'jwt', 'oidc-client-secret': 'oidc' };
  if (adminFile !== undefined) secrets['gateway-admin-file'] = adminFile;
  const app = {
    id: ID, name: 'ca-claude-gw', location: 'East US 2', type: 'Microsoft.App/containerApps', etag: '"etag-1"', tags: { owner: 'x' },
    identity: { type: 'UserAssigned', userAssignedIdentities: { '/id/gw': {} } },
    systemData: { createdBy: 'someone', lastModifiedAt: '2026-10-24T09:00:00Z' },
    properties: {
      provisioningState: 'Succeeded', runningStatus: 'Running', latestRevisionName: 'ca-claude-gw--0000004', latestReadyRevisionName: 'ca-claude-gw--0000004',
      configuration: {
        activeRevisionsMode: 'Single',
        ingress: { fqdn: 'ca-claude-gw.example.azurecontainerapps.io', customDomains: [] },
        secrets: [...Object.keys(secrets).map((name) => ({ name })), { name: 'kv-secret', keyVaultUrl: 'https://kv.vault.azure.net/secrets/x', identity: '/id/gw' }],
      },
      template: {
        containers: [
          { name: 'gateway', image: 'acr/gw@sha256:1', volumeMounts: [{ mountPath: '/etc/claude', volumeName: 'gateway-config' }],
            env: [{ name: 'AZURE_CLIENT_SECRET', secretRef: 'azure-client-secret-crosstenant' }, { name: 'SECRETS_UPDATED_AT', value: 's0' }, { name: 'CONFIG_UPDATED_AT', value: 'c0' }] },
          { name: 'postgres', image: 'postgres:16', volumeMounts: [{ mountPath: '/var/lib/postgresql/data', volumeName: 'pgdata' }], env: [{ name: 'POSTGRES_PASSWORD', secretRef: 'pg-password' }] },
        ],
        volumes: [
          { name: 'gateway-config', storageType: 'Secret', secrets: [{ path: 'gateway.yaml', secretRef: 'gateway-config' }] },
          { name: 'pgdata', storageType: temporaryDatabase ? 'EmptyDir' : 'AzureFile', storageName: temporaryDatabase ? undefined : 'pgshare' },
        ],
      },
    },
  };
  return { app, secrets };
}

function fakeArm(state) {
  const calls = [];
  const revisions = state.revisions ?? {};
  let gets = 0;
  async function arm(method, p, body, options = {}) {
    calls.push({ method, path: p, body: body === undefined ? undefined : structuredClone(body), ifMatch: options.ifMatch });
    const [pathname, qs] = p.split('?');
    assert.match(qs ?? '', /api-version=2025-07-01/, `${method} ${p} names the api-version`);
    if (method === 'GET' && pathname === ID) {
      const json = structuredClone(state.app);
      gets += 1;
      state.afterGet?.(gets);
      return { status: 200, json };
    }
    if (method === 'POST' && pathname === `${ID}/listSecrets`) {
      return { status: 200, json: { value: state.app.properties.configuration.secrets.map((s) => (s.keyVaultUrl ? { ...s, value: '' } : { name: s.name, value: state.secrets[s.name] })) } };
    }
    if (method === 'PUT' && pathname === ID) {
      if (state.app.etag !== undefined && options.ifMatch !== (state.forceEtagMismatch ? '"etag-2"' : state.app.etag)) {
        throw Object.assign(new Error('ARM conditional update failed'), { status: 412 });
      }
      state.put = body;
      if (state.applyPut) {
        for (const s of body.properties.configuration.secrets) if (typeof s.value === 'string') state.secrets[s.name] = s.value;
        state.app.properties.configuration.secrets = body.properties.configuration.secrets.map(({ value, ...rest }) => rest);
        state.app.properties.template = body.properties.template;
        state.app.systemData.lastModifiedAt = new Date(Date.parse(state.app.systemData.lastModifiedAt) + 1000).toISOString();
      }
      return { status: 201, json: body };
    }
    const rev = pathname.match(/\/revisions\/([^/]+)$/);
    if (method === 'GET' && rev) return { status: 200, json: { name: rev[1], properties: revisions[rev[1]] } };
    throw Object.assign(new Error(`fake ARM: no route for ${method} ${p}`), { status: 500 });
  }
  return { arm, calls };
}

function store(state, extra = {}) {
  const { arm, calls } = fakeArm(state);
  const s = createConfigStore({
    arm, resourceId: ID, deployAdmin: contosoAdmin, topology: 'test', adminFilePath: 'config/gateway-admin.azure-contoso.json',
    knownRoles: async () => KNOWN, now: () => new Date('2026-10-24T10:00:00Z'), ...extra,
  });
  return { s, calls };
}

const fileText = (admin) => `${JSON.stringify(admin, null, 2)}\n`;
const edited = () => {
  const admin = structuredClone(contosoAdmin);
  admin.models.push({ id: 'claude-haiku-5', label: 'Claude Haiku 5', deployment: 'claude-haiku-5' });
  admin.policies[0].models = [...admin.policies[0].models, 'claude-haiku-5'];
  return admin;
};

test('T-98 read with no gateway-admin-file secret returns the deploy-time admin file and its version, and no secret value', async () => {
  const state = fakeApp();
  const { s } = store(state);
  const r = await s.read();
  assert.equal(r.source, 'deploy');
  assert.deepEqual(r.admin, contosoAdmin);
  assert.equal(r.version, adminVersion(contosoAdmin));
  assert.match(r.version, /^[0-9a-f]{64}$/);
  assert.equal(r.deployFileMatches, true, 'the live gateway.yaml is the rendering of the deploy file');
  assert.deepEqual(r.gateway, { app: 'ca-claude-gw', revision: 'ca-claude-gw--0000004', url: 'https://ca-claude-gw.example.azurecontainerapps.io' });
  const text = JSON.stringify(r);
  for (const v of ['pg-secret', 'xt-secret', 'jwt', 'oidc', 'awk']) assert.ok(!text.includes(`"${v}"`), `read must not return the secret value ${v}`);
});

test('T-98 read prefers the live gateway-admin-file secret and reports when it differs from the deploy file', async () => {
  const live = edited();
  const { s } = store(fakeApp({ adminFile: fileText(live) }));
  const r = await s.read();
  assert.equal(r.source, 'live');
  assert.deepEqual(r.admin, live);
  assert.equal(r.deployFileMatches, false);
});

test('T-98 the client URL prefers an enabled custom domain and ignores disabled domains', async () => {
  const state = fakeApp();
  state.app.properties.configuration.ingress.customDomains = [
    { name: 'claude-gateway.corp.example', bindingType: 'SniEnabled' },
    { name: 'disabled.example', bindingType: 'Disabled' },
  ];
  assert.equal((await store(state).s.read()).gateway.url, 'https://claude-gateway.corp.example');
});

test('T-98 read reports a temporary database when a container of the gateway app mounts an EmptyDir volume', async () => {
  const a = await store(fakeApp()).s.read();
  assert.equal(a.restart.temporaryDatabase, true);
  assert.match(a.restart.warning, /spend/i);
  const b = await store(fakeApp({ temporaryDatabase: false })).s.read();
  assert.deepEqual(b.restart, { temporaryDatabase: false, warning: null });
});

test('T-98 preview renders byte-identically to the repository rendering of the same admin file', async () => {
  const { s } = store(fakeApp());
  const p = await s.preview(contosoAdmin);
  assert.deepEqual(p.errors, []);
  assert.equal(p.yaml, contosoYaml);
  assert.deepEqual(p.changes, []);
});

test('T-98 preview of an invalid admin file returns adminErrors and no YAML', async () => {
  const admin = structuredClone(contosoAdmin);
  admin.policies[0].models = ['claude-nope'];
  const p = await store(fakeApp()).s.preview(admin);
  assert.equal(p.yaml, null);
  assert.ok(p.errors.some((e) => /claude-nope is not in models/.test(e)), p.errors.join('\n'));
});

test('T-98 describeChanges names added models and changed policy models and desktop access', () => {
  const after = edited();
  after.policies[1].desktop = !contosoAdmin.policies[1].desktop;
  const lines = describeChanges(contosoAdmin, after);
  assert.ok(lines.some((l) => /model claude-haiku-5 added/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith(`${contosoAdmin.policies[0].role}: models`) && l.includes('claude-haiku-5')), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith(`${contosoAdmin.policies[1].role}: Claude Desktop`)), lines.join('\n'));
});

test('T-98 write sends one PUT that keeps every other secret and env value and starts a new revision', async () => {
  const state = fakeApp({ temporaryDatabase: false });
  const { s, calls } = store(state);
  const before = await s.read();
  const admin = edited();
  const result = await s.write({ admin, baseVersion: before.version });
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);
  assert.equal(calls.find((c) => c.method === 'PUT').ifMatch, '"etag-1"', 'the full-resource PUT is conditional on the GET ETag');
  const put = state.put;
  const sent = Object.fromEntries(put.properties.configuration.secrets.map((x) => [x.name, x]));
  for (const [name, value] of Object.entries(state.secrets)) {
    if (name === 'gateway-config') continue;
    assert.equal(sent[name]?.value, value, `secret ${name} is sent back unchanged`);
  }
  assert.deepEqual(sent['kv-secret'], { name: 'kv-secret', keyVaultUrl: 'https://kv.vault.azure.net/secrets/x', identity: '/id/gw' }, 'a Key Vault reference stays a reference');
  assert.equal(sent['gateway-admin-file'].value, fileText(admin));
  assert.equal(sent['gateway-config'].value, (await s.preview(admin)).yaml);
  assert.notEqual(sent['gateway-config'].value, contosoYaml);
  const gw = put.properties.template.containers[0];
  assert.deepEqual(gw.env.find((e) => e.name === 'CONFIG_UPDATED_AT'), { name: 'CONFIG_UPDATED_AT', value: '2026-10-24T10:00:00.000Z' });
  const oldTemplate = structuredClone(state.app.properties.template);
  oldTemplate.containers[0].env.find((e) => e.name === 'CONFIG_UPDATED_AT').value = '2026-10-24T10:00:00.000Z';
  assert.deepEqual(put.properties.template, oldTemplate, 'nothing else in the template changes');
  assert.equal(put.identity.type, 'UserAssigned');
  assert.equal(put.location, 'East US 2');
  assert.equal(put.systemData, undefined);
  assert.equal(result.version, adminVersion(admin));
  assert.deepEqual(result.rollout, { previousRevision: 'ca-claude-gw--0000004', requestedAt: '2026-10-24T10:00:00.000Z' });
  assert.ok(!JSON.stringify(result).includes('pg-secret'));
});

test('T-98 write refuses a stale version with 409 and sends no PUT', async () => {
  const state = fakeApp({ temporaryDatabase: false });
  const { s, calls } = store(state);
  await assert.rejects(s.write({ admin: edited(), baseVersion: 'f'.repeat(64) }), (e) => e.status === 409 && e.details.currentVersion === adminVersion(contosoAdmin));
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
});

test('T-98 write refuses when ARM rejects a stale ETag and returns the current client version for reload', async () => {
  const state = fakeApp({ temporaryDatabase: false });
  state.forceEtagMismatch = true;
  const { s, calls } = store(state);
  await assert.rejects(s.write({ admin: edited(), baseVersion: adminVersion(contosoAdmin) }),
    (e) => e.status === 409 && e.details.currentVersion === adminVersion(contosoAdmin));
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1, 'the conditional request was attempted');
  assert.equal(state.put, undefined, 'ARM rejected the write before changing the resource');
});

test('T-98 without an ETag (live Container Apps behaviour, U-94) write re-reads the app and sends an unconditional PUT when nothing changed', async () => {
  const state = fakeApp({ temporaryDatabase: false });
  delete state.app.etag;
  const { s, calls } = store(state);
  await s.write({ admin: edited(), baseVersion: adminVersion(contosoAdmin) });
  const appCalls = calls.filter((c) => c.path.split('?')[0] === ID);
  assert.deepEqual(appCalls.map((c) => c.method), ['GET', 'GET', 'PUT'], 'the app is read again immediately before the PUT');
  assert.equal(appCalls[2].ifMatch, undefined, 'no invented If-Match is sent');
  assert.ok(state.put, 'the configuration was written');
});

test('T-98 without an ETag write refuses with 409 and sends no PUT when the app was modified after it was read', async () => {
  const state = fakeApp({ temporaryDatabase: false });
  delete state.app.etag;
  state.afterGet = (n) => { if (n === 1) state.app.systemData.lastModifiedAt = '2026-10-24T09:59:59Z'; };
  const { s, calls } = store(state);
  await assert.rejects(s.write({ admin: edited(), baseVersion: adminVersion(contosoAdmin) }),
    (e) => e.status === 409 && /changed while/.test(e.message) && e.details.currentVersion === adminVersion(contosoAdmin));
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
  assert.equal(state.put, undefined);
});

test('T-98 without an ETag write refuses with 409 when a new revision appeared after the app was read', async () => {
  const state = fakeApp({ temporaryDatabase: false });
  delete state.app.etag;
  state.afterGet = (n) => { if (n === 1) state.app.properties.latestRevisionName = 'ca-claude-gw--0000005'; };
  const { s, calls } = store(state);
  await assert.rejects(s.write({ admin: edited(), baseVersion: adminVersion(contosoAdmin) }), (e) => e.status === 409);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
});

test('T-98 two saves started together from the same version write once: the second answers 409 and sends no PUT', async () => {
  const state = fakeApp({ temporaryDatabase: false });
  delete state.app.etag;
  state.applyPut = true;
  const { s, calls } = store(state);
  const base = adminVersion(contosoAdmin);
  const other = edited();
  other.models[0].label = 'Renamed by a second admin';
  const outcomes = await Promise.allSettled([s.write({ admin: edited(), baseVersion: base }), s.write({ admin: other, baseVersion: base })]);
  assert.deepEqual(outcomes.map((o) => o.status), ['fulfilled', 'rejected']);
  assert.equal(outcomes[1].reason.status, 409);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1, 'the second save did not overwrite the first');
});

test('T-98 write refuses with 502 when ARM returns neither an ETag nor a last-modified time', async () => {
  const state = fakeApp({ temporaryDatabase: false });
  delete state.app.etag;
  delete state.app.systemData.lastModifiedAt;
  const { s, calls } = store(state);
  await assert.rejects(s.write({ admin: edited(), baseVersion: adminVersion(contosoAdmin) }),
    (e) => e.status === 502 && /etag/i.test(e.message) && /lastModifiedAt/.test(e.message));
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
});

test('T-98 write refuses an invalid admin file with 400 naming each error and sends no PUT', async () => {
  const state = fakeApp({ temporaryDatabase: false });
  const { s, calls } = store(state);
  const admin = edited();
  admin.roles.push('Gateway.Unknown');
  await assert.rejects(s.write({ admin, baseVersion: adminVersion(contosoAdmin) }), (e) => e.status === 400 && e.details.errors.some((m) => /Gateway.Unknown/.test(m)));
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
});

test('T-98 write on a gateway with a temporary database needs acknowledgeDataLoss, else 428 and no PUT', async () => {
  const state = fakeApp();
  const { s, calls } = store(state);
  await assert.rejects(s.write({ admin: edited(), baseVersion: adminVersion(contosoAdmin) }), (e) => e.status === 428 && e.details.requiresAcknowledgement === true);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
  await s.write({ admin: edited(), baseVersion: adminVersion(contosoAdmin), acknowledgeDataLoss: true });
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);
});

test('T-98 write refuses when no container mounts the gateway-config secret, since no revision would start', async () => {
  const state = fakeApp({ temporaryDatabase: false });
  state.app.properties.template.containers[0].volumeMounts = [];
  const { s, calls } = store(state);
  await assert.rejects(s.write({ admin: edited(), baseVersion: adminVersion(contosoAdmin) }), /gateway-config/);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
});

test('T-98 rollout is done only when a new revision is the latest ready one and healthy', async () => {
  const state = fakeApp();
  state.app.properties.latestRevisionName = 'ca-claude-gw--0000005';
  state.app.properties.provisioningState = 'InProgress';
  state.revisions = { 'ca-claude-gw--0000005': { provisioningState: 'Provisioning', runningState: 'Processing', healthState: 'None' } };
  const { s } = store(state);
  let r = await s.rollout('ca-claude-gw--0000004');
  assert.equal(r.latestRevision, 'ca-claude-gw--0000005');
  assert.equal(r.done, false);
  assert.equal(r.failed, false);
  state.app.properties.provisioningState = 'Succeeded';
  state.revisions['ca-claude-gw--0000005'] = { provisioningState: 'Provisioned', runningState: 'Running', healthState: 'Healthy' };
  r = await s.rollout('ca-claude-gw--0000004');
  assert.equal(r.done, false, 'a healthy new revision that is not yet the latest ready one is not done');
  state.app.properties.provisioningState = 'Succeeded';
  state.app.properties.latestReadyRevisionName = 'ca-claude-gw--0000005';
  state.revisions['ca-claude-gw--0000005'] = { provisioningState: 'Provisioned', runningState: 'Running', healthState: 'Healthy' };
  r = await s.rollout('ca-claude-gw--0000004');
  assert.equal(r.done, true);
  assert.equal(r.healthy, true);
  r = await s.rollout('ca-claude-gw--0000005');
  assert.equal(r.done, false, 'no new revision since the one named yet');
  state.app.properties.latestRevisionName = 'ca-claude-gw--0000006';
  state.revisions['ca-claude-gw--0000006'] = { provisioningState: 'Failed', runningState: 'Failed', healthState: 'Unhealthy' };
  r = await s.rollout('ca-claude-gw--0000005');
  assert.equal(r.failed, true);
  assert.equal(r.done, false);
});

// T-115 (ADR-0012): the move to the managed database is one write through this store, with a reshape of the app.
test('T-115 write with a reshape changes the app template and named secrets in the same PUT, and keeps everything else', async () => {
  const state = fakeApp({ temporaryDatabase: true });
  delete state.app.etag;
  const { s } = store(state);
  const admin = structuredClone(contosoAdmin);
  admin.deployment = { ...admin.deployment, database: 'managed' };
  await s.write({ admin, baseVersion: adminVersion(contosoAdmin), acknowledgeDataLoss: true, reshape: ({ template, secret, setSecret }) => {
    template.containers = template.containers.filter((c) => c.name !== 'postgres');
    template.volumes = template.volumes.filter((v) => v.name !== 'pgdata');
    template.containers[0].env.push({ name: 'GATEWAY_PG_HOST', value: 'psql.example' });
    setSecret('pg-password', `${secret('pg-password')}A`);
  } });
  const put = state.put;
  assert.deepEqual(put.properties.template.containers.map((c) => c.name), ['gateway']);
  assert.deepEqual(put.properties.template.volumes.map((v) => v.name), ['gateway-config']);
  assert.ok(put.properties.template.containers[0].env.some((e) => e.name === 'GATEWAY_PG_HOST' && e.value === 'psql.example'));
  const secrets = Object.fromEntries(put.properties.configuration.secrets.map((x) => [x.name, x]));
  assert.equal(secrets['pg-password'].value, 'pg-secretA');
  assert.equal(secrets['jwt-secret'].value, 'jwt', 'other secrets keep their values');
  assert.match(secrets['gateway-config'].value, /postgres_url: "postgres:\/\/gateway@\$\{GATEWAY_PG_HOST\}:5432\/gateway\?sslmode=require"/);
  assert.equal(JSON.parse(secrets['gateway-admin-file'].value).deployment.database, 'managed');
});

test('T-115 a reshape cannot rename or drop a secret, so a mistake cannot remove one the app needs', async () => {
  const state = fakeApp({ temporaryDatabase: true });
  delete state.app.etag;
  const { s, calls } = store(state);
  await assert.rejects(s.write({ admin: contosoAdmin, baseVersion: adminVersion(contosoAdmin), acknowledgeDataLoss: true,
    reshape: ({ setSecret }) => setSecret('no-such-secret', 'x') }), /no-such-secret/);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
});

test('T-115 a save that changes deployment.database without the move is refused with 409 and sends no PUT', async () => {
  for (const [from, to] of [[undefined, 'managed'], ['managed', 'sidecar'], ['managed', undefined]]) {
    const state = fakeApp({ temporaryDatabase: from !== 'managed' });
    delete state.app.etag;
    const live = structuredClone(contosoAdmin);
    if (from) live.deployment = { ...live.deployment, database: from }; else delete live.deployment?.database;
    state.secrets['gateway-admin-file'] = `${JSON.stringify(live, null, 2)}\n`;
    state.app.properties.configuration.secrets.push({ name: 'gateway-admin-file' });
    const { s, calls } = store(state);
    const next = structuredClone(live);
    if (to) next.deployment = { ...next.deployment, database: to }; else delete next.deployment.database;
    await assert.rejects(s.write({ admin: next, baseVersion: adminVersion(live), acknowledgeDataLoss: true }),
      (e) => e.status === 409 && /move-to-managed-database/.test(e.message), `${from} -> ${to}`);
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
  }
});

// T-136 (ADR-0014): the rendered configuration reads ${GATEWAY_ADMIN_PACER_KEY} once pacing is on, and the gateway does
// not start with an undefined variable, so the save needs the variable on the container that mounts the config.
const withPacing = () => ({ ...structuredClone(contosoAdmin), spendPacing: { softLimitPercent: 80 } });

test('T-136 negative: turning pacing on for a gateway without GATEWAY_ADMIN_PACER_KEY is refused with 409 and nothing is written', async () => {
  const state = fakeApp({ temporaryDatabase: false });
  const { s, calls } = store(state);
  await assert.rejects(s.write({ admin: withPacing(), baseVersion: adminVersion(contosoAdmin) }),
    (e) => e.status === 409 && /GATEWAY_ADMIN_PACER_KEY/.test(e.message) && /app stage/.test(e.message));
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
});

test('T-136 with the variable on the gateway container, the save goes through and the change list names the soft limit', async () => {
  const state = fakeApp({ temporaryDatabase: false });
  state.app.properties.template.containers[0].env.push({ name: 'GATEWAY_ADMIN_PACER_KEY', secretRef: 'admin-pacer-key' });
  const { s, calls } = store(state);
  await s.write({ admin: withPacing(), baseVersion: adminVersion(contosoAdmin) });
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);
  assert.match(state.put.properties.configuration.secrets.find((x) => x.name === 'gateway-config').value, /- id: spend-pacer/);
  assert.ok(describeChanges(contosoAdmin, withPacing()).includes('soft limit: off → 80% of the monthly cap'));
  assert.ok(describeChanges(withPacing(), contosoAdmin).includes('soft limit: 80% of the monthly cap → off'));
});
