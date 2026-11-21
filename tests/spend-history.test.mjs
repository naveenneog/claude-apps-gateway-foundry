// T-184 (P-50, ADR-0021): chargeback history in our own admin_console schema, managed PostgreSQL only. The gateway keeps
// period spend for admin.spend_retention_months (default 13) and its admin API returns only the period in progress, so
// the console copies it: from the documented /effective API every run, and from the gateway's public.spend table while
// that table matches the measured contract. History is never deleted and the gateway's tables are only read.
import assert from 'node:assert/strict';
import test from 'node:test';
import { periodKeys, periodOf, spendTableContract } from '../scripts/admin/spend-periods.mjs';
import { captureEffective, copyGatewayTable, readHistory, historyKeys, HISTORY_SCHEMA, runHistory } from '../admin-ui/server/spend-history.mjs';

const SPEND_COLS = [['principal', 'text'], ['period', 'text'], ['cents', 'double precision'], ['updated_at', 'timestamp with time zone']];
const EMAIL_COLS = [['principal', 'text'], ['email', 'text'], ['name', 'text'], ['groups', 'jsonb'], ['updated_at', 'timestamp with time zone']];

function fakeDb({ spendCols = SPEND_COLS, emailCols = EMAIL_COLS, oddPeriods = 0, rows = {} } = {}) {
  const sent = [];
  return {
    sent,
    async query(text, params = []) {
      sent.push({ text, params });
      if (/information_schema\.columns/.test(text)) {
        const cols = params[0] === 'spend' ? spendCols : emailCols;
        return { rows: cols.map(([c, t]) => ({ c, t })) };
      }
      if (/count\(\*\) AS n FROM public\.spend/.test(text)) return { rows: [{ n: String(oddPeriods) }] };
      for (const [pattern, result] of Object.entries(rows)) if (text.includes(pattern)) return { rows: result };
      return { rows: [], command: 'INSERT 0 0' };
    },
  };
}
const WRITES = /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i;
const onlyOurSchemaWritten = (sent) => sent.filter((s) => WRITES.test(s.text)).every((s) => {
  if (/\b(DELETE|TRUNCATE|DROP)\b/i.test(s.text)) return false;
  const target = /(?:INSERT INTO|UPDATE|ALTER TABLE|CREATE TABLE IF NOT EXISTS|CREATE SCHEMA IF NOT EXISTS|CREATE INDEX IF NOT EXISTS \w+ ON)\s+([\w.]+)/i.exec(s.text)?.[1] ?? '';
  return target === 'admin_console' || target.startsWith('admin_console.');
});

test('T-184 period keys and kinds match the gateway: UTC day, ISO week, month', () => {
  assert.deepEqual(periodKeys(new Date('2026-11-21T23:59:59Z')), { day: '2026-11-21', week: '2026-W47', month: '2026-11' });
  assert.equal(periodKeys(new Date('2027-01-01T00:00:00Z')).week, '2026-W53');
  assert.equal(periodKeys(new Date('2024-12-30T00:00:00Z')).week, '2025-W01');
  assert.deepEqual(['2026-11-21', '2026-W47', '2026-11', '2026-13-01', 'x'].map(periodOf), ['daily', 'weekly', 'monthly', null, null]);
});

test('T-184 the schema only adds to admin_console, never drops, and never touches the gateway tables', () => {
  for (const sql of HISTORY_SCHEMA) {
    assert.match(sql, /IF NOT EXISTS/);
    assert.match(sql, /admin_console/);
    assert.doesNotMatch(sql, /\b(DROP|DELETE|TRUNCATE)\b|public\./i);
  }
});

