// The live inference suite's runner and checks, run offline against fakes (P-20; council round 3). Every
// successful gateway answer on /v1/messages is matched to its inference audit event, whether a check sent it
// through ctx.send or Claude Code sent it through the capture relay; the APIM route of T-64 has no gateway audit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const live = path.join(path.dirname(fileURLToPath(import.meta.url)), 'live');
const checksFile = () => [path.join(live, 'inference-checks.mjs'), path.join(live, 'inference-suite.mjs')].find((f) => fs.existsSync(f));
const load = async () => ({ ...(await import('./live/inference-runner.mjs')), ...(await import('./live/inference-checks.mjs')) });
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const TOKEN = `${b64({ alg: 'none' })}.${b64({ sub: 'user-1', email: 'dev@contoso.example' })}.signature`;
const PONG_STREAM = [
  { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PONG' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } },
  { event: 'message_stop', data: { type: 'message_stop' } },
];
const withText = (stream, text) => stream.map((e) => (e.event === 'content_block_delta' ? { ...e, data: { ...e.data, delta: { type: 'text_delta', text } } } : e));
// A stream the suite closed after its first delta: 14 characters received, so the floor is 4 output tokens.
const CLOSED_STREAM = withText(PONG_STREAM.slice(0, 3), 'Mountains rise');

// Fakes for everything that reaches the network. Each gateway answer gets a request ID; the fake log holds an
// inference event for every request ID except the withheld ones, and answers null, as the suite's log reader
// does, when an asked ID has no matching event. respond(pathname, body, options, requestId) may answer a request
// instead of the default, and eventOf(event, request) may change the event the log holds for a request.
function fakes({ withheld = [], config = {}, respond = () => undefined, eventOf = (e) => e, respondExternal = () => undefined } = {}) {
  let n = 0;
  const gatewayCalls = [];
  const externalCalls = [];
  const asked = [];
  const requests = new Map();
  const event = (id) => eventOf({ evt: 'inference', status: 200, upstream: 'foundry', model: 'claude-sonnet-5', request_id: id, sub: 'user-1' }, requests.get(id));
  const deps = {
    config: { models: ['claude-sonnet-5'], fast: 'claude-sonnet-5', unlisted: 'claude-haiku-4-5', samples: 2, base: 'https://gateway.contoso.example', ...config },
    send: async (pathname, body, options = {}) => {
      gatewayCalls.push({ pathname, body, options });
      const requestId = `r${++n}`;
      requests.set(requestId, { pathname, body, options });
      const answer = respond(pathname, body, options, requestId);
      if (answer) return answer;
      if (body?.stream) return { status: 200, events: PONG_STREAM, requestId, firstTokenMs: 10 };
      return { status: 200, json: { type: 'message', content: [{ type: 'text', text: 'PONG' }], usage: { input_tokens: 5, output_tokens: 2 } }, requestId };
    },
    sendExternal: async (pathname, body, options = {}) => {
      externalCalls.push({ pathname, body, options });
      return respondExternal(externalCalls.length) ?? { status: 200, events: PONG_STREAM, requestId: null, firstTokenMs: 12 };
    },
    eventsFor: async (ids, matches = () => true) => {
      asked.push(...ids);
      const events = ids.filter((id) => !withheld.includes(id)).map(event);
      return ids.every((id) => events.some((e) => e.request_id === id && matches(e))) ? events : null;
    },
    sessionToken: async () => ({ token: TOKEN }),
    apimToken: () => 'apim-token',
    helperProfile: async () => null,
  };
  return { deps, gatewayCalls, externalCalls, asked };
}

// A Claude Code profile whose CLI answers from fixed captures, the way the capture relay records them.
function fakeProfile(t, { runs }) {
  return async (ctx) => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-fake-profile-'));
    ctx.cleanups.push(() => fs.rmSync(work, { recursive: true, force: true }));
    let call = 0;
    return {
      work,
      cli: async (prompt, extraArgs = [], env = {}, options = {}) => {
        const { stdout, status = 0, stderr = '', ids = [], captured: given, timedOut = false } = runs[call++]({ work, prompt, extraArgs, options });
        const captured = given ?? (ids.length ? [{ method: 'HEAD', path: '/api/hello', status: 200, requestId: null },
          ...ids.map((id) => ({ method: 'POST', path: '/v1/messages', status: 200, requestId: id }))] : []);
        return { status, stdout, stderr, captured, timedOut };
      },
    };
  };
}

// Claude Code 2.1.272's stderr in non-interactive mode when the helper has no session for an origin: the helper's exit
// status and its message, which names the sign-in command for that origin (U-53).
const helperReport = (origin, exit = 1) => `apiKeyHelper failed: exited ${exit}: Get-ClaudeGatewayToken: No saved session for ${origin}. To sign in again, run: powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\dev\\AppData\\Local\\ClaudeAppsGateway\\bin\\0123456789ab\\Connect-ClaudeGateway.ps1" -GatewayUrl ${origin}`;

