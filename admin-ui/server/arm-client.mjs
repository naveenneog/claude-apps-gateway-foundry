// An Azure Resource Manager client shaped like graph-client.mjs's graph(method, path, body, options) -> { status, json },
// authenticated as admin-ui's own user-assigned managed identity. Used by gateway-config.mjs (ADR-0010) to read and
// write the gateway container app, and by capabilities.mjs to read admin-ui's own permissions on it.
import { getManagedIdentityToken } from './managed-identity.mjs';

const ARM = 'https://management.azure.com';

/** cache is a Map the caller owns (one per process in the real server, a fresh one per test). env defaults to process.env. */
export function createArmClient({ clientId, fetch: fetchImpl = fetch, cache, env = process.env }) {
  return async function arm(method, path, body, { ok = [200, 201, 202, 204], ifMatch } = {}) {
    const token = await getManagedIdentityToken({ resource: ARM, clientId, fetch: fetchImpl, cache, env });
    const url = /^https:\/\//.test(path) ? path : `${ARM}${path}`;
    const headers = { Authorization: 'Bearer '.concat(token) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (ifMatch !== undefined) headers['If-Match'] = ifMatch;
    const res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
