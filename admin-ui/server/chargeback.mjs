// Chargeback by business unit (ADR-0010): the gateway's /effective spend rows for one period, joined to Entra users
// by email address, since a row's user_id is the token's per-application sub, not the user's object ID (U-90).
// The gateway reports the current period only (U-89), at list price unless gateway.yaml sets pricing overrides.
import { listEffectiveSpend } from './gateway-client.mjs';

export const PERIODS = ['daily', 'weekly', 'monthly'];
export const GROUP_BY = ['department', 'companyName', 'officeLocation', 'costCenter', 'division', 'role'];
const UNRESOLVED = '(unresolved)';
const UNASSIGNED = '(unassigned)';
const SELECT = 'id,displayName,userPrincipalName,mail,department,companyName,officeLocation,jobTitle,employeeOrgData';
// Graph: department is at most 64 characters (user resource type); admin-ui applies the same limit to cost center.
const ATTRIBUTE = /^[^\x00-\x1f\x7f]{1,64}$/;

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

async function findUser(graph, email) {
  const direct = await graph('GET', `/users/${encodeURIComponent(email)}?$select=${SELECT}`, undefined, { ok: [200, 404] });
  if (direct.status === 200) return direct.json;
  const filter = encodeURIComponent(`mail eq '${email.replace(/'/g, "''")}'`);
  const byMail = await graph('GET', `/users?$filter=${filter}&$select=${SELECT}`, undefined, { ok: [200] });
  return byMail.json?.value?.[0] ?? null;
}

const attribute = (user, groupBy) => {
  if (groupBy === 'costCenter' || groupBy === 'division') return user?.employeeOrgData?.[groupBy] ?? null;
  return user?.[groupBy] ?? null;
};

/** The report for one period and grouping. rows: /effective rows (any period; others are ignored). */
export async function buildChargeback({ rows, graph, period, groupBy, now = () => new Date() }) {
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
    let groupKey;
    if (groupBy === 'role') groupKey = roles.length ? roles.join(' + ') : UNASSIGNED;
    else if (!user) groupKey = UNRESOLVED;
    else groupKey = attribute(user, groupBy) || UNASSIGNED;
    return {
      userId: r.scope.user_id, name: user?.displayName ?? r.actor?.name ?? null, email, groupKey, roles,
      spendCents: Number(r.period_to_date_spend ?? 0), capCents: r.amount === null || r.amount === undefined ? null : Number(r.amount),
      department: user?.department ?? null, costCenter: user?.employeeOrgData?.costCenter ?? null,
      companyName: user?.companyName ?? null, jobTitle: user?.jobTitle ?? null, resolved: Boolean(user),
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
      `${UNRESOLVED}: no email recorded for the user, or no Entra user with that email. ${UNASSIGNED}: the Entra attribute is empty.`,
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
  const head = ['period', 'group', 'name', 'email', 'roles', 'department', 'cost_center', 'spend_usd', 'cap_usd', 'resolved'];
  const lines = [head.join(',')];
  for (const r of report.rows) {
    lines.push([
      report.period, r.groupKey, r.name, r.email, r.roles.join(' + '), r.department, r.costCenter,
      (r.spendCents / 100).toFixed(4), r.capCents === null ? '' : (r.capCents / 100).toFixed(4), r.resolved,
    ].map(cell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Business units: the Entra department of each gateway role holder (listDevelopers rows), spend or not, so a unit can
 * be created and filled before its users have spend. A principal that is not a user (a group) is skipped, not expanded.
 */
export async function listBusinessUnits({ graph, developers }) {
  const holders = new Map();
  for (const d of developers ?? []) {
    const h = holders.get(d.principalId) ?? { name: d.name ?? null, roles: new Set() };
    h.roles.add(d.role);
    holders.set(d.principalId, h);
  }
  const users = [];
  const skipped = [];
  for (const [id, h] of holders) {
    const found = await graph('GET', `/users/${encodeURIComponent(id)}?$select=id,displayName,userPrincipalName,department,employeeOrgData`, undefined, { ok: [200, 404] });
    if (found.status !== 200) { skipped.push({ principalId: id, name: h.name }); continue; }
    const u = found.json;
    users.push({
      id, upn: u.userPrincipalName ?? null, name: u.displayName ?? h.name, roles: [...h.roles].sort(),
      department: u.department || null, costCenter: u.employeeOrgData?.costCenter || null,
    });
  }
  const counts = new Map();
  for (const u of users) if (u.department) counts.set(u.department, (counts.get(u.department) ?? 0) + 1);
  const units = [...counts].map(([name, n]) => ({ name, users: n })).sort((a, b) => a.name.localeCompare(b.name));
  const rank = (u) => (u.department ? 0 : 1);
  users.sort((a, b) => rank(a) - rank(b) || String(a.department ?? '').localeCompare(String(b.department ?? '')) || String(a.name ?? '').localeCompare(String(b.name ?? '')));
  return { users, units, unassigned: users.filter((u) => !u.department).length, skipped };
}

/** Sets a user's department and/or cost center in Entra. Needs User.ReadWrite.All. null clears a value. */
export async function tagUser({ graph }, upn, changes = {}) {
  const body = {};
  for (const key of ['department', 'costCenter']) {
    if (!(key in changes)) continue;
    const v = changes[key];
    if (v !== null && (typeof v !== 'string' || !ATTRIBUTE.test(v))) throw fail(400, `${key} must be 1 to 64 characters without control characters, or null to clear it`);
  }
  if (!('department' in changes) && !('costCenter' in changes)) throw fail(400, 'send department and/or costCenter');
  const found = await graph('GET', `/users/${encodeURIComponent(upn)}?$select=id,userPrincipalName,department,employeeOrgData`, undefined, { ok: [200, 404] });
  if (found.status === 404) throw fail(404, `no Entra user ${upn}`);
  if ('department' in changes) body.department = changes.department;
  if ('costCenter' in changes) body.employeeOrgData = { costCenter: changes.costCenter, division: found.json?.employeeOrgData?.division ?? null };
  await graph('PATCH', `/users/${encodeURIComponent(upn)}`, body);
  return {
    user: {
      upn: found.json?.userPrincipalName ?? upn,
      department: 'department' in changes ? changes.department : found.json?.department ?? null,
      costCenter: 'costCenter' in changes ? changes.costCenter : found.json?.employeeOrgData?.costCenter ?? null,
    },
  };
}
