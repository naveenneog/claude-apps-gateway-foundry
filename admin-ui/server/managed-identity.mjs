// Acquires a token for the admin-ui's own user-assigned managed identity from the identity endpoint Azure Container
// Apps injects into the container as IDENTITY_ENDPOINT/IDENTITY_HEADER - an App Service-style sidecar broker, not
// the bare-VM Instance Metadata Service at 169.254.169.254 (which a Container App's container cannot reach: nothing
// listens there in this environment - live-found 2026-10-16, every call failed with a generic "fetch failed" until
// this was corrected).
// https://learn.microsoft.com/en-us/azure/container-apps/managed-identity#connect-to-azure-services-in-app-code
//
// deps.fetch replaces the real fetch for tests; no test in this repository calls the live identity endpoint. The
// caller owns the cache Map (the server keeps one per process); passing a fresh Map isolates each test. deps.env
// defaults to process.env; tests pass a fake one.

/** A bearer token for `resource`, from the identity named by `clientId`. Cached in `cache` until 5 minutes before expiry. */
export async function getManagedIdentityToken({ resource, clientId, fetch: fetchImpl = fetch, cache, env = process.env }) {
  const key = `${clientId}:${resource}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt - Date.now() > 5 * 60_000) return hit.token;
  const endpoint = env.IDENTITY_ENDPOINT;
  const header = env.IDENTITY_HEADER;
  if (!endpoint || !header) throw new Error('IDENTITY_ENDPOINT and IDENTITY_HEADER must be set (the Container Apps managed-identity sidecar sets these once an identity is attached; see admin-ui/README.md)');
  const url = `${endpoint}?api-version=2019-08-01&resource=${encodeURIComponent(resource)}&client_id=${encodeURIComponent(clientId)}`;
  const res = await fetchImpl(url, { headers: { 'X-IDENTITY-HEADER': header } });
  const text = await res.text();
  if (!res.ok) throw new Error(`managed identity token request failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  cache.set(key, { token: json.access_token, expiresAt: Number(json.expires_on) * 1000 });
  return json.access_token;
}

