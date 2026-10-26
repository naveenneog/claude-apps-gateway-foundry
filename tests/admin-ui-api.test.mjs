// T-83: admin-ui/server/api.mjs, the framework-free API router. Fakes both data sources: scripts/admin/set-developer.mjs's
// own logic is already tested in tests/admin-developer.test.mjs, so here only the routing/wiring is under test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../admin-ui/server/api.mjs';

const req = (method, path, body) => {
  const [pathname, qs] = path.split('?');
  return { method, pathname, searchParams: new URLSearchParams(qs ?? ''), body };
};

function fakeDeps({ gatewayCalls = [], developerCalls = [] } = {}) {
  const gatewayFns = {
    listSpendLimits: async (...a) => { gatewayCalls.push(['listSpendLimits', ...a]); return { data: [] }; },
  };
  return {
    gateway: { baseUrl: 'https://gw', writeKey: 'k' },
    developers: {
      setDeveloper: async (args) => { developerCalls.push(['setDeveloper', args]); return { changed: true, message: 'ok' }; },
      listDevelopers: async (args) => { developerCalls.push(['listDevelopers', args]); return [{ role: 'Gateway.Standard', name: 'A', principalId: '1' }]; },
    },
    developersDeps: { graph: 'fake-graph', servicePrincipalId: 'sp-1', appRoles: [], admittedRoles: ['Gateway.Standard'] },
    gatewayFns,
  };
}

test('T-83 GET /api/health answers ok without touching any backend', async () => {
  const res = await handleApi(req('GET', '/api/health'), fakeDeps());
  assert.deepEqual(res, { status: 200, body: { ok: true } });
});

test('T-83 unknown paths and methods answer 404, not a crash', async () => {
  assert.equal((await handleApi(req('GET', '/api/nope'), fakeDeps())).status, 404);
  assert.equal((await handleApi(req('PATCH', '/api/developers'), fakeDeps())).status, 404);
});

test('T-83 POST /api/spend-limits refuses a malformed body before calling the gateway', async () => {
  const res = await handleApi(req('POST', '/api/spend-limits', { amountCents: 100 }), fakeDeps());
  assert.equal(res.status, 400);
});

test('T-83 POST /api/spend-limits forwards a well-formed body to the gateway client and returns its result', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'spl_1' }) }; };
  const deps = fakeDeps();
  deps.gateway = { baseUrl: 'https://gw.example.com', writeKey: 'wk', fetch: fetchImpl };
  const res = await handleApi(req('POST', '/api/spend-limits', { scope: { type: 'organization' }, amountCents: 50000, period: 'monthly' }), deps);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, 'spl_1');
  assert.equal(calls[0].url, 'https://gw.example.com/v1/organizations/spend_limits');
  assert.equal(calls[0].init.headers['x-api-key'], 'wk');
});

test('T-83 GET /api/spend-limits/effective forwards query parameters, including repeated user_ids[]', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) }; };
  const deps = fakeDeps();
  deps.gateway = { baseUrl: 'https://gw.example.com', writeKey: 'wk', fetch: fetchImpl };
  const res = await handleApi(req('GET', '/api/spend-limits/effective?user_ids[]=a&user_ids[]=b&sort=spend_desc&period[]=monthly'), deps);
  assert.equal(res.status, 200);
  const url = new URL(calls[0]);
  assert.deepEqual(url.searchParams.getAll('user_ids[]'), ['a', 'b']);
  assert.equal(url.searchParams.get('sort'), 'spend_desc');
});

test('T-83 DELETE /api/spend-limits/:id calls the gateway\'s delete endpoint with that id', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => JSON.stringify({ type: 'spend_limit_deleted' }) }; };
  const deps = fakeDeps();
  deps.gateway = { baseUrl: 'https://gw.example.com', writeKey: 'wk', fetch: fetchImpl };
  const res = await handleApi(req('DELETE', '/api/spend-limits/spl_42'), deps);
  assert.equal(res.status, 200);
  assert.equal(calls[0].init.method, 'DELETE');
  assert.match(calls[0].url, /spend_limits\/spl_42$/);
});

