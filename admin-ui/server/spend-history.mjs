// Chargeback history (P-50, ADR-0021): each person's spend per closed day, ISO week and month, kept in our own
// admin_console schema in the gateway's managed PostgreSQL, so the Chargeback page can report past periods for longer
// than the gateway keeps them (admin.spend_retention_months, default 13). Two sources, both into the same rows:
// - the gateway's documented admin API, GET /v1/organizations/spend_limits/effective, every run of job-spend-pacer;
// - the gateway's public.spend table, copied incrementally, only while it matches the contract measured in U-156.
// The larger value wins, because spend within a period only grows. Rows are never deleted, and the gateway's tables are
// only read. The run logs counts only.
import { connect as pgConnect } from './pg-wire.mjs';
import { periodKeys, periodOf, PERIOD_FIELD, spendTableContract, emailsTableContract } from '../../scripts/admin/spend-periods.mjs';

export const HISTORY_SCHEMA = Object.freeze([
  'CREATE SCHEMA IF NOT EXISTS admin_console',
  'CREATE TABLE IF NOT EXISTS admin_console.spend_history (principal text NOT NULL, period text NOT NULL, period_key text NOT NULL, ' +
    'cents double precision NOT NULL, source text NOT NULL, email text, display_name text, groups jsonb, gateway_updated_at timestamptz, ' +
    'captured_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (principal, period_key))',
  'CREATE INDEX IF NOT EXISTS spend_history_period ON admin_console.spend_history (period, period_key)',
]);
const PERIODS = Object.keys(PERIOD_FIELD);
const UPSERT_TAIL = 'ON CONFLICT (principal, period_key) DO UPDATE SET ' +
  'cents = GREATEST(admin_console.spend_history.cents, EXCLUDED.cents), ' +
  'source = CASE WHEN EXCLUDED.cents > admin_console.spend_history.cents THEN EXCLUDED.source ELSE admin_console.spend_history.source END, ' +
  'email = COALESCE(EXCLUDED.email, admin_console.spend_history.email), ' +
  'display_name = COALESCE(EXCLUDED.display_name, admin_console.spend_history.display_name), ' +
  'groups = COALESCE(EXCLUDED.groups, admin_console.spend_history.groups), ' +
  'gateway_updated_at = GREATEST(admin_console.spend_history.gateway_updated_at, EXCLUDED.gateway_updated_at), captured_at = now()';
const fail = (status, message) => Object.assign(new Error(message), { status });

export async function ensureSchema(db) { for (const sql of HISTORY_SCHEMA) await db.query(sql); }

/**
 * Upserts the user rows of /effective. keysBefore and keysAfter are periodKeys() taken before and after the rows were
 * read: a period that rolled over in between is skipped, so a new period is never given the previous period's total.
 */
export async function captureEffective({ db, rows, keysBefore, keysAfter }) {
  let captured = 0;
  for (const r of rows ?? []) {
    if (r?.scope?.type !== 'user' || !r.scope.user_id || !PERIODS.includes(r.period)) continue;
    const field = PERIOD_FIELD[r.period];
    if (keysBefore[field] !== keysAfter[field]) continue;
    const cents = Number(r.period_to_date_spend ?? 0);
    if (!Number.isFinite(cents)) continue;
    await db.query('INSERT INTO admin_console.spend_history (principal, period, period_key, cents, source, email, display_name, groups) ' +
      `VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ${UPSERT_TAIL}`,
    [r.scope.user_id, r.period, keysAfter[field], cents, 'effective', r.actor?.email_address ?? null, r.actor?.name ?? null,
      Array.isArray(r.groups) ? JSON.stringify(r.groups) : null]);
    captured += 1;
  }
  return { captured };
}

/**
 * Copies rows of public.spend changed since the last copy (with an hour's overlap), only if the table matches the
 * contract. E-mail, name and groups come from public.principal_emails when that table matches too.
 */
