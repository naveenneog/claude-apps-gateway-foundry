// T-84: admin-ui/server/server.mjs - buildDeps' environment validation, and createServer as a real node:http
// server on an ephemeral port (no mocking of http itself; this is the one place a real server is worth starting).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildDeps, createServer } from '../admin-ui/server/server.mjs';

const validEnv = () => ({
  GATEWAY_URL: 'https://claude-gateway.internal.example.com',
  GATEWAY_ADMIN_WRITE_KEY: 'wk',
  AZURE_CLIENT_ID: 'client-1',
  GATEWAY_SERVICE_PRINCIPAL_ID: 'sp-1',
  GATEWAY_APP_ROLES: JSON.stringify([{ id: 'r1', value: 'Gateway.Standard' }, { id: 'r2', value: 'Gateway.Premium' }]),
  GATEWAY_ADMIN_FILE_JSON: JSON.stringify({
    roles: ['Gateway.Standard', 'Gateway.Premium'],
    models: [{ id: 'claude-sonnet-5', deployment: 'claude-sonnet-5' }],
    policies: [{ role: 'Gateway.Standard', models: ['claude-sonnet-5'] }, { role: 'Gateway.Premium', models: ['claude-sonnet-5'] }],
  }),
});

test('T-84 buildDeps throws naming the missing variable, for each one required, before anything else runs', () => {
  for (const key of Object.keys(validEnv())) {
    const env = validEnv();
    delete env[key];
    assert.throws(() => buildDeps({ env }), new RegExp(key), `missing ${key} was not refused`);
  }
});

test('T-84 buildDeps refuses an admin file the renderer itself would refuse, e.g. a role missing a policy', () => {
  const env = validEnv();
  const admin = JSON.parse(env.GATEWAY_ADMIN_FILE_JSON);
  admin.policies = [admin.policies[0]]; // Gateway.Premium now has no policy
  env.GATEWAY_ADMIN_FILE_JSON = JSON.stringify(admin);
  assert.throws(() => buildDeps({ env }), /no policy/);
});

test('T-84 buildDeps succeeds on a valid environment and wires gateway/developers deps', () => {
  const deps = buildDeps({ env: validEnv(), fetchImpl: async () => { throw new Error('not called'); } });
  assert.equal(deps.gateway.baseUrl, 'https://claude-gateway.internal.example.com');
  assert.equal(deps.gateway.writeKey, 'wk');
  assert.equal(deps.developersDeps.servicePrincipalId, 'sp-1');
  assert.deepEqual(deps.developersDeps.admittedRoles, ['Gateway.Standard', 'Gateway.Premium']);
  assert.equal(typeof deps.developersDeps.graph, 'function');
});