test('T-83 GET /api/developers calls listDevelopers with the configured service principal context', async () => {
  const developerCalls = [];
  const deps = fakeDeps({ developerCalls });
  const res = await handleApi(req('GET', '/api/developers'), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.developers, [{ role: 'Gateway.Standard', name: 'A', principalId: '1' }]);
  assert.equal(developerCalls[0][0], 'listDevelopers');
  assert.equal(developerCalls[0][1].servicePrincipalId, 'sp-1');
});

test('T-83 POST /api/developers grants a role, and DELETE removes it, both via the shared setDeveloper call', async () => {
  const developerCalls = [];
  const deps = fakeDeps({ developerCalls });
  await handleApi(req('POST', '/api/developers', { upn: 'dev@contoso.com', role: 'Gateway.Standard' }), deps);
  await handleApi(req('DELETE', '/api/developers', { upn: 'dev@contoso.com', role: 'Gateway.Standard' }), deps);
  assert.equal(developerCalls[0][1].remove, false);
  assert.equal(developerCalls[1][1].remove, true);
  assert.equal(developerCalls[0][1].upn, 'dev@contoso.com');
});

test('T-83 POST /api/developers without upn or role is refused before calling setDeveloper', async () => {
  const developerCalls = [];
  const deps = fakeDeps({ developerCalls });
  const res = await handleApi(req('POST', '/api/developers', { upn: 'dev@contoso.com' }), deps);
  assert.equal(res.status, 400);
  assert.equal(developerCalls.length, 0);
});

test('T-83 a thrown gateway/Graph error becomes a JSON error response, not an unhandled rejection', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: 'rate limited' } }) });
  const deps = fakeDeps();
  deps.gateway = { baseUrl: 'https://gw.example.com', writeKey: 'wk', fetch: fetchImpl };
  const res = await handleApi(req('GET', '/api/spend-limits'), deps);
  assert.equal(res.status, 429);
  assert.match(res.body.error, /rate limited/);
});

test('T-83 an error with no .status becomes a 502, not a 200 or an uncaught throw', async () => {
  const deps = fakeDeps();
  deps.developers.listDevelopers = async () => { throw new Error('boom'); };
  const res = await handleApi(req('GET', '/api/developers'), deps);
  assert.equal(res.status, 502);
  assert.match(res.body.error, /boom/);
});

// T-103: sign-in enforcement on the write routes ADR-0010 adds, and their wiring. X-MS-CLIENT-PRINCIPAL is the
// base64 JSON Container Apps authentication sets (https://learn.microsoft.com/en-us/azure/container-apps/authentication);
// it is trusted only when ADMIN_UI_SIGN_IN=required, because the platform strips it from external requests only then (U-87).
const principal = (roles, name = 'admin@contoso.example') => Buffer.from(JSON.stringify({
  auth_typ: 'aad', name_typ: 'preferred_username', role_typ: 'roles',
  claims: [{ typ: 'preferred_username', val: name }, { typ: 'name', val: 'Admin One' }, ...roles.map((val) => ({ typ: 'roles', val }))],
})).toString('base64');
const withHeaders = (r, headers) => ({ ...r, headers });

function writeDeps(signIn) {
  const calls = [];
  const deps = fakeDeps();
  deps.auth = { signIn };
  deps.configStore = {
    read: async () => ({ admin: { roles: [] }, version: 'v1' }),
    preview: async (admin) => { calls.push(['preview', admin]); return { errors: [], yaml: 'y', changes: [] }; },
    write: async (args) => { calls.push(['write', args]); return { version: 'v2', rollout: { previousRevision: 'r1', requestedAt: 't' } }; },
    rollout: async (prev) => { calls.push(['rollout', prev]); return { done: true }; },
  };
  deps.roles = {
    list: async () => [{ value: 'Gateway.Standard' }],
    create: async (body) => { calls.push(['createRole', body]); return { value: body.value }; },
  };
  deps.users = { tag: async (upn, body) => { calls.push(['tag', upn, body]); return { user: { upn } }; }, canWrite: async () => true };
  deps.chargeback = { build: async (q) => { calls.push(['chargeback', q]); return { period: q.period, groupBy: q.groupBy, rows: [], groups: [], totalCents: 0, notes: [] }; }, csv: () => 'period\r\n' };
  return { deps, calls };
}

const WRITES = [
  ['PUT', '/api/gateway-config', { admin: { roles: [] }, baseVersion: 'v1' }],
  ['POST', '/api/roles', { value: 'Gateway.Trial', displayName: 'T', description: 'T' }],
  ['PATCH', '/api/users/ana%40contoso.example', { department: 'X' }],
];

