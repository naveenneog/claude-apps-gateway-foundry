// Helpers for tests/live/gateway-live.mjs: JWT handling for negative checks, gateway log parsing,
// server-sent events, RFC 8628 device-flow outcomes, the evidence rules each check applies, and the
// restore journal for checks that remove access. Only startCaptureRelay uses the network: it listens on
// loopback and forwards to one origin. Graph and ARM calls go through functions the caller passes in.
// No file access.
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';

const encodeJson = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function decodeJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3 || !BASE64URL.test(parts[0]) || !BASE64URL.test(parts[1])) throw new Error('not a JWT');
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')),
      payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')),
    };
  } catch {
    throw new Error('not a JWT');
  }
}

// A token the gateway never issued: same claims, signed with a different secret (T-44, T-06 negative).
export function signHs256(payload, secret) {
  const signed = `${encodeJson({ alg: 'HS256', typ: 'JWT' })}.${encodeJson(payload)}`;
  return `${signed}.${crypto.createHmac('sha256', secret).update(signed).digest('base64url')}`;
}

// The gateway's own token with a changed subject and the original signature (T-44).
export function tamperJwtPayload(token) {
  const [header, , signature] = String(token).split('.');
  const { payload } = decodeJwt(token);
  return `${header}.${encodeJson({ ...payload, sub: `${payload.sub ?? ''}-tampered` })}.${signature}`;
}

const tryJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// Gateway stderr: audit events are single-line JSON with an `evt` field; everything else is operational.
// Lines may arrive raw or wrapped by the Container Apps log stream as {"TimeStamp": ..., "Log": ...},
// whose Log text starts with the container runtime's own timestamp.
const RUNTIME_STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\s+(?=\{)/;
export function parseLogLines(lines) {
  const audit = [];
  const operational = [];
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;
    const outer = tryJson(line);
    const text = outer && typeof outer.Log === 'string' ? outer.Log.trim() : line;
    const parsed = text === line ? outer : tryJson(text.replace(RUNTIME_STAMP, ''));
    if (parsed && typeof parsed.evt === 'string') audit.push(parsed);
    else if (text) operational.push(text);
  }
  return { audit, operational };
}

export class SseParser {
  #buffer = '';

  feed(chunk) {
    this.#buffer = (this.#buffer + chunk).replace(/\r\n/g, '\n');
    const events = [];
    let end;
    while ((end = this.#buffer.indexOf('\n\n')) >= 0) {
      const block = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 2);
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const name = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (name === 'event') event = value;
        else if (name === 'data') data.push(value);
      }
      if (data.length || event !== 'message') events.push({ event, data: data.join('\n') });
    }
    return events;
  }
}

const DEVICE_ERRORS = { authorization_pending: 'pending', slow_down: 'slow_down', access_denied: 'denied', expired_token: 'expired' };

// Token endpoint response during device-flow polling (RFC 8628 section 3.5). The gateway's /protocol
// allows slow_down as 400 or 429; every other error arrives as 400.
export function deviceTokenOutcome(status, body) {
  if (status === 200) return typeof body?.access_token === 'string' && body.access_token ? 'token' : 'error';
  if (status === 429 && body?.error === 'slow_down') return 'slow_down';
  if (status === 400 && typeof body?.error === 'string') return DEVICE_ERRORS[body.error] ?? 'error';
  return 'error';
}

