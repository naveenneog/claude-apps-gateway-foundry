import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { runRenewer } from '../admin-ui/server/signin-renewer.mjs';
import { selfSignedCertificate, thumbprints } from '../infra/azure-test/lib/x509.mjs';

// T-153 (P-45): the daily sign-in renewal, over a fake gateway app and a fake app registration.
const RID = '/subscriptions/s/resourceGroups/rg-gw/providers/Microsoft.App/containerApps/ca-claude-gw';
const OWN = 'gateway-test run-1';
const DAY = 86_400_000;

function world({ mode, endsInDays, now = new Date('2026-11-03T12:00:00Z'), readyAfter = 1, foreign = false }) {
  const calls = [];
  const state = { revision: 'ca--1', ready: 'ca--1', revisionCredential: { 'ca--1': null }, keyCredentials: [], passwords: [], secrets: {} };
  let credentialId;
  if (mode === 'certificate') {
    const c = selfSignedCertificate({ commonName: 'claude-gateway', months: 12, now: new Date(now.getTime() - (365 - endsInDays) * DAY) });
    // Make the running certificate end endsInDays from now.
    state.secrets['oidc-certificate'] = c.keyPem + c.certPem;
    credentialId = thumbprints(c.certPem).sha1Hex;
    state.keyCredentials = [{ customKeyIdentifier: credentialId, displayName: OWN, endDateTime: new Date(now.getTime() + endsInDays * DAY).toISOString() }];
  } else {
    credentialId = 'key-old';
    state.secrets['oidc-client-secret'] = 'old-secret-value';
    state.passwords = [{ keyId: 'key-old', displayName: OWN, endDateTime: new Date(now.getTime() + endsInDays * DAY).toISOString() }];
  }
  if (foreign) state.keyCredentials.push({ customKeyIdentifier: 'AB', displayName: 'someone else' });
  state.secrets['jwt-secret'] = 'jwt';
  state.revisionCredential['ca--1'] = credentialId;
  const env = () => [{ name: 'OIDC_CREDENTIAL_ID', value: state.revisionCredential[state.revision] }, { name: 'OTHER', value: 'x' }];
  const appJson = () => ({
    location: 'eastus', tags: { purpose: 'claude-apps-gateway-test', runId: 'run-1' }, identity: { type: 'UserAssigned' },
    properties: { provisioningState: 'Succeeded', latestRevisionName: state.revision, latestReadyRevisionName: state.ready,
      configuration: { secrets: Object.keys(state.secrets).map((name) => ({ name })) },
      template: { containers: [{ name: 'gateway', env: env() }] } },
  });
  let polls = 0;
  const arm = async (method, path, body) => {
    calls.push(`ARM ${method} ${path.split('?')[0].replace(RID, '')}`);
    if (method === 'GET' && path.startsWith(`${RID}/revisions/`)) {
      const name = decodeURIComponent(path.split('/revisions/')[1].split('?')[0]);
      return { status: 200, json: { properties: { template: { containers: [{ name: 'gateway', env: [{ name: 'OIDC_CREDENTIAL_ID', value: state.revisionCredential[name] }] }] } } } };
    }
    if (method === 'GET') {
      polls += 1;
      if (state.revision !== state.ready && polls >= readyAfter) state.ready = state.revision;
      return { status: 200, json: appJson() };
    }
    if (method === 'POST' && path.includes('/listSecrets')) return { status: 200, json: { value: Object.entries(state.secrets).map(([name, value]) => ({ name, value })) } };
    if (method === 'PUT') {
      for (const s of body.properties.configuration.secrets) state.secrets[s.name] = s.value;
      const next = `ca--${Number(state.revision.split('--')[1]) + 1}`;
      state.revisionCredential[next] = body.properties.template.containers[0].env.find((e) => e.name === 'OIDC_CREDENTIAL_ID').value;
      state.revision = next;
      polls = 0;
      return { status: 200, json: {} };
    }
    throw new Error(`unexpected ARM ${method} ${path}`);
  };
  const graph = async (method, path, body) => {
    calls.push(`GRAPH ${method} ${path.split('?')[0]}`);
    if (method === 'GET' && path.includes('keyCredentials')) return { status: 200, json: { keyCredentials: state.keyCredentials } };
    if (method === 'GET' && path.includes('passwordCredentials')) return { status: 200, json: { passwordCredentials: state.passwords } };
    if (method === 'PATCH') {
      state.keyCredentials = body.keyCredentials.map((k) => ({ customKeyIdentifier: crypto.createHash('sha1').update(Buffer.from(k.key, 'base64')).digest('hex').toUpperCase(), displayName: k.displayName }));
      return { status: 204, json: null };
    }
    if (method === 'POST' && path.endsWith('/addPassword')) {
      const p = { keyId: 'key-new', displayName: body.passwordCredential.displayName, endDateTime: body.passwordCredential.endDateTime };
      state.passwords.push(p);
      return { status: 200, json: { ...p, secretText: 'new-secret-value' } };
    }
    if (method === 'POST' && path.endsWith('/removePassword')) { state.passwords = state.passwords.filter((p) => p.keyId !== body.keyId); return { status: 204, json: null }; }
    throw new Error(`unexpected Graph ${method} ${path}`);
  };
  const logs = [];
  const run = (extra = {}) => runRenewer({ arm, graph, resourceId: RID, applicationId: 'app-obj', now: () => now, sleep: async () => {}, log: (l) => logs.push(JSON.parse(l)), ...extra });
  return { state, calls, logs, run, credentialId };
}

