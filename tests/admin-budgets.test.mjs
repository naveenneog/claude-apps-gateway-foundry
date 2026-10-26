// T-90 (docs/TEST-PLAN.md): scripts/admin/bootstrap-budgets.mjs sets every budget an admin file declares (ADR-0009),
// through admin-ui/server/gateway-client.mjs's own setSpendLimit - no parallel HTTP client. Every gateway call here
// is faked; no test reaches a live gateway.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootstrapBudgets, budgetsFrom, main } from '../scripts/admin/bootstrap-budgets.mjs';

// Matches admin-ui/server/gateway-client.mjs's own call() contract: fetch(url, {method, headers, body}) -> {ok,
// status, text()}. failOn, if set, fails the POST whose body JSON.stringifies to a scope containing that substring.
function fakeFetch({ failOn } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined });
    if (failOn && init?.body?.includes(failOn)) return { ok: false, status: 401, text: async () => JSON.stringify({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ type: 'spend_limit', id: 'spl_1' }) };
  };
  return { fetch, calls };
}
const gatewayDeps = (fakeFetchResult) => ({ baseUrl: 'https://ca-claude-gw.example.azurecontainerapps.io', writeKey: 'test-write-key', fetch: fakeFetchResult.fetch });

const roles = ['Gateway.Standard', 'Gateway.Premium'];
const threeBudgets = () => ([
  { scope: { type: 'organization' }, amountUsd: 500, period: 'monthly' },
  { scope: { type: 'rbac_group', rbac_group_id: 'Gateway.Premium' }, amountUsd: 200, period: 'monthly' },
  { scope: { type: 'user', user_id: 'sub-123' }, amountUsd: null, period: 'daily' },
]);

test('T-90 each budget row is sent as one setSpendLimit call, amountUsd converted to whole cents, null kept as unlimited', async () => {
  const f = fakeFetch();
  const { set, failed } = await bootstrapBudgets({ gateway: gatewayDeps(f), budgets: threeBudgets() });
  assert.deepEqual(failed, []);
  assert.equal(set.length, 3);
  assert.deepEqual(f.calls.map((c) => c.body), [
    { scope: { type: 'organization' }, amount: '50000', period: 'monthly' },
    { scope: { type: 'rbac_group', rbac_group_id: 'Gateway.Premium' }, amount: '20000', period: 'monthly' },
    { scope: { type: 'user', user_id: 'sub-123' }, amount: null, period: 'daily' },
  ]);
  for (const call of f.calls) assert.equal(call.headers['x-api-key'], 'test-write-key');
});

test('T-90 a second run sends the same calls again, relying on the API\'s own replace-by-scope-and-period semantics', async () => {
  const f = fakeFetch();
  await bootstrapBudgets({ gateway: gatewayDeps(f), budgets: threeBudgets() });
  await bootstrapBudgets({ gateway: gatewayDeps(f), budgets: threeBudgets() });
  assert.equal(f.calls.length, 6);
  assert.deepEqual(f.calls[0].body, f.calls[3].body);
});

test('T-90 plan prints every call it would make and sends none', async () => {
  const f = fakeFetch();
  const lines = [];
  const { set, failed } = await bootstrapBudgets({ gateway: gatewayDeps(f), budgets: threeBudgets(), plan: true, log: (l) => lines.push(l) });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(set, []);
  assert.deepEqual(failed, []);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /PLAN: set organization monthly = \$500\.00/);
  assert.match(lines[1], /PLAN: set rbac_group:Gateway\.Premium monthly = \$200\.00/);
  assert.match(lines[2], /PLAN: set user:sub-123 daily = \$?unlimited/);
});

test('T-90 a failing row is reported by name and does not stop the rows after it', async () => {
  const f = fakeFetch({ failOn: 'Gateway.Premium' });
  const { set, failed } = await bootstrapBudgets({ gateway: gatewayDeps(f), budgets: threeBudgets() });
  assert.equal(set.length, 2, 'the organization and user rows, around the failing one');
  assert.equal(failed.length, 1);
  assert.match(failed[0].message, /invalid x-api-key/);
  assert.equal(f.calls.length, 3, 'all three rows were attempted');
});

function adminFile(t, admin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-budgets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'admin.json');
  fs.writeFileSync(file, typeof admin === 'string' ? admin : JSON.stringify(admin));
  return file;
}
const models = [{ id: 'claude-sonnet-5', deployment: 'claude-sonnet-5' }];
const policies = [{ role: 'Gateway.Standard', models: ['claude-sonnet-5'] }, { role: 'Gateway.Premium', models: ['claude-sonnet-5'] }];

test('T-90 budgetsFrom reads a validated admin file\'s budgets, and an empty or absent array is empty, not an error', (t) => {
  assert.deepEqual(budgetsFrom(adminFile(t, { roles, models, policies }), roles, 'test'), []);
  assert.deepEqual(budgetsFrom(adminFile(t, { roles, models, policies, budgets: [] }), roles, 'test'), []);
  assert.deepEqual(budgetsFrom(adminFile(t, { roles, models, policies, budgets: threeBudgets() }), roles, 'test'), threeBudgets());
});

test('T-90 budgetsFrom stops on an admin file that fails the renderer\'s validation, before any gateway call', (t) => {
  for (const admin of ['{ "roles": [', { roles, models, policies, budgets: [{ scope: { type: 'team' }, amountUsd: 1, period: 'monthly' }] }]) {
    assert.throws(() => budgetsFrom(adminFile(t, admin), roles, 'test'), /is not readable JSON|has \d+ problem/);
  }
});

test('T-90 the CLI reports no budgets to set, rather than an error, for a file that declares none', async (t) => {
  const file = adminFile(t, { roles, models, policies });
  const out = await main(['--admin', file, '--plan'], { knownRoles: roles });
  assert.match(out, /declares no budgets; nothing to set/);
});

test('T-90 the CLI runs budgetsFrom before discovering the gateway, so a bad admin file never calls discoverGateway', async (t) => {
  const file = adminFile(t, { roles, models, policies, budgets: [{ scope: { type: 'team' }, amountUsd: 1, period: 'monthly' }] });
  let discovered = false;
  await assert.rejects(main(['--admin', file], { knownRoles: roles, discoverGateway: async () => { discovered = true; return gatewayDeps(fakeFetch()); } }), /has \d+ problem/);
  assert.equal(discovered, false);
});

test('T-90 the CLI sets every budget through the discovered gateway, and throws naming the failed row when one fails', async (t) => {
  const file = adminFile(t, { roles, models, policies, budgets: threeBudgets() });
  const f = fakeFetch();
  const out = await main(['--admin', file], { knownRoles: roles, discoverGateway: async () => gatewayDeps(f) });
  assert.equal(f.calls.length, 3);
  assert.match(out, /set organization monthly/);

  const failing = fakeFetch({ failOn: 'Gateway.Premium' });
  await assert.rejects(main(['--admin', file], { knownRoles: roles, discoverGateway: async () => gatewayDeps(failing) }), /1 of 3 budget\(s\) failed/);
});