test('T-103 with sign-in off, every write route answers 403 even with a forged admin principal header', async () => {
  for (const [method, p, body] of WRITES) {
    const { deps, calls } = writeDeps('off');
    const res = await handleApi(withHeaders(req(method, p, body), { 'x-ms-client-principal': principal(['AdminUi.Admin']) }), deps);
    assert.equal(res.status, 403, `${method} ${p}`);
    assert.match(res.body.error, /sign-in/i);
    assert.match(res.body.error, /AdminUi\.Admin.*app role before it can be assigned/i);
    assert.equal(calls.length, 0, `${method} ${p} reached its backend`);
  }
});

test('T-103 with sign-in required, a principal without AdminUi.Admin gets 403 and one with it is allowed', async () => {
  for (const [method, p, body] of WRITES) {
    const a = writeDeps('required');
    const denied = await handleApi(withHeaders(req(method, p, body), { 'x-ms-client-principal': principal(['Gateway.Standard']) }), a.deps);
    assert.equal(denied.status, 403, `${method} ${p}`);
    assert.equal(a.calls.length, 0);
    const none = await handleApi(withHeaders(req(method, p, body), {}), a.deps);
    assert.equal(none.status, 403, `${method} ${p} with no principal`);
    const b = writeDeps('required');
    const ok = await handleApi(withHeaders(req(method, p, body), { 'x-ms-client-principal': principal(['AdminUi.Admin']) }), b.deps);
    assert.equal(ok.status, 200, `${method} ${p}: ${JSON.stringify(ok.body)}`);
    assert.equal(b.calls.length, 1);
  }
});

test('T-103 a malformed principal header is treated as no principal, not a crash', async () => {
  const { deps, calls } = writeDeps('required');
  const res = await handleApi(withHeaders(req('POST', '/api/roles', { value: 'X' }), { 'x-ms-client-principal': '%%%not-base64-json' }), deps);
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test('T-103 GET /api/me reports the sign-in mode and the signed-in admin only when sign-in is required', async () => {
  const off = await handleApi(withHeaders(req('GET', '/api/me'), { 'x-ms-client-principal': principal(['AdminUi.Admin']) }), writeDeps('off').deps);
  assert.deepEqual(off.body, { signIn: 'off', user: null, roles: [], isAdmin: false });
  const on = await handleApi(withHeaders(req('GET', '/api/me'), { 'x-ms-client-principal': principal(['AdminUi.Admin']) }), writeDeps('required').deps);
  assert.deepEqual(on.body, { signIn: 'required', user: { name: 'Admin One', upn: 'admin@contoso.example' }, roles: ['AdminUi.Admin'], isAdmin: true });
});

test('T-103 the new routes pass their inputs through: rollout previous revision, PUT acknowledgement, chargeback query and CSV', async () => {
  const admin = principal(['AdminUi.Admin']);
  const { deps, calls } = writeDeps('required');
  await handleApi(withHeaders(req('GET', '/api/gateway-config/rollout?previous=r1'), { 'x-ms-client-principal': admin }), deps);
  await handleApi(withHeaders(req('PUT', '/api/gateway-config', { admin: { roles: [] }, baseVersion: 'v1', acknowledgeDataLoss: true }), { 'x-ms-client-principal': admin }), deps);
  await handleApi(withHeaders(req('PATCH', '/api/users/ana%40contoso.example', { department: 'X' }), { 'x-ms-client-principal': admin }), deps);
  const csv = await handleApi(withHeaders(req('GET', '/api/chargeback?period=weekly&groupBy=costCenter&format=csv'), { 'x-ms-client-principal': admin }), deps);
  assert.deepEqual(calls[0], ['rollout', 'r1']);
  assert.deepEqual(calls[1], ['write', { admin: { roles: [] }, baseVersion: 'v1', acknowledgeDataLoss: true }]);
  assert.deepEqual(calls[2], ['tag', 'ana@contoso.example', { department: 'X' }]);
  assert.deepEqual(calls[3], ['chargeback', { period: 'weekly', groupBy: 'costCenter' }]);
  assert.equal(csv.status, 200);
  assert.equal(csv.raw, 'period\r\n');
  assert.match(csv.headers['Content-Type'], /^text\/csv/);
  assert.match(csv.headers['Content-Disposition'], /attachment; filename="chargeback-weekly-costCenter-\d{4}-\d{2}-\d{2}\.csv"/);
});

test('T-101 PATCH /api/users/:upn refuses tagging without User.ReadWrite.All before calling Graph', async () => {
  const { deps, calls } = writeDeps('required');
  deps.users.canWrite = async () => false;
  const res = await handleApi(withHeaders(
    req('PATCH', '/api/users/ana%40contoso.example', { department: 'Engineering' }),
    { 'x-ms-client-principal': principal(['AdminUi.Admin']) },
  ), deps);
  assert.equal(res.status, 403);
  assert.match(res.body.error, /User\.ReadWrite\.All/);
  assert.equal(calls.some(([name]) => name === 'tag'), false);
});

test('T-103 a store error with details reaches the browser with its status and details', async () => {
  const { deps } = writeDeps('required');
  deps.configStore.write = async () => { throw Object.assign(new Error('the configuration changed since it was read'), { status: 409, details: { currentVersion: 'v9' } }); };
  const res = await handleApi(withHeaders(req('PUT', '/api/gateway-config', { admin: {}, baseVersion: 'v1' }), { 'x-ms-client-principal': principal(['AdminUi.Admin']) }), deps);
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'the configuration changed since it was read', currentVersion: 'v9' });
});