test('T-184 /effective rows are kept per user and period key, as the larger value, with email and groups', async () => {
  const db = fakeDb();
  const now = new Date('2026-11-21T10:00:00Z');
  const keys = periodKeys(now);
  const rows = [
    { scope: { type: 'user', user_id: 'u1' }, period: 'monthly', period_to_date_spend: '1234.5', actor: { email_address: 'a@contoso.com', name: 'A' }, groups: ['Gateway.Premium'] },
    { scope: { type: 'user', user_id: 'u1' }, period: 'daily', period_to_date_spend: '10' },
    { scope: { type: 'rbac_group', rbac_group_id: 'g' }, period: 'monthly', period_to_date_spend: '9' },
    { scope: { type: 'user', user_id: 'u2' }, period: 'yearly', period_to_date_spend: '9' },
  ];
  const r = await captureEffective({ db, rows, keysBefore: keys, keysAfter: keys });
  assert.equal(r.captured, 2);
  const inserts = db.sent.filter((s) => /INSERT INTO admin_console\.spend_history/.test(s.text));
  assert.equal(inserts.length, 2);
  assert.match(inserts[0].text, /GREATEST\(admin_console\.spend_history\.cents, EXCLUDED\.cents\)/);
  assert.deepEqual(inserts[0].params.slice(0, 7), ['u1', 'monthly', '2026-11', 1234.5, 'effective', 'a@contoso.com', 'A']);
  assert.equal(inserts[0].params[7], JSON.stringify(['Gateway.Premium']));
  assert.deepEqual(inserts[1].params.slice(0, 4), ['u1', 'daily', '2026-11-21', 10]);
  assert.ok(onlyOurSchemaWritten(db.sent));
});

test('T-184 a period that rolled over while /effective was read is not written, so the new period never gets the old total', async () => {
  const db = fakeDb();
  const before = periodKeys(new Date('2026-11-21T23:59:59Z'));
  const after = periodKeys(new Date('2026-11-22T00:00:01Z'));
  const rows = ['daily', 'weekly', 'monthly'].map((period) => ({ scope: { type: 'user', user_id: 'u1' }, period, period_to_date_spend: '50' }));
  const r = await captureEffective({ db, rows, keysBefore: before, keysAfter: after });
  assert.equal(r.captured, 2, 'daily skipped; the week and month did not roll over');
  assert.ok(!db.sent.some((s) => s.params.includes('daily')));
  const lastMonth = periodKeys(new Date('2026-11-30T23:59:59Z'));
  const db2 = fakeDb();
  const r2 = await captureEffective({ db: db2, rows, keysBefore: lastMonth, keysAfter: periodKeys(new Date('2026-12-01T00:00:01Z')) });
  assert.equal(r2.captured, 1, 'day and month rolled over; 2026-11-30 and 2026-12-01 share ISO week W49');
  assert.deepEqual(db2.sent.filter((s) => /INSERT/.test(s.text)).map((s) => s.params.slice(1, 3)), [['weekly', '2026-W49']]);
});

test('T-184 the gateway table is copied only when its contract matches, incrementally, and read only', async () => {
  const db = fakeDb({ rows: { 'max(gateway_updated_at)': [{ w: '2026-11-20T00:00:00Z' }] } });
  const r = await copyGatewayTable({ db });
  assert.equal(r.refused, null);
  const copy = db.sent.find((s) => /INSERT INTO admin_console\.spend_history/.test(s.text));
  assert.match(copy.text, /FROM public\.spend/);
  assert.match(copy.text, /LEFT JOIN public\.principal_emails/);
  assert.match(copy.text, /GREATEST/);
  assert.equal(copy.params[0], '2026-11-20T00:00:00Z');
  // An hour's overlap before the watermark, so a gateway row updated late in the same second as the last copy is not missed.
  assert.match(copy.text, /updated_at > COALESCE\(\$1::timestamptz, '-infinity'::timestamptz\) - interval '1 hour'/);
  assert.ok(onlyOurSchemaWritten(db.sent));
  assert.ok(!db.sent.some((s) => /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b[^;]*public\./i.test(s.text.replace(/FROM public\.\w+|JOIN public\.\w+/g, ''))));
});

