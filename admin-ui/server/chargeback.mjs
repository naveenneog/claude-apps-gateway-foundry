// Chargeback by business unit (ADR-0010, ADR-0015): the gateway's /effective spend rows for one period, joined to Entra
// users by email address, since a row's user_id is the token's per-application sub, not the user's object ID (U-90),
// and grouped by the business-unit tags the gateway database holds by object ID. Entra is only read, for names and IDs.
// The gateway reports the current period only (U-89), at list price unless gateway.yaml sets pricing overrides.
import { listEffectiveSpend } from './gateway-client.mjs';

export const PERIODS = ['daily', 'weekly', 'monthly'];
export const GROUP_BY = ['department', 'companyName', 'officeLocation', 'costCenter', 'division', 'role'];
const UNRESOLVED = '(unresolved)';
const UNASSIGNED = '(unassigned)';
const SELECT = 'id,displayName,userPrincipalName,mail';
const KEYS = ['department', 'costCenter', 'companyName', 'officeLocation', 'division'];
// tags: a Map of object ID -> tags, or { unavailable, reason } when the gateway has no managed database (ADR-0015).
const tagsOf = (tags, id) => (tags instanceof Map && id ? tags.get(String(id).toLowerCase()) ?? null : null);
const blank = () => Object.fromEntries(KEYS.map((k) => [k, null]));

function fail(status, message) { return Object.assign(new Error(message), { status }); }

/** Every /effective row for one period, following next_page. */
export async function collectEffective({ gateway, period, listEffective = listEffectiveSpend }) {
  const rows = [];
  let page;
  for (let i = 0; i < 1000; i += 1) {
    const res = await listEffective(gateway, { period: [period], page });
    rows.push(...(res?.data ?? []));
    page = res?.next_page ?? null;
    if (!page) return rows;
  }
  throw fail(502, 'the gateway returned more than 1000 pages of /effective rows');
}

/** The Entra user for a UPN or email address, or null. Exported for the CSV import's user column. */
export async function findUser(graph, email) {
  const direct = await graph('GET', `/users/${encodeURIComponent(email)}?$select=${SELECT}`, undefined, { ok: [200, 404] });
  if (direct.status === 200) return direct.json;
  const filter = encodeURIComponent(`mail eq '${email.replace(/'/g, "''")}'`);
  const byMail = await graph('GET', `/users?$filter=${filter}&$select=${SELECT}`, undefined, { ok: [200] });
  return byMail.json?.value?.[0] ?? null;
}

/** The report for one period and grouping. rows: /effective rows (any period; others are ignored). */
export async function buildChargeback({ rows, graph, period, groupBy, tags, now = () => new Date() }) {
  if (!PERIODS.includes(period)) throw fail(400, `period must be one of ${PERIODS.join(', ')}`);
  if (!GROUP_BY.includes(groupBy)) throw fail(400, `groupBy must be one of ${GROUP_BY.join(', ')}`);
  const mine = rows.filter((r) => r?.scope?.type === 'user' && r.period === period);
  const lookups = new Map();
  for (const r of mine) {
    const email = r.actor?.email_address?.toLowerCase();
    if (email && !lookups.has(email)) lookups.set(email, await findUser(graph, email));
  }
  const out = mine.map((r) => {
    const email = r.actor?.email_address?.toLowerCase() ?? null;
    const user = email ? lookups.get(email) : null;
    const roles = [...(r.groups ?? [])].sort();
    const own = { ...blank(), ...(tagsOf(tags, user?.id) ?? {}) };
    let groupKey;
    if (groupBy === 'role') groupKey = roles.length ? roles.join(' + ') : UNASSIGNED;
    else if (!user) groupKey = UNRESOLVED;
    else groupKey = own[groupBy] || UNASSIGNED;
    return {
      userId: r.scope.user_id, objectId: user?.id ?? null, name: user?.displayName ?? r.actor?.name ?? null, email, groupKey, roles,
      spendCents: Number(r.period_to_date_spend ?? 0), capCents: r.amount === null || r.amount === undefined ? null : Number(r.amount),
      ...own, resolved: Boolean(user),
    };
  });
  const groups = new Map();
  for (const row of out) {
    const g = groups.get(row.groupKey) ?? { key: row.groupKey, label: row.groupKey, totalCents: 0, users: 0 };
    g.totalCents += row.spendCents;
    g.users += 1;
    groups.set(row.groupKey, g);
  }
  const list = [...groups.values()].sort((a, b) => b.totalCents - a.totalCents || a.key.localeCompare(b.key));
  const totalCents = list.reduce((a, g) => a + g.totalCents, 0);
  for (const g of list) g.sharePct = totalCents ? Math.round((g.totalCents / totalCents) * 1000) / 10 : 0;
  out.sort((a, b) => b.spendCents - a.spendCents);
  return {
    period, groupBy, generatedAt: now().toISOString(), currency: 'USD', totalCents, groups: list, rows: out,
    notes: [
      "Amounts are the gateway's own estimates at list price, or at gateway.yaml's pricing overrides, for the current period to date; they are not the Azure invoice.",
      'The gateway reports the current period only; earlier periods need an OpenTelemetry export kept elsewhere.',
      `${UNRESOLVED}: no email recorded for the user, or no Entra user with that email. ${UNASSIGNED}: the user has no tag for this classification.`,
      ...(tags && !(tags instanceof Map) && tags.reason ? [tags.reason] : []),
    ],
  };
}