test('the checks reach the network only through their context, so the runner records every gateway answer', () => {
  const source = fs.readFileSync(checksFile(), 'utf8');
  const block = source.slice(source.indexOf('checks = {'));
  assert.doesNotMatch(block, /(?<![.\w])send\(/, 'a check calls the unrecorded sender directly');
  assert.doesNotMatch(source, /\bfetch\(/, 'a check makes its own HTTP request');
  assert.doesNotMatch(source, /lib\/spawn\.mjs|developer\/harness\.mjs/, 'a check starts processes itself');
});

test('T-55 to T-63: every 200 answer through ctx.send is matched to its inference event; one without an event makes the check BLOCKED', async () => {
  const { createRunner } = await load();
  for (const [withheld, expected] of [[[], 'PASS'], [['r2'], 'BLOCKED']]) {
    const fake = fakes({ withheld });
    const record = await createRunner(fake.deps)('messages', async (ctx, token) => {
      await ctx.send('/v1/messages', { model: 'claude-sonnet-5' }, { token });
      await ctx.send('/v1/messages', { model: 'claude-sonnet-5' }, { token, url: 'https://elsewhere.example' });
    }, ['T-56']);
    assert.equal(record.result, expected, record.notes.join('\n'));
    assert.deepEqual(fake.asked, ['r1', 'r2'], 'both answers were looked up in the gateway log');
    assert.ok(fake.gatewayCalls.every((c) => c.options.url === undefined), 'ctx.send always goes to the gateway');
  }
});

test('T-64: latency sends its gateway samples through the recorded sender, so each is audited, and the APIM samples through the external one', async () => {
  const { createRunner, checks } = await load();
  for (const [withheld, expected] of [[[], 'PASS'], [['r2'], 'BLOCKED']]) {
    const fake = fakes({ withheld, config: { samples: 2, apimUrl: 'https://apim.contoso.example/claude' } });
    const record = await createRunner(fake.deps)('latency', checks.latency, ['T-64']);
    assert.equal(fake.gatewayCalls.length, 2, 'two gateway samples');
    assert.equal(fake.externalCalls.length, 2, 'two APIM samples');
    assert.ok(fake.externalCalls.every((c) => c.options.url === 'https://apim.contoso.example/claude' && c.options.token === 'apim-token'));
    assert.deepEqual(fake.asked, ['r1', 'r2'], 'the gateway samples, and only they, were looked up in the gateway log');
    assert.equal(record.result, expected, record.notes.join('\n'));
  }
  const noApim = fakes({ config: { samples: 1 } });
  const blocked = await createRunner(noApim.deps)('latency', checks.latency, ['T-64']);
  assert.equal(blocked.result, 'BLOCKED');
  assert.match(blocked.notes.join('\n'), /no APIM URL/);
  assert.equal(noApim.externalCalls.length, 0, 'without an APIM URL nothing is sent to an APIM route');
});

test('T-64: a failed sample on either route fails the check, which reports the failures and no percentiles', async () => {
  const { createRunner, checks } = await load();
  const config = { samples: 2, apimUrl: 'https://apim.contoso.example/claude' };
  let streams = 0;
  const gateway = fakes({ config, respond: (pathname, body, options, requestId) => (body?.stream && ++streams === 2 ? { status: 429, json: { type: 'error' }, requestId } : undefined) });
  const apim = fakes({ config, respondExternal: (n) => (n === 1 ? { status: 503, events: [], requestId: null, firstTokenMs: null } : undefined) });
  for (const [fake, route, status] of [[gateway, 'gateway', 'HTTP 429'], [apim, 'APIM', 'HTTP 503']]) {
    const record = await createRunner(fake.deps)('latency', checks.latency, ['T-64']);
    const notes = record.notes.join('\n');
    assert.equal(record.result, 'FAIL', notes);
    assert.match(notes, new RegExp(`FAILED ${route}: 1 of 2 requests failed: ${status}`));
    assert.doesNotMatch(notes.split('\n').find((n) => n.startsWith(`${route} `)) ?? '', /p50/, 'no percentiles for a route with a failed request');
  }
});

test('T-64: the suite sends to an APIM route only when --apim-url names one, and reads no Claude Code settings for it', () => {
  const source = fs.readFileSync(path.join(live, 'inference-suite.mjs'), 'utf8');
  assert.match(source, /apimUrl: opts\['apim-url'\] === undefined/, 'the APIM URL comes from --apim-url');
  assert.doesNotMatch(source, /ANTHROPIC_FOUNDRY_BASE_URL|\.claude['"]|homedir\(/, "the suite takes an APIM URL from the tester's Claude Code settings");
});

test('T-65: agentic audits every model request the CLI sent, in both runs, and the second run disallows the reading tools', async (t) => {
  const { createRunner, checks } = await load();
  for (const [withheld, expected] of [[[], 'PASS'], [['c3'], 'BLOCKED']]) {
    const fake = fakes({ withheld });
    const args = [];
    fake.deps.helperProfile = fakeProfile(t, { runs: [
      ({ work, extraArgs }) => { args.push(extraArgs); return { stdout: fs.readFileSync(path.join(work, 'marker.txt'), 'utf8').split('\n')[0], ids: ['c1', 'c2'] }; },
      ({ extraArgs }) => { args.push(extraArgs); return { stdout: 'The tools I need are not available.', ids: ['c3'] }; },
    ] });
    const record = await createRunner(fake.deps)('agentic', checks.agentic, ['T-65']);
    assert.equal(record.result, expected, record.notes.join('\n'));
    assert.deepEqual(fake.asked.sort(), ['c1', 'c2', 'c3']);
    assert.deepEqual(args, [[], ['--disallowedTools', 'Read', 'Grep', 'Glob', 'Bash']]);
  }
});

// A CLI run counts only when Claude Code ended by itself with status 0: a run the time limit stopped can carry status 0
// when a process it left holds its output open (QA third follow-up review of the live-run fixes).
test('T-51, T-65: a CLI run the time limit stopped, or one that exited non-zero, fails the check', async (t) => {
  const { createRunner, checks } = await load();
  const markerOf = (work) => fs.readFileSync(path.join(work, 'marker.txt'), 'utf8').split('\n')[0];
  const noSession = ({ options }) => ({ status: 1, stdout: '', stderr: helperReport(options.helperGateway) });
  const declined = () => ({ stdout: 'The tools I need are not available.', ids: ['c3'] });
  const read = (extra) => ({ work }) => ({ stdout: markerOf(work), ids: ['c1', 'c2'], ...extra });
  for (const [name, ids, runs, note] of [
    ['profile', ['T-51'], [() => ({ status: 0, timedOut: true, stdout: 'PONG', ids: ['c1'] }), noSession], /claude -p: Claude Code was stopped at the time limit/],
    ['profile', ['T-51'], [() => ({ status: 2, stdout: 'PONG', ids: ['c1'] }), noSession], /claude -p: Claude Code exited 2/],
    ['agentic', ['T-65'], [read({ status: 0, timedOut: true }), declined], /read: Claude Code was stopped at the time limit/],
    ['agentic', ['T-65'], [read({ status: 1 }), declined], /read: Claude Code exited 1/],
    ['agentic', ['T-65'], [read(), () => ({ status: 0, timedOut: true, stdout: '', ids: ['c3'] })], /tools disallowed: Claude Code was stopped at the time limit with the tools disallowed/],
    ['agentic', ['T-65'], [read(), () => ({ status: 1, stdout: '', ids: ['c3'] })], /tools disallowed: Claude Code exited 1 with the tools disallowed/],
  ]) {
    const fake = fakes();
    fake.deps.helperProfile = fakeProfile(t, { runs });
    const record = await createRunner(fake.deps)(name, checks[name], ids);
    assert.equal(record.result, 'FAIL', record.notes.join('\n'));
    assert.match(record.notes.join('\n'), note);
  }
});

test('T-51: profile audits every model request the CLI sent, and a run with no session gets no model answer', async (t) => {
  const { createRunner, checks } = await load();
  for (const [withheld, expected] of [[[], 'PASS'], [['c1'], 'BLOCKED']]) {
    const fake = fakes({ withheld });
    fake.deps.helperProfile = fakeProfile(t, { runs: [
      () => ({ stdout: 'PONG', ids: ['c1'] }),
      ({ options }) => ({ status: 1, stdout: '', stderr: helperReport(options.helperGateway) }),
    ] });
    const record = await createRunner(fake.deps)('profile', checks.profile, ['T-51']);
    assert.equal(record.result, expected, record.notes.join('\n'));
  }
});

// A failing apiKeyHelper leaves Claude Code's requests with a placeholder key, so they can reach the gateway, which must
// refuse each with 401; any other answer without a session fails T-51 (https://code.claude.com/docs/en/llm-gateway-connect,
// its troubleshooting table; the live run of 2026-09-28).
test('T-51: the run with no session may reach the gateway only to be refused with 401', async (t) => {
  const { createRunner, checks } = await load();
  const post = (status, requestId) => ({ method: 'POST', path: '/v1/messages', status, requestId });
  for (const [captured, expected, note] of [
    [[post(401, 'x1'), post(401, 'x2')], 'PASS', /without a session, Claude Code exited 1 and reported the helper's exit 1 with its message; 2 model request\(s\) reached the gateway, each refused with 401/],
    [[post(401, 'x1'), post(200, 'x2')], 'FAIL', /1 model request\(s\) without a session got 200, not 401/],
  ]) {
    const fake = fakes();
    fake.deps.helperProfile = fakeProfile(t, { runs: [
      () => ({ stdout: 'PONG', ids: ['c1'] }),
      ({ options }) => ({ status: 1, stdout: '', stderr: helperReport(options.helperGateway), captured }),
    ] });
    const record = await createRunner(fake.deps)('profile', checks.profile, ['T-51']);
    assert.equal(record.result, expected, record.notes.join('\n'));
    assert.match(record.notes.join('\n'), note);
  }
});

test('T-51, T-65: the temporary profile is removed when the install fails or its settings cannot be read', async (t) => {
  const { createRunner, createHelperProfile, checks } = await load();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-infer-root-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const installs = [
    [async () => ({ status: 1, stdout: '', stderr: 'Install-ClaudeGatewayProfile: refused' }), /install: Install-ClaudeGatewayProfile: refused/],
    [async (profile) => {
      fs.mkdirSync(profile, { recursive: true });
      fs.writeFileSync(path.join(profile, 'settings.json'), '{ not json');
      return { status: 0, stdout: '', stderr: '' };
    }, /settings\.json could not be read/],
    // An install the time limit stopped has failed, even with status 0 and a readable profile (QA follow-up reviews
    // of the live-run fixes).
    [async (profile) => {
      fs.mkdirSync(profile, { recursive: true });
      fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ apiKeyHelper: 'helper.cmd' }));
      return { status: 0, stdout: '', stderr: '', timedOut: true };
    }, /install: the installer was stopped at the time limit/],
  ];
  for (const [install, note] of installs) {
    const fake = fakes();
    fake.deps.helperProfile = createHelperProfile({ install, runClaude: async () => { throw new Error('not reached'); }, tmpRoot });
    const record = await createRunner(fake.deps)('profile', checks.profile, ['T-51']);
    assert.equal(record.result, 'FAIL', record.notes.join('\n'));
    assert.match(record.notes.join('\n'), note);
    assert.deepEqual(fs.readdirSync(tmpRoot), [], 'the temporary profile was removed');
  }
});

test('a clean-up that fails is reported in the result, not swallowed', async () => {
  const { createRunner } = await load();
  const record = await createRunner(fakes().deps)('models', async (ctx) => { ctx.cleanups.push(() => { throw new Error('the folder is in use'); }); }, ['T-55']);
  assert.ok(record.notes.some((n) => /clean-up failed: the folder is in use/.test(n)), record.notes.join('\n'));
});

test('the exit code is 1 when a check failed, 2 when one was BLOCKED, and 0 when all passed', async () => {
  const { exitCodeOf } = await load();
  assert.equal(exitCodeOf([{ result: 'PASS' }, { result: 'PASS' }]), 0);
  assert.equal(exitCodeOf([{ result: 'PASS' }, { result: 'BLOCKED' }]), 2);
  assert.equal(exitCodeOf([{ result: 'BLOCKED' }, { result: 'FAIL' }]), 1);
});

test('T-57: a stream closed early passes with output tokens at the four-characters-per-token floor for the received text and a cost above zero', async () => {
  const { closedStreamFindings } = await import('./live/inference-lib.mjs');
  // https://code.claude.com/docs/en/claude-apps-gateway-spend-limits#how-requests-are-priced
  const received = { receivedText: 'Mountains rise', maxTokens: 800 };
  const event = { evt: 'inference', output_tokens: 6, cost_usd: 0.0002 };
  assert.deepEqual(closedStreamFindings(event, received), { fail: [], block: [] });
  assert.match(closedStreamFindings({ ...event, cost_usd: 0 }, received).fail.join(), /cost 0/);
  assert.match(closedStreamFindings({ evt: 'inference', output_tokens: 6, price_usd: 0.000015 }, received).block.join(), /no total cost field/);
  assert.match(closedStreamFindings({ ...event, output_tokens: 2 }, received).fail.join(), /below the floor of 4/);
  assert.match(closedStreamFindings({ ...event, output_tokens: 900 }, received).fail.join(), /above max_tokens 800/);
  assert.match(closedStreamFindings(undefined, received).block.join(), /no inference event/);
  assert.match(closedStreamFindings({ evt: 'inference', cost_usd: 0.1 }, received).block.join(), /no output token field/);
});

// The stream check through the runner. The closed stream's event is varied; the other answers' events are correct.
async function streamCheck(cutEvent, { cutAnswer } = {}) {
  const { createRunner, checks } = await load();
  const fake = fakes({
    respond: (pathname, body, options, requestId) => {
      if (!body?.stream) return undefined;
      if (options.cut) return cutAnswer?.(requestId) ?? { status: 200, events: CLOSED_STREAM, requestId, firstTokenMs: 10, cut: true };
      return { status: 200, events: withText(PONG_STREAM, '4'), requestId, firstTokenMs: 10 };
    },
    eventOf: (e, request) => (request?.options?.cut ? { ...e, ...cutEvent } : e),
  });
  const record = await createRunner(fake.deps)('stream', checks.stream, ['T-57']);
  return { record, notes: record.notes.join('\n') };
}

test('T-57 through the runner: the closed stream passes at the floor and at max_tokens, and fails one token outside either', async () => {
  for (const [cutEvent, expected, note] of [
    [{ output_tokens: 4, cost_usd: 0.0002 }, 'PASS'],
    [{ output_tokens: 3, cost_usd: 0.0002 }, 'FAIL', /below the floor of 4/],
    [{ output_tokens: 800, cost_usd: 0.0002 }, 'PASS'],
    [{ output_tokens: 801, cost_usd: 0.0002 }, 'FAIL', /above max_tokens 800/],
    [{ usage: { output_tokens: 6 }, cost_usd: 0.0002 }, 'PASS'],
    [{ output_tokens: 6, cost: 0.0002 }, 'PASS'],
    [{ output_tokens: 6, cost_usd: 0 }, 'FAIL', /cost 0/],
    [{ output_tokens: 6, price_usd: 0.000015 }, 'BLOCKED', /no total cost field/],
  ]) {
    const { record, notes } = await streamCheck(cutEvent);
    assert.equal(record.result, expected, `${JSON.stringify(cutEvent)}: ${notes}`);
    if (note) assert.match(notes, note);
  }
});

test('T-57 through the runner: the closed stream\'s event gets the audit of every answer, so a wrong status, upstream, model or subject fails', async () => {
  const priced = { output_tokens: 6, cost_usd: 0.0002 };
  for (const [wrong, note] of [
    [{ status: 499 }, /status 499, expected 200/],
    [{ upstream: 'anthropic' }, /upstream anthropic/],
    [{ model: 'claude-opus-5' }, /model claude-opus-5, expected claude-sonnet-5/],
    [{ sub: 'user-2' }, /names another subject/],
  ]) {
    const { record, notes } = await streamCheck({ ...priced, ...wrong });
    assert.equal(record.result, 'FAIL', `${JSON.stringify(wrong)}: ${notes}`);
    assert.match(notes, note);
  }
  const refused = await streamCheck(priced, { cutAnswer: (requestId) => ({ status: 429, json: { type: 'error' }, requestId }) });
  assert.equal(refused.record.result, 'FAIL');
  assert.match(refused.notes, /closed stream: status 429/);
});

test('ctx.sendExternal refuses a request without a url, or to the gateway, which ctx.send reaches', async () => {
  const { createRunner } = await load();
  for (const options of [{ token: 'apim-token' }, { token: 'apim-token', url: 'https://gateway.contoso.example/claude' }, { token: 'apim-token', url: 'http://apim.contoso.example/claude' }]) {
    const fake = fakes();
    const record = await createRunner(fake.deps)('latency', async (ctx) => { await ctx.sendExternal('/v1/messages', {}, options); }, ['T-64']);
    assert.equal(record.result, 'FAIL', record.notes.join('\n'));
    assert.match(record.notes.join('\n'), /ctx\.sendExternal refused/);
    assert.equal(fake.externalCalls.length, 0, 'nothing was sent');
  }
});

test('T-64: --apim-url is an https URL without credentials, a query or a fragment, so the APIM token is never sent in plain text', async () => {
  const { apimBaseUrl } = await load();
  // The APIM route's base path is kept, without a trailing slash (Architect review, round 5).
  assert.equal(apimBaseUrl('https://apim-claude-gw.azure-api.net/claude/'), 'https://apim-claude-gw.azure-api.net/claude');
  assert.equal(apimBaseUrl('https://APIM.contoso.example:8443/claude'), 'https://apim.contoso.example:8443/claude');
  for (const [url, why] of [
    ['http://apim.contoso.example/claude', /must use https/],
    ['apim.contoso.example/claude', /not an absolute URL/],
    ['https://user:secret@apim.contoso.example/claude', /user name or password/],
    ['https://apim.contoso.example/claude?subscription-key=x', /query or fragment/],
    ['https://apim.contoso.example/claude#x', /query or fragment/],
  ]) assert.throws(() => apimBaseUrl(url), why, url);
  // A refused URL is not repeated, since it can hold a key or a password (UX review, round 6).
  for (const url of ['http://user:SENTINEL-SECRET@apim.contoso.example/claude', 'https://apim.contoso.example/claude?subscription-key=SENTINEL-SECRET',
    'https://apim.contoso.example/claude#SENTINEL-SECRET', 'SENTINEL-SECRET/claude']) {
    assert.throws(() => apimBaseUrl(url), (error) => !error.message.includes('SENTINEL-SECRET'), url);
  }
  const source = fs.readFileSync(path.join(live, 'inference-suite.mjs'), 'utf8');
  assert.match(source, /apimUrl: opts\['apim-url'\] === undefined \? undefined : apimBaseUrl\(opts\['apim-url'\]\)/, 'the suite checks --apim-url before any request');
});

test('every check runs against the fakes without an error, so a name the refactor left behind shows offline', async () => {
  const { createRunner, checks, TESTS } = await load();
  assert.deepEqual(Object.keys(checks).sort(), Object.keys(TESTS).sort(), 'each check has its test IDs');
  for (const name of Object.keys(TESTS)) {
    const record = await createRunner(fakes().deps)(name, checks[name], TESTS[name]);
    assert.ok(!record.notes.some((n) => n.startsWith('error:')), `${name}: ${record.notes.join('\n')}`);
  }
});

// A gateway that answers the tool call with a tool_use block, so the round trip and its negative run offline too; the
// fakes above never answer with one, and the check stops after its first request (Coder review, round 5).
test('T-59: tools runs its tool_use round trip and its unknown tool_use_id negative offline', async () => {
  const { createRunner, checks } = await load();
  const usage = { input_tokens: 9, output_tokens: 6 };
  const fake = fakes({ respond: (pathname, body, options, requestId) => {
    if (!body?.tools) return undefined;
    const last = body.messages.at(-1);
    const result = Array.isArray(last.content) ? last.content.find((b) => b.type === 'tool_result') : null;
    if (!result) return { status: 200, json: { type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }], usage }, requestId };
    if (result.tool_use_id !== 'toolu_1') return { status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'unknown tool_use_id' } }, requestId };
    return { status: 200, json: { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `It is ${result.content} in Paris.` }], usage }, requestId };
  } });
  const record = await createRunner(fake.deps)('tools', checks.tools, ['T-59']);
  assert.equal(record.result, 'PASS', record.notes.join('\n'));
  assert.equal(fake.gatewayCalls.length, 3, 'the tool call, the tool_result round trip and the unknown tool_use_id');
  assert.equal(fake.gatewayCalls[1].body.messages.at(-1).content[0].tool_use_id, 'toolu_1');
  assert.equal(fake.gatewayCalls[2].body.messages.at(-1).content[0].tool_use_id, 'toolu_unknown');
  // Thinking counts toward max_tokens, so the answer that uses the tool result has room for it (Coder review of the
  // live-run fixes).
  assert.ok(fake.gatewayCalls.every((c) => c.body.max_tokens >= 1024), 'each tools request leaves room for thinking');
});

