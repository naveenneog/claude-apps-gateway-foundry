// T-165/T-167: real console pages in Playwright, with a local authentication/CSRF fixture and fake upstream data.
// This fixture reproduces the customer's required Referer; it is not the Azure Authentication implementation.
// Run: node tests/live/console-browser.mjs (Playwright installed separately; PLAYWRIGHT_CHANNEL defaults to msedge).
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { createServer } from '../../admin-ui/server/server.mjs';
import { capabilities } from '../../admin-ui/server/capabilities.mjs';
import { adminErrors, renderGatewayConfig } from '../../scripts/admin/new-gateway-config.mjs';
import { describeChanges } from '../../admin-ui/server/gateway-config.mjs';

const subject = 'gateway-subject-not-an-entra-object-id';
const email = 'pilot@contoso.example';
const role = 'Gateway.Premium';
const calls = [];
const assignments = [];
const caps = [];
let admin = {
  roles: ['Gateway.Standard', role],
  models: [{ id: 'claude-sonnet-5', deployment: 'claude-sonnet-5' }],
  policies: [{ role, models: ['claude-sonnet-5'], desktop: true }, { role: 'Gateway.Standard', models: ['claude-sonnet-5'] }],
  deployment: { adminApi: true, database: 'managed' },
};
const effective = { scope: { type: 'user', user_id: subject }, actor: { type: 'user_actor', user_id: subject, name: 'Pilot', email_address: email },
  groups: [role], period: 'monthly', amount: null, period_to_date_spend: '0', currency: 'USD' };
