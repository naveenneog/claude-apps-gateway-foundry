// The checks of the live inference suite (P-20, and T-51 of P-18; docs/TEST-PLAN.md), run by
// tests/live/inference-runner.mjs. A check reaches the network only through its context:
//   ctx.send          a gateway request; the runner records it and audits every 200 answer on /v1/messages
//   ctx.sendExternal  a request to another route, the APIM route of T-64, which has no gateway audit; it refuses the
//                     gateway's own origin
//   ctx.events        the gateway's audit events for request IDs
//   ctx.auditCaptured the model answers Claude Code got through the capture relay, each matched to its event
//   ctx.helperProfile a throwaway Claude Code profile behind the capture relay
//   ctx.apimToken     a token for the APIM route, fetched before the timed requests
// tests/inference-runner.test.mjs checks that no check sends, fetches or starts a process by itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../../infra/azure-test/lib/secrets.mjs';
import {
  cacheFindings, closedStreamFindings, concurrencyFindings, countFindings, invalidRequestFindings, latencySummary, messageFindings,
  modelListFindings, solidPng, streamFindings, textOf, thinkingFindings, toolUseFindings,
} from './inference-lib.mjs';

export const TESTS = { models: ['T-55'], messages: ['T-56'], stream: ['T-57'], count: ['T-58'], tools: ['T-59'], thinking: ['T-60'], cache: ['T-61'],
  image: ['T-62'], concurrency: ['T-63'], latency: ['T-64'], profile: ['T-51'], agentic: ['T-65'] };

// Thinking tokens count toward max_tokens, and Claude Opus 5 and Sonnet 5 think adaptively by default, so a request that
// expects text leaves room for thinking (https://platform.claude.com/docs/en/build-with-claude/thinking; the live run of
// 2026-09-28 got no text with max_tokens 5 and 16).
const TEXT_MAX_TOKENS = 1024;
const ask = (model, prompt, extra = {}) => ({ model, max_tokens: TEXT_MAX_TOKENS, messages: [{ role: 'user', content: prompt }], ...extra });
const streamedText = (events) => (events ?? []).filter((e) => e.event === 'content_block_delta').map((e) => e.data?.delta?.text ?? '').join('');
const CLOSED_STREAM_MAX_TOKENS = 800;
// T-51's run without a session points the helper at an origin it holds no session for, and the helper names the
// sign-in command for that origin (scripts/developer/Get-ClaudeGatewayToken.ps1:72).
const NO_SESSION = 'https://no-session.invalid';
const NO_SESSION_SIGN_IN = new RegExp(`Connect-ClaudeGateway\\.ps1.*-GatewayUrl ${NO_SESSION.replace(/[.]/g, '\\.')}(\\s|$)`);
// Why a Claude Code run did not end by itself with status 0. A run the time limit stopped can still carry status 0,
// when a process it left holds its output open (QA follow-up reviews of the live-run fixes).
const cliFault = (r) => (r.timedOut ? 'was stopped at the time limit' : r.status !== 0 ? `exited ${r.status}` : null);