test('the suite reads the gateway log with the deployment\'s subscription, and stops when the Azure CLI does not hold it in the deployment\'s tenant', async () => {
  const { azureAccountProblem } = await load();
  const state = { subscriptionId: 'sub-1', tenantId: 'tenant-1' };
  const asked = [];
  const az = (answer) => (args, options) => { asked.push({ args, options }); return answer; };
  assert.equal(azureAccountProblem({ runAz: az({ status: 0, stdout: JSON.stringify({ id: 'sub-1', tenantId: 'tenant-1' }) }), state }), null);
  assert.deepEqual(asked[0], { args: ['account', 'show', '--subscription', 'sub-1', '--output', 'json'], options: { allowFailure: true } });
  assert.match(azureAccountProblem({ runAz: az({ status: 1, stdout: '' }), state }), /holds no subscription sub-1, .*; run az login --tenant tenant-1$/);
  assert.match(azureAccountProblem({ runAz: az({ status: 0, stdout: 'not json' }), state }), /holds no subscription sub-1/);
  assert.match(azureAccountProblem({ runAz: az({ status: 0, stdout: JSON.stringify({ id: 'sub-1', tenantId: 'tenant-2' }) }), state }),
    /in tenant tenant-2, not in the deployment's tenant tenant-1; run az login --tenant tenant-1$/);
  const source = fs.readFileSync(path.join(live, 'inference-suite.mjs'), 'utf8');
  assert.match(source, /'logs', 'show'[^\n]*\n[^\n]*'--subscription', state\.subscriptionId/, 'the log read names the subscription');
  assert.match(source, /const accountProblem = azureAccountProblem\(\{ runAz, state \}\);\nif \(accountProblem\) \{/, 'the account is checked before the checks run');
});

test('the suite registers each token for redaction, sends through createSend, and asks the helper for the gateway\'s token only', () => {
  const source = fs.readFileSync(path.join(live, 'inference-suite.mjs'), 'utf8');
  // createSend follows no redirect; the loopback tests below show it.
  assert.match(source, /^const send = createSend\(base\);$/m, 'the suite sends through createSend');
  assert.doesNotMatch(source, /\bfetch\(/, 'the suite sends a request of its own');
  assert.match(source, /return \{ token: registerSecret\(r\.stdout\.trim\(\)\) \};/, 'the session token is registered for redaction');
  assert.match(source, /if \(r\.timedOut \|\| r\.status !== 0 \|\| !r\.stdout\.trim\(\)\) return \{ blocked:/,
    'a helper the time limit stopped gives no session token (QA follow-up reviews of the live-run fixes)');
  assert.match(source, /apimToken: \(\) => registerSecret\(runAz\(/, 'the APIM token is registered for redaction');
  assert.match(source, /'get-access-token', '--resource', 'https:\/\/cognitiveservices\.azure\.com', '--tenant', opts\['apim-tenant'\] \?\? state\.tenantId,/,
    'the APIM token is for the tenant the account check confirmed, not the Azure CLI default (Architect review, round 5)');
  assert.match(source, /env: \{ \.\.\.process\.env, ANTHROPIC_BASE_URL: base \}/, 'the helper is asked for the token of the gateway');
});

// A loopback server for createSend, the suite's HTTP sender. The live run of 2026-09-28 failed on a stream closed after
// its first delta, which the fakes above never close (docs/TEST-PLAN.md, the live results of that date).
async function loopback(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const sse = (res, e) => res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);

test('T-57: send closes a stream after its first delta without an error, and the server sees the client go away', async (t) => {
  const { createSend } = await import('./live/inference-http.mjs');
  let closed;
  const base = await loopback(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req-cut' });
    for (const e of CLOSED_STREAM) sse(res, e);
    const timer = setInterval(() => sse(res, { event: 'ping', data: { type: 'ping' } }), 20);
    closed = new Promise((resolve) => res.on('close', () => { clearInterval(timer); resolve(res.writableEnded); }));
  });
  const r = await createSend(base)('/v1/messages', { model: 'm', stream: true }, { token: 'x', cut: true });
  assert.equal(r.status, 200);
  assert.equal(r.cut, true);
  assert.equal(r.requestId, 'req-cut');
  assert.ok(r.firstTokenMs >= 0);
  assert.equal(r.events.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta.text).join(''), 'Mountains rise');
  assert.equal(await closed, false, 'the connection closed before the server ended the stream');
});

test('T-57: send reads a stream that is not cut to its end', async (t) => {
  const { createSend } = await import('./live/inference-http.mjs');
  const base = await loopback(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req-full' });
    for (const e of PONG_STREAM) sse(res, e);
    res.end();
  });
  const r = await createSend(base)('/v1/messages', { model: 'm', stream: true }, { token: 'x' });
  assert.equal(r.status, 200);
  assert.equal(r.cut, undefined);
  assert.deepEqual(r.events.map((e) => e.event), PONG_STREAM.map((e) => e.event));
});

test('send follows no redirect, so a token stays with the host it was sent to', async (t) => {
  const { createSend } = await import('./live/inference-http.mjs');
  let reached = 0;
  const other = await loopback(t, (req, res) => { reached += 1; res.end('{}'); });
  const base = await loopback(t, (req, res) => { res.writeHead(307, { location: `${other}/v1/messages` }); res.end(); });
  const r = await createSend(base)('/v1/messages', { model: 'm' }, { token: 'x' });
  assert.equal(r.status, 307);
  assert.equal(reached, 0, 'nothing reached the redirect target');
});
// Claude Opus 5 and Sonnet 5 think adaptively, refuse a manual thinking budget, and count thinking tokens toward
// max_tokens (https://platform.claude.com/docs/en/build-with-claude/thinking; the live run of 2026-09-28).
const answer = (requestId, stop_reason, content) => ({ status: 200, json: { type: 'message', role: 'assistant', stop_reason, content, usage: { input_tokens: 12, output_tokens: 5 } }, requestId });
const refusal = (requestId, message) => ({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message } }, requestId });

test('T-60: thinking asks for adaptive thinking and passes on the refusal of a manual budget; a turn without thinking is BLOCKED', async () => {
  const { createRunner, checks } = await load();
  const models = ['claude-opus-5', 'claude-sonnet-5'];
  for (const [thought, expected] of [['Euclid', 'PASS'], [null, 'BLOCKED'], ['', 'FAIL']]) {
    const fake = fakes({ config: { models }, eventOf: (e, request) => ({ ...e, model: request?.body?.model ?? e.model }), respond: (pathname, body, options, requestId) => {
      if (body?.thinking?.type === 'enabled') return refusal(requestId, '"thinking.type.enabled" is not supported for this model.');
      if (body?.thinking?.type !== 'adaptive') return undefined;
      // An empty summary, although the request asked for display summarized, fails (QA review of the live-run fixes).
      return answer(requestId, 'end_turn', [...(thought === null ? [] : [{ type: 'thinking', thinking: thought, signature: 's' }]), { type: 'text', text: '21' }]);
    } });
    const record = await createRunner(fake.deps)('thinking', checks.thinking, ['T-60']);
    assert.equal(record.result, expected, record.notes.join('\n'));
    const adaptive = fake.gatewayCalls.filter((c) => c.body?.thinking?.type === 'adaptive');
    assert.deepEqual(adaptive.map((c) => c.body.model), models, 'one adaptive request per model');
    assert.ok(adaptive.every((c) => c.body.output_config?.effort === 'high' && c.body.thinking.display === 'summarized'));
    // Every model is asked for the manual budget (Coder review of the live-run fixes).
    assert.deepEqual(fake.gatewayCalls.filter((c) => c.body?.thinking?.type === 'enabled').map((c) => c.body.model), models, 'a manual budget per model');
  }
});

test('T-56: a max_tokens stop that holds only thinking passes; the other stop reasons still need text', async () => {
  const { createRunner, checks } = await load();
  const fake = fakes({ respond: (pathname, body, options, requestId) => {
    if (body?.max_tokens === undefined) return refusal(requestId, 'max_tokens: Field required');
    if (body.max_tokens === 5) return answer(requestId, 'max_tokens', [{ type: 'thinking', thinking: '', signature: 's' }]);
    if (body.stop_sequences) return answer(requestId, 'stop_sequence', [{ type: 'text', text: '1 2 3 4' }]);
    return answer(requestId, 'end_turn', [{ type: 'text', text: '4' }]);
  } });
  const record = await createRunner(fake.deps)('messages', checks.messages, ['T-56']);
  assert.equal(record.result, 'PASS', record.notes.join('\n'));
  assert.ok(fake.gatewayCalls.filter((c) => c.body?.max_tokens !== undefined && c.body.max_tokens !== 5).every((c) => c.body.max_tokens >= 1024),
    'a request that expects text leaves room for thinking');
});
// QA review of the live-run fixes: the sender's ordinary contract, its deadline, and a cut that waits for text.
test('send posts the JSON body with the bearer token and API version, and reads a JSON answer with its request ID', async (t) => {
  const { createSend } = await import('./live/inference-http.mjs');
  const seen = [];
  const base = await loopback(t, (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, version: req.headers['anthropic-version'], type: req.headers['content-type'], body: raw });
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req-json' });
      res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'PONG' }] }));
    });
  });
  const send = createSend(base);
  const r = await send('/v1/messages', { model: 'm', max_tokens: 5 }, { token: 'tok-1' });
  assert.deepEqual(r, { status: 200, json: { type: 'message', content: [{ type: 'text', text: 'PONG' }] }, requestId: 'req-json' });
  assert.deepEqual(seen[0], { method: 'POST', url: '/v1/messages', auth: 'Bearer tok-1', version: '2023-06-01', type: 'application/json', body: '{"model":"m","max_tokens":5}' });
  await send('/v1/models', null, {});
  assert.equal(seen[1].method, 'GET');
  assert.equal(seen[1].auth, undefined, 'no token, no authorization header');
  assert.equal(seen[1].type, undefined);
});

