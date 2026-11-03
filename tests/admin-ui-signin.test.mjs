import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSignInCredential } from '../admin-ui/server/signin-credential.mjs';
import { handleApi } from '../admin-ui/server/api.mjs';

// T-154 (P-45): the console's Sign-in credential card: status, and Renew now started in the background.
const RID = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/ca-claude-gw';
function fakes({ mode = 'certificate' } = {}) {
  const arm = async (method, path) => {
    if (method === 'POST') return { status: 200, json: { value: [{ name: mode === 'certificate' ? 'oidc-certificate' : 'oidc-client-secret', value: 'SECRET-VALUE' }] } };
    return { status: 200, json: { tags: { runId: 'run-1' }, properties: { template: { containers: [{ name: 'gateway', env: [{ name: 'OIDC_CREDENTIAL_ID', value: 'ABC123' }] }] } } } };
  };
  const graph = async (method, path) => {
    if (path.includes('keyCredentials')) return { status: 200, json: { keyCredentials: [{ customKeyIdentifier: 'ABC123', displayName: 'gateway-test run-1', endDateTime: '2027-11-03T12:00:00Z' }] } };
    return { status: 200, json: { passwordCredentials: [{ keyId: 'ABC123', displayName: 'gateway-test run-1', endDateTime: '2027-06-01T00:00:00Z' }] } };
  };
  return { arm, graph };
}

test('T-154 status: the mode, the credential the gateway reads, when it ends, the renewal settings, and no secret value', async () => {
  for (const [mode, ends] of [['certificate', '2027-11-03T12:00:00Z'], ['secret', '2027-06-01T00:00:00Z']]) {
    const s = createSignInCredential({ ...fakes({ mode }), resourceId: RID, applicationId: 'obj', months: 12, secretDays: 365, now: () => new Date('2026-11-03T12:00:00Z') });
    const status = await s.status();
    assert.equal(status.mode, mode);
    assert.equal(status.credentialId, 'ABC123');
    assert.equal(status.endsAt, ends);
    assert.equal(status.renewsWithinDays, 30);
    assert.ok(status.daysLeft > 200);
    assert.deepEqual(status.defaults, { months: 12, secretDays: 365 });
    assert.equal(JSON.stringify(status).includes('SECRET-VALUE'), false);
  }
});

test('T-154 renew starts one run in the background with force and the chosen months; a second while it runs is refused; months are checked', async () => {
  let release; const started = [];
  const renewer = (opts) => { started.push(opts); return new Promise((r) => { release = () => r({ exitCode: 0, summary: { action: 'renewed', credentialId: 'NEW' } }); }); };
  const s = createSignInCredential({ ...fakes(), resourceId: RID, applicationId: 'obj', months: 12, secretDays: 365, renewer });
  const first = await s.renew({ months: 6 });
  assert.equal(first.started, true);
  assert.equal(started[0].force, true);
  assert.equal(started[0].months, 6);
  await assert.rejects(s.renew({}), (e) => e.status === 409);
  assert.equal((await s.status()).lastRun.state, 'running');
  release(); await new Promise((r) => setImmediate(r));
  assert.equal((await s.status()).lastRun.state, 'renewed');
  for (const months of [0, 25, 'x', 1.5]) await assert.rejects(s.renew({ months }), (e) => e.status === 400, String(months));
  await s.renew({});
  assert.equal(started[1].months, 12, 'absent: the installed default');
});

test('T-154 API: GET /api/sign-in-credential for a signed-in admin; POST .../renew starts a renewal (202); without sign-in a write is refused', async () => {
  const calls = [];
  const signInCredential = { status: async () => ({ mode: 'certificate' }), renew: async (b) => { calls.push(b); return { started: true }; } };
  const principal = Buffer.from(JSON.stringify({ auth_typ: 'aad', claims: [{ typ: 'preferred_username', val: 'admin@contoso.example' },
    { typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: '9a9a9a9a-0000-4000-8000-000000000001' }, { typ: 'roles', val: 'AdminUi.Admin' }] })).toString('base64');
  const req = (method, pathname, body, headers = { 'x-ms-client-principal': principal }) => ({ method, pathname, searchParams: new URLSearchParams(), body, headers });
  const deps = { auth: { signIn: 'required' }, signInCredential };
  const get = await handleApi(req('GET', '/api/sign-in-credential'), deps);
  assert.equal(get.status, 200);
  assert.equal(get.body.mode, 'certificate');
  const post = await handleApi(req('POST', '/api/sign-in-credential/renew', { months: 6 }), deps);
  assert.equal(post.status, 202, JSON.stringify(post.body));
  assert.deepEqual(calls, [{ months: 6 }]);
  const off = await handleApi(req('POST', '/api/sign-in-credential/renew', {}, {}), { auth: { signIn: 'off' }, signInCredential });
  assert.equal(off.status, 403, 'with sign-in off every write route answers 403');
  assert.equal(calls.length, 1);
  assert.equal((await handleApi(req('GET', '/api/sign-in-credential'), { auth: { signIn: 'required' } })).status, 503, 'not configured');
});