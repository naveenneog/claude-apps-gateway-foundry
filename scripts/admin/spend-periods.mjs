// The gateway's spend periods and the contract of its public.spend table (ADR-0021), shared by the console's chargeback
// history (P-50) and the image-only gateway upgrade check (P-51). The table is not a documented interface: the shape
// below was measured on the Contoso managed PostgreSQL on 2026-11-21 (U-156), so code that reads it checks it first.
const pad = (n) => String(n).padStart(2, '0');
export const SPEND_CONTRACT = Object.freeze([['principal', 'text'], ['period', 'text'], ['cents', 'double precision'], ['updated_at', 'timestamp with time zone']]);
export const EMAILS_CONTRACT = Object.freeze([['principal', 'text'], ['email', 'text'], ['name', 'text'], ['groups', 'jsonb']]);
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const WEEK = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The gateway's current UTC period keys: day YYYY-MM-DD, ISO week YYYY-Www, month YYYY-MM. */
export function periodKeys(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week = 1 + Math.round(((thursday - jan4) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return { day, week: `${isoYear}-W${pad(week)}`, month: day.slice(0, 7) };
}

/** daily, weekly or monthly for a period key, or null. */
export const periodOf = (key) => (DAY.test(key) ? 'daily' : WEEK.test(key) ? 'weekly' : MONTH.test(key) ? 'monthly' : null);
export const PERIOD_FIELD = Object.freeze({ daily: 'day', weekly: 'week', monthly: 'month' });

async function columns(db, table) {
  const r = await db.query("SELECT column_name AS c, data_type AS t FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position", [table]);
  return r.rows.map((x) => [x.c, x.t]);
}

function firstDifference(cols, contract, table, exact) {
  if (!cols.length) return `public.${table} is missing`;
  for (const [c, t] of contract) {
    const found = cols.find(([name]) => name === c);
    if (!found) return `column ${c} is missing from public.${table}`;
    if (found[1] !== t) return `column ${c} is ${found[1]}, expected ${t}`;
  }
  if (exact && cols.length !== contract.length) return `public.${table} has ${cols.length} columns, expected ${contract.length}`;
  return null;
}

/** 'ok', or the first way public.spend differs from the measured contract. */
export async function spendTableContract(db) {
  const diff = firstDifference(await columns(db, 'spend'), SPEND_CONTRACT, 'spend', true);
  if (diff) return diff;
  const odd = Number((await db.query(String.raw`SELECT count(*) AS n FROM public.spend WHERE period !~ '^\d{4}-(\d{2}-\d{2}|W\d{2}|\d{2})$'`)).rows[0]?.n ?? 0);
  return odd ? `${odd} spend periods match no known period format` : 'ok';
}

/** 'ok', or why public.principal_emails cannot supply e-mail addresses for past periods. */
export async function emailsTableContract(db) {
  return firstDifference(await columns(db, 'principal_emails'), EMAILS_CONTRACT, 'principal_emails', false) ?? 'ok';
}
