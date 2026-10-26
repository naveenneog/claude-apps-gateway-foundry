// T-85: admin-ui/server/managed-identity.mjs and graph-client.mjs, corrected against Azure Container Apps' own
// documented identity endpoint (IDENTITY_ENDPOINT/IDENTITY_HEADER), not the bare-VM IMDS address at
// 169.254.169.254 the original T-82 tests wrongly assumed (live-found 2026-10-16: that address is unreachable from
// inside a Container App's container, so every real call failed with "fetch failed" - see managed-identity.mjs).
// No test here reaches the live identity endpoint or Microsoft Graph.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createGraphClient } from '../admin-ui/server/graph-client.mjs';
import { getManagedIdentityToken } from '../admin-ui/server/managed-identity.mjs';

const FAKE_ENV = { IDENTITY_ENDPOINT: 'http://localhost:42356/msi/token', IDENTITY_HEADER: 'test-identity-header-guid' };

test('T-85 getManagedIdentityToken requests IDENTITY_ENDPOINT with X-IDENTITY-HEADER and the identity\'s client_id', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok-1', expires_on: String(Math.floor(Date.now() / 1000) + 3600) }) };
  };
  const token = await getManagedIdentityToken({ resource: 'https://graph.microsoft.com', clientId: 'client-abc', fetch: fetchImpl, cache: new Map(), env: FAKE_ENV });
  assert.equal(token, 'tok-1');
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'http://localhost:42356/msi/token');
  assert.equal(url.searchParams.get('resource'), 'https://graph.microsoft.com');
  assert.equal(url.searchParams.get('client_id'), 'client-abc');
  assert.equal(url.searchParams.get('api-version'), '2019-08-01');
  assert.equal(calls[0].headers['X-IDENTITY-HEADER'], FAKE_ENV.IDENTITY_HEADER);
});

test('T-85 getManagedIdentityToken throws a clear message when IDENTITY_ENDPOINT or IDENTITY_HEADER is not set', async () => {
  const fetchImpl = async () => { throw new Error('must not be called'); };
  await assert.rejects(
    () => getManagedIdentityToken({ resource: 'https://graph.microsoft.com', clientId: 'c', fetch: fetchImpl, cache: new Map(), env: {} }),
    /IDENTITY_ENDPOINT and IDENTITY_HEADER must be set/,
  );
});

test('T-85 getManagedIdentityToken caches a token until 5 minutes before its expiry, then refetches', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: `tok-${n}`, expires_on: String(Math.floor(Date.now() / 1000) + 3600) }) };
  };
  const cache = new Map();
  const a = await getManagedIdentityToken({ resource: 'https://graph.microsoft.com', clientId: 'c', fetch: fetchImpl, cache, env: FAKE_ENV });
  const b = await getManagedIdentityToken({ resource: 'https://graph.microsoft.com', clientId: 'c', fetch: fetchImpl, cache, env: FAKE_ENV });
  assert.equal(a, b, 'the second call reused the cached token, not a fresh fetch');
  assert.equal(n, 1);
  // An expiry 4 minutes out is inside the 5-minute refresh margin, so the next call must refetch.
  cache.set('c:https://graph.microsoft.com', { token: a, expiresAt: Date.now() + 4 * 60_000 });
  const c = await getManagedIdentityToken({ resource: 'https://graph.microsoft.com', clientId: 'c', fetch: fetchImpl, cache, env: FAKE_ENV });
  assert.equal(n, 2, 'a token inside the refresh margin was refetched');
  assert.notEqual(c, a);
});

test('T-85 getManagedIdentityToken throws a clear message on a non-2xx identity-endpoint response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => 'identity not found' });
  await assert.rejects(
    () => getManagedIdentityToken({ resource: 'https://graph.microsoft.com', clientId: 'missing', fetch: fetchImpl, cache: new Map(), env: FAKE_ENV }),
    /managed identity token request failed.*identity not found/s,
  );
});

test('T-85 the Graph client sends a bearer token from the managed identity and returns {status, json}, the azure-rest.mjs shape', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (String(url).startsWith(FAKE_ENV.IDENTITY_ENDPOINT)) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'graph-tok', expires_on: String(Math.floor(Date.now() / 1000) + 3600) }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ value: [{ id: 'u1' }] }) };
  };
  const graph = createGraphClient({ clientId: 'c1', fetch: fetchImpl, cache: new Map(), env: FAKE_ENV });
  const result = await graph('GET', '/users?$select=id');
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { value: [{ id: 'u1' }] });
  const graphCall = calls.find((c) => String(c.url).startsWith('https://graph.microsoft.com'));
  assert.equal(graphCall.init.headers.Authorization, `Bearer graph-tok`);
  assert.equal(graphCall.url, 'https://graph.microsoft.com/v1.0/users?$select=id');
});

test('T-85 the Graph client throws with the Graph error code/message on a non-ok response, and sets .status', async () => {
  const fetchImpl = async (url) => {
    if (String(url).startsWith(FAKE_ENV.IDENTITY_ENDPOINT)) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't', expires_on: String(Math.floor(Date.now() / 1000) + 3600) }) };
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: { code: 'Request_ResourceNotFound', message: 'Resource not found' } }) };
  };
  const graph = createGraphClient({ clientId: 'c1', fetch: fetchImpl, cache: new Map(), env: FAKE_ENV });
  await assert.rejects(() => graph('GET', '/users/missing'), (err) => {
    assert.match(err.message, /Request_ResourceNotFound.*Resource not found/);
    assert.equal(err.status, 404);
    return true;
  });
});

test('T-85 the Graph client honors an ok list, e.g. treating 404 as a valid "not found" result rather than throwing', async () => {
  const fetchImpl = async (url) => {
    if (String(url).startsWith(FAKE_ENV.IDENTITY_ENDPOINT)) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't', expires_on: String(Math.floor(Date.now() / 1000) + 3600) }) };
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: { code: 'x', message: 'not found' } }) };
  };
  const graph = createGraphClient({ clientId: 'c1', fetch: fetchImpl, cache: new Map(), env: FAKE_ENV });
  const result = await graph('GET', '/users/missing', undefined, { ok: [200, 404] });
  assert.equal(result.status, 404);
});
