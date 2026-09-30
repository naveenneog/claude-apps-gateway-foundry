#!/usr/bin/env node
// Live checks against the Azure test deployment (docs/TEST-PLAN.md, environment azure-test).
//   node tests/live/gateway-live.mjs --check surface,outside,boot,build
//   node tests/live/gateway-live.mjs --check signin,inference,cli,refresh,stream,longstream,upstream,denied
// Tokens stay in this process's memory and are registered for redaction; results go to tests/live/out/
// with status codes, audit event names and redacted identities only. Audit evidence is read between two
// control requests whose x-request-id values appear in the log, so a check sees exactly the events of
// the interval it tests, or reports BLOCKED when the log does not cover it. No check passes without the
// thing it claims: a missing browser sign-in, stimulus or log coverage is BLOCKED, never PASS.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readState, statePath } from '../../infra/azure-test/deploy.mjs';
import { arm, graph } from '../../infra/azure-test/lib/azure-rest.mjs';
import { cidrContains, redirectUriFor, secretEndDate } from '../../infra/azure-test/lib/plan.mjs';
import { redactSecrets, registerSecret } from '../../infra/azure-test/lib/secrets.mjs';
import { resolveClaudeCommand, runAz, runProgram, runProgramAsync } from '../../infra/azure-test/lib/spawn.mjs';
import {
  SseParser, admissionFindings, alterToken, decodeJwt, deviceTokenOutcome, inferenceFindings, isSignInDenial, nextJournal,
  parseLogLines, quietGaps, reconcilePendingRestore, refreshFindings, refusedCliFindings, relayEvidence, restoreCommand, runThroughRelay, signHs256,
  subjectMatch, tamperJwtPayload, withArmRoleRemoved, withRoleRemoved,
} from './lib.mjs';
import { checkBoot, checkBuild, checkOutside } from './acr-checks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: opts } = parseArgs({ options: {
  check: { type: 'string', default: 'surface' },
  'resource-group': { type: 'string', default: 'rg-claude-apps-gateway-test' },
  'tester-cidr': { type: 'string' },
} });
const group = opts['resource-group'];
const state = readState(group);
if (!state.gatewayFqdn) throw new Error(`no state for ${group}; run infra/azure-test/deploy.mjs first`);
const testerCidr = opts['tester-cidr'] ?? state.testerCidr;
if (!testerCidr) throw new Error('no tester range recorded; pass --tester-cidr');
const base = `https://${state.gatewayFqdn}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (m) => console.log(redactSecrets(`[live] ${m}`));
const clip = (text, n) => redactSecrets(String(text)).trim().slice(0, n);
const writeState = () => fs.writeFileSync(statePath(group), `${JSON.stringify(state, null, 2)}\n`);
// Restore records for checks that remove access; null clears the record. An outstanding record of
// another removal is never replaced (nextJournal, tests/live/lib.mjs).
const journal = (record) => {
  const next = nextJournal(state.pendingRestore ?? null, record);
  if (next) state.pendingRestore = next;
  else delete state.pendingRestore;
  writeState();
};
const inRange = (ip) => {
  try { return typeof ip === 'string' && cidrContains(testerCidr, ip); } catch { return false; }
};
// Checks that remove access do not start while an earlier removal is unrepaired (Architect review, round 2).
const deployment = { group, testerCidr, emailDomain: state.tester?.emailDomain };
const outstandingRestore = () => (state.pendingRestore
  ? `a ${state.pendingRestore.kind} removal is not restored; run ${restoreCommand(state.pendingRestore, deployment)}` : null);
const results = [];
const session = {};

async function run(name, tests, body) {
  const record = { check: name, tests, result: 'PASS', notes: [] };
  const ctx = {
    note: (m) => record.notes.push(redactSecrets(m)),
    expect: (ok, m) => { if (!ok) { record.result = 'FAIL'; record.notes.push(redactSecrets(`FAILED: ${m}`)); } },
    block: (m) => { if (record.result === 'PASS') record.result = 'BLOCKED'; record.notes.push(redactSecrets(`BLOCKED: ${m}`)); },
  };
  // Applies { block, fail } findings from the helpers in tests/live/lib.mjs.
  ctx.findings = (label, { block, fail }) => {
    for (const m of fail) ctx.expect(false, `${label}: ${m}`);
    for (const m of block) ctx.block(`${label}: ${m}`);
  };
  say(`${name} (${tests.join(', ')})`);
  try {
    await body(ctx);
  } catch (error) {
    record.result = 'FAIL';
    record.notes.push(redactSecrets(`error: ${error.message}`));
  }
  results.push(record);
  say(`${name}: ${record.result}${record.notes.length ? `\n    ${record.notes.join('\n    ')}` : ''}`);
}

async function http(method, url, { token, headers = {}, body, form } = {}) {
  const response = await fetch(url, {
    method,
    redirect: 'manual',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(body ? { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' } : {}),
      ...headers,
    },
    body: form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, json, text, requestId: response.headers.get('x-request-id') };
}

function gatewayLogs() {
  const r = runAz(['containerapp', 'logs', 'show', '--name', state.appName, '--resource-group', group,
    '--container', 'gateway', '--type', 'console', '--tail', '300', '--format', 'json']);
  const lines = r.stdout.split(/\r?\n/);
  return { ...parseLogLines(lines), lines };
}

// An unauthenticated request the gateway refuses with 401 and logs as auth.denied under its request id.
async function control() {
  const r = await http('POST', `${base}/v1/messages`, { body: {} });
  if (r.status !== 401 || !r.requestId) throw new Error(`control request returned ${r.status} without a request id`);
  return r.requestId;
}

// Runs action between two control requests and returns the audit events logged between them, in log
// order, with the controls' gateway timestamps. events is null when the log does not hold both controls.
async function bracket(action) {
  const open = await control();
  const result = await action();
  const close = await control();
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(attempt ? 8000 : 5000);
    const logs = gatewayLogs();
    const a = logs.audit.findIndex((e) => e.request_id === open);
    const b = logs.audit.findIndex((e) => e.request_id === close);
    if (a >= 0 && b > a) {
      const from = Date.parse(logs.audit[a].ts);
      const to = Date.parse(logs.audit[b].ts);
      const operational = logs.operational.filter((l) => {
        const t = Date.parse(/^(\S+Z)\s/.exec(l)?.[1] ?? '');
        return t >= from && t <= to;
      });
      return { result, events: logs.audit.slice(a + 1, b), operational };
    }
    if (a < 0 && b >= 0) break;
  }
  return { result, events: null, operational: [] };
}

const messages = (model, prompt, extra = {}) => ({ model, max_tokens: 32, messages: [{ role: 'user', content: prompt }], ...extra });

// The audit events of one request, found by its x-request-id; null when they do not appear in time.
async function eventsForRequest(requestId) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(attempt ? 8000 : 5000);
    const own = gatewayLogs().audit.filter((e) => e.request_id === requestId);
    if (own.length) return own;
  }
  return null;
}
const textOf = (json) => (json?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');

const forgedToken = () => signHs256(decodeJwt(session.token).payload, crypto.randomBytes(32).toString('hex'));

// RFC 8628 device flow with a human in the browser. Polls at the gateway's interval until a token, a
// terminal error, the grant's expiry, or (for a refusal test) an audit event that matches stopWhen.
async function deviceSignIn(purpose, stopWhen) {
  const started = Date.now();
  const device = await http('POST', `${base}/oauth/device_authorization`, { form: {} });
  if (device.status !== 200) throw new Error(`device_authorization ${device.status}`);
  registerSecret(device.json.device_code);
  say(`${purpose}: confirm code ${device.json.user_code} at ${device.json.verification_uri_complete} within ${device.json.expires_in} s`);
  runProgram(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'), [device.json.verification_uri_complete]);
  let interval = (device.json.interval ?? 5) * 1000;
  const deadline = started + device.json.expires_in * 1000;
  let polls = 0;
  while (Date.now() < deadline) {
    await sleep(interval);
    const r = await http('POST', `${base}/oauth/token`, { form: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.json.device_code } });
    const outcome = deviceTokenOutcome(r.status, r.json);
    if (outcome === 'slow_down') interval += 5000;
    if (outcome === 'token') {
      session.token = registerSecret(r.json.access_token);
      if (r.json.refresh_token) session.refresh = registerSecret(r.json.refresh_token);
      return { outcome, userCode: device.json.user_code };
    }
    if (['denied', 'expired', 'error'].includes(outcome)) {
      say(`token endpoint: ${r.status} ${r.json?.error ?? clip(r.text, 120)}`);
      return { outcome, userCode: device.json.user_code };
    }
    if (stopWhen && ++polls % 3 === 0 && gatewayLogs().audit.some((e) => stopWhen(e) && Date.parse(e.ts) >= started - 60_000)) return { outcome: 'pending', userCode: device.json.user_code };
  }
  return { outcome: 'expired', userCode: device.json.user_code };
}

// T-08 (short, needs a silence over 15 s) and T-46 (long, measures the ingress request timeout).
async function streamCheck(c, long) {
  if (!session.token) return c.block('no session token; run signin in the same invocation');
  const prompt = long
    ? 'Write a very long, detailed technical history of network protocols, at least 15000 words, in numbered sections. Do not stop early.'
    : 'Think carefully, then give only the final answer: how many primes are there below 5000?';
  const started = Date.now();
  const response = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: long ? 'claude-sonnet-5' : 'claude-opus-5', max_tokens: long ? 32000 : 2000, stream: true, messages: [{ role: 'user', content: prompt }] }) });
  c.expect(response.status === 200, `stream status ${response.status}`);
  const parser = new SseParser();
  const timeline = [];
  let text = '';
  const decoder = new TextDecoder();
  try {
    for await (const chunk of response.body) {
      for (const e of parser.feed(decoder.decode(chunk, { stream: true }))) {
        timeline.push({ event: e.event, at: Date.now() - started });
        if (e.event === 'content_block_delta') {
          try { const d = JSON.parse(e.data).delta; if (d?.type === 'text_delta') text += d.text ?? ''; } catch { /* not JSON */ }
        }
      }
    }
  } catch (error) {
    c.note(`stream ended with ${error.message}`);
  }
  const elapsed = (Date.now() - started) / 1000;
  const stop = timeline.some((e) => e.event === 'message_stop');
  const gaps = quietGaps(timeline);
  c.note(`${timeline.length} events, ${text.length} text characters, ${timeline.filter((e) => e.event === 'ping').length} pings, quiet gaps ${JSON.stringify(gaps)}, ${elapsed.toFixed(1)} s, message_stop ${stop}`);
  c.expect(text.trim().length > 0, 'visible text arrived');
  if (!long) {
    c.expect(stop, 'the stream reached message_stop');
    if (!gaps.length) return c.block('no upstream silence over 15 s occurred, so the keepalive stimulus was not achieved');
    c.expect(gaps.every((g) => g.pings >= 1), 'every silence over 15 s carried at least one ping');
    // The negative needs a front end whose idle timeout is below 15 s; the Container Apps ingress
    // allows 240 s (U-40), and no such front end is part of this harness yet (QA review, round 2).
    return c.block('positive phase only: the negative (a front-end idle timeout below 15 s cuts the stream) is not implemented');
  }
  c.note(stop ? `long stream completed after ${elapsed.toFixed(0)} s` : `long stream cut after ${elapsed.toFixed(0)} s without message_stop`);
  c.expect(!stop && elapsed > 220 && elapsed < 260, 'T-46 expects the ingress to end the stream at about 240 s (U-40)');
}

const checks = {
  async entra(c) {
    const app = (await graph('GET', `/applications/${state.application.id}?$select=web,optionalClaims,appRoles,passwordCredentials`)).json;
    c.expect(JSON.stringify(app.web.redirectUris) === JSON.stringify([redirectUriFor(state.gatewayFqdn)]), `redirect URIs ${JSON.stringify(app.web.redirectUris)}`);
    c.expect(app.optionalClaims?.idToken?.some((x) => x.name === 'email'), 'email optional claim on the ID token');
    c.expect(JSON.stringify(app.appRoles.map((r) => r.value).sort()) === '["Gateway.Premium","Gateway.Standard"]', 'app roles');
    const sp = (await graph('GET', `/servicePrincipals/${state.servicePrincipal.id}?$select=appRoleAssignmentRequired`)).json;
    c.expect(sp.appRoleAssignmentRequired === false, 'assignment not required (U-39)');
    const standard = app.appRoles.find((r) => r.value === 'Gateway.Standard').id;
    const assigned = (await graph('GET', `/servicePrincipals/${state.servicePrincipal.id}/appRoleAssignedTo`)).json.value;
    c.expect(assigned.length === 1 && assigned[0].principalId === state.tester.objectId && assigned[0].appRoleId === standard, `assignments: ${assigned.length}`);
    for (const p of app.passwordCredentials) {
      const days = (Date.parse(p.endDateTime) - Date.parse(p.startDateTime)) / 86_400_000;
      c.note(`secret ${p.keyId.slice(0, 8)}… lifetime ${days.toFixed(2)} days`);
      c.expect(days <= 7.05, `secret ${p.keyId} lifetime ${days} days`);
    }
    c.expect(app.passwordCredentials.length === 1, `password credentials: ${app.passwordCredentials.length}`);
    const tooLong = { passwordCredential: { displayName: 'policy check (60 days)', endDateTime: new Date(Date.now() + 60 * 86_400_000).toISOString() } };
    let created = null;
    let refusal = null;
    try { created = await graph('POST', `/applications/${state.application.id}/addPassword`, tooLong); } catch (error) { refusal = error; }
    if (created) {
      registerSecret(created.json.secretText);
      c.expect(false, 'the tenant accepted a 60-day secret');
      try {
        await graph('POST', `/applications/${state.application.id}/removePassword`, { keyId: created.json.keyId });
        c.note('the 60-day secret was removed again');
      } catch (error) {
        c.expect(false, `removing the 60-day secret failed (${error.status}); remove key ${created.json.keyId} by hand`);
      }
    } else {
      c.note(`60-day secret refused: ${refusal.status} ${refusal.code ?? ''}`);
      c.expect(refusal.status === 400 && refusal.code === 'CredentialInvalidLifetimeAsPerAppPolicy', 'refused by the credential lifetime policy');
    }
    c.expect(secretEndDate(new Date(0), 7) === new Date(7 * 86_400_000).toISOString(), 'deploy tool asks for 7 days');
  },

  async surface(c) {
    const discovery = await http('GET', `${base}/.well-known/oauth-authorization-server`);
    c.expect(discovery.status === 200, `discovery ${discovery.status}`);
    c.expect(discovery.json?.issuer === base, `issuer ${discovery.json?.issuer}`);
    c.expect(discovery.json?.device_authorization_endpoint && discovery.json?.token_endpoint, 'device and token endpoints listed');
    for (const probe of ['/healthz', '/readyz']) {
      const r = await http('GET', `${base}${probe}`);
      c.expect(r.status === 200, `${probe} ${r.status}`);
    }
    const { result: device, events } = await bracket(() => http('POST', `${base}/oauth/device_authorization`, { form: {} }));
    c.expect(device.status === 200 && /^[A-Z0-9-]+$/.test(device.json?.user_code ?? ''), `device_authorization ${device.status}`);
    c.expect(device.json?.expires_in === 600, `expires_in ${device.json?.expires_in}`);
    if (!events) return c.block('log coverage for the device authorization could not be established');
    const authorize = events.find((e) => e.request_id === device.requestId);
    c.expect(authorize?.evt === 'device.authorize' && cidrContains(testerCidr, authorize.client_ip ?? '0.0.0.0'),
      `device.authorize event for request ${device.requestId} from ${authorize?.client_ip}`);
    const protocol = await http('GET', `${base}/protocol`);
    fs.mkdirSync(path.join(here, 'out'), { recursive: true });
    fs.writeFileSync(path.join(here, 'out', 'protocol.txt'), protocol.text);
    c.note(`/protocol ${protocol.status}, ${protocol.text.length} bytes saved to tests/live/out/protocol.txt`);
  },

  outside: (c) => checkOutside(c, { state, base, testerCidr, http, bracket }),
  boot: (c) => checkBoot(c, { state }),
  build: (c) => checkBuild(c, { state }),

  async signin(c) {
    const { result, events, operational } = await bracket(() => deviceSignIn('sign in as the tester'));
    if (result.outcome !== 'token') return c.block(`no session token (${result.outcome}); the browser sign-in did not complete`);
    const claims = decodeJwt(session.token).payload;
    c.note(`session token: exp in ${Math.round(claims.exp - Date.now() / 1000)} s, claims ${Object.keys(claims).sort().join(',')}`);
    if (!events) return c.block('log coverage for the sign-in could not be established');
    const mints = events.filter((e) => e.evt === 'session.mint');
    c.expect(mints.length === 1, `session.mint events in the sign-in: ${mints.length}`);
    const mint = mints[0] ?? {};
    c.note(`session.mint fields ${Object.keys(mint).sort().join(',')}; email domain ${String(mint.email).split('@')[1]}; client_ip ${mint.client_ip}`);
    const minted = subjectMatch(mint, claims);
    if (minted === 'unknown') c.block('session.mint names no subject (sub or email)');
    c.expect(minted !== 'mismatch', 'session.mint names the subject of the minted token');
    c.expect(String(mint.email).endsWith(`@${state.tester.emailDomain}`), 'minted email in the allowed domain');
    c.expect(mint.client_ip && cidrContains(testerCidr, mint.client_ip), `client_ip ${mint.client_ip} inside the allow list (U-32)`);
    const claimLine = operational.find((l) => /claim/i.test(l) && /\bemail\b/.test(l) && /\broles\b/.test(l));
    c.note(`debug claim line: ${claimLine ? clip(claimLine.replace(/^\S+\s+\S+\s+/, ''), 160) : 'none'}`);
    c.expect(Boolean(claimLine), 'the debug log of this sign-in names the email and roles claims (U-34)');
  },

  async inference(c) {
    if (!session.token) return c.block('no session token; run signin in the same invocation');
    const claims = decodeJwt(session.token).payload;
    const models = await http('GET', `${base}/v1/models`, { token: session.token });
    const ids = (models.json?.data ?? []).map((m) => m.id).sort();
    c.expect(models.status === 200 && JSON.stringify(ids) === '["claude-opus-5","claude-sonnet-5"]', `/v1/models ${models.status} ${ids}`);
    const { result: calls, events } = await bracket(async () => {
      const good = [];
      for (const id of ids) good.push({ id, r: await http('POST', `${base}/v1/messages`, { token: session.token, body: messages(id, 'Reply with the single word PONG.') }) });
      const absent = await http('POST', `${base}/v1/messages`, { token: session.token, body: messages('claude-haiku-4-5', 'Reply with PONG') });
      const bad = [];
      for (const [label, token] of [['no token', undefined], ['tampered payload', tamperJwtPayload(session.token)], ['foreign secret', forgedToken()]]) {
        bad.push({ label, r: await http('POST', `${base}/v1/messages`, { token, body: messages('claude-sonnet-5', 'Reply with PONG') }) });
      }
      return { good, absent, bad };
    });
    for (const { id, r } of calls.good) {
      c.note(`${id}: ${r.status} "${clip(textOf(r.json), 40)}"`);
      c.expect(r.status === 200 && /PONG/i.test(textOf(r.json)), `${id} answers PONG`);
    }
    c.note(`claude-haiku-4-5 (not in models): ${calls.absent.status} ${calls.absent.json?.error?.type ?? ''}`);
    c.expect(calls.absent.status >= 400 && calls.absent.status < 500, 'a model outside models: is not served');
    for (const { label, r } of calls.bad) c.expect(r.status === 401, `${label}: ${r.status}`);
    if (!events) return c.block('log coverage for the inference requests could not be established');
    for (const { id, r } of calls.good) {
      const own = events.filter((e) => e.request_id === r.requestId && e.evt === 'inference');
      if (own[0]) c.note(`inference event fields: ${Object.keys(own[0]).sort().join(',')}`);
      c.expect(own.length === 1, `${id}: inference events for request ${r.requestId}: ${own.length}`);
      if (own.length === 1) c.findings(`${id} inference event`, inferenceFindings(own[0], { claims, model: id }));
    }
    for (const { label, r } of calls.bad) {
      const own = events.filter((e) => e.request_id === r.requestId);
      c.expect(own.some((e) => e.evt === 'auth.denied') && !own.some((e) => e.evt === 'inference'), `${label}: auth.denied and no inference for request ${r.requestId}`);
    }
  },

  // Claude Code talks to a loopback relay that forwards to the gateway and records each response's
  // x-request-id, so the check reads the audit events of this invocation's own requests and no other
  // client's (QA and Coder review, round 3).
  async cli(c) {
    if (!session.token) return c.block('no session token; run signin in the same invocation');
    const claims = decodeJwt(session.token).payload;
    const claude = resolveClaudeCommand();
    // Retries off for the refused run: by default Claude Code retries a 401 ten times and prints nothing
    // for minutes; with CLAUDE_CODE_MAX_RETRIES=0 it exits and reports it (U-46).
    const invoke = (token, { retries } = {}) => runThroughRelay(base, async (relayUrl) => {
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gw-cli-'));
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CONFIG_DIR$)/.test(k)));
      Object.assign(env, { CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_BASE_URL: relayUrl, ANTHROPIC_AUTH_TOKEN: token,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-5', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
        ...(retries === undefined ? {} : { CLAUDE_CODE_MAX_RETRIES: String(retries) }) });
      try {
        return await runProgramAsync(claude.command, [...claude.prefixArgs, '-p', 'Reply with the single word PONG.', '--model', 'claude-sonnet-5'], { env, timeoutMs: 240_000 });
      } finally {
        fs.rmSync(configDir, { recursive: true, force: true });
      }
    });
    const requests = (captured) => captured.map((x) => `${x.method} ${x.path} ${x.status ?? '-'}${x.error ? ` (${x.error})` : ''}`).join(', ') || 'none';
    const { result: ok, events } = await bracket(() => invoke(session.token));
    c.note(`claude -p exit ${ok.status}${ok.timedOut ? ' (timed out)' : ''}: "${clip(ok.stdout, 60)}"; requests through the relay: ${requests(ok.captured)}`);
    c.expect(ok.status === 0 && /PONG/i.test(ok.stdout), 'Claude Code replies PONG through the gateway');
    if (events) {
      const { block, own } = relayEvidence(ok.captured, events);
      block.forEach((m) => c.block(m));
      const inference = own.filter((e) => e.evt === 'inference');
      c.expect(inference.length >= 1, `inference events of the CLI's own requests: ${inference.length} (U-38)`);
      inference.forEach((e, i) => c.findings(`inference event ${i + 1} of the run`, inferenceFindings(e, { claims, model: 'claude-sonnet-5' })));
    } else {
      c.block('log coverage for the CLI run could not be established');
    }
    const { result: bad, events: badEvents } = await bracket(() => invoke(forgedToken(), { retries: 0 }));
    c.note(`claude -p with a foreign-secret token: exit ${bad.status}: "${clip(bad.stdout + bad.stderr, 100)}"; requests through the relay: ${requests(bad.captured)}`);
    if (badEvents) {
      const denied = relayEvidence(bad.captured, badEvents).own.filter((e) => e.evt === 'auth.denied');
      c.note(`refusals of the CLI's own requests: ${denied.map((e) => e.reason).join(', ') || 'none'}`);
    }
    c.findings('refused CLI run', refusedCliFindings({ status: bad.status, stdout: bad.stdout, stderr: bad.stderr, captured: bad.captured, events: badEvents }));
  },
  async refresh(c) {
    if (!session.refresh) return c.block('no refresh token from the sign-in');
    const claims = decodeJwt(session.token).payload;
    const altered = alterToken(session.refresh);
    const { result: bad, events: badEvents } = await bracket(() => http('POST', `${base}/oauth/token`, { form: { grant_type: 'refresh_token', refresh_token: altered } }));
    c.expect(bad.status === 400 || bad.status === 401, `altered refresh token: ${bad.status} ${bad.json?.error ?? ''}`);
    const { result: good, events } = await bracket(() => http('POST', `${base}/oauth/token`, { form: { grant_type: 'refresh_token', refresh_token: session.refresh } }));
    c.expect(good.status === 200 && typeof good.json?.access_token === 'string', `refresh ${good.status} ${good.json?.error ?? ''}`);
    if (good.json?.access_token) session.token = registerSecret(good.json.access_token);
    if (good.json?.refresh_token) session.refresh = registerSecret(good.json.refresh_token);
    if (!badEvents || !events) return c.block('log coverage for the refresh requests could not be established');
    c.note(`events of the altered-token request ${bad.requestId}: ${badEvents.filter((e) => e.request_id === bad.requestId).map((e) => `${e.evt} ${e.reason ?? ''}`.trim()).join(', ') || 'none'}`);
    c.findings('refresh', refreshFindings({ good, goodEvents: events, badEvents, claims }));
  },

  stream: (c) => streamCheck(c, false),
  longstream: (c) => streamCheck(c, true),

  // T-06 negative: the gateway identity loses its Foundry role, so the upstream refuses. The removal is
  // journalled in the state file first and repaired at the next start if this process dies.
  async upstream(c) {
    if (outstandingRestore()) return c.block(outstandingRestore());
    if (!session.token) return c.block('no session token; run signin in the same invocation');
    const claims = decodeJwt(session.token).payload;
    const probe = () => http('POST', `${base}/v1/messages`, { token: session.token, body: messages('claude-sonnet-5', 'Reply with PONG') });
    const until = async (ok, minutes) => {
      const started = Date.now();
      while (Date.now() - started < minutes * 60_000) {
        const r = await probe();
        if (ok(r)) return { r, seconds: Math.round((Date.now() - started) / 1000) };
        await sleep(30_000);
      }
      return null;
    };
    let back = null;
    const outcome = await withArmRoleRemoved({
      arm, assignmentId: state.foundryRoleAssignmentId, principalId: state.identity.principalId,
      journal,
    }, async () => {
      const refused = await until((r) => r.status === 401 || r.status === 403, 12);
      return refused ? { ...refused, own: await eventsForRequest(refused.r.requestId) } : null;
    });
    if (!outcome.removed) return c.block('the recorded Foundry role assignment of the gateway identity is not present');
    if (outcome.result) back = await until((r) => r.status === 200, 12);
    if (!outcome.result) return c.block('the upstream kept answering for 12 minutes after the role was removed');
    const { r, seconds, own } = outcome.result;
    c.note(`upstream refusal ${r.status} after ${seconds} s; ${back ? `answers again ${back.seconds} s after the restore` : 'not answering 12 minutes after the restore'}`);
    if (!own) c.block(`the audit event of request ${r.requestId} did not appear in the log`);
    else c.findings(`the inference event of request ${r.requestId}`, inferenceFindings(own.find((e) => e.evt === 'inference'), { claims, model: 'claude-sonnet-5', status: [401, 403] }));
    c.expect(Boolean(back), 'inference works again after the role is restored');
  },

  // T-04 negative: without a gateway role the tester still passes Entra (assignment is not required,
  // U-39), so the refusal must come from the gateway's allowed_groups check. withRoleRemoved restores
  // only an assignment this run removed, after journalling it, so the check never grants access that
  // someone else revoked and a killed run is repaired at the next start.
  async denied(c) {
    if (outstandingRestore()) return c.block(outstandingRestore());
    const sp = state.servicePrincipal.id;
    const appRoleId = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'infra', 'azure-test', 'entra-app.json'), 'utf8'))
      .appRoles.find((r) => r.value === 'Gateway.Standard').id;
    const outcome = await withRoleRemoved({
      graph, servicePrincipalId: sp, principalId: state.tester.objectId, appRoleId, assignmentId: state.testerAssignmentId,
      journal,
      onRestored: (id) => { state.testerAssignmentId = id; writeState(); c.note('the Gateway.Standard assignment this run removed is restored'); },
    }, async () => {
      await sleep(20_000);
      return bracket(() => deviceSignIn('sign in again: the tester now holds no gateway role', isSignInDenial));
    });
    if (!outcome.removed) return c.block('the recorded Gateway.Standard assignment is not present; nothing removed and nothing restored');
    const { result: signIn, events } = outcome.result;
    if (!events) return c.block('log coverage for the refused sign-in could not be established');
    const denials = events.filter(isSignInDenial);
    c.note(`device flow ended ${signIn.outcome}; sign-in refusals: ${denials.map((e) => `${e.reason} on ${e.path} (fields ${Object.keys(e).sort().join(',')})`).join('; ') || 'none'}`);
    c.findings('sign-in without a gateway role', admissionFindings({ events, outcome: signIn.outcome, userCode: signIn.userCode, inRange }));
  },

  // Last in any run: it spends the per-address device-authorization budget for 10 minutes. The
  // tester's egress rotates across several addresses (U-33), each with its own bucket.
  async ratelimit(c) {
    const statuses = [];
    for (let i = 1; i <= 300; i++) {
      const r = await http('POST', `${base}/oauth/device_authorization`, { form: {} });
      statuses.push(r.status);
      if (r.status === 429) break;
    }
    const first = statuses.indexOf(429) + 1;
    c.note(first ? `first 429 at request ${first}` : `no 429 in ${statuses.length} requests`);
    c.expect(first > 0, 'device authorization is rate limited per address');
  },
};