export async function copyGatewayTable({ db }) {
  const contract = await spendTableContract(db);
  if (contract !== 'ok') return { copied: 0, refused: contract, note: null };
  const emails = await emailsTableContract(db);
  const watermark = (await db.query("SELECT max(gateway_updated_at) AS w FROM admin_console.spend_history WHERE source = 'gateway-table'")).rows[0]?.w ?? null;
  const join = emails === 'ok';
  const kind = String.raw`CASE WHEN s.period ~ '^\d{4}-\d{2}-\d{2}$' THEN 'daily' WHEN s.period ~ '^\d{4}-W\d{2}$' THEN 'weekly' ELSE 'monthly' END`;
  const r = await db.query('INSERT INTO admin_console.spend_history (principal, period, period_key, cents, source, email, display_name, groups, gateway_updated_at) ' +
    `SELECT s.principal, ${kind}, s.period, s.cents, 'gateway-table', ${join ? 'e.email, e.name, e.groups' : 'NULL, NULL, NULL'}, s.updated_at ` +
    `FROM public.spend s ${join ? 'LEFT JOIN public.principal_emails e ON e.principal = s.principal ' : ''}` +
    "WHERE s.updated_at > COALESCE($1::timestamptz, '-infinity'::timestamptz) - interval '1 hour' " + UPSERT_TAIL, [watermark]);
  const copied = Number(/\d+$/.exec(r.command ?? '')?.[0] ?? 0);
  return { copied, refused: null, note: join ? null : `public.principal_emails differs (${emails}); copied rows have no e-mail address until the person's next request` };
}

/** History rows for one period key, in the /effective row shape the chargeback report reads. */
export async function readHistory({ db, period, key }) {
  if (!PERIODS.includes(period)) throw fail(400, `period must be one of ${PERIODS.join(', ')}`);
  if (periodOf(key) !== period) throw fail(400, `key ${JSON.stringify(key)} is not a ${period} period key`);
  const rows = (await db.query('SELECT principal, cents, email, display_name, groups FROM admin_console.spend_history WHERE period = $1 AND period_key = $2 ORDER BY principal', [period, key])).rows;
  return rows.map((r) => ({
    scope: { type: 'user', user_id: r.principal }, period, period_to_date_spend: String(r.cents), amount: null,
    actor: { email_address: r.email ?? null, name: r.display_name ?? null },
    groups: typeof r.groups === 'string' ? JSON.parse(r.groups) : (r.groups ?? []),
  }));
}

/** Period keys with history for one period, newest first. */
export async function historyKeys({ db, period, limit = 500 }) {
  if (!PERIODS.includes(period)) throw fail(400, `period must be one of ${PERIODS.join(', ')}`);
  return (await db.query('SELECT DISTINCT period_key FROM admin_console.spend_history WHERE period = $1 ORDER BY period_key DESC LIMIT $2', [period, limit])).rows.map((r) => r.period_key);
}

/**
 * One history run. credential: user-tags gatewayDatabase()'s result; effective: async () => /effective rows for all three
 * periods. Returns { exitCode }. Logs one line with counts.
 */
export async function runHistory({ credential, effective, connect = pgConnect, now = () => new Date(), log = console.log }) {
  const line = (o) => log(JSON.stringify(o));
  try {
    const cred = await credential();
    if (cred?.unavailable) { line({ evt: 'spend_history.run', skipped: 'the gateway uses its in-app database; history needs the managed database' }); return { exitCode: 0 }; }
    const keysBefore = periodKeys(now());
    const rows = await effective();
    const keysAfter = periodKeys(now());
    const db = await connect(cred);
    try {
      await ensureSchema(db);
      const { captured } = await captureEffective({ db, rows, keysBefore, keysAfter });
      const table = await copyGatewayTable({ db });
      line({ evt: 'spend_history.run', captured, copied: table.copied, refused: table.refused, note: table.note });
    } finally { await db.close(); }
    return { exitCode: 0 };
  } catch (error) {
    line({ evt: 'spend_history.error', message: String(error.message ?? error).slice(0, 300) });
    return { exitCode: 1 };
  }
}

/**
 * The console's read side. credential: async () => database credential or {unavailable, reason} (user-tags
 * gatewayDatabase). The schema is created on first use, so the page works before the job's first run.
 */
export function createHistoryStore({ credential, connect = pgConnect }) {
  let ready = false;
  async function withDb(fn) {
    const cred = await credential();
    if (cred?.unavailable) throw Object.assign(new Error(cred.reason), { status: 503 });
    const db = await connect(cred);
    try {
      if (!ready) { await ensureSchema(db); ready = true; }
      return await fn(db);
    } finally { await db.close(); }
  }
  return {
    /** Keys with history for a period, the current key excluded, newest first. */
    async periods(period, current) {
      const cred = await credential();
      if (cred?.unavailable) return { period, current, keys: [], available: false, reason: cred.reason };
      const keys = await withDb((db) => historyKeys({ db, period }));
      return { period, current, keys: keys.filter((k) => k !== current), available: true };
    },
    rows: (period, key) => withDb((db) => readHistory({ db, period, key })),
  };
}
