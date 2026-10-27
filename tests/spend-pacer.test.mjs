// T-134 and T-138 (docs/TEST-PLAN.md): the soft limit and daily pacing of ADR-0014. pacePlan is the rule over the
// gateway's own /effective rows, caps and audit trail; runPacer is the scheduled job around it. The dates below are UTC:
// 2026-10-27 leaves 5 days in October, the 27th included.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PACER_KEY_ID, pacePlan } from '../scripts/admin/spend-pacing.mjs';
import { runPacer } from '../admin-ui/server/pacer-job.mjs';

const NOW = new Date('2026-10-27T10:00:00Z');
const PACER = `admin-key:${PACER_KEY_ID}`;
const row = (user, period, amount, spend, groups = ['Gateway.Standard']) => ({
  type: 'spend_summary', scope: { type: 'user', user_id: user }, period,
  amount: amount === null ? null : String(amount), period_to_date_spend: String(spend), groups, actor: { email_address: `${user}@example.com` },
});
const userCap = (id, user, amount, period = 'daily') => ({ type: 'spend_limit', id, scope: { type: 'user', user_id: user }, period, amount: String(amount) });
const groupCap = (id, group, amount, period = 'daily') => ({ type: 'spend_limit', id, scope: { type: 'rbac_group', rbac_group_id: group }, period, amount: amount === null ? null : String(amount) });
const event = (id, actor, before, after, at = '2026-10-26T00:00:00Z') => ({ id, actor, created_at: at, before, after });
const plan = (over = {}) => pacePlan({ percent: 80, now: NOW, effective: [], caps: [], audit: [], ...over });

test('T-134 past the soft limit, a user daily cap of the rest of the month over the days left is set', () => {
  // $100 monthly cap, $85 spent of which $3 today: $82 before today, $18 left over 5 days = $3.60 a day.
  const p = plan({ effective: [row('a', 'monthly', 10000, 8500), row('a', 'daily', null, 300)] });
  assert.deepEqual(p.set, [{ userId: 'a', amountCents: 360 }]);
  assert.deepEqual(p.remove, []);
  assert.deepEqual(p.paced, ['a']);
});

test('T-134 the amount stays the same through the day as the person spends, and changes the next day', () => {
  const later = plan({ effective: [row('a', 'monthly', 10000, 8700), row('a', 'daily', null, 500)] });
  assert.deepEqual(later.set, [{ userId: 'a', amountCents: 360 }], 'spend today moves both totals, so the amount is unchanged');
  const tomorrow = plan({ now: new Date('2026-10-28T00:10:00Z'), effective: [row('a', 'monthly', 10000, 8700), row('a', 'daily', null, 0)] });
  assert.deepEqual(tomorrow.set, [{ userId: 'a', amountCents: 325 }], '$13 left over 4 days, rounded down to whole cents');
  const lastDay = plan({ now: new Date('2026-10-31T12:00:00Z'), effective: [row('a', 'monthly', 10000, 9500), row('a', 'daily', null, 100)] });
  assert.deepEqual(lastDay.set, [{ userId: 'a', amountCents: 600 }], 'on the last day the whole rest is the day\'s cap');
});

test('T-134 below the soft limit, or with an unlimited or zero monthly cap, nothing is set', () => {
  assert.deepEqual(plan({ effective: [row('b', 'monthly', 10000, 7999)] }).set, []);
  assert.deepEqual(plan({ effective: [row('g', 'monthly', null, 999999)] }).set, []);
  assert.deepEqual(plan({ effective: [row('z', 'monthly', 0, 0)] }).set, []);
  assert.deepEqual(plan({ effective: [row('b', 'monthly', 10000, 8000)] }).paced, ['b'], 'exactly at the soft limit counts as past it');
});

