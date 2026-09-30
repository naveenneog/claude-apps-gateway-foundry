// The runner of the live inference suite (P-20; tests/live/inference-suite.mjs). A check reaches the gateway only
// through its context. The runner records each gateway request the check sends, then matches every 200 answer on
// /v1/messages to its inference audit event by x-request-id; ctx.auditCaptured does the same for the answers Claude
// Code got through the capture relay. The APIM route of T-64 goes through ctx.sendExternal, which refuses the gateway's
// own origin, and has no gateway audit.
// Everything that reaches the network or starts a process is passed in, so tests/inference-runner.test.mjs runs the
// checks against fakes (council round 3).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSecrets } from '../../infra/azure-test/lib/secrets.mjs';
import { decodeJwt, inferenceFindings } from './lib.mjs';

// What the gateway audits with an inference event: a model answer, not count_tokens and not a refusal.
const isModelAnswer = (pathname, status) => status === 200 && pathname === '/v1/messages';

// The convention of tests/live/gateway-live.mjs: 1 when any check failed, 2 when any was BLOCKED, 0 when all passed.
export const exitCodeOf = (results) => (results.some((r) => r.result === 'FAIL') ? 1 : results.some((r) => r.result === 'BLOCKED') ? 2 : 0);

// The APIM route of T-64 from --apim-url: an https URL without credentials, a query or a fragment, since the suite sends
// it a bearer token; its base path, such as /claude, is kept without a trailing slash (Architect review, round 5). A
// refused value is not repeated in the message, since it can hold a key or a password (UX review, round 6).
export function apimBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('--apim-url is not an absolute URL'); }
  if (url.protocol !== 'https:') throw new Error(`--apim-url must use https, because the suite sends the APIM route a bearer token; it uses ${url.protocol.replace(/:$/, '')}`);
  if (url.username || url.password) throw new Error('--apim-url must not contain a user name or password');
  if (url.search || url.hash) throw new Error('--apim-url must not have a query or fragment');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

// The suite reads the gateway log with the deployment's subscription from the state file, so the Azure CLI's default
// subscription does not matter; the CLI must hold that subscription in the deployment's tenant (UX review, round 4).
// runAz(args, { allowFailure }) => { status, stdout }. Returns null, or what to run.
export function azureAccountProblem({ runAz, state }) {
  const login = `az login --tenant ${state.tenantId}`;
  const r = runAz(['account', 'show', '--subscription', state.subscriptionId, '--output', 'json'], { allowFailure: true });
  let account = null;
  try { account = r.status === 0 ? JSON.parse(r.stdout) : null; } catch { account = null; }
  if (!account) return `the Azure CLI holds no subscription ${state.subscriptionId}, where the gateway's log is; run ${login}`;
  if (account.tenantId !== state.tenantId) return `the Azure CLI holds subscription ${state.subscriptionId} in tenant ${account.tenantId}, not in the deployment's tenant ${state.tenantId}; run ${login}`;
  return null;
}

/**
 * @param {object} deps
 * @param {Function} deps.send          (pathname, body, { token, cut }) => response, to the gateway
 * @param {Function} deps.sendExternal  (pathname, body, { token, url }) => response, to another route (APIM)
 * @param {Function} deps.eventsFor     (requestIds, predicate) => the audit events, or null when the log does not show,
 *                                      for each ID, an event that matches the predicate
 * @param {Function} deps.sessionToken  () => { token } or { blocked }
 * @param {Function} deps.helperProfile (ctx) => { work, cli } or null
 * @param {Function} deps.apimToken     () => a token for the APIM route
 * @param {object}   deps.config        models, fast, unlisted, samples, base, apimUrl
 */