test('T-103 with sign-in required, granting or removing a developer role needs AdminUi.Admin, and so does listing (ADR-0011)', async () => {
  for (const method of ['POST', 'DELETE']) {
    const developerCalls = [];
    const deps = fakeDeps({ developerCalls });
    deps.auth = { signIn: 'required' };
    const denied = await handleApi(withHeaders(req(method, '/api/developers', { upn: 'dev@contoso.com', role: 'Gateway.Standard' }), { 'x-ms-client-principal': principal(['Gateway.Standard']) }), deps);
    assert.equal(denied.status, 403, method);
    assert.equal(developerCalls.length, 0, `${method} reached setDeveloper`);
    const ok = await handleApi(withHeaders(req(method, '/api/developers', { upn: 'dev@contoso.com', role: 'Gateway.Standard' }), { 'x-ms-client-principal': principal(['AdminUi.Admin']) }), deps);
    assert.equal(ok.status, 200, method);
  }
  const deps = fakeDeps();
  deps.auth = { signIn: 'required' };
  assert.equal((await handleApi(withHeaders(req('GET', '/api/developers'), {}), deps)).status, 403);
  assert.equal((await handleApi(withHeaders(req('GET', '/api/developers'), { 'x-ms-client-principal': principal(['AdminUi.Admin']) }), deps)).status, 200);
});

test('T-107 GET /api/business-units returns the units with canTag, which needs both sign-in and User.ReadWrite.All', async () => {
  const data = { users: [{ id: 'u1', upn: 'ana@contoso.example', department: 'Engineering' }], units: [{ name: 'Engineering', users: 1 }], unassigned: 0, skipped: [] };
  const admin = { 'x-ms-client-principal': principal(['AdminUi.Admin']) };
  const on = writeDeps('required').deps;
  on.businessUnits = { list: async () => data };
  const ok = await handleApi(withHeaders(req('GET', '/api/business-units'), admin), on);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ...data, canTag: true });
  const offDeps = writeDeps('off').deps;
  offDeps.businessUnits = { list: async () => data };
  assert.equal((await handleApi(withHeaders(req('GET', '/api/business-units'), admin), offDeps)).body.canTag, false, 'sign-in off: no tagging');
  on.users.canWrite = async () => false;
  assert.equal((await handleApi(withHeaders(req('GET', '/api/business-units'), admin), on)).body.canTag, false);
  const none = writeDeps('required').deps;
  assert.equal((await handleApi(withHeaders(req('GET', '/api/business-units'), admin), none)).status, 503);
});