const TESTS = { entra: ['T-01'], surface: ['T-02', 'T-03'], outside: ['T-42'], boot: ['T-02', 'T-05'], build: ['T-43'], signin: ['T-04'],
  inference: ['T-07', 'T-44'], cli: ['T-06'], refresh: ['T-47'], stream: ['T-08'], longstream: ['T-46'], upstream: ['T-06'], denied: ['T-04'],
  ratelimit: ['T-03'] };

// A removal left by an interrupted run is repaired first. The record stays until the repair succeeds;
// an ambiguous one (the run died while removing) stays until the deploy step named below restores the
// assignment by intent, and meanwhile the checks that remove access do not start.
if (state.pendingRestore) {
  const { kind } = state.pendingRestore;
  try {
    const repaired = await reconcilePendingRestore({ pending: state.pendingRestore, graph, arm, journal });
    if (repaired.ambiguous) {
      say(`an interrupted run was changing the ${kind === 'appRole' ? "tester's Gateway.Standard role" : "gateway identity's Foundry role"} (${state.pendingRestore.phase}); `
        + `its outcome is unknown, so nothing was granted. To restore it by intent, run ${restoreCommand(state.pendingRestore, deployment)}`);
    } else {
      say(`repaired the ${kind} removal left by an interrupted run: ${JSON.stringify(repaired)}`);
      if (kind === 'appRole') state.testerAssignmentId = repaired.assignmentId;
      journal(null);
    }
  } catch (error) {
    say(`the ${kind} removal left by an interrupted run could not be repaired (${error.message}); the record is kept`);
  }
}
for (const name of opts.check.split(',')) {
  if (!checks[name]) throw new Error(`unknown check ${name}; known: ${Object.keys(checks).join(', ')}`);
  await run(name, TESTS[name], checks[name]);
}
fs.mkdirSync(path.join(here, 'out'), { recursive: true });
const file = path.join(here, 'out', `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, redactSecrets(JSON.stringify({ at: new Date().toISOString(), gateway: state.gatewayFqdn, revision: state.revision, testerCidr, results }, null, 2)));
say(`results: ${results.map((r) => `${r.check}=${r.result}`).join(' ')}; saved ${path.relative(process.cwd(), file)}`);
process.exitCode = results.some((r) => r.result === 'FAIL') ? 1 : results.some((r) => r.result === 'BLOCKED') ? 2 : 0;
if (state.pendingRestore) {
  const line = '!'.repeat(100);
  say(`${line}\n[live] ACCESS NOT RESTORED: ${outstandingRestore()}\n[live] ${line}`);
  process.exitCode = 1;
}
