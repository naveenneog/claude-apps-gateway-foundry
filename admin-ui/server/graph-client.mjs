// A Microsoft Graph client shaped exactly like infra/azure-test/lib/azure-rest.mjs's graph(method, path, body,
// options) -> { status, json }, so scripts/admin/set-developer.mjs's setDeveloper/listDevelopers/admittedRolesFrom
// run unmodified against it. That module's own graph() shells out to the Azure CLI (an operator's signed-in
// session); this one authenticates as the admin-ui's own deployed user-assigned managed identity instead, since a
// Container App has no Azure CLI and no operator sitting at it.
import { getManagedIdentityToken } from './managed-identity.mjs';

const GRAPH = 'https://graph.microsoft.com/v1.0';

/** cache is a Map the caller owns (one per process in the real server, a fresh one per test). env defaults to process.env. */
export function createGraphClient({ clientId, fetch: fetchImpl = fetch, cache, env = process.env }) {
  return async function graph(method, path, body, { ok = [200, 201, 202, 204], headers = {} } = {}) {
    const token = await getManagedIdentityToken({ resource: 'https://graph.microsoft.com', clientId, fetch: fetchImpl, cache, env });
    const url = /^https:\/\//.test(path) ? path : `${GRAPH}${path}`;
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* a non-JSON error body still reports res.status below */ }
    if (!ok.includes(res.status)) {
      const detail = json?.error ? `${json.error.code ?? ''}: ${json.error.message ?? ''}` : text.slice(0, 400);
      const error = new Error(`${method} ${url.split('?')[0]} returned ${res.status} ${detail}`);
      error.status = res.status;
      throw error;
    }
    return { status: res.status, json };
  };
}