const principal = (isAdmin) => Buffer.from(JSON.stringify({ claims: [
  { typ: 'preferred_username', val: 'admin@contoso.example' }, { typ: 'roles', val: isAdmin ? 'AdminUi.Admin' : 'OtherRole' },
] })).toString('base64');
const permissions = [{ actions: ['Microsoft.App/containerApps/*/read', 'Microsoft.App/containerApps/*/write', 'Microsoft.App/containerApps/*/action'] }];
const graphRoles = ['User.Read.All', 'Application.Read.All', 'Application.ReadWrite.OwnedBy', 'AppRoleAssignment.ReadWrite.All'];
const deps = {
  log: () => {}, auth: { signIn: 'required' },
  gateway: { baseUrl: 'https://gateway.contoso.example', writeKey: 'fixture-only', fetch: async (url, options) => {
    const request = new URL(url);
    let response = { data: [] };
    if (request.pathname.endsWith('/effective')) {
      const requested = request.searchParams.get('user_ids[]');
      response = { data: requested && requested !== subject ? [{
        ...effective, scope: { type: 'user', user_id: requested }, actor: { type: 'user_actor', user_id: requested },
      }] : [effective] };
    }
    else if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      calls.push(body);
      const cap = { id: 'fixture-cap', ...body };
      caps.push(cap);
      response = cap;
    } else if (request.pathname.endsWith('/spend_limits')) response = { data: caps };
    return new Response(JSON.stringify(response), { status: 200 });
  } },
  developersDeps: {},
  developers: {
    listDevelopers: async () => assignments,
    setDeveloper: async ({ upn, role: assigned }) => {
      const entry = { name: upn, principalId: 'fixture-entra-object', role: assigned };
      assignments.push(entry);
      return entry;
    },
  },
  roles: { list: async () => admin.roles.map((value) => ({ id: value, value, displayName: value, isEnabled: true, admitted: true })) },
  configStore: {
    read: async () => ({ admin, version: 'fixture-version', source: 'live', deployFileMatches: true, topology: 'test',
      gateway: { app: 'ca-claude-gw', url: 'https://gateway.contoso.example' }, restart: { temporaryDatabase: false } }),
    preview: async (draft) => ({ errors: adminErrors(draft, admin.roles, 'test'), changes: describeChanges(admin, draft),
      yaml: renderGatewayConfig(draft, { topology: 'test' }) }),
    write: async ({ admin: draft }) => {
      assert.deepEqual(adminErrors(draft, admin.roles, 'test'), []);
      admin = draft;
      return { rollout: { previousRevision: 'old' } };
    },
    rollout: async () => ({ done: true, healthy: true, latestRevision: 'new', latestReadyRevision: 'new', previousRevision: 'old', provisioningState: 'Succeeded' }),
  },
  capabilities: (signIn) => capabilities({
    signIn, graphToken: async () => `h.${Buffer.from(JSON.stringify({ roles: graphRoles })).toString('base64url')}.s`,
    armPermissions: async () => permissions, tagsStatus: async () => ({ available: true }),
  }),
};
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const backend = createServer(deps);
const backendPort = await listen(backend);
const middleware = http.createServer((req, res) => {
  const origin = `http://${req.headers.host}`;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers.referer?.split('/').slice(0, 3).join('/') !== origin) {
    res.writeHead(403, { 'x-ms-middleware-request-id': 'local-csrf-fixture' }).end();
    return;
  }
  const headers = { ...req.headers };
  delete headers['x-ms-client-principal'];
  headers['x-ms-client-principal'] = principal(req.headers.cookie?.includes('fixture-session=admin'));
  const proxy = http.request({ hostname: '127.0.0.1', port: backendPort, path: req.url, method: req.method, headers }, (reply) => {
    res.writeHead(reply.statusCode, reply.headers);
    reply.pipe(res);
  });
  proxy.on('error', () => { res.writeHead(502).end(); });
  req.pipe(proxy);
});
const port = await listen(middleware);
const origin = `http://127.0.0.1:${port}`;
let browser;
let releaseMetadata = () => {};
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'msedge', headless: true });
  const context = await browser.newContext();
  await context.addCookies([{ name: 'fixture-session', value: 'admin', url: origin }]);
  const metadataGate = new Promise((resolve) => { releaseMetadata = resolve; });
  await context.route('**/api/gateway-config', async (route) => { await metadataGate; await route.continue(); });
  const page = await context.newPage();
  await page.goto(`${origin}/#/budgets`);
  await page.getByRole('button', { name: 'Set cap', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Set cap', exact: true }).isDisabled(), true,
    'T-165 cap submission waits for initial metadata, avoiding a write followed by an uninitialized-people error');
  releaseMetadata();
  await page.getByLabel('User', { exact: true }).fill('00000000-0000-4000-8000-000000000001');
  await page.getByLabel('Amount (USD)').fill('70');
  await page.getByRole('button', { name: 'Set cap', exact: true }).click();
  await page.getByRole('dialog', { name: 'Use this gateway subject?' }).waitFor({ timeout: 3000 });
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(calls.length, 0, 'T-165 canceling an unrecorded subject does not create an ineffective cap');
  await page.getByLabel('User', { exact: true }).fill(email);
  await page.getByLabel('Amount (USD)').fill('70');
  const budgetReply = page.waitForResponse((response) => response.url().endsWith('/api/spend-limits') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Set cap', exact: true }).click();
  const response = await budgetReply;
  assert.equal(response.status(), 200, 'T-165 same-origin Set cap passes the authentication fixture instead of 403');
  assert.equal(new URL(response.request().headers().referer).origin, origin);
  assert.equal(calls[0].scope.user_id, subject, 'T-165 email resolves to gateway subject, not the Entra object ID');
  assert.equal(calls[0].amount, '7000');
  console.log('PASS T-165 browser Set cap carries Referer and targets the gateway subject');

  await page.goto(`${origin}/#/developers`);
  await page.getByLabel('User principal name').fill(email);
  await page.getByLabel('Role', { exact: true }).selectOption(role);
  const developerReply = page.waitForResponse((reply) => reply.url().endsWith('/api/developers') && reply.request().method() === 'POST');
  await page.getByRole('button', { name: 'Grant role', exact: true }).click();
  assert.equal((await developerReply).status(), 200, 'T-165 same-origin Grant role succeeds');
  assert.equal(assignments[0].name, email);
  console.log('PASS T-165 browser Grant role reaches the real admin-ui handler');

  await page.goto(`${origin}/#/settings`);
  await page.getByText('Container Apps Contributor on the gateway app (Azure RBAC)', { exact: true }).waitFor();
  const permissionRow = page.locator('li').filter({ hasText: 'Container Apps Contributor on the gateway app (Azure RBAC)' });
  assert.match(await permissionRow.innerText(), /Granted/, 'T-166 published Contributor role is shown as Granted');
  console.log('PASS T-166 browser permission indicator recognizes Contributor');

  await page.goto(`${origin}/#/access`);
  await page.getByLabel(`${role}: Allow plugin uploads`, { exact: true }).selectOption('true');
  await page.getByLabel(`${role}: Allow Claude.ai import`, { exact: true }).selectOption('true');
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await page.getByText(/Desktop userPluginUploadsEnabled/).waitFor();
  await page.getByRole('button', { name: 'Apply and roll out', exact: true }).click();
  const confirmation = page.getByRole('dialog');
  await confirmation.getByRole('button', { name: 'Apply and roll out', exact: true }).click();
  await page.getByText('The change is live', { exact: true }).waitFor();
  assert.deepEqual(admin.policies[0].desktopSettings, { userPluginUploadsEnabled: true, claudeAiImport: { enabled: true } });
  assert.equal(admin.policies[1].desktopSettings, undefined);
  assert.ok(!JSON.stringify(admin).includes('automatic3pImport'));
  console.log('PASS T-167 browser Desktop capabilities preview and reviewed rollout preserve other roles');

  const blocked = await page.evaluate(async () => (await fetch('/api/developers', {
    method: 'POST', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upn: 'blocked@contoso.example', role: 'Gateway.Standard' }),
  })).status);
  assert.equal(blocked, 403, 'T-165 removing the Referer still reproduces the platform fixture rejection');
  assert.equal(assignments.length, 1);
  const ordinary = await browser.newContext();
  await ordinary.addCookies([{ name: 'fixture-session', value: 'ordinary', url: origin }]);
  const ordinaryPage = await ordinary.newPage();
  await ordinaryPage.goto(`${origin}/`);
  const forbidden = await ordinaryPage.evaluate(async () => (await fetch('/api/developers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upn: 'blocked@contoso.example', role: 'Gateway.Standard' }),
  })).status);
  assert.equal(forbidden, 403, 'T-165 a same-origin caller without AdminUi.Admin remains refused');
  assert.equal(assignments.length, 1);
  console.log('PASS T-165 missing Referer and non-admin writes remain refused');
} finally {
  releaseMetadata();
  await browser?.close();
  middleware.closeAllConnections();
  backend.closeAllConnections();
  await Promise.all([new Promise((resolve) => middleware.close(resolve)), new Promise((resolve) => backend.close(resolve))]);
}
