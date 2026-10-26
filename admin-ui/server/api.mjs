// The admin-ui's API surface, as one framework-free router: { method, pathname, searchParams, body } -> { status,
// body }. Framework-free so it is testable directly, the same shape this repository's own resolver/handler modules
// use elsewhere - no HTTP server needs to run to exercise it.
//
// Two real data sources, nothing invented: the gateway's own spend-limits admin API (gateway-client.mjs, ADR-0008)
// for budgets, and Microsoft Graph app-role assignments (reusing scripts/admin/set-developer.mjs unmodified) for
// developer access. The gateway has no other admin API (confirmed in its own docs: "The gateway serves the
// spend-limits endpoints only") - this router does not pretend otherwise.
import {
  deleteSpendLimit, getSpendLimit, listAudit, listEffectiveSpend, listSpendLimits, setSpendLimit,
} from './gateway-client.mjs';
import { adminRefusal, consoleRefusal, principalFrom } from './auth.mjs';
import { clientKitAnswer } from './client-kit.mjs';

function json(status, body) { return { status, body }; }
function qsNumber(searchParams, name) { const v = searchParams.get(name); return v ? Number(v) : undefined; }

async function handleSpendLimits(req, deps) {
  const { method, pathname, searchParams, body } = req;
  const parts = pathname.split('/').filter(Boolean); // ['api', 'spend-limits', ...]
  const tail = parts.slice(2); // [] | ['effective'] | ['audit'] | [':id']

  if (tail.length === 0 && method === 'GET') {
    return json(200, await listSpendLimits(deps.gateway, {
      scopeType: searchParams.get('scope_type') ?? undefined,
      limit: qsNumber(searchParams, 'limit'),
      afterId: searchParams.get('after_id') ?? undefined,
      beforeId: searchParams.get('before_id') ?? undefined,
    }));
  }
  if (tail.length === 0 && method === 'POST') {
    if (!body?.scope || !body?.period) return json(400, { error: 'body must be {scope, amountCents, period}' });
    return json(200, await setSpendLimit(deps.gateway, body));
  }
  if (tail.length === 1 && tail[0] === 'effective' && method === 'GET') {
    return json(200, await listEffectiveSpend(deps.gateway, {
      userIds: searchParams.getAll('user_ids[]'),
      period: searchParams.getAll('period[]'),
      sort: searchParams.get('sort') ?? undefined,
      q: searchParams.get('q') ?? undefined,
      limit: qsNumber(searchParams, 'limit'),
      page: searchParams.get('page') ?? undefined,
    }));
  }
  if (tail.length === 1 && tail[0] === 'audit' && method === 'GET') {
    return json(200, await listAudit(deps.gateway, { limit: qsNumber(searchParams, 'limit'), afterId: searchParams.get('after_id') ?? undefined }));
  }
  if (tail.length === 1 && method === 'GET') return json(200, await getSpendLimit(deps.gateway, tail[0]));
  if (tail.length === 1 && method === 'DELETE') return json(200, await deleteSpendLimit(deps.gateway, tail[0]));
  return json(404, { error: 'no such spend-limits route' });
}

async function handleDevelopers(req, deps) {
  const { method, body } = req;
  const { setDeveloper, listDevelopers } = deps.developers;
  // A function in the real server: the live app roles and the live admitted roles (ADR-0010), so a role created or
  // admitted in admin-ui is usable here without redeploying admin-ui. Absent in tests and without GATEWAY_RESOURCE_ID.
  const context = deps.developersLive ? await deps.developersLive() : deps.developersDeps;
  if (method === 'GET') return json(200, { developers: await listDevelopers(context) });
  if (method === 'POST' || method === 'DELETE') {
    // ADR-0008 left this open behind admin-ui's IP restriction; once sign-in is on it needs the admin role too.
    if (deps.auth?.signIn === 'required') {
      const refusal = adminRefusal(principalFrom(req.headers ?? {}, 'required'));
      if (refusal) return json(refusal.status, refusal.body);
    }
    if (!body?.upn || !body?.role) return json(400, { error: 'body must be {upn, role}' });
    const result = await setDeveloper({ ...context, upn: body.upn, role: body.role, remove: method === 'DELETE' });
    return json(200, result);
  }
  return json(404, { error: 'no such developers route' });
}

const notConfigured = (what) => json(503, { error: `${what} is not configured for this admin-ui; see admin-ui/README.md` });

