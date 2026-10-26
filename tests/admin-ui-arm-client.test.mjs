// T-98: the ARM adapter carries the conditional request from gateway-config.mjs to Azure Resource Manager.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createArmClient } from '../admin-ui/server/arm-client.mjs';

test('T-98 ARM PUT forwards the caller ETag as the If-Match HTTP header', async () => {
  const calls = [];
  const arm = createArmClient({
    clientId: 'identity-1',
    cache: new Map(),
    env: { IDENTITY_ENDPOINT: 'https://identity.example/token', IDENTITY_HEADER: 'header' },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return {
        status: 200,
        ok: true,
        text: async () => url.startsWith('https://identity.example/')
          ? JSON.stringify({ access_token: 'token', expires_on: String(Math.floor(Date.now() / 1000) + 3600) })
          : '{}',
      };
    },
  });

  await arm('PUT', '/subscriptions/s/resource?api-version=1', { properties: {} }, { ifMatch: '"etag-1"' });

  assert.equal(calls[1].init.headers['If-Match'], '"etag-1"');
});