// OWASP CSV injection: a cell starting with = + - @ (or tab or carriage return) is read as a formula by spreadsheets.
function cell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function chargebackCsv(report) {
  const head = ['period', 'group', 'name', 'email', 'roles', 'department', 'cost_center', 'company', 'office', 'division', 'spend_usd', 'cap_usd', 'resolved'];
  const lines = [head.join(',')];
  for (const r of report.rows) {
    lines.push([
      report.period, r.groupKey, r.name, r.email, r.roles.join(' + '), r.department, r.costCenter, r.companyName, r.officeLocation, r.division,
      (r.spendCents / 100).toFixed(4), r.capCents === null ? '' : (r.capCents / 100).toFixed(4), r.resolved,
    ].map(cell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Business units: the department tag of each gateway role holder (listDevelopers rows), spend or not, so a unit can be
 * created and filled before its users have spend. A principal that is not a user (a group) is skipped, not expanded.
 * Entra gives only the name and UPN; the five classifications are the tags (ADR-0015).
 */
export async function listBusinessUnits({ graph, developers, tags }) {
  const holders = new Map();
  for (const d of developers ?? []) {
    const h = holders.get(d.principalId) ?? { name: d.name ?? null, roles: new Set() };
    h.roles.add(d.role);
    holders.set(d.principalId, h);
  }
  const users = [];
  const skipped = [];
  for (const [id, h] of holders) {
    const found = await graph('GET', `/users/${encodeURIComponent(id)}?$select=id,displayName,userPrincipalName`, undefined, { ok: [200, 404] });
    if (found.status !== 200) { skipped.push({ principalId: id, name: h.name }); continue; }
    const u = found.json;
    users.push({ id, upn: u.userPrincipalName ?? null, name: u.displayName ?? h.name, roles: [...h.roles].sort(), ...blank(), ...(tagsOf(tags, id) ?? {}) });
  }
  const counts = new Map();
  for (const u of users) if (u.department) counts.set(u.department, (counts.get(u.department) ?? 0) + 1);
  const units = [...counts].map(([name, n]) => ({ name, users: n })).sort((a, b) => a.name.localeCompare(b.name));
  const rank = (u) => (u.department ? 0 : 1);
  users.sort((a, b) => rank(a) - rank(b) || String(a.department ?? '').localeCompare(String(b.department ?? '')) || String(a.name ?? '').localeCompare(String(b.name ?? '')));
  return { users, units, unassigned: users.filter((u) => !u.department).length, skipped };
}