test('T-184 a changed gateway table is refused with the reason and nothing is copied; emails are joined only if their table matches', async () => {
  for (const [opts, reason] of [
    [{ spendCols: [['principal', 'text'], ['period', 'text'], ['cents', 'numeric'], ['updated_at', 'timestamp with time zone']] }, /cents is numeric, expected double precision/],
    [{ spendCols: [] }, /public\.spend is missing|column principal is missing/],
    [{ oddPeriods: 3 }, /3 spend periods match no known period format/],
  ]) {
    const db = fakeDb(opts);
    const r = await copyGatewayTable({ db });
    assert.match(r.refused, reason);
    assert.ok(!db.sent.some((s) => /INSERT/.test(s.text)), JSON.stringify(opts));
  }
  const noEmails = fakeDb({ emailCols: [['principal', 'text'], ['mail', 'text']] });
  const r = await copyGatewayTable({ db: noEmails });
  assert.equal(r.refused, null);
  const copy = noEmails.sent.find((s) => /INSERT INTO admin_console\.spend_history/.test(s.text));
  assert.doesNotMatch(copy.text, /principal_emails/);
  assert.match(r.note, /principal_emails/);
});

test('T-184 the spend contract helper names the first difference', async () => {
  assert.equal(await spendTableContract(fakeDb()), 'ok');
  assert.match(await spendTableContract(fakeDb({ spendCols: [...SPEND_COLS, ['model', 'text']] })), /5 columns, expected 4/);
});

test('T-184 history reads back as /effective-shaped rows for one period key, and lists the keys newest first', async () => {
  const db = fakeDb({ rows: {
    'WHERE period = $1 AND period_key = $2': [{ principal: 'u1', cents: '1234.5', email: 'a@contoso.com', display_name: 'A', groups: '["Gateway.Premium"]' }],
    'SELECT DISTINCT period_key': [{ period_key: '2026-11' }, { period_key: '2026-10' }],
  } });
  const rows = await readHistory({ db, period: 'monthly', key: '2026-10' });
  assert.deepEqual(rows, [{ scope: { type: 'user', user_id: 'u1' }, period: 'monthly', period_to_date_spend: '1234.5', amount: null,
    actor: { email_address: 'a@contoso.com', name: 'A' }, groups: ['Gateway.Premium'] }]);
  assert.deepEqual(await historyKeys({ db, period: 'monthly' }), ['2026-11', '2026-10']);
  await assert.rejects(readHistory({ db, period: 'monthly', key: '2026-10-01' }), /key/);
  await assert.rejects(readHistory({ db, period: 'yearly', key: '2026' }), /period/);
});

test('T-184 a history run on the in-app database does nothing, and a failure is reported, not thrown', async () => {
  const lines = [];
  const skip = await runHistory({ credential: async () => ({ unavailable: true, reason: 'in-app database' }), effective: async () => [], log: (l) => lines.push(l) });
  assert.equal(skip.exitCode, 0);
  assert.match(lines.join('\n'), /skipped/);
  const broken = await runHistory({ credential: async () => ({ host: 'h' }), connect: async () => { throw new Error('ETIMEDOUT'); }, effective: async () => [], log: (l) => lines.push(l) });
  assert.equal(broken.exitCode, 1);
  assert.match(lines.at(-1), /spend_history\.error/);
  assert.doesNotMatch(lines.join('\n'), /@|password/i, 'counts only, no personal data or secrets');
});

test('T-184 the job runs pacing and history independently: either failing still runs the other, and fails the run', async () => {
  const { runJob } = await import('../admin-ui/server/pacer-job.mjs');
  const order = [];
  const ok = (name) => async () => { order.push(name); return { exitCode: 0 }; };
  const bad = (name) => async () => { order.push(name); throw new Error(`${name} broke`); };
  assert.deepEqual(await runJob({ pacer: ok('pacer'), history: ok('history') }), { exitCode: 0, pacer: 0, history: 0 });
  assert.deepEqual(await runJob({ pacer: bad('pacer'), history: ok('history') }), { exitCode: 1, pacer: 1, history: 0 });
  assert.deepEqual(await runJob({ pacer: ok('pacer'), history: bad('history') }), { exitCode: 1, pacer: 0, history: 1 });
  assert.deepEqual(order, ['pacer', 'history', 'pacer', 'history', 'pacer', 'history']);
});