// T-108 (ADR-0011): with sign-in required, every API route except /api/health and /api/me needs AdminUi.Admin,
// checked once in handleApi before any route runs, so the backend behind a refused route is never called.
const READS_AND_WRITES = [
  ['GET', '/api/spend-limits'],
  ['GET', '/api/spend-limits/effective?sort=spend_desc'],
  ['POST', '/api/spend-limits', { scope: { type: 'organization' }, amountCents: 100, period: 'monthly' }],
  ['DELETE', '/api/spend-limits/spl_1'],
  ['GET', '/api/developers'],
  ['POST', '/api/developers', { upn: 'dev@contoso.com', role: 'Gateway.Standard' }],
  ['GET', '/api/gateway-config'],
  ['POST', '/api/gateway-config/preview', { admin: { roles: [] } }],
  ['GET', '/api/gateway-config/rollout'],
  ['GET', '/api/roles'],
  ['GET', '/api/chargeback'],
  ['GET', '/api/business-units'],
  ['GET', '/api/capabilities'],
  ['GET', '/api/nope'],
];

function adminOnlyDeps() {
  const calls = [];
  const { deps } = writeDeps('required');
  const record = (name) => async (...a) => { calls.push(name); return {}; };
  deps.gateway = { baseUrl: 'https://gw.example.com', writeKey: 'wk', fetch: async (url) => { calls.push(`gateway ${url}`); return { ok: true, status: 200, text: async () => '{"data":[]}' }; } };
  deps.developers = { listDevelopers: async () => { calls.push('listDevelopers'); return []; }, setDeveloper: async () => { calls.push('setDeveloper'); return {}; } };
  for (const fn of ['read', 'preview', 'rollout']) deps.configStore[fn] = record(fn);
  deps.roles = { list: async () => { calls.push('roles'); return []; } };
  deps.chargeback = { build: async () => { calls.push('chargeback'); return {}; }, csv: () => '' };
  deps.businessUnits = { list: async () => { calls.push('businessUnits'); return {}; } };
  deps.capabilities = async () => { calls.push('capabilities'); return {}; };
  return { deps, calls };
}

test('T-108 with sign-in required, a signed-in user without AdminUi.Admin, or no principal, gets 403 on every API route and reaches no backend', async () => {
  for (const [method, p, body] of READS_AND_WRITES) {
    for (const headers of [{ 'x-ms-client-principal': principal(['Gateway.Standard']) }, {}]) {
      const { deps, calls } = adminOnlyDeps();
      const res = await handleApi(withHeaders(req(method, p, body), headers), deps);
      assert.equal(res.status, 403, `${method} ${p} with ${Object.keys(headers).length ? 'a non-admin' : 'no'} principal`);
      assert.match(res.body.error, /AdminUi\.Admin/);
      assert.deepEqual(calls, [], `${method} ${p} reached ${calls.join(', ')}`);
    }
  }
});

test('T-108 with sign-in required, AdminUi.Admin reaches every route; /api/health and /api/me need no role', async () => {
  for (const [method, p, body] of READS_AND_WRITES.filter(([, p]) => p !== '/api/nope')) {
    const { deps, calls } = adminOnlyDeps();
    const res = await handleApi(withHeaders(req(method, p, body), { 'x-ms-client-principal': principal(['AdminUi.Admin']) }), deps);
    assert.equal(res.status, 200, `${method} ${p}: ${JSON.stringify(res.body)}`);
    assert.ok(calls.length > 0, `${method} ${p} reached no backend`);
  }
  const { deps } = adminOnlyDeps();
  assert.equal((await handleApi(withHeaders(req('GET', '/api/health'), {}), deps)).status, 200);
  const me = await handleApi(withHeaders(req('GET', '/api/me'), { 'x-ms-client-principal': principal(['Gateway.Standard'], 'bob@contoso.example') }), deps);
  assert.equal(me.status, 200);
  assert.deepEqual(me.body, { signIn: 'required', user: { name: 'Admin One', upn: 'bob@contoso.example' }, roles: ['Gateway.Standard'], isAdmin: false });
});

test('T-108 with sign-in off, reads and ADR-0008 writes keep working behind the IP allowlist (unchanged)', async () => {
  const { deps, calls } = adminOnlyDeps();
  deps.auth = { signIn: 'off' };
  for (const [method, p, body] of [['GET', '/api/spend-limits'], ['GET', '/api/developers'], ['POST', '/api/developers', { upn: 'dev@contoso.com', role: 'Gateway.Standard' }], ['GET', '/api/chargeback']]) {
    assert.equal((await handleApi(withHeaders(req(method, p, body), {}), deps)).status, 200, `${method} ${p}`);
  }
  assert.ok(calls.length >= 4);
});
