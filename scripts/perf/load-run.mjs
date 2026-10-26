// Load generator for a Claude apps gateway in load_test_mode (P-36, T-110).
// Holds `concurrency` streamed /v1/messages requests open, each tagged with an `x-load-test-user`
// number from 1 to `population`, and reports status counts and latency percentiles.
// Never point it at a gateway developers use:
// https://code.claude.com/docs/en/claude-apps-gateway-config#load_test_mode
//   node scripts/perf/load-run.mjs --gateway http://127.0.0.1:18080 --token-file token.txt
//     --population 25000 --levels 50,150,256 --duration 60 [--model claude-sonnet-5] [--json]
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseCli } from 'node:util';

const MAX_POPULATION = 9_999_999; // x-load-test-user takes up to 7 digits

export function percentile(samples, p) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function summarize(samples) {
  return {
    count: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    max: samples.length ? Math.max(...samples) : null,
  };
}

function oneRequest(target, agent, headers, body) {
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const start = performance.now();
    let ttfb = null;
    const req = client.request(target, { method: 'POST', agent, headers }, (res) => {
      res.once('data', () => { ttfb = performance.now() - start; });
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode, ttfb, total: performance.now() - start }));
      res.on('error', () => resolve({ status: 'network' }));
    });
    req.on('error', () => resolve({ status: 'network' }));
    req.end(body);
  });
}

export async function runLoad({ url, token, population, concurrency, totalRequests, durationMs,
  model = 'claude-sonnet-5', maxTokens = 1024 }) {
  if (!Number.isInteger(population) || population < 1 || population > MAX_POPULATION) {
    throw new RangeError(`population must be an integer from 1 to ${MAX_POPULATION}`);
  }
  if (typeof token !== 'string' || token.length === 0) throw new TypeError('token is required');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be a positive integer');
  if (totalRequests === undefined && durationMs === undefined) throw new RangeError('give totalRequests or durationMs');

  const target = new URL('/v1/messages', url);
  const Agent = target.protocol === 'https:' ? https.Agent : http.Agent;
  const agent = new Agent({ keepAlive: true, maxSockets: Infinity });
  const body = JSON.stringify({ model, max_tokens: maxTokens, stream: true, messages: [{ role: 'user', content: 'load test' }] });
  const deadline = durationMs === undefined ? Infinity : performance.now() + durationMs;

  let issued = 0;
  let ok = 0;
  const errors = {};
  const ttfbs = [];
  const totals = [];
  const started = performance.now();

  async function worker() {
    for (;;) {
      if (totalRequests !== undefined && issued >= totalRequests) return;
      if (performance.now() >= deadline) return;
      const user = String((issued % population) + 1);
      issued += 1;
      const r = await oneRequest(target, agent, {
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-load-test-user': user,
      }, body);
      if (r.status === 200) {
        ok += 1;
        ttfbs.push(r.ttfb);
        totals.push(r.total);
      } else {
        errors[r.status] = (errors[r.status] ?? 0) + 1;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  agent.destroy();
  const seconds = (performance.now() - started) / 1000;
  return { concurrency, requests: issued, ok, errors, seconds, okPerSecond: ok / seconds, ttfb: summarize(ttfbs), total: summarize(totals) };
}

function cliOptions(argv) {
  const { values } = parseCli({
    args: argv,
    options: {
      gateway: { type: 'string' },
      'token-file': { type: 'string' },
      population: { type: 'string', default: '25000' },
      levels: { type: 'string', default: '50' },
      duration: { type: 'string', default: '60' },
      model: { type: 'string', default: 'claude-sonnet-5' },
      json: { type: 'boolean', default: false },
    },
  });
  if (!values.gateway || !values['token-file']) throw new Error('--gateway and --token-file are required');
  return { gateway: values.gateway, token: readFileSync(values['token-file'], 'utf8').trim(), population: Number(values.population),
    levels: values.levels.split(',').map(Number), duration: Number(values.duration), model: values.model, json: values.json };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const o = cliOptions(process.argv.slice(2));
  for (const level of o.levels) {
    const r = await runLoad({ url: o.gateway, token: o.token, population: o.population, concurrency: level, durationMs: o.duration * 1000, model: o.model });
    const f = (x) => (x === null ? '—' : Math.round(x));
    console.log(o.json ? JSON.stringify(r)
      : `open=${level} requests=${r.requests} ok=${r.ok} errors=${JSON.stringify(r.errors)} ok/s=${r.okPerSecond.toFixed(1)} `
        + `ttfb p50/p95/p99=${f(r.ttfb.p50)}/${f(r.ttfb.p95)}/${f(r.ttfb.p99)} ms total p50/p95/p99=${f(r.total.p50)}/${f(r.total.p95)}/${f(r.total.p99)} ms`);
  }
}