export function createRunner({ send, sendExternal, eventsFor, sessionToken, helperProfile, apimToken, config, say = () => {} }) {
  // Each answer has an inference event naming the tester, its model and the Foundry upstream.
  async function audit(ctx, label, answers, claims) {
    if (!answers.length) return;
    const events = await eventsFor(answers.map((a) => a.requestId), (e) => e.evt === 'inference');
    if (!events) {
      ctx.apply(label, { block: [`the gateway log did not show an inference event for each of ${answers.length} request IDs in time`] });
      return;
    }
    for (const a of answers) {
      const e = events.find((x) => x.request_id === a.requestId && x.evt === 'inference');
      ctx.evidence.push({ requestId: a.requestId, model: a.model ?? null, fields: e ? Object.keys(e).sort() : [] });
      ctx.apply(`${label} ${a.requestId}`, inferenceFindings(e, { claims, model: a.model }));
    }
  }

  return async function run(name, check, tests = []) {
    const record = { check: name, tests, result: 'PASS', notes: [], evidence: [] };
    const sent = [];
    let claims = null;
    const ctx = {
      config,
      evidence: record.evidence,
      cleanups: [],
      note: (m) => record.notes.push(redactSecrets(m)),
      apply: (label, { fail = [], block = [] }) => {
        for (const m of fail) { record.result = 'FAIL'; record.notes.push(redactSecrets(`FAILED ${label}: ${m}`)); }
        for (const m of block) { if (record.result === 'PASS') record.result = 'BLOCKED'; record.notes.push(redactSecrets(`BLOCKED ${label}: ${m}`)); }
      },
      // Always to the gateway, and recorded, so each answer is audited after the check.
      send: async (pathname, body, options = {}) => {
        const r = await send(pathname, body, { ...options, url: undefined });
        sent.push({ pathname, model: body?.model, status: r.status, requestId: r.requestId, withToken: Boolean(options.token) });
        return r;
      },
      // Only to another route, and only over https. A request to the gateway goes through ctx.send, so that it is
      // recorded and audited.
      sendExternal: (pathname, body, options = {}) => {
        const target = options.url ? new URL(options.url) : null;
        if (!target || target.protocol !== 'https:' || target.origin === new URL(config.base).origin) {
          throw new Error(`ctx.sendExternal refused ${target ? `${target.protocol}//${target.host}` : 'a request without a url'}: it sends only to another route, over https; the gateway is reached through ctx.send`);
        }
        return sendExternal(pathname, body, options);
      },
      events: (ids, matches) => eventsFor(ids, matches),
      // The model answers Claude Code got through the capture relay, each matched to its inference event.
      auditCaptured: async (label, captured) => {
        const answers = captured.filter((c) => c.method === 'POST' && isModelAnswer(c.path, c.status));
        const unnamed = answers.filter((a) => !a.requestId).length;
        if (unnamed) ctx.apply(label, { block: [`${unnamed} answers through the relay carried no x-request-id`] });
        if (!answers.length) {
          ctx.apply(label, { block: ['Claude Code got no model answer through the relay'] });
          return;
        }
        await audit(ctx, label, answers.filter((a) => a.requestId), claims);
      },
      helperProfile: () => helperProfile(ctx),
      apimToken: () => apimToken(),
    };
    say(`${name} (${tests.join(', ')})`);
    try {
      const session = await sessionToken();
      if (session.token) claims = decodeJwt(session.token).payload;
      if (session.blocked && name !== 'latency') ctx.apply('session', { block: [session.blocked] });
      else {
        await check(ctx, session.token, session.blocked);
        const answers = sent.filter((s) => s.withToken && isModelAnswer(s.pathname, s.status));
        const unnamed = answers.filter((a) => !a.requestId).length;
        if (unnamed) ctx.apply('audit', { block: [`${unnamed} answers carried no x-request-id`] });
        if (claims) await audit(ctx, 'audit', answers.filter((a) => a.requestId), claims);
      }
    } catch (error) {
      record.result = 'FAIL';
      record.notes.push(redactSecrets(`error: ${error.message}`));
    } finally {
      for (const cleanup of ctx.cleanups) {
        try {
          await cleanup();
        } catch (error) {
          record.notes.push(redactSecrets(`clean-up failed: ${error.message}`));
        }
      }
    }
    say(`${name}: ${record.result}${record.notes.length ? `\n    ${record.notes.join('\n    ')}` : ''}`);
    return record;
  };
}

// A throwaway Claude Code profile for T-51 and T-65. Its directory is registered for removal as soon as it exists, so a
// failed install or an unreadable settings file leaves nothing behind (QA review, round 3). An install the time limit
// stopped has failed, whatever its status (QA follow-up reviews of the live-run fixes).
//   install(profileDir) => { status, stdout, stderr, timedOut }
//   runClaude({ work, profile, helper, prompt, extraArgs, env, helperGateway }) => the CLI result with the relay capture
export function createHelperProfile({ install, runClaude, tmpRoot = os.tmpdir() }) {
  return async function helperProfile(ctx) {
    const work = fs.mkdtempSync(path.join(tmpRoot, 'cgw-infer-'));
    ctx.cleanups.push(() => fs.rmSync(work, { recursive: true, force: true }));
    const profile = path.join(work, 'profile');
    const installed = await install(profile);
    if (installed.timedOut || installed.status !== 0) {
      ctx.apply('install', { fail: [installed.timedOut ? 'the installer was stopped at the time limit' : String(installed.stderr ?? '').trim() || `the installer exited ${installed.status}`] });
      return null;
    }
    let helper;
    try {
      helper = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).apiKeyHelper;
    } catch (error) {
      ctx.apply('install', { fail: [`the profile's settings.json could not be read: ${error.message}`] });
      return null;
    }
    if (typeof helper !== 'string' || !helper) {
      ctx.apply('install', { fail: ['the profile\'s settings.json names no apiKeyHelper'] });
      return null;
    }
    const cli = (prompt, extraArgs = [], env = {}, { helperGateway } = {}) => runClaude({ work, profile, helper, prompt, extraArgs, env, helperGateway });
    return { work, cli };
  };
}