// Removes one recorded app role assignment while body() runs, then restores it. Nothing is removed,
// and nothing is granted, unless the recorded assignment exists and names this principal, role and
// service principal (security review, 2026-09-23). journal() receives the record in phase "removing"
// before the delete, "removed" after it, "restoring" before the restore and null after it (journalled),
// so reconcilePendingRestore can repair a killed run without granting from intent alone.
export async function withRoleRemoved({ graph, servicePrincipalId, principalId, appRoleId, assignmentId, journal = () => {}, onRestored = () => {} }, body) {
  const listed = (await graph('GET', `/servicePrincipals/${servicePrincipalId}/appRoleAssignedTo?$select=id,principalId,appRoleId,resourceId`)).json.value;
  const recorded = listed.find((a) => a.id === assignmentId && a.principalId === principalId
    && a.appRoleId === appRoleId && a.resourceId === servicePrincipalId);
  if (!recorded) return { removed: false };
  const record = { kind: 'appRole', servicePrincipalId, principalId, appRoleId };
  await journalled(journal, { before: { ...record, phase: 'removing' }, ifRefused: null },
    () => graph('DELETE', `/servicePrincipals/${servicePrincipalId}/appRoleAssignedTo/${recorded.id}`, undefined, { ok: [204] }));
  journal({ ...record, phase: 'removed' });
  try {
    return { removed: true, result: await body() };
  } finally {
    const restored = await journalled(journal, { before: { ...record, phase: 'restoring' }, ifRefused: { ...record, phase: 'removed' } },
      () => graph('POST', `/servicePrincipals/${servicePrincipalId}/appRoleAssignedTo`, { principalId, resourceId: servicePrincipalId, appRoleId }));
    journal(null);
    onRestored(restored.json.id);
  }
}
// One call that removes or grants access, with the journal kept truthful about its outcome (Coder
// review, round 2; security review, round 3). The record moves to `before` first. A 4xx refusal
// changed nothing, so the record moves to `ifRefused` (null clears it). A 408, a 5xx or a transport
// failure may have taken effect, so the record stays at `before`, which reconcilePendingRestore treats as
// ambiguous. Success leaves the next step to the caller.
async function journalled(journal, { before, ifRefused }, call) {
  journal(before);
  try {
    return await call();
  } catch (error) {
    if (typeof error?.status === 'number' && error.status >= 400 && error.status < 500 && error.status !== 408) journal(ifRefused);
    throw error;
  }
}

// Upstream silences in a stream (T-08): consecutive non-ping events more than thresholdMs apart, with
// the pings that arrived between them. Events are { event, at } with at in milliseconds.
export function quietGaps(events, thresholdMs = 15_000) {
  const gaps = [];
  let last = null;
  let pings = 0;
  for (const e of events) {
    if (e.event === 'ping') {
      pings++;
      continue;
    }
    if (last && e.at - last.at > thresholdMs) gaps.push({ fromMs: last.at, toMs: e.at, pings });
    last = e;
    pings = 0;
  }
  return gaps;
}

// A refusal of a sign-in, as opposed to a missing or bad bearer token on an inference path.
export const isSignInDenial = (e) => e?.evt === 'auth.denied' && typeof e.path === 'string' && !e.path.startsWith('/v1/');