test('T-134 a role or organization daily cap at or below the pace means no user cap; the job\'s own cap is then deleted', () => {
  const effective = [row('f', 'monthly', 10000, 8500), row('f', 'daily', null, 300)];
  assert.deepEqual(plan({ effective, caps: [groupCap('spl_g', 'Gateway.Standard', 200)] }).set, []);
  assert.deepEqual(plan({ effective, caps: [{ ...groupCap('spl_o', null, 360), scope: { type: 'organization' } }] }).set, [], 'an organization cap equal to the pace');
  assert.deepEqual(plan({ effective, caps: [groupCap('spl_g', 'Gateway.Other', 200)] }).set, [{ userId: 'f', amountCents: 360 }], 'another role\'s cap does not apply');
  const owned = userCap('spl_f', 'f', 360);
  const p = plan({ effective, caps: [owned, groupCap('spl_g', 'Gateway.Standard', 200)], audit: [event(9, PACER, null, owned)] });
  assert.deepEqual(p.remove, [{ id: 'spl_f', userId: 'f' }]);
});

test('T-134 an unchanged amount writes nothing; a changed one is written again', () => {
  const effective = [row('e', 'monthly', 10000, 8500), row('e', 'daily', null, 300)];
  const same = userCap('spl_e', 'e', 360);
  const p = plan({ effective, caps: [same], audit: [event(5, PACER, null, same)] });
  assert.deepEqual([p.set, p.remove, p.paced], [[], [], ['e']]);
  const stale = userCap('spl_e', 'e', 500);
  assert.deepEqual(plan({ effective, caps: [stale], audit: [event(5, PACER, null, stale)] }).set, [{ userId: 'e', amountCents: 360 }]);
});

test('T-134 below the soft limit, or with pacing off, the job deletes only the caps it set', () => {
  const mine = userCap('spl_c', 'c', 360);
  const audit = [event(7, PACER, null, mine)];
  assert.deepEqual(plan({ effective: [row('c', 'monthly', 10000, 100)], caps: [mine], audit }).remove, [{ id: 'spl_c', userId: 'c' }], 'a new month');
  assert.deepEqual(plan({ effective: [], caps: [mine], audit }).remove, [{ id: 'spl_c', userId: 'c' }], 'no spend row this month');
  const off = plan({ percent: null, effective: [row('c', 'monthly', 10000, 9900)], caps: [mine], audit });
  assert.deepEqual([off.set, off.remove], [[], [{ id: 'spl_c', userId: 'c' }]], 'pacing off');
});

test('T-134 negative: a user daily cap whose newest audit event names another actor is never changed or deleted', () => {
  const admins = userCap('spl_d', 'd', 5000);
  const effective = [row('d', 'monthly', 10000, 9000), row('d', 'daily', null, 0)];
  const byAdmin = plan({ effective, caps: [admins], audit: [event(3, 'admin-key:admin-ui', null, admins)] });
  assert.deepEqual([byAdmin.set, byAdmin.remove], [[], []]);
  assert.deepEqual(byAdmin.notPaced, [{ userId: 'd', reason: 'an administrator set this person\'s daily cap' }]);
  // The job set it first, then an administrator changed it: the administrator now owns it.
  const taken = plan({ percent: null, effective, caps: [admins], audit: [event(8, 'oidc:sub-1', userCap('spl_d', 'd', 360), admins), event(4, PACER, null, userCap('spl_d', 'd', 360))] });
  assert.deepEqual(taken.remove, []);
  const unknown = plan({ percent: null, effective, caps: [admins], audit: [] });
  assert.deepEqual(unknown.remove, [], 'a cap with no audit event left is not the job\'s');
  const weekly = userCap('spl_w', 'd', 360, 'weekly');
  assert.deepEqual(plan({ percent: null, caps: [weekly], audit: [event(2, PACER, null, weekly)] }).remove, [], 'the job manages daily caps only');
});

// ── T-138: runPacer, with a fake Resource Manager and a fake gateway admin API ──

const RESOURCE = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/ca-claude-gw';
const pacedAdmin = (extra = {}) => ({ roles: ['Gateway.Standard'], models: [{ id: 'm', deployment: 'm' }], deployment: { adminApi: true }, spendPacing: { softLimitPercent: 80 }, ...extra });

