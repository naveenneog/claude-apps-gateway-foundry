// T-149: infra/azure-test/lib/azure-rest.mjs retries a read that Azure Resource Manager or Microsoft Graph answers
// with a temporary error (429, 500, 502, 503, 504, or no answer), as the deployment status poll that stopped an install
// on 2026-11-03 with a 503 HTML page needed; a write is never sent twice.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sendWithRetry, TRANSIENT_STATUSES } from '../infra/azure-test/lib/azure-rest.mjs';

const answer = (status, headers = {}) => ({ status, headers: new Headers(headers) });

function scripted(...results) {
  const calls = [];
  const waits = [];
  const send = async () => {
    calls.push(1);
    const next = results.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { send, calls, waits, sleep: async (ms) => { waits.push(ms); } };
}

test('T-149 a GET answered 503 and then 200 is retried and returns the 200', async () => {
  const s = scripted(answer(503), answer(200));
  const r = await sendWithRetry(s.send, { method: 'GET', sleep: s.sleep });
  assert.equal(r.status, 200);
  assert.equal(s.calls.length, 2);
  assert.equal(s.waits.length, 1);
});

test('T-149 each temporary status and a network failure are retried; Retry-After is honoured', async () => {
  assert.deepEqual([...TRANSIENT_STATUSES].sort(), [429, 500, 502, 503, 504]);
  for (const status of TRANSIENT_STATUSES) {
    const s = scripted(answer(status), answer(200));
    assert.equal((await sendWithRetry(s.send, { method: 'GET', sleep: s.sleep })).status, 200, String(status));
  }
  const net = scripted(new TypeError('fetch failed'), answer(200));
  assert.equal((await sendWithRetry(net.send, { method: 'GET', sleep: net.sleep })).status, 200);
  const throttled = scripted(answer(429, { 'retry-after': '7' }), answer(200));
  await sendWithRetry(throttled.send, { method: 'GET', sleep: throttled.sleep });
  assert.deepEqual(throttled.waits, [7000]);
});

test('T-149 a write is sent once; a lasting error is returned after the last attempt; other statuses are not retried', async () => {
  for (const method of ['PUT', 'POST', 'PATCH', 'DELETE']) {
    const s = scripted(answer(503), answer(200));
    assert.equal((await sendWithRetry(s.send, { method, sleep: s.sleep })).status, 503, method);
    assert.equal(s.calls.length, 1, `${method} was sent again`);
  }
  const down = scripted(...Array.from({ length: 10 }, () => answer(503)));
  assert.equal((await sendWithRetry(down.send, { method: 'GET', attempts: 4, sleep: down.sleep })).status, 503);
  assert.equal(down.calls.length, 4);
  const gone = scripted(answer(404), answer(200));
  assert.equal((await sendWithRetry(gone.send, { method: 'GET', sleep: gone.sleep })).status, 404);
  assert.equal(gone.calls.length, 1);
  const net = scripted(...Array.from({ length: 4 }, () => new TypeError('fetch failed')));
  await assert.rejects(sendWithRetry(net.send, { method: 'GET', attempts: 4, sleep: net.sleep }), /fetch failed/);
});