// The refusal T-04's negative is about: the sign-in callback turned away for a group or role reason.
// Any other sign-in failure (expired flow, bad state, missing token) is not evidence of admission
// control (Coder and QA review, round 2).
export const isRoleAdmissionDenial = (e) => isSignInDenial(e) && /^\/oauth\/callback(?:[?#]|$)/.test(e.path)
  && typeof e.reason === 'string' && /group|role/i.test(e.reason);

// The upstream an inference event names, read from its own field only: a mention of "foundry" in an
// e-mail address or note says nothing about where the request went.
export const inferenceUpstream = (e) => [e?.upstream, e?.provider].find((v) => typeof v === 'string' && v) ?? null;

const inferenceModel = (e) => [e?.model, e?.model_id].find((v) => typeof v === 'string' && v) ?? null;

// What an inference audit event proves about one request (Coder and QA review, round 2). A missing
// field is a gap in the evidence (block); a field with another value is a failure (fail).
export function inferenceFindings(e, { claims, model, status = 200 }) {
  const block = [];
  const fail = [];
  if (e?.evt !== 'inference') return { block: ['no inference event'], fail };
  if (![status].flat().includes(e.status)) fail.push(`status ${e.status}, expected ${[status].flat().join(' or ')}`);
  const upstream = inferenceUpstream(e);
  if (!upstream) block.push(`no upstream field (fields: ${Object.keys(e).sort().join(',')})`);
  else if (upstream !== 'foundry') fail.push(`upstream ${upstream}`);
  const named = inferenceModel(e);
  if (!named) block.push('no model field');
  else if (model && named !== model) fail.push(`model ${named}, expected ${model}`);
  const subject = subjectMatch(e, claims);
  if (subject === 'unknown') block.push('no sub or email field');
  else if (subject === 'mismatch') fail.push('names another subject');
  return { block, fail };
}

// A loopback HTTP relay to one upstream origin. For each request it forwards, it records the method,
// path, status and x-request-id of the response, and nothing else: no header, no body. A client pointed
// at it has its own requests, and so its own audit events, identified by request id (QA and Coder
// review, round 3). Failures pass through (QA, UX and Coder review, round 4): a response the upstream
// cuts short breaks the client's connection, a client that goes away cancels its upstream request, and
// close() ends every connection on both sides, idle ones included. Such a request is recorded with
// error set. close() resolves once every request has reached its final record, so a capture read after
// it is complete (QA and UX review, round 5).
export async function startCaptureRelay(targetOrigin) {
  const target = new URL(targetOrigin);
  const client = target.protocol === 'https:' ? https : http;
  const agent = new client.Agent({ keepAlive: true });
  const captured = [];
  const unsettled = new Set();
  let closing = false;
  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    let entry = null;
    // A request is settled when the client's response has closed; by then its record is final.
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    unsettled.add(settled);
    settled.then(() => unsettled.delete(settled));
    const record = (fields) => {
      entry = { method: req.method, path, ...fields };
      captured.push(entry);
    };
    const upstream = client.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, agent,
      method: req.method, path: req.url, headers: { ...req.headers, host: target.host },
    }, (response) => {
      record({ status: response.statusCode, requestId: response.headers['x-request-id'] ?? null });
      res.writeHead(response.statusCode, response.headers);
      pipeline(response, res, (error) => {
        if (error) entry.error = 'response not completed';
      });
    });
    upstream.on('error', (error) => {
      if (!entry) record({ status: null, requestId: null, error: closing ? 'relay closed' : String(error.code ?? error.message) });
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502);
      res.end();
    });
    res.on('close', () => {
      if (!res.writableFinished) {
        if (!entry) record({ status: null, requestId: null, error: closing ? 'relay closed' : 'client closed the connection' });
        upstream.destroy();
      }
      settle();
    });
    req.pipe(upstream);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { address, port } = server.address();
  return {
    url: `http://${address}:${port}`,
    captured,
    close: async () => {
      closing = true;
      server.closeAllConnections();
      agent.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
      await Promise.all([...unsettled]);
    },
  };
}

// Runs a program against a fresh relay to origin and returns its result with the relay's capture. The
// capture is read after the relay has closed, so a request still open when the program finished is in
// it (QA and UX review, round 5).
export async function runThroughRelay(origin, run) {
  const relay = await startCaptureRelay(origin);
  let result;
  try {
    result = await run(relay.url);
  } finally {
    await relay.close();
  }
  return { ...result, captured: [...relay.captured] };
}
// The audit events of the requests a relay captured, found by x-request-id. No captured request, or a
// response without a request id, is a gap in the evidence.
export function relayEvidence(captured, events) {
  const block = [];
  if (!captured.length) block.push('the client sent no request through the relay');
  const unnamed = captured.filter((c) => !c.requestId).length;
  if (unnamed) block.push(`${unnamed} response${unnamed === 1 ? '' : 's'} through the relay carried no x-request-id`);
  const ids = new Set(captured.map((c) => c.requestId).filter(Boolean));
  return { block, own: events.filter((e) => ids.has(e.request_id)) };
}