// ADR-0010 routes. handleApi has already refused non-admins when sign-in is on (ADR-0011); writes also need sign-in.
async function handleAdr0010(req, deps, principal) {
  const { method, pathname, searchParams, body } = req;
  const refusal = adminRefusal(principal);
  const guard = () => refusal && json(refusal.status, refusal.body);

  if (pathname === '/api/me' && method === 'GET') return json(200, { signIn: principal.signIn, user: principal.user, roles: principal.roles, isAdmin: principal.isAdmin });

  if (pathname === '/api/capabilities' && method === 'GET') {
    if (!deps.capabilities) return notConfigured('the capabilities check');
    return json(200, await deps.capabilities({ mode: principal.signIn, user: principal.user, isAdmin: principal.isAdmin }));
  }

  if (pathname.startsWith('/api/gateway-config')) {
    if (!deps.configStore) return notConfigured('Gateway configuration editing (GATEWAY_RESOURCE_ID)');
    const store = deps.configStore;
    if (pathname === '/api/gateway-config' && method === 'GET') {
      return json(200, { ...(await store.read()), canWrite: !refusal, readOnlyReason: refusal?.body.error ?? null });
    }
    if (pathname === '/api/gateway-config/preview' && method === 'POST') {
      if (!body?.admin || typeof body.admin !== 'object') return json(400, { error: 'body must be {admin}' });
      return json(200, await store.preview(body.admin));
    }
    if (pathname === '/api/gateway-config/rollout' && method === 'GET') return json(200, await store.rollout(searchParams.get('previous') ?? undefined));
    if (pathname === '/api/gateway-config' && method === 'PUT') {
      const denied = guard(); if (denied) return denied;
      if (!body?.admin || typeof body.admin !== 'object' || typeof body.baseVersion !== 'string') return json(400, { error: 'body must be {admin, baseVersion, acknowledgeDataLoss?}' });
      return json(200, await store.write({ admin: body.admin, baseVersion: body.baseVersion, acknowledgeDataLoss: body.acknowledgeDataLoss === true }));
    }
    return json(404, { error: 'no such gateway-config route' });
  }

  if (pathname === '/api/roles') {
    if (!deps.roles) return notConfigured('Role management');
    if (method === 'GET') {
      const canCreate = !refusal && (deps.roles.canCreate ? await deps.roles.canCreate() : true);
      return json(200, { roles: await deps.roles.list(), canCreate });
    }
    if (method === 'POST') {
      const denied = guard(); if (denied) return denied;
      return json(200, await deps.roles.create({ value: body?.value, displayName: body?.displayName, description: body?.description }));
    }
    return json(404, { error: 'no such roles route' });
  }

  if (pathname.startsWith('/api/users/') && method === 'PATCH') {
    const denied = guard(); if (denied) return denied;
    if (!deps.users) return notConfigured('User tagging');
    let upn;
    try { upn = decodeURIComponent(pathname.slice('/api/users/'.length)); } catch { return json(400, { error: 'invalid user in path' }); }
    if (!upn || upn.includes('/')) return json(400, { error: 'invalid user in path' });
    if (typeof deps.users.canWrite !== 'function' || !await deps.users.canWrite()) {
      return json(403, { error: 'User tagging requires the User.ReadWrite.All Microsoft Graph application permission.' });
    }
    const changes = {};
    for (const key of ['department', 'costCenter']) if (body && key in body) changes[key] = body[key];
    return json(200, await deps.users.tag(upn, changes));
  }

  if (pathname === '/api/client-kit' && method === 'GET') {
    if (!deps.clientKit) return notConfigured('Client files');
    return clientKitAnswer(searchParams, deps.clientKit);
  }

  if (pathname === '/api/business-units' && method === 'GET') {
    if (!deps.businessUnits) return notConfigured('Business units');
    const canTag = !refusal && Boolean(deps.users?.canWrite) && await deps.users.canWrite();
    return json(200, { ...(await deps.businessUnits.list()), canTag });
  }

  if (pathname === '/api/chargeback' && method === 'GET') {
    if (!deps.chargeback) return notConfigured('Chargeback');
    const period = searchParams.get('period') ?? 'monthly';
    const groupBy = searchParams.get('groupBy') ?? 'department';
    const report = await deps.chargeback.build({ period, groupBy });
    if (searchParams.get('format') === 'csv') {
      const day = new Date().toISOString().slice(0, 10);
      return {
        status: 200, raw: deps.chargeback.csv(report),
        headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="chargeback-${period}-${groupBy}-${day}.csv"` },
      };
    }
    const canTag = !refusal && Boolean(deps.users) && (deps.users.canWrite ? await deps.users.canWrite() : false);
    return json(200, { ...report, canTag });
  }
  return null;
}

/**
 * The one entry point. req: { method, pathname, searchParams: URLSearchParams, body: parsed JSON or undefined,
 * headers: lower-cased request headers }.
 */
export async function handleApi(req, deps) {
  try {
    if (req.pathname === '/api/health') return json(200, { ok: true });
    const principal = principalFrom(req.headers ?? {}, deps.auth?.signIn);
    // ADR-0011: checked once, before any route, so a route added later is covered too.
    if (req.pathname !== '/api/me') {
      const refused = consoleRefusal(principal);
      if (refused) return json(refused.status, refused.body);
    }
    if (req.pathname.startsWith('/api/spend-limits')) return await handleSpendLimits(req, deps);
    if (req.pathname === '/api/developers') return await handleDevelopers(req, deps);
    const answer = await handleAdr0010(req, deps, principal);
    if (answer) return answer;
    return json(404, { error: 'not found' });
  } catch (error) {
    // The gateway's, Graph's and ARM's own error messages are safe to show an admin (they never carry secrets - the
    // clients throw text built from the response body, never from a request header); logged either way.
    deps.log?.(`admin-ui API error: ${error.message}`);
    const details = error.details && typeof error.details === 'object' ? error.details : {};
    return json(error.status && error.status < 500 ? error.status : 502, { error: error.message, ...details });
  }
}