function fakes({ secrets, effective = [], caps = [], audit = [] }) {
  const calls = [];
  const arm = async (method, p) => {
    calls.push({ to: 'arm', method, path: p });
    if (method === 'POST' && p.startsWith(`${RESOURCE}/listSecrets?`)) return { status: 200, json: { value: Object.entries(secrets).map(([name, value]) => ({ name, value })) } };
    throw new Error(`fake ARM: no route for ${method} ${p}`);
  };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const key = init.headers?.['x-api-key'];
    calls.push({ to: 'gateway', method: init.method, path: u.pathname, query: u.search, key, body: init.body ? JSON.parse(init.body) : undefined });
    const json = (body, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
    if (u.pathname === '/v1/organizations/spend_limits/effective') {
      const periods = u.searchParams.getAll('period[]');
      return json({ data: effective.filter((r) => !periods.length || periods.includes(r.period)), next_page: null });
    }
    if (u.pathname === '/v1/organizations/spend_limits/audit') return json({ data: audit, has_more: false });
    if (u.pathname === '/v1/organizations/spend_limits' && init.method === 'GET') return json({ data: caps, has_more: false });
    if (u.pathname === '/v1/organizations/spend_limits' && init.method === 'POST') return json({ type: 'spend_limit', id: 'spl_new', ...JSON.parse(init.body) });
    if (u.pathname.startsWith('/v1/organizations/spend_limits/') && init.method === 'DELETE') return json({ type: 'spend_limit_deleted', id: u.pathname.split('/').pop() });
    return json({ type: 'error', error: { message: 'no route' } }, 404);
  };
  const lines = [];
  return { calls, deps: { arm, resourceId: RESOURCE, gatewayUrl: 'https://gw.example', fetch: fetchImpl, now: () => NOW, log: (l) => lines.push(l) }, lines };
}

test('T-138 runPacer reads the admin file and keys from the app, sets with the pacer key and logs one summary line', async () => {
  const mine = userCap('spl_c', 'c', 360);
  const f = fakes({
    secrets: { 'gateway-admin-file': JSON.stringify(pacedAdmin()), 'admin-write-key': 'awk', 'admin-pacer-key': 'pk' },
    effective: [row('a', 'monthly', 10000, 8500), row('a', 'daily', null, 300), row('c', 'monthly', 10000, 100)],
    caps: [mine], audit: [event(7, PACER, null, mine)],
  });
  const r = await runPacer(f.deps);
  assert.equal(r.exitCode, 0);
  const writes = f.calls.filter((c) => c.to === 'gateway' && c.method !== 'GET');
  assert.deepEqual(writes.map((c) => [c.method, c.path, c.key]), [
    ['POST', '/v1/organizations/spend_limits', 'pk'],
    ['DELETE', '/v1/organizations/spend_limits/spl_c', 'pk'],
  ]);
  assert.deepEqual(writes[0].body, { scope: { type: 'user', user_id: 'a' }, amount: '360', period: 'daily' });
  assert.equal(f.lines.length, 1, 'one line a run');
  const summary = JSON.parse(f.lines[0]);
  assert.deepEqual({ evt: summary.evt, percent: summary.percent, paced: summary.paced, set: summary.set, removed: summary.removed, notPaced: summary.notPaced, errors: summary.errors },
    { evt: 'spend_pacer.run', percent: 80, paced: 1, set: 1, removed: 1, notPaced: 0, errors: 0 });
  assert.doesNotMatch(f.lines[0], /@|example\.com|"a"|"c"/, 'no address or user ID in the log');
});

test('T-138 the deploy-time admin file applies until the app holds a gateway-admin-file secret', async () => {
  const f = fakes({ secrets: { 'admin-write-key': 'awk', 'admin-pacer-key': 'pk' }, effective: [row('a', 'monthly', 10000, 8500), row('a', 'daily', null, 300)] });
  const r = await runPacer({ ...f.deps, deployAdmin: pacedAdmin() });
  assert.equal(r.exitCode, 0);
  assert.equal(f.calls.filter((c) => c.method === 'POST' && c.to === 'gateway').length, 1);
});