// T-06's negative: Claude Code run with a token the gateway did not sign. The log evidence is that of the
// CLI's own requests, by the request ids the relay recorded, so another client's traffic in the same
// window neither passes nor fails it (Coder review, rounds 3 and 4).
export function refusedCliFindings({ status, stdout, stderr, captured, events }) {
  const fail = [];
  if (status === 0 || /PONG/i.test(stdout)) fail.push('the invocation succeeded with a token the gateway did not sign');
  if (!/\b401\b|unauthori[sz]ed|authenticat/i.test(`${stdout}\n${stderr}`)) fail.push('Claude Code did not report the refusal');
  if (!events) return { block: ['log coverage for the refused CLI run could not be established'], fail };
  const { block, own } = relayEvidence(captured, events);
  if (block.length) return { block, fail };
  if (!captured.some((x) => x.status === 401 && x.path.startsWith('/v1/'))) fail.push('the gateway did not answer the CLI with 401 on an inference path');
  if (own.some((e) => e.evt === 'inference')) fail.push('an inference event belongs to the CLI\'s own requests');
  if (!own.some((e) => e.evt === 'auth.denied')) fail.push('the gateway logged no auth.denied for the CLI\'s own requests');
  return { block: [], fail };
}
// T-47: one session.refresh for the valid request, naming the tester, and none in the window of the
// altered token (QA review, round 2).
export function refreshFindings({ good, goodEvents, badEvents, claims }) {
  const block = [];
  const fail = [];
  const refreshes = goodEvents.filter((e) => e.evt === 'session.refresh');
  if (refreshes.some((e) => e.request_id === undefined)) block.push('a session.refresh event carries no request_id');
  const own = refreshes.filter((e) => e.request_id === good.requestId);
  if (own.length !== 1) fail.push(`session.refresh events for request ${good.requestId}: ${own.length}`);
  else {
    const subject = subjectMatch(own[0], claims);
    if (subject === 'unknown') block.push('the session.refresh event names no subject');
    if (subject === 'mismatch') fail.push('the session.refresh event names another subject');
  }
  if (badEvents.some((e) => e.evt === 'session.refresh')) fail.push('a session.refresh event appeared for the altered token');
  return { block, fail };
}

// T-04's negative: the sign-in of this device flow, from the tester's range, refused on the callback
// for a group or role reason. Another refusal, or one that does not carry this flow's user code, is a
// gap: the tester's range is shared, and the flow's own outcome does not say whose event it is (QA
// and Coder review, rounds 2 and 3).
export function admissionFindings({ events, outcome, userCode, inRange }) {
  if (outcome === 'token') return { block: [], fail: ['a sign-in without a gateway role got a token'] };
  const denials = events.filter(isSignInDenial);
  if (!denials.length) return { block: ['no sign-in refusal: the second browser sign-in did not happen'], fail: [] };
  const admission = denials.filter(isRoleAdmissionDenial);
  if (!admission.length) return { block: [`the sign-in was refused for another reason: ${denials.map((d) => `${d.reason} on ${d.path}`).join('; ')}`], fail: [] };
  const own = admission.filter((e) => inRange(e.client_ip) && e.user_code === userCode);
  if (!own.length) return { block: ['no role refusal is tied to this sign-in by user code and tester address'], fail: [] };
  return { block: [], fail: [] };
}

// The next restore record. A different outstanding record is never replaced: it is cleared only by
// its own check's restore or by a reconcile (Architect review, round 2).
export function nextJournal(current, record) {
  if (!record) return null;
  const same = current && current.kind === record.kind && current.principalId === record.principalId
    && (record.kind === 'appRole'
      ? current.servicePrincipalId === record.servicePrincipalId && current.appRoleId === record.appRoleId
      : current.assignmentId === record.assignmentId);
  if (current && !same) throw new Error(`a ${current.kind} restore is outstanding; refusing to record a ${record.kind} removal`);
  return record;
}

// The deploy command, run from the repository root, that re-creates a removed assignment by intent in
// the deployment it belongs to: entra assigns the tester's app role, base deploys the gateway identity's
// Foundry role on the account named in the assignment's scope (UX review, round 3).
export function restoreCommand(pending, { group, testerCidr, emailDomain }) {
  const common = ['node', 'infra/azure-test/deploy.mjs', '--resource-group', group, '--tester-cidr', testerCidr];
  if (pending.kind === 'appRole') return [...common, ...(emailDomain ? ['--email-domain', emailDomain] : []), '--step', 'entra'].join(' ');
  if (pending.kind === 'armRole') {
    const scope = /\/resourceGroups\/([^/]+)\/providers\/Microsoft\.CognitiveServices\/accounts\/([^/]+)\/providers\/Microsoft\.Authorization\/roleAssignments\//i
      .exec(pending.assignmentId ?? '');
    if (!scope) throw new Error(`the assignment ${pending.assignmentId} is not on a Foundry account`);
    return [...common, '--foundry-resource-group', scope[1], '--foundry-account', scope[2], '--step', 'base'].join(' ');
  }
  throw new Error(`unknown restore kind ${pending.kind}`);
}

