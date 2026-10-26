// T-81: admin-ui/server/gateway-client.mjs against the documented contract of the gateway's own admin API
// (https://code.claude.com/docs/en/claude-apps-gateway-spend-limits#admin-api-reference). Every call is faked; no
// test here reaches a live gateway.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deleteSpendLimit, getSpendLimit, listAudit, listEffectiveSpend, listSpendLimits, setSpendLimit,
} from '../admin-ui/server/gateway-client.mjs';

// Records every call a test makes and answers canned responses in order.
function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body });
    const next = responses.shift();
    if (!next) throw new Error('fakeFetch: no more canned responses');
    return { ok: next.status < 300, status: next.status, text: async () => JSON.stringify(next.body) };
  };
  return { fetch, calls };
}

const deps = (responses) => {
  const f = fakeFetch(responses);
  return { deps: { baseUrl: 'https://claude-gateway.internal.example.com', writeKey: 'test-write-key', fetch: f.fetch }, calls: f.calls };
};

test('T-81 listSpendLimits GETs the documented path and sends the write key as x-api-key', async () => {
  const { deps: d, calls } = deps([{ status: 200, body: { data: [] } }]);
  await listSpendLimits(d);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'https://claude-gateway.internal.example.com/v1/organizations/spend_limits');
  assert.equal(calls[0].headers['x-api-key'], 'test-write-key');
});

test('T-81 listSpendLimits appends scope_type, limit, after_id and before_id as query parameters', async () => {
  const { deps: d, calls } = deps([{ status: 200, body: { data: [] } }]);
  await listSpendLimits(d, { scopeType: 'organization', limit: 10, afterId: 'spl_1', beforeId: 'spl_2' });
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('scope_type'), 'organization');
  assert.equal(url.searchParams.get('limit'), '10');
  assert.equal(url.searchParams.get('after_id'), 'spl_1');
  assert.equal(url.searchParams.get('before_id'), 'spl_2');
});

test('T-81 setSpendLimit POSTs {scope, amount, period} with amount as a whole-number string', async () => {
  const { deps: d, calls } = deps([{ status: 200, body: { type: 'spend_limit', id: 'spl_abc' } }]);
  const result = await setSpendLimit(d, { scope: { type: 'organization' }, amountCents: 50000, period: 'monthly' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://claude-gateway.internal.example.com/v1/organizations/spend_limits');
  const sent = JSON.parse(calls[0].body);
  assert.deepEqual(sent, { scope: { type: 'organization' }, amount: '50000', period: 'monthly' });
  assert.equal(result.id, 'spl_abc');
});

test('T-81 setSpendLimit accepts a null amount for unlimited', async () => {
  const { deps: d, calls } = deps([{ status: 200, body: { type: 'spend_limit', id: 'spl_1' } }]);
  await setSpendLimit(d, { scope: { type: 'user', user_id: 'sub-1' }, amountCents: null, period: 'daily' });
  assert.equal(JSON.parse(calls[0].body).amount, null);
});

test('T-81 setSpendLimit refuses an unknown scope.type or period before any network call', async () => {
  const { deps: d, calls } = deps([]);
  await assert.rejects(() => setSpendLimit(d, { scope: { type: 'workspace' }, amountCents: '1', period: 'monthly' }), /scope\.type/);
  await assert.rejects(() => setSpendLimit(d, { scope: { type: 'organization' }, amountCents: '1', period: 'yearly' }), /period/);
  assert.equal(calls.length, 0, 'an invalid request never reaches the network');
});

test('T-81 setSpendLimit targets a rbac_group or a single user by the documented scope shape', async () => {
  const { deps: d, calls } = deps([{ status: 200, body: {} }, { status: 200, body: {} }]);
  await setSpendLimit(d, { scope: { type: 'rbac_group', rbac_group_id: 'contractors' }, amountCents: 10000, period: 'daily' });
  await setSpendLimit(d, { scope: { type: 'user', user_id: 'sub-123' }, amountCents: 5000, period: 'weekly' });
  assert.deepEqual(JSON.parse(calls[0].body).scope, { type: 'rbac_group', rbac_group_id: 'contractors' });
  assert.deepEqual(JSON.parse(calls[1].body).scope, { type: 'user', user_id: 'sub-123' });
});

test('T-81 getSpendLimit and deleteSpendLimit address one cap by its spl_-prefixed id, URL-encoded', async () => {
  const { deps: d, calls } = deps([{ status: 200, body: {} }, { status: 200, body: { type: 'spend_limit_deleted' } }]);
  await getSpendLimit(d, 'spl_abc/def');
  await deleteSpendLimit(d, 'spl_abc/def');
  assert.equal(calls[0].url, 'https://claude-gateway.internal.example.com/v1/organizations/spend_limits/spl_abc%2Fdef');
  assert.equal(calls[1].method, 'DELETE');
});

test('T-81 listEffectiveSpend repeats user_ids[] and period[], and forwards sort/q/limit/page', async () => {
  const { deps: d, calls } = deps([{ status: 200, body: { data: [] } }]);
  await listEffectiveSpend(d, { userIds: ['a', 'b'], period: ['daily', 'monthly'], sort: 'spend_desc', q: 'contoso', limit: 50, page: 'tok' });
  const url = new URL(calls[0].url);
  assert.deepEqual(url.searchParams.getAll('user_ids[]'), ['a', 'b']);
  assert.deepEqual(url.searchParams.getAll('period[]'), ['daily', 'monthly']);
  assert.equal(url.searchParams.get('sort'), 'spend_desc');
  assert.equal(url.searchParams.get('q'), 'contoso');
  assert.equal(url.searchParams.get('limit'), '50');
  assert.equal(url.searchParams.get('page'), 'tok');
});

test('T-81 listAudit GETs the documented audit path with after_id/limit', async () => {
  const { deps: d, calls } = deps([{ status: 200, body: { data: [], has_more: false } }]);
  await listAudit(d, { limit: 100, afterId: '42' });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/v1/organizations/spend_limits/audit');
  assert.equal(url.searchParams.get('after_id'), '42');
});

test('T-81 a non-2xx response throws with the gateway\'s own error message, not a generic one', async () => {
  const { deps: d } = deps([{ status: 404, body: { type: 'error', error: { type: 'not_found_error', message: 'no spend limit with that ID' } } }]);
  await assert.rejects(() => getSpendLimit(d, 'spl_missing'), /no spend limit with that ID/);
});

test('T-81 a non-2xx response\'s thrown error carries .status, so a caller can pass through 429 instead of flattening it to a generic failure', async () => {
  const { deps: d } = deps([{ status: 429, body: { error: { message: 'rate limited' } } }]);
  await assert.rejects(() => listSpendLimits(d), (err) => { assert.equal(err.status, 429); return true; });
});

test('T-81 a non-JSON response (e.g. an upstream proxy error page) throws a clear message instead of a parse crash', async () => {
  const fetch = async () => ({ ok: false, status: 502, text: async () => '<html>Bad Gateway</html>' });
  await assert.rejects(() => listSpendLimits({ baseUrl: 'https://x', writeKey: 'k', fetch }), /non-JSON response/);
});
