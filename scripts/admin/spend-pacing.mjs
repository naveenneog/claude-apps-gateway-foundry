// Soft limit and daily pacing of the monthly cap (ADR-0014): the admin file's spendPacing setting, the lines it adds to
// the gateway's admin block, and pacePlan, the rule the scheduled job applies through the gateway's own admin API
// (https://code.claude.com/docs/en/claude-apps-gateway-spend-limits). Amounts are whole US cents, days are UTC days.
export const PACER_KEY_ID = 'spend-pacer';
export const PACER_ENV = 'GATEWAY_ADMIN_PACER_KEY';
export const PACER_SECRET = 'admin-pacer-key';
const PACER_ACTOR = `admin-key:${PACER_KEY_ID}`;

export function spendPacingErrors(spendPacing, deployment) {
  if (spendPacing === null || typeof spendPacing !== 'object' || Array.isArray(spendPacing)) return ['spendPacing: must be an object, such as { "softLimitPercent": 80 }'];
  const errors = [];
  for (const key of Object.keys(spendPacing)) if (key !== 'softLimitPercent') errors.push(`spendPacing.${key}: unknown key; the key is softLimitPercent`);
  const p = spendPacing.softLimitPercent;
  if (!(Number.isInteger(p) && p >= 1 && p <= 99)) errors.push('spendPacing.softLimitPercent: must be a whole number from 1 to 99');
  // The job sets caps through the admin API, which the gateway serves only with an admin: block.
  if (deployment?.adminApi !== true) errors.push('spendPacing: needs deployment.adminApi true, since the pacing job sets caps through the admin API');
  return errors;
}

/** The lines spendPacing adds to the admin: block, after admin-ui's write key: the job's key and the 429 explanation. */
export function pacingAdminLines(spendPacing) {
  if (!spendPacing) return { keys: [], message: [] };
  const percent = spendPacing.softLimitPercent;
  const message = `If this is a daily limit: you have passed ${percent}% of your monthly budget, so the rest is spread over the days `
    + 'left in the month, and the daily limit resets at 00:00 UTC. To raise the monthly budget, ask your gateway administrator.';
  return {
    keys: [`    - id: ${PACER_KEY_ID}`, `      key: "\${${PACER_ENV}}"`],
    message: [`  blocked_message: ${JSON.stringify(message)}`],
  };
}

// ADR-0008: the gateway's own spend-limits admin API (https://code.claude.com/docs/en/claude-apps-gateway-spend-limits),
// which the admin-ui BFF calls server-to-server with GATEWAY_ADMIN_WRITE_KEY. Retention matches the gateway's own
// defaults, stated explicitly rather than left implicit. write_keys/read_keys entries are {id, key} objects, not
// bare strings (confirmed live 2026-10-16 against the gateway's own schema and Anthropic's example config). Shared
// by both topologies: the admin API is as usable on the test deployment as on the private one. ADR-0014 adds the
// pacing job's key and the blocked message when spendPacing is set.
export function adminApiBlock(enabled, spendPacing) {
  if (!enabled) return [];
  const pacing = pacingAdminLines(spendPacing);
  return [
    '',
    '# The gateway\'s own spend-limits admin API, called by the admin-ui backend (ADR-0008). Not a human sign-in path:',
    '# GATEWAY_ADMIN_WRITE_KEY is a server-held secret, never a developer credential.',
    'admin:',
    '  write_keys:',
    '    - id: admin-ui',
    '      key: "${GATEWAY_ADMIN_WRITE_KEY}"',
    ...pacing.keys,
    ...pacing.message,
    '  spend_retention_months: 13',
    '  audit_retention_days: 365',
  ];
}

const cents = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const daysLeft = (now) => {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate() - now.getUTCDate() + 1;
};

// The daily cap that applies to a person without a per-user one: their role caps, the most restrictive by default
// (admin.group_limit_mode), else the organization's; null when unlimited. A role cap of null is an unlimited role cap.
function roleOrOrgDaily(caps, groups, mode) {
  const daily = caps.filter((c) => c?.period === 'daily');
  const roleCaps = daily.filter((c) => c.scope?.type === 'rbac_group' && groups.includes(c.scope.rbac_group_id)).map((c) => cents(c.amount));
  if (roleCaps.length) {
    const numbers = roleCaps.filter((v) => v !== null);
    if (numbers.length < roleCaps.length && mode === 'max') return null;
    if (!numbers.length) return null;
    return mode === 'max' ? Math.max(...numbers) : Math.min(...numbers);
  }
  const org = daily.find((c) => (c.scope?.type ?? 'organization') === 'organization');
  return org ? cents(org.amount) : null;
}

/**
 * What the job does in one run. effective: /effective rows (monthly and daily); caps: every configured cap; audit:
 * /audit events newest first. percent null means pacing is off: the job then only deletes the caps it set.
 * Returns { set: [{userId, amountCents}], remove: [{id, userId}], paced: [userId], notPaced: [{userId, reason}] }.
 */
export function pacePlan({ percent, now, effective = [], caps = [], audit = [], groupLimitMode = 'min' }) {
  const userDaily = new Map(caps.filter((c) => c?.scope?.type === 'user' && c.period === 'daily').map((c) => [c.scope.user_id, c]));
  // A user daily cap is the job's while the newest audit event for that user's daily cap is the job's own write.
  const owner = new Map();
  for (const e of audit) {
    const cap = e?.after ?? e?.before;
    if (cap?.scope?.type !== 'user' || cap.period !== 'daily') continue;
    if (!owner.has(cap.scope.user_id)) owner.set(cap.scope.user_id, e.actor === PACER_ACTOR && Boolean(e.after));
  }
  const rows = new Map();
  for (const r of effective) {
    if (r?.scope?.type !== 'user') continue;
    const id = r.scope.user_id;
    rows.set(id, { ...rows.get(id), [r.period]: r });
  }
  const set = [];
  const remove = [];
  const paced = [];
  const notPaced = [];
  const handled = new Set();
  for (const [userId, { monthly, daily }] of rows) {
    if (!monthly) continue;
    handled.add(userId);
    const existing = userDaily.get(userId);
    const mine = Boolean(existing) && owner.get(userId) === true;
    const cap = cents(monthly.amount);
    const spent = cents(monthly.period_to_date_spend) ?? 0;
    const past = percent !== null && cap !== null && cap > 0 && spent >= (cap * percent) / 100;
    if (!past) { if (mine) remove.push({ id: existing.id, userId }); continue; }
    if (existing && !mine) { notPaced.push({ userId, reason: 'an administrator set this person\'s daily cap' }); continue; }
    const today = cents(daily?.period_to_date_spend) ?? 0;
    const pace = Math.max(0, Math.floor((cap - (spent - today)) / daysLeft(now)));
    const floor = roleOrOrgDaily(caps, Array.isArray(monthly.groups) ? monthly.groups : [], groupLimitMode);
    if (floor !== null && floor <= pace) { if (mine) remove.push({ id: existing.id, userId }); continue; }
    paced.push(userId);
    if (!mine || cents(existing.amount) !== pace) set.push({ userId, amountCents: pace });
  }
  // The job's caps for people with no spend row this month (a new month, or rows swept) are deleted too.
  for (const [userId, existing] of userDaily) {
    if (!handled.has(userId) && owner.get(userId) === true) remove.push({ id: existing.id, userId });
  }
  return { set, remove, paced, notPaced };
}
