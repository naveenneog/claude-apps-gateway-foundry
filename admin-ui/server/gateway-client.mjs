// A thin client for the Claude apps gateway's own admin API (ADR-0008), served at
// /v1/organizations/spend_limits when gateway.yaml's admin: block is on
// (https://code.claude.com/docs/en/claude-apps-gateway-spend-limits). No SDK: the gateway's wire shapes mirror
// Anthropic's public Admin API, so this is deliberately a plain fetch wrapper, not a generated client.
//
// deps.fetch replaces the real fetch for tests; no test in this repository calls a live gateway.

/** One gateway admin API call. Throws with the gateway's own error message on a non-2xx response. */
async function call(deps, method, path, body) {
  const { baseUrl, writeKey, fetch: fetchImpl = fetch } = deps;
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const res = await fetchImpl(url, {
    method,
    headers: { 'x-api-key': writeKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { throw new Error(`the gateway's admin API returned a non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) {
    const message = json?.error?.message ?? `HTTP ${res.status}`;
    const error = new Error(`gateway admin API ${method} ${path}: ${message}`);
    error.status = res.status;
    throw error;
  }
  return json;
}

/** GET /v1/organizations/spend_limits - list configured caps, optionally filtered to one scope type. */
export function listSpendLimits(deps, { scopeType, limit, afterId, beforeId } = {}) {
  const q = new URLSearchParams();
  if (scopeType) q.set('scope_type', scopeType);
  if (limit) q.set('limit', String(limit));
  if (afterId) q.set('after_id', afterId);
  if (beforeId) q.set('before_id', beforeId);
  const qs = q.toString();
  return call(deps, 'GET', `/v1/organizations/spend_limits${qs ? `?${qs}` : ''}`);
}

/** POST /v1/organizations/spend_limits - create or replace a cap for {scope, period}. amountCents is a whole-number string or null for unlimited. */
export async function setSpendLimit(deps, { scope, amountCents, period }) {
  if (!scope || !['user', 'rbac_group', 'organization'].includes(scope.type)) throw new Error('scope.type must be user, rbac_group or organization');
  if (!['daily', 'weekly', 'monthly'].includes(period)) throw new Error('period must be daily, weekly or monthly');
  return call(deps, 'POST', '/v1/organizations/spend_limits', { scope, amount: amountCents === null ? null : String(amountCents), period });
}

/** GET /v1/organizations/spend_limits/{id} - fetch one cap. */
export function getSpendLimit(deps, id) {
  return call(deps, 'GET', `/v1/organizations/spend_limits/${encodeURIComponent(id)}`);
}

/** DELETE /v1/organizations/spend_limits/{id} - delete one cap. */
export function deleteSpendLimit(deps, id) {
  return call(deps, 'DELETE', `/v1/organizations/spend_limits/${encodeURIComponent(id)}`);
}

/** GET /v1/organizations/spend_limits/effective - resolved cap and period-to-date spend per principal. */
export function listEffectiveSpend(deps, { userIds, period, sort, q, limit, page } = {}) {
  const qs = new URLSearchParams();
  for (const id of userIds ?? []) qs.append('user_ids[]', id);
  for (const p of period ?? []) qs.append('period[]', p);
  if (sort) qs.set('sort', sort);
  if (q) qs.set('q', q);
  if (limit) qs.set('limit', String(limit));
  if (page) qs.set('page', page);
  const s = qs.toString();
  return call(deps, 'GET', `/v1/organizations/spend_limits/effective${s ? `?${s}` : ''}`);
}

/** GET /v1/organizations/spend_limits/audit - the admin mutation trail, newest-first. */
export function listAudit(deps, { limit, afterId } = {}) {
  const qs = new URLSearchParams();
  if (limit) qs.set('limit', String(limit));
  if (afterId) qs.set('after_id', afterId);
  const s = qs.toString();
  return call(deps, 'GET', `/v1/organizations/spend_limits/audit${s ? `?${s}` : ''}`);
}