// A copy of an opaque token with its middle character changed. A middle character carries six bits of
// data in base64 and base64url; the last one may carry padding bits that a lenient decoder ignores.
export function alterToken(token) {
  const i = Math.floor(token.length / 2);
  return `${token.slice(0, i)}${token[i] === 'A' ? 'B' : 'A'}${token.slice(i + 1)}`;
}
// Whether an event belongs to the signed-in tester. sub decides when the event carries it; e-mail
// is used only when it does not. "unknown" means the event carries no identity at all.
export function subjectMatch(e, claims) {
  if (typeof e?.sub === 'string' && e.sub) return e.sub === claims.sub ? 'match' : 'mismatch';
  if (typeof e?.email === 'string' && e.email) {
    const mine = [claims.email, claims.preferred_username, claims.upn].filter((v) => typeof v === 'string');
    return mine.some((v) => v.toLowerCase() === e.email.toLowerCase()) ? 'match' : 'mismatch';
  }
  return 'unknown';
}

// Removes the gateway identity's role assignment on the Foundry account while body() runs, then puts
// the same assignment back. Nothing changes unless the recorded assignment exists for this principal.
export async function withArmRoleRemoved({ arm, assignmentId, principalId, journal = () => {}, onRestored = () => {} }, body) {
  const api = 'api-version=2022-04-01';
  const current = await arm('GET', `${assignmentId}?${api}`, undefined, { ok: [200, 404] });
  if (current.status !== 200 || current.json?.properties?.principalId !== principalId) return { removed: false };
  const { roleDefinitionId } = current.json.properties;
  const record = { kind: 'armRole', assignmentId, principalId, roleDefinitionId };
  await journalled(journal, { before: { ...record, phase: 'removing' }, ifRefused: null },
    () => arm('DELETE', `${assignmentId}?${api}`, undefined, { ok: [200, 204] }));
  journal({ ...record, phase: 'removed' });
  try {
    return { removed: true, result: await body() };
  } finally {
    await journalled(journal, { before: { ...record, phase: 'restoring' }, ifRefused: { ...record, phase: 'removed' } },
      () => arm('PUT', `${assignmentId}?${api}`, { properties: { roleDefinitionId, principalId, principalType: 'ServicePrincipal' } }));
    journal(null);
    onRestored();
  }
}
// Puts back an assignment that an interrupted run removed, from the record journal() wrote before the
// removal. An assignment that exists again is left alone (Coder review, 2026-09-23). The grant itself
// is journalled as "restoring" (journalled); the caller clears the record once it has the result.
export async function reconcilePendingRestore({ pending, graph, arm, journal = () => {} }) {
  if (!pending) return null;
  // Only a removal known to have happened and not yet undone is undone. A run that died while removing
  // may have removed nothing, one that died while restoring may have restored, and an administrator may
  // have revoked the access meanwhile (security review, rounds 2 and 3).
  if (pending.phase !== 'removed') return { restored: false, ambiguous: true };
  const restoring = { before: { ...pending, phase: 'restoring' }, ifRefused: pending };
  if (pending.kind === 'appRole') {
    const { servicePrincipalId, principalId, appRoleId } = pending;
    const listed = (await graph('GET', `/servicePrincipals/${servicePrincipalId}/appRoleAssignedTo?$select=id,principalId,appRoleId`)).json.value;
    const present = listed.find((a) => a.principalId === principalId && a.appRoleId === appRoleId);
    if (present) return { restored: false, assignmentId: present.id };
    const created = await journalled(journal, restoring,
      () => graph('POST', `/servicePrincipals/${servicePrincipalId}/appRoleAssignedTo`, { principalId, resourceId: servicePrincipalId, appRoleId }));
    return { restored: true, assignmentId: created.json.id };
  }
  if (pending.kind === 'armRole') {
    const { assignmentId, principalId, roleDefinitionId } = pending;
    const api = 'api-version=2022-04-01';
    const current = await arm('GET', `${assignmentId}?${api}`, undefined, { ok: [200, 404] });
    if (current.status === 200) return { restored: false, assignmentId };
    await journalled(journal, restoring,
      () => arm('PUT', `${assignmentId}?${api}`, { properties: { roleDefinitionId, principalId, principalType: 'ServicePrincipal' } }));
    return { restored: true, assignmentId };
  }
  throw new Error(`unknown pending restore kind ${pending.kind}`);
}