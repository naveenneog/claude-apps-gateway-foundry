// T-185 (P-50, ADR-0021): the Chargeback page reports a closed period from the console's own history, and the current
// period, as before, from the gateway's /effective. A past-period request never reaches /effective, and the current period
// never reads history.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { handleApi } from '../admin-ui/server/api.mjs';
import { buildChargeback, chargebackRows } from '../admin-ui/server/chargeback.mjs';
import { createHistoryStore } from '../admin-ui/server/spend-history.mjs';

const admin = Buffer.from(JSON.stringify({ auth_typ: 'aad', name_typ: 'preferred_username', role_typ: 'roles',
  claims: [{ typ: 'preferred_username', val: 'admin@contoso.example' }, { typ: 'roles', val: 'AdminUi.Admin' }] })).toString('base64');
const req = (p) => { const [pathname, qs] = p.split('?'); return { method: 'GET', pathname, searchParams: new URLSearchParams(qs ?? ''), headers: { 'x-ms-client-principal': admin } }; };
function deps() {
  const calls = [];
  return { calls, deps: {
    auth: { signIn: 'required' }, tags: { status: async () => ({ available: true }) },
    chargeback: {
      build: async (q) => { calls.push(['build', q]); return { period: q.period, groupBy: q.groupBy, key: q.key ?? null, rows: [], groups: [], totalCents: 0, notes: [] }; },
      csv: () => 'period\r\n',
      periods: async (p) => { calls.push(['periods', p]); return { period: p, current: '2026-11', keys: ['2026-10', '2026-09'], available: true }; },
    },
  } };
}

test('T-185 the route passes a past period key through, names it in the CSV file, and lists the periods with history', async () => {
  const { deps: d, calls } = deps();
  const r = await handleApi(req('/api/chargeback?period=monthly&key=2026-10&groupBy=department'), d);
  assert.equal(r.status, 200);
  assert.deepEqual(calls[0], ['build', { period: 'monthly', groupBy: 'department', key: '2026-10' }]);
  const csv = await handleApi(req('/api/chargeback?period=monthly&key=2026-10&groupBy=role&format=csv'), d);
  assert.match(csv.headers['Content-Disposition'], /filename="chargeback-monthly-2026-10-role\.csv"/);
  const periods = await handleApi(req('/api/chargeback/periods?period=weekly'), d);
  assert.deepEqual(calls.at(-1), ['periods', 'weekly']);
  assert.deepEqual(periods.body.keys, ['2026-10', '2026-09']);
  const current = await handleApi(req('/api/chargeback?period=monthly&groupBy=department'), d);
  assert.equal(current.status, 200);
  assert.deepEqual(calls.at(-1), ['build', { period: 'monthly', groupBy: 'department' }], 'no key when none is asked for');
});

test('T-185 a past key reads history only; no key or the current key reads /effective only', async () => {
  const seen = [];
  const sources = { effective: async () => { seen.push('effective'); return ['e']; }, history: async (k) => { seen.push(`history:${k}`); return ['h']; } };
  assert.deepEqual(await chargebackRows({ period: 'monthly', key: '2026-10', currentKey: '2026-11', ...sources }), ['h']);
  assert.deepEqual(await chargebackRows({ period: 'monthly', key: null, currentKey: '2026-11', ...sources }), ['e']);
  assert.deepEqual(await chargebackRows({ period: 'monthly', key: '2026-11', currentKey: '2026-11', ...sources }), ['e']);
  assert.deepEqual(seen, ['history:2026-10', 'effective', 'effective']);
  await assert.rejects(chargebackRows({ period: 'monthly', key: '2026-12', currentKey: '2026-11', ...sources }), /future/);
});

test('T-185 report notes say where the amounts come from: current period from the gateway, a past one from the history', async () => {
  const graph = async () => ({ status: 404, json: null });
  const current = await buildChargeback({ rows: [], graph, period: 'monthly', groupBy: 'department', tags: new Map() });
  assert.doesNotMatch(current.notes.join(' '), /current period only|OpenTelemetry/);
  assert.match(current.notes.join(' '), /Past periods/);
  const past = await buildChargeback({ rows: [], graph, period: 'monthly', groupBy: 'department', tags: new Map(), key: '2026-10' });
  assert.equal(past.key, '2026-10');
  assert.match(past.notes.join(' '), /closed period 2026-10/);
});

test('T-185 the history store answers the in-app database with a reason and lists keys with the current one first', async () => {
  const off = createHistoryStore({ credential: async () => ({ unavailable: true, reason: 'in-app database' }) });
  assert.deepEqual(await off.periods('monthly', '2026-11'), { period: 'monthly', current: '2026-11', keys: [], available: false, reason: 'in-app database' });
  const db = { async query(text) { return { rows: /DISTINCT period_key/.test(text) ? [{ period_key: '2026-11' }, { period_key: '2026-10' }] : [] }; }, async close() {} };
  const on = createHistoryStore({ credential: async () => ({ host: 'h' }), connect: async () => db });
  assert.deepEqual(await on.periods('monthly', '2026-11'), { period: 'monthly', current: '2026-11', keys: ['2026-10'], available: true });
});

test('T-185 the page offers the current period then past keys with readable labels, and builds keyed links', () => {
  const context = { URL };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(import.meta.dirname, '..', 'admin-ui', 'web', 'chargeback-view.js'), 'utf8'), context);
  const cb = context.chargebackView;
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plain(cb.periodChoices('monthly', ['2026-10', '2025-11'])), [
    { value: '', label: 'Month to date' }, { value: '2026-10', label: 'October 2026' }, { value: '2025-11', label: 'November 2025' }]);
  assert.deepEqual(plain(cb.periodChoices('weekly', ['2026-W46'])), [{ value: '', label: 'Week to date' }, { value: '2026-W46', label: 'Week 46, 2026' }]);
  assert.deepEqual(plain(cb.periodChoices('daily', ['2026-11-20'])), [{ value: '', label: 'Today' }, { value: '2026-11-20', label: '2026-11-20' }]);
  // The Period list names the kind only, so it never contradicts a closed period chosen under Showing.
  assert.deepEqual(plain(cb.PERIODS).map((p) => p.label), ['Monthly', 'Weekly', 'Daily']);
  assert.equal(cb.dataHref('monthly', 'role', '2026-10'), '/api/chargeback?period=monthly&groupBy=role&key=2026-10');
  assert.equal(cb.dataHref('monthly', 'role'), '/api/chargeback?period=monthly&groupBy=role');
  assert.equal(cb.csvHref('monthly', 'role', '2026-10'), '/api/chargeback?format=csv&period=monthly&groupBy=role&key=2026-10');
  assert.equal(cb.csvFileName('monthly', 'role', '2026-11-21T00:00:00Z', '2026-10'), 'chargeback-monthly-2026-10-role.csv');
});