test('T-138 with pacing turned off, the job still deletes its caps, with admin-ui\'s key once the pacer key is gone', async () => {
  const mine = userCap('spl_c', 'c', 360);
  const f = fakes({ secrets: { 'gateway-admin-file': JSON.stringify(pacedAdmin({ spendPacing: undefined })), 'admin-write-key': 'awk' }, caps: [mine], audit: [event(7, PACER, null, mine)] });
  const r = await runPacer(f.deps);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(f.calls.filter((c) => c.method === 'DELETE').map((c) => [c.path, c.key]), [['/v1/organizations/spend_limits/spl_c', 'awk']]);
});

test('T-138 negative: pacing on without the admin-pacer-key secret writes nothing and exits 1', async () => {
  const f = fakes({ secrets: { 'gateway-admin-file': JSON.stringify(pacedAdmin()), 'admin-write-key': 'awk' }, effective: [row('a', 'monthly', 10000, 8500)] });
  const r = await runPacer(f.deps);
  assert.equal(r.exitCode, 1);
  assert.equal(f.calls.filter((c) => c.to === 'gateway').length, 0, 'the gateway was not called');
  assert.match(f.lines.join('\n'), /admin-pacer-key/);
});

test('T-138 negative: with the admin API off the job does nothing and exits 0', async () => {
  const f = fakes({ secrets: { 'gateway-admin-file': JSON.stringify(pacedAdmin({ deployment: { adminApi: false }, spendPacing: undefined })) } });
  const r = await runPacer(f.deps);
  assert.equal(r.exitCode, 0);
  assert.equal(f.calls.filter((c) => c.to === 'gateway').length, 0);
});

test('T-138 a failed write is counted, the others still run, and the run exits 1', async () => {
  const f = fakes({
    secrets: { 'gateway-admin-file': JSON.stringify(pacedAdmin()), 'admin-write-key': 'awk', 'admin-pacer-key': 'pk' },
    effective: [row('a', 'monthly', 10000, 8500), row('b', 'monthly', 10000, 9000)],
  });
  const real = f.deps.fetch;
  f.deps.fetch = async (url, init = {}) => {
    if (init.method === 'POST' && JSON.parse(init.body).scope.user_id === 'a') return { ok: false, status: 500, text: async () => JSON.stringify({ type: 'error', error: { message: 'boom' } }) };
    return real(url, init);
  };
  const r = await runPacer(f.deps);
  assert.equal(r.exitCode, 1);
  const summary = JSON.parse(f.lines.at(-1));
  assert.deepEqual([summary.set, summary.errors], [1, 1]);
});

test('T-138 negative: a daily cap an administrator sets while the run is planning is not replaced', async () => {
  const f = fakes({
    secrets: { 'gateway-admin-file': JSON.stringify(pacedAdmin()), 'admin-write-key': 'awk', 'admin-pacer-key': 'pk' },
    effective: [row('a', 'monthly', 10000, 8500), row('a', 'daily', null, 300)],
  });
  const real = f.deps.fetch;
  let capLists = 0;
  f.deps.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/v1/organizations/spend_limits' && (init.method ?? 'GET') === 'GET') {
      capLists += 1;
      // The first listing is the plan's; by the second an administrator has set a $50 daily cap.
      const data = capLists === 1 ? [] : [userCap('spl_admin', 'a', 5000)];
      return { ok: true, status: 200, text: async () => JSON.stringify({ data, has_more: false }) };
    }
    return real(url, init);
  };
  const r = await runPacer(f.deps);
  assert.equal(capLists, 2, 'the caps are listed again just before writing');
  assert.equal(f.calls.filter((c) => c.method === 'POST' && c.to === 'gateway').length, 0, 'the administrator\'s cap was not replaced');
  assert.equal(r.exitCode, 0);
  assert.equal(JSON.parse(f.lines.at(-1)).notPaced, 1);
});