export const checks = {
  async models(ctx, token) {
    const { models, unlisted } = ctx.config;
    ctx.apply('models', modelListFindings((await ctx.send('/v1/models', null, { token })).json, models));
    const answers = [];
    for (const model of models) answers.push({ model, ...(await ctx.send('/v1/messages', ask(model, 'Reply with the single word PONG.'), { token })) });
    for (const a of answers) ctx.apply(a.model, messageFindings(a));
    const denied = await ctx.send('/v1/messages', ask(unlisted, 'Reply with PONG.'), { token });
    ctx.apply(`unlisted ${unlisted}`, invalidRequestFindings(denied));
    const deniedEvents = await ctx.events([denied.requestId]);
    if (deniedEvents?.some((e) => e.evt === 'inference' && e.status === 200)) ctx.apply('unlisted audit', { fail: ['an inference event with status 200 for the unlisted model'] });
  },
  async messages(ctx, token) {
    const { models } = ctx.config;
    for (const model of models) {
      const system = 'You answer with digits only.';
      ctx.apply(`${model} end_turn`, messageFindings(await ctx.send('/v1/messages', ask(model, 'What is 2+2?', { system }), { token }), { stop: 'end_turn' }));
      ctx.apply(`${model} stop_sequence`, messageFindings(await ctx.send('/v1/messages', ask(model, 'Count from 1 to 10, separated by spaces.', { stop_sequences: [' 5'] }), { token }), { stop: 'stop_sequence' }));
      ctx.apply(`${model} max_tokens`, messageFindings(await ctx.send('/v1/messages', ask(model, 'Write a long essay about rivers.', { max_tokens: 5 }), { token }), { stop: 'max_tokens', requireText: false }));
    }
    const { max_tokens: _, ...noLimit } = ask(models[0], 'Hi');
    ctx.apply('no max_tokens', invalidRequestFindings(await ctx.send('/v1/messages', noLimit, { token })));
  },
  async stream(ctx, token) {
    const { models, fast } = ctx.config;
    for (const model of models) {
      const r = await ctx.send('/v1/messages', ask(model, 'What is 2+2? Answer with the digit only.', { stream: true }), { token });
      ctx.apply(`${model} stream`, r.status === 200 ? streamFindings(r.events) : { fail: [`status ${r.status}`] });
      if (!/4/.test(streamedText(r.events))) ctx.apply(`${model} text`, { fail: [`streamed text ${JSON.stringify(streamedText(r.events).slice(0, 80))} does not hold 4`] });
    }
    const cut = await ctx.send('/v1/messages', ask(fast, 'Write 300 words about mountains.', { stream: true, max_tokens: CLOSED_STREAM_MAX_TOKENS }), { token, cut: true });
    // The runner audits the closed stream's event as it does every answer's: status, upstream, model and subject. The
    // floor price is judged here, on the same event (U-51).
    if (cut.status !== 200) {
      ctx.apply('closed stream', { fail: [`status ${cut.status}`] });
      return;
    }
    const e = (cut.requestId ? await ctx.events([cut.requestId], (x) => x.evt === 'inference') : null)?.find((x) => x.evt === 'inference');
    const received = streamedText(cut.events);
    ctx.apply('closed stream', closedStreamFindings(e, { receivedText: received, maxTokens: CLOSED_STREAM_MAX_TOKENS }));
    if (e) ctx.note(`closed stream: ${received.length} characters received; event output tokens ${e.output_tokens ?? e.usage?.output_tokens}, cost ${e.cost_usd ?? e.cost}`);
  },
  async count(ctx, token) {
    const { models, unlisted } = ctx.config;
    for (const model of models) {
      const body = ask(model, 'Name three rivers in Europe.', { system: 'Answer in one line.' });
      const { max_tokens: _, ...countBody } = body;
      const counted = await ctx.send('/v1/messages/count_tokens', countBody, { token });
      const answered = await ctx.send('/v1/messages', body, { token });
      ctx.apply(model, counted.status === 200 ? countFindings(counted.json, answered.json?.usage) : { fail: [`count_tokens status ${counted.status}`] });
    }
    ctx.apply(`unlisted ${unlisted}`, invalidRequestFindings(await ctx.send('/v1/messages/count_tokens', { model: unlisted, messages: [{ role: 'user', content: 'Hi' }] }, { token })));
  },
  async tools(ctx, token) {
    const { models } = ctx.config;
    const tool = { name: 'get_weather', description: 'Current weather for a city.', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
    const question = { role: 'user', content: 'What is the weather in Paris? Use the tool.' };
    const call = (messages) => ctx.send('/v1/messages', { model: models[0], max_tokens: TEXT_MAX_TOKENS, tools: [tool], messages }, { token });
    const first = await call([question]);
    ctx.apply('tool_use', toolUseFindings(first.json, tool.name));
    const use = (first.json?.content ?? []).find((b) => b.type === 'tool_use');
    if (!use) return;
    const answer = (id, content) => [question, { role: 'assistant', content: first.json.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }];
    const second = await call(answer(use.id, 'Sunny, 31 degrees Celsius'));
    if (!/31/.test(textOf(second.json))) ctx.apply('tool_result', { fail: [`the final answer does not use the result: ${JSON.stringify(textOf(second.json).slice(0, 120))}`] });
    ctx.apply('unknown tool_use_id', invalidRequestFindings(await call(answer('toolu_unknown', 'x'))));
  },
  async thinking(ctx, token) {
    const { models } = ctx.config;
    // Adaptive thinking with its summary shown, steered towards thinking; no setting guarantees a thinking block
    // (https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost).
    const system = 'This task involves multistep reasoning. Think carefully before responding.';
    for (const model of models) {
      const r = await ctx.send('/v1/messages', ask(model, 'What is the greatest common divisor of 1071 and 462? Reply with the number only.',
        { max_tokens: 4096, system, thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } }), { token });
      ctx.apply(model, r.status === 200 ? thinkingFindings(r.json, { summarized: true }) : { fail: [`status ${r.status}: ${r.json?.error?.message ?? ''}`] });
    }
    // A manual thinking budget is refused on Claude Opus 5 and Sonnet 5, and the gateway passes the refusal on
    // (https://platform.claude.com/docs/en/build-with-claude/thinking#configuring-thinking). Each model is asked.
    for (const model of models) {
      ctx.apply(`${model} manual thinking budget`, invalidRequestFindings(await ctx.send('/v1/messages', ask(model, 'Hi', { max_tokens: 2048, thinking: { type: 'enabled', budget_tokens: 1024 } }), { token })));
    }
  },
  async cache(ctx, token) {
    const { models } = ctx.config;
    const body = (system) => ({ model: models[0], max_tokens: 16, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: 'Say OK.' }] });
    const long = `${'You are a careful assistant for a hydrology team. '.repeat(700)}Run ${crypto.randomUUID()}.`;
    const first = await ctx.send('/v1/messages', body(long), { token });
    const second = await ctx.send('/v1/messages', body(long), { token });
    ctx.apply('cache', cacheFindings(first.json, second.json));
    const short = await ctx.send('/v1/messages', body(`Short prompt ${crypto.randomUUID()}.`), { token });
    const u = short.json?.usage ?? {};
    if (short.status !== 200) ctx.apply('short prompt', { fail: [`status ${short.status}`] });
    else if ((u.cache_creation_input_tokens ?? 0) !== 0 || (u.cache_read_input_tokens ?? 0) !== 0) ctx.apply('short prompt', { fail: [`cache tokens ${JSON.stringify(u)} below the minimum length`] });
  },
  async image(ctx, token) {
    const { models } = ctx.config;
    const content = (data) => [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }, { type: 'text', text: 'What colour fills this image? One word.' }];
    const call = (data) => ctx.send('/v1/messages', { model: models[0], max_tokens: TEXT_MAX_TOKENS, messages: [{ role: 'user', content: content(data) }] }, { token });
    const r = await call(solidPng(64, 64, [220, 20, 20]).toString('base64'));
    if (r.status !== 200 || !/red/i.test(textOf(r.json))) ctx.apply('colour', { fail: [`status ${r.status}, answer ${JSON.stringify(textOf(r.json))}`] });
    ctx.apply('invalid base64', invalidRequestFindings(await call('not-base64!!')));
  },
  async concurrency(ctx, token) {
    const { fast } = ctx.config;
    const parallel = Array.from({ length: 8 }, () => ctx.send('/v1/messages', ask(fast, 'Reply with the single word PONG.', { max_tokens: 8 }), { token }));
    const [unauthenticated, ...answers] = await Promise.all([ctx.send('/v1/messages', ask(fast, 'Reply with PONG.')), ...parallel]);
    ctx.apply('parallel', concurrencyFindings(answers, unauthenticated));
  },
  async latency(ctx, token, blocked) {
    const { fast, samples, base, apimUrl } = ctx.config;
    const body = { model: fast, max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'Reply with the single word PONG.' }] };
    const measure = async (request) => {
      const out = [];
      for (let i = 0; i < samples; i++) {
        const r = await request().catch((e) => ({ status: 0, error: e.message }));
        out.push(r.status === 200 && r.firstTokenMs !== null ? { ok: true, ms: Math.round(r.firstTokenMs) } : { ok: false, error: r.error ?? `HTTP ${r.status}` });
      }
      return latencySummary(out);
    };
    // The gateway samples go through ctx.send, so each answer is audited; the APIM route has no gateway audit. A route
    // with a failed request is reported with its failures and no percentiles, and fails the check (QA review, round 5).
    const report = (route, origin, summary) => {
      ctx.note(`${route} ${origin} time to first token (ms): ${JSON.stringify(summary)}`);
      if (summary.failures) ctx.apply(route, { fail: [`${summary.failures} of ${summary.n} requests failed: ${summary.errors.join(', ')}`] });
    };
    if (token) report('gateway', base, await measure(() => ctx.send('/v1/messages', body, { token })));
    else ctx.apply('gateway', { block: [blocked] });
    if (!apimUrl) {
      ctx.apply('APIM', { block: ['no APIM URL; pass --apim-url'] });
      return;
    }
    // Fetched before the timed requests, so token acquisition is outside the measured interval.
    const apimToken = ctx.apimToken();
    const url = apimUrl.replace(/\/$/, '');
    report('APIM', new URL(url).origin, await measure(() => ctx.sendExternal('/v1/messages', body, { token: apimToken, url })));
  },
  async profile(ctx) {
    const setup = await ctx.helperProfile();
    if (!setup) return;
    const r = await setup.cli('Reply with the single word PONG');
    const fault = cliFault(r);
    if (fault || !/PONG/i.test(r.stdout)) ctx.apply('claude -p', { fail: [`Claude Code ${fault ?? 'answered without PONG'}: ${redactSecrets(`${r.stdout}${r.stderr}`).slice(0, 300)}`] });
    await ctx.auditCaptured('audit', r.captured);
    // An origin with no saved session, rather than another LOCALAPPDATA, which would also move a Claude Code installed there.
    const refused = await setup.cli('Reply with PONG', [], {}, { helperGateway: NO_SESSION });
    // Claude Code exits by itself with a non-zero status; a run the time limit stopped, or one without an exit status,
    // shows neither (QA follow-up review of the live-run fixes).
    if (refused.timedOut) ctx.apply('no session', { fail: ['Claude Code was stopped at the time limit instead of exiting with no saved session'] });
    else if (refused.status === 0) ctx.apply('no session', { fail: ['Claude Code answered with no saved session'] });
    else if (!Number.isInteger(refused.status)) ctx.apply('no session', { fail: [`Claude Code ended with no exit status (${refused.status})`] });
    // In non-interactive mode Claude Code reports a failing helper on stderr as "apiKeyHelper failed:"
    // (https://code.claude.com/docs/en/llm-gateway-connect, troubleshooting); 2.1.272 adds the helper's exit status and
    // its stderr, "apiKeyHelper failed: exited 1: <message>" (U-53). Without a session the helper exits 1 (T-49).
    const report = /apiKeyHelper failed: exited (\d+): (.*)/.exec(refused.stderr ?? '');
    if (!report) ctx.apply('no session message', { fail: ['Claude Code did not report the failing apiKeyHelper and its exit status on stderr'] });
    else {
      if (report[1] !== '1') ctx.apply('no session message', { fail: [`Claude Code reported that the helper exited ${report[1]}, not 1`] });
      if (!NO_SESSION_SIGN_IN.test(report[2])) ctx.apply('no session message', { fail: [`the helper's message in Claude Code's report names no sign-in command for ${NO_SESSION}`] });
    }
    // A failing apiKeyHelper leaves the requests with a placeholder key, so they can reach the gateway, which refuses
    // each with 401 (https://code.claude.com/docs/en/llm-gateway-connect, troubleshooting; the live run of 2026-09-28).
    const reached = refused.captured.filter((c) => c.path.startsWith('/v1/messages'));
    const answered = reached.filter((c) => c.status !== 401);
    if (answered.length) ctx.apply('no session requests', { fail: [`${answered.length} model request(s) without a session got ${answered.map((c) => c.status).join(', ')}, not 401`] });
    else ctx.note(`without a session, Claude Code exited ${refused.status}${report ? ` and reported the helper's exit ${report[1]} with its message` : ''}; ${reached.length} model request(s) reached the gateway, each refused with 401`);
  },
  async agentic(ctx) {
    const setup = await ctx.helperProfile();
    if (!setup) return;
    const marker = `CGW-MARKER-${crypto.randomBytes(6).toString('hex')}`;
    fs.writeFileSync(path.join(setup.work, 'marker.txt'), `${marker}\nsecond line\n`);
    const prompt = 'Read the file marker.txt in the current directory and reply with its first line only';
    const r = await setup.cli(prompt);
    const fault = cliFault(r);
    if (fault) ctx.apply('read', { fail: [`Claude Code ${fault}`] });
    if (!r.stdout.includes(marker)) ctx.apply('read', { fail: [`the answer does not quote the marker: ${redactSecrets(r.stdout).slice(0, 200)}`] });
    const turns = r.captured.filter((c) => c.method === 'POST' && c.path.startsWith('/v1/messages')).length;
    if (turns < 2) ctx.apply('turns', { fail: [`${turns} /v1/messages request(s); a tool round trip needs at least 2`] });
    await ctx.auditCaptured('audit', r.captured);
    const denied = await setup.cli(prompt, ['--disallowedTools', 'Read', 'Grep', 'Glob', 'Bash']);
    // A run that did not end by itself shows nothing about the disallowed tools.
    const deniedFault = cliFault(denied);
    if (deniedFault) ctx.apply('tools disallowed', { fail: [`Claude Code ${deniedFault} with the tools disallowed`] });
    if (denied.stdout.includes(marker)) ctx.apply('tools disallowed', { fail: ['the marker was quoted with Read, Grep, Glob and Bash disallowed'] });
    await ctx.auditCaptured('tools disallowed audit', denied.captured);
  },
};