test('T-153 a certificate with more than 30 days left is left alone; nothing is written', async () => {
  const w = world({ mode: 'certificate', endsInDays: 200 });
  const r = await w.run();
  assert.equal(r.exitCode, 0);
  assert.equal(r.summary.action, 'reuse');
  assert.ok(!w.calls.some((c) => / (PUT|PATCH|POST) /.test(c) && !c.includes('listSecrets')), w.calls.join('\n'));
});

test('T-153 a certificate within 30 days is replaced in the gateway\'s order: register both, roll out, then keep only the new one', async () => {
  const w = world({ mode: 'certificate', endsInDays: 10 });
  const r = await w.run({ months: 6 });
  assert.equal(r.exitCode, 0, JSON.stringify(w.logs));
  assert.equal(r.summary.action, 'renewed');
  const pem = w.state.secrets['oidc-certificate'];
  const newThumb = thumbprints(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n/.exec(pem)[0]).sha1Hex;
  assert.notEqual(newThumb, w.credentialId);
  assert.equal(w.state.revisionCredential[w.state.ready], newThumb, 'the ready revision reads the new certificate');
  assert.deepEqual(w.state.keyCredentials.map((k) => k.customKeyIdentifier), [newThumb], 'the old one is removed only after the rollout');
  const order = w.calls.filter((c) => /PATCH|PUT/.test(c));
  assert.deepEqual(order, ['GRAPH PATCH /applications/app-obj', 'ARM PUT ', 'GRAPH PATCH /applications/app-obj']);
  assert.equal(w.state.secrets['jwt-secret'], 'jwt', 'the other secrets are written back unchanged');
  const months = Math.round((new Date(new crypto.X509Certificate(pem.slice(pem.indexOf('-----BEGIN CERTIFICATE'))).validTo) - new Date('2026-11-03T12:00:00Z')) / (30.4 * DAY));
  assert.equal(months, 6);
});

test('T-153 force (Renew now) replaces a certificate that is not due', async () => {
  const w = world({ mode: 'certificate', endsInDays: 200 });
  const r = await w.run({ force: true });
  assert.equal(r.summary.action, 'renewed');
});

test('T-153 a client secret within 30 days is replaced: add, roll out, then remove the old one', async () => {
  const w = world({ mode: 'secret', endsInDays: 5 });
  const r = await w.run({ secretDays: 365 });
  assert.equal(r.exitCode, 0, JSON.stringify(w.logs));
  assert.equal(w.state.secrets['oidc-client-secret'], 'new-secret-value');
  assert.equal(w.state.revisionCredential[w.state.ready], 'key-new');
  assert.deepEqual(w.state.passwords.map((p) => p.keyId), ['key-new']);
  assert.equal(new Date(w.state.passwords[0].endDateTime).toISOString().slice(0, 10), '2027-11-03');
  assert.equal(JSON.stringify(w.logs).includes('new-secret-value'), false, 'the secret never reaches the log');
});

test('T-153 a rollout that does not become ready leaves both credentials registered and exits 1', async () => {
  const w = world({ mode: 'certificate', endsInDays: 10, readyAfter: Infinity });
  const r = await w.run({ readyTimeoutMs: 0 });
  assert.equal(r.exitCode, 1);
  assert.equal(w.state.keyCredentials.length, 2, 'the running certificate stays registered');
});

test('T-153 a certificate not made by the installer stops the run before anything changes', async () => {
  const w = world({ mode: 'certificate', endsInDays: 10, foreign: true });
  const r = await w.run();
  assert.equal(r.exitCode, 1);
  assert.match(JSON.stringify(w.logs), /not made by the installer/);
  assert.ok(!w.calls.some((c) => /PATCH|PUT/.test(c)));
});