test('send gives up at its deadline on an answer that never comes', async (t) => {
  const { createSend } = await import('./live/inference-http.mjs');
  const base = await loopback(t, () => {});
  // The test's own limit makes a sender without a deadline fail here in seconds rather than hang the run.
  const limit = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('no deadline: the request was still open after 5 s')), 5000); t.after(() => clearTimeout(timer)); });
  await assert.rejects(Promise.race([createSend(base, { timeoutMs: 300 })('/v1/messages', { model: 'm' }, { token: 'x' }), limit]), /timeout|aborted/i);
});

test('T-57: a cut stream stays open through thinking and closes after the first text it receives', async (t) => {
  const { createSend } = await import('./live/inference-http.mjs');
  let closed;
  const thinking = [
    { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Mountains...' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 's' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
  ];
  const base = await loopback(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req-think' });
    for (const e of thinking) sse(res, e);
    // The text arrives later, in its own write.
    setTimeout(() => sse(res, { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Peaks' } } }), 100);
    const timer = setInterval(() => sse(res, { event: 'ping', data: { type: 'ping' } }), 20);
    closed = new Promise((resolve) => res.on('close', () => { clearInterval(timer); resolve(res.writableEnded); }));
  });
  const r = await createSend(base)('/v1/messages', { model: 'm', stream: true }, { token: 'x', cut: true });
  assert.equal(r.cut, true);
  assert.equal(r.events.filter((e) => e.data?.delta?.type === 'text_delta').map((e) => e.data.delta.text).join(''), 'Peaks', 'the cut came after the first text');
  assert.ok(r.firstTokenMs < 100, 'time to first token counts the first delta of any kind');
  assert.equal(await closed, false);
});

test('T-57: a closed stream with no text received decides nothing about the floor price', async () => {
  const { closedStreamFindings } = await import('./live/inference-lib.mjs');
  const f = closedStreamFindings({ evt: 'inference', output_tokens: 0, cost_usd: 0.01 }, { receivedText: '', maxTokens: 800 });
  assert.deepEqual(f.fail, []);
  assert.match(f.block.join(), /no text was received before the close/);
});

test('T-51: a run without a session that answers, or whose report does not show the helper exiting 1 with its sign-in command, fails', async (t) => {
  const { createRunner, checks } = await load();
  const refused401 = [{ method: 'POST', path: '/v1/messages', status: 401, requestId: 'x1' }];
  const noSession = 'https://no-session.invalid';
  for (const [second, note] of [
    [{ status: 0, stdout: 'PONG', stderr: '', captured: refused401 }, /Claude Code answered with no saved session/],
    [{ status: 1, stdout: '', stderr: 'something else failed', captured: refused401 }, /did not report the failing apiKeyHelper/],
    // The helper's exit status and message come from Claude Code's report on stderr (QA follow-up review of the
    // live-run fixes; U-53).
    [{ status: 1, stdout: '', stderr: helperReport(noSession, 2), captured: refused401 }, /reported that the helper exited 2, not 1/],
    [{ status: 1, stdout: '', stderr: `apiKeyHelper failed: exited 1: Get-ClaudeGatewayToken: No saved session for ${noSession}.`, captured: refused401 }, /names no sign-in command for https:\/\/no-session\.invalid/],
    [{ status: 1, stdout: helperReport(noSession), stderr: '', captured: refused401 }, /did not report the failing apiKeyHelper and its exit status on stderr/],
    // Claude Code exits by itself: a run the time limit stopped, or one without an exit status, fails even with the
    // report and the 401s (QA second follow-up review of the live-run fixes).
    [{ status: 1, timedOut: true, stdout: '', stderr: helperReport(noSession), captured: refused401 }, /stopped at the time limit instead of exiting/],
    [{ status: null, stdout: '', stderr: helperReport(noSession), captured: refused401 }, /ended with no exit status \(null\)/],
  ]) {
    const fake = fakes();
    fake.deps.helperProfile = fakeProfile(t, { runs: [() => ({ stdout: 'PONG', ids: ['c1'] }), () => second] });
    const record = await createRunner(fake.deps)('profile', checks.profile, ['T-51']);
    assert.equal(record.result, 'FAIL', record.notes.join('\n'));
    assert.match(record.notes.join('\n'), note);
  }
});