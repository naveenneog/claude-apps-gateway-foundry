// T-110: load generator for a gateway in load_test_mode (P-36).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runLoad, percentile, summarize } from '../scripts/perf/load-run.mjs';

function sseServer({ delayMs = 30, failEvery = 0 } = {}) {
  const seen = [];
  let open = 0;
  let peak = 0;
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      n += 1;
      seen.push({ user: req.headers['x-load-test-user'], auth: req.headers.authorization, version: req.headers['anthropic-version'], body });
      if (failEvery && n % failEvery === 0) { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{}'); return; }
      open += 1; peak = Math.max(peak, open);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {}\n\n');
      setTimeout(() => { res.end('event: message_stop\ndata: {}\n\n'); open -= 1; }, delayMs);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, seen, peak: () => peak, close: () => new Promise((r) => server.close(r)),
  })));
}

test('T-110 every request carries the token, the API version and a user number inside the population', async () => {
  const s = await sseServer();
  try {
    const report = await runLoad({ url: s.url, token: 'tok-1', population: 7, concurrency: 4, totalRequests: 20 });
    assert.equal(report.requests, 20);
    assert.equal(report.ok, 20);
    assert.equal(s.seen.length, 20);
    for (const r of s.seen) {
      assert.equal(r.auth, 'Bearer tok-1');
      assert.equal(r.version, '2023-06-01');
      assert.match(r.user, /^\d{1,7}$/);
      const id = Number(r.user);
      assert.ok(id >= 1 && id <= 7, `user ${id}`);
      assert.equal(JSON.parse(r.body).stream, true);
    }
    assert.equal(new Set(s.seen.map((r) => r.user)).size, 7);
  } finally { await s.close(); }
});

test('T-110 holds the target number of requests open at once', async () => {
  const s = await sseServer({ delayMs: 150 });
  try {
    await runLoad({ url: s.url, token: 't', population: 100, concurrency: 12, totalRequests: 36 });
    assert.equal(s.peak(), 12);
  } finally { await s.close(); }
});

test('T-110 counts errors by status and never as success', async () => {
  const s = await sseServer({ failEvery: 4 });
  try {
    const report = await runLoad({ url: s.url, token: 't', population: 10, concurrency: 2, totalRequests: 16 });
    assert.equal(report.requests, 16);
    assert.equal(report.ok, 12);
    assert.deepEqual(report.errors, { 429: 4 });
    assert.equal(report.ttfb.count, 12);
  } finally { await s.close(); }
  const down = await runLoad({ url: 'http://127.0.0.1:9', token: 't', population: 1, concurrency: 1, totalRequests: 2 });
  assert.equal(down.ok, 0);
  assert.deepEqual(down.errors, { network: 2 });
});

test('T-110 measures time to first byte below total time, from successful requests only', async () => {
  const s = await sseServer({ delayMs: 80 });
  try {
    const report = await runLoad({ url: s.url, token: 't', population: 5, concurrency: 2, totalRequests: 6 });
    assert.ok(report.total.p50 >= 80, `total p50 ${report.total.p50}`);
    assert.ok(report.ttfb.p50 < report.total.p50);
    assert.ok(report.ttfb.p99 <= report.total.p99);
  } finally { await s.close(); }
});

test('T-110 percentiles use the nearest rank of the sorted samples', () => {
  const xs = Array.from({ length: 100 }, (_, i) => 100 - i);
  assert.equal(percentile(xs, 50), 50);
  assert.equal(percentile(xs, 95), 95);
  assert.equal(percentile(xs, 99), 99);
  assert.equal(percentile([7], 99), 7);
  assert.equal(percentile([], 50), null);
  assert.deepEqual(summarize([3, 1, 2]), { count: 3, p50: 2, p95: 3, p99: 3, max: 3 });
});

test('T-110 rejects a population outside 1 to 9,999,999 and a missing token', async () => {
  await assert.rejects(runLoad({ url: 'http://x', token: 't', population: 0, concurrency: 1, totalRequests: 1 }), /population/);
  await assert.rejects(runLoad({ url: 'http://x', token: 't', population: 10_000_000, concurrency: 1, totalRequests: 1 }), /population/);
  await assert.rejects(runLoad({ url: 'http://x', token: '', population: 1, concurrency: 1, totalRequests: 1 }), /token/);
});