// Found live 2026-10-17: config/gateway-admin.azure-test-demo.json's deployment block is just { adminApi: true },
// the ADR-0003 test topology's shape (no VNet, so no developerCidrs) - buildDeps called adminErrors() with no
// topology argument, which defaults to 'private' and requires developerCidrs, so admin-ui crash-looped on both
// gateways the demo admin file was ever deployed to. developerCidrs is a gateway network-access-control concern
// admin-ui's own code never reads (it only needs roles/policies), so admin-ui must not require it either way.
test('T-84 buildDeps accepts deployment.adminApi with no developerCidrs, the test-topology admin file\'s shape', () => {
  const env = validEnv();
  const admin = JSON.parse(env.GATEWAY_ADMIN_FILE_JSON);
  admin.deployment = { adminApi: true };
  env.GATEWAY_ADMIN_FILE_JSON = JSON.stringify(admin);
  const deps = buildDeps({ env, fetchImpl: async () => { throw new Error('not called'); } });
  assert.equal(deps.gateway.baseUrl, 'https://claude-gateway.internal.example.com');
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('T-84 the server answers /api/health over real HTTP, and unknown API paths 404', async () => {
  const deps = { log: () => {} };
  const server = createServer(deps);
  const port = await listen(server);
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    const missing = await fetch(`http://127.0.0.1:${port}/api/nope`);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test('T-84 the server serves the real, checked-in frontend, and falls back to index.html for a client-side route', async () => {
  // Reads the real admin-ui/web/index.html as deployed; createServer's webRoot is not injectable, and a previous
  // version of this test wrote a stub directly into that file to work around that, silently overwriting the real
  // frontend on every test run - undetected because the only assertion was that the word "admin-ui" appeared
  // somewhere, which a bare `<title>admin-ui</title>` with no body, nav or script tag also satisfies (live-found
  // 2026-10-17: the deployed admin-ui rendered a blank page, with no code ever loading app.js).
  const server = createServer({ log: () => {} });
  const port = await listen(server);
  try {
    const root = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /admin-ui/);
    const spaRoute = await fetch(`http://127.0.0.1:${port}/budgets`);
    assert.equal(spaRoute.status, 200, 'a client-side route falls back to index.html, not a 404');
  } finally {
    server.close();
  }
});

test('T-84 index.html actually wires up app.js: an #app element the router renders into, and a nav link per route', () => {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const html = fs.readFileSync(path.join(here, '..', 'admin-ui', 'web', 'index.html'), 'utf8');
  assert.match(html, /<script src="app\.js">/, 'app.js is never loaded without a script tag naming it');
  assert.match(html, /id="app"/, 'app.js looks up document.getElementById(\'app\'); without it every render throws before anything is shown');
  for (const route of ['dashboard', 'budgets', 'developers', 'audit']) {
    assert.match(html, new RegExp(`<nav>[\\s\\S]*data-route="${route}"[\\s\\S]*</nav>`), `no nav link for ${route}`);
  }
});

test('T-84 the server refuses a path-traversal request instead of serving a file outside web/', async () => {
  const server = createServer({ log: () => {} });
  const port = await listen(server);
  try {
    // Node's own HTTP client normalizes ../ before sending, as browsers do, so this drives the raw socket directly -
    // the attack this guard exists for is a request line an HTTP client would never itself construct safely.
    const net = await import('node:net');
    const response = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('GET /../../../../../../windows/win.ini HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      socket.on('data', (chunk) => { data += chunk; });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    const statusLine = response.split('\r\n')[0];
    assert.ok(/ 200 | 403 | 404 /.test(` ${statusLine.split(' ').slice(1).join(' ')} `), statusLine);
    assert.doesNotMatch(response, /\[fonts\]|for 16-bit app support/i, 'win.ini content must never be served');
  } finally {
    server.close();
  }
});

// T-103/T-104: the ADR-0010 environment. GATEWAY_RESOURCE_ID turns on config editing, roles and chargeback;
// ADMIN_UI_SIGN_IN must be exactly 'required' or 'off', so a typo cannot leave writes guarded by a header anyone can send.
test('T-103 buildDeps leaves ADR-0010 features off without GATEWAY_RESOURCE_ID, and sign-in off by default', () => {
  const deps = buildDeps({ env: validEnv(), fetchImpl: async () => { throw new Error('not called'); } });
  assert.equal(deps.configStore, undefined);
  assert.equal(deps.developersLive, undefined);
  assert.equal(deps.auth.signIn, 'off');
  assert.equal(typeof deps.roles.list, 'function', 'roles are listed from Graph even without the ARM resource');
  assert.equal(typeof deps.chargeback.build, 'function');
  assert.equal(typeof deps.capabilities, 'function');
});

test('T-103 buildDeps wires the config store with GATEWAY_RESOURCE_ID, and refuses a sign-in mode it does not know', () => {
  const env = { ...validEnv(), GATEWAY_RESOURCE_ID: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/ca-claude-gw', GATEWAY_TOPOLOGY: 'test', ADMIN_UI_SIGN_IN: 'required' };
  const deps = buildDeps({ env, fetchImpl: async () => { throw new Error('not called'); } });
  for (const fn of ['read', 'preview', 'write', 'rollout']) assert.equal(typeof deps.configStore[fn], 'function', fn);
  assert.equal(typeof deps.developersLive, 'function');
  assert.equal(deps.auth.signIn, 'required');
  assert.throws(() => buildDeps({ env: { ...env, ADMIN_UI_SIGN_IN: 'Required ' } }), /ADMIN_UI_SIGN_IN/);
  assert.throws(() => buildDeps({ env: { ...env, GATEWAY_TOPOLOGY: 'prod' } }), /GATEWAY_TOPOLOGY/);
  assert.throws(() => buildDeps({ env: { ...env, GATEWAY_RESOURCE_ID: 'ca-claude-gw' } }), /GATEWAY_RESOURCE_ID/);
});

test('T-103 the server passes request headers to the router and sends a raw CSV body with its own headers', async () => {
  const seen = [];
  const deps = {
    log: () => {}, auth: { signIn: 'required' },
    chargeback: { build: async (q) => ({ ...q, rows: [] }), csv: () => 'period,group\r\nmonthly,"a,b"\r\n' },
    configStore: { read: async () => ({ admin: {}, version: 'v' }), preview: async () => ({}), write: async (a) => { seen.push(a); return {}; }, rollout: async () => ({}) },
  };
  const server = createServer(deps);
  const port = await listen(server);
  try {
    const p = Buffer.from(JSON.stringify({ claims: [{ typ: 'roles', val: 'AdminUi.Admin' }] })).toString('base64');
    const csv = await fetch(`http://127.0.0.1:${port}/api/chargeback?period=monthly&groupBy=department&format=csv`, { headers: { 'X-MS-CLIENT-PRINCIPAL': p } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /^text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /attachment; filename="chargeback-monthly-department-/);
    assert.equal(await csv.text(), 'period,group\r\nmonthly,"a,b"\r\n');
    const put = await fetch(`http://127.0.0.1:${port}/api/gateway-config`, { method: 'PUT', headers: { 'X-MS-CLIENT-PRINCIPAL': p, 'Content-Type': 'application/json' }, body: JSON.stringify({ admin: {}, baseVersion: 'v' }) });
    assert.equal(put.status, 200, 'the principal header reached the router');
    assert.equal(seen.length, 1);
  } finally {
    server.close();
  }
});

// T-108 (ADR-0011, U-95): HTTP hardening. The sign-in cookie is SameSite=None, so a page on another site can make the
// admin's browser send it; a write is accepted only with an application/json body and never from Sec-Fetch-Site: cross-site.
test('T-108 every response carries the security headers, and API responses are not cached', async () => {
  const server = createServer({ log: () => {} });
  const port = await listen(server);
  try {
    for (const p of ['/', '/api/health']) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      const csp = res.headers.get('content-security-policy') ?? '';
      for (const directive of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'"]) assert.ok(csp.includes(directive), `${p}: CSP lacks ${directive}: ${csp}`);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, p);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', p);
      assert.equal(res.headers.get('x-frame-options'), 'DENY', p);
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer', p);
      await res.arrayBuffer();
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).headers.get('cache-control'), 'no-store');
  } finally {
    server.close();
  }
});

test('T-108 a write with a non-JSON body, an oversized body, or from another site is refused before the router runs', async () => {
  const seen = [];
  // Sign-in required and an admin principal, so the router itself would accept every request below: a refusal can only
  // come from the HTTP layer.
  const deps = { log: () => {}, auth: { signIn: 'required' }, roles: { list: async () => [], create: async (b) => { seen.push(b); return b; } } };
  const admin = Buffer.from(JSON.stringify({ claims: [{ typ: 'roles', val: 'AdminUi.Admin' }] })).toString('base64');
  const server = createServer(deps);
  const port = await listen(server);
  const post = (headers, body) => fetch(`http://127.0.0.1:${port}/api/roles`, { method: 'POST', headers: { 'X-MS-CLIENT-PRINCIPAL': admin, ...headers }, body });
  try {
    const plain = await post({ 'Content-Type': 'text/plain' }, JSON.stringify({ value: 'X' }));
    assert.equal(plain.status, 415);
    const form = await post({ 'Content-Type': 'application/x-www-form-urlencoded' }, 'value=X');
    assert.equal(form.status, 415);
    const big = await post({ 'Content-Type': 'application/json' }, JSON.stringify({ value: 'x'.repeat(1024 * 1024 + 1) }));
    assert.equal(big.status, 413);
    const cross = await post({ 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, JSON.stringify({ value: 'X' }));
    assert.equal(cross.status, 403);
    assert.match((await cross.json()).error, /cross-site/);
    assert.equal(seen.length, 0, 'a refused request reached the router');
    const same = await post({ 'Content-Type': 'application/json; charset=utf-8', 'Sec-Fetch-Site': 'same-origin' }, JSON.stringify({ value: 'X' }));
    assert.equal(same.status, 200, 'a well-formed same-origin admin write reaches the router');
    assert.equal(seen.length, 1);
  } finally {
    server.close();
  }
});
