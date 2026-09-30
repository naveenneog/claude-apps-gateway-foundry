// Unit tests for the inference suite's evaluators (tests/live/inference-lib.mjs, T-55 to T-64 in docs/TEST-PLAN.md),
// with answers shaped like the Messages API (https://platform.claude.com/docs/en/api/messages).
import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import {
  cacheFindings, concurrencyFindings, countFindings, crc32, invalidRequestFindings, latencySummary, messageFindings, modelListFindings,
  solidPng, streamFindings, thinkingFindings, toolUseFindings,
} from './live/inference-lib.mjs';

const ok = (f) => assert.deepEqual(f, { fail: [], block: [] });
const fails = (f, re) => assert.ok(f.fail.some((m) => re.test(m)), `expected a failure matching ${re}: ${JSON.stringify(f)}`);
const message = (over = {}) => ({ type: 'message', role: 'assistant', content: [{ type: 'text', text: '4' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3 }, ...over });
const sse = (...names) => names.map((event, i) => ({ event, data: { index: 0, ...(event === 'message_delta' ? { usage: { output_tokens: 5 } } : {}), i } }));

test('models: exactly the configured IDs pass; a missing or extra model fails', () => {
  ok(modelListFindings({ data: [{ id: 'b' }, { id: 'a' }] }, ['a', 'b']));
  fails(modelListFindings({ data: [{ id: 'a' }] }, ['a', 'b']), /lists \[a\]/);
  fails(modelListFindings({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, ['a', 'b']), /the config lists \[a, b\]/);
});

test('invalid request: 400 invalid_request_error passes; 200 or another error type fails', () => {
  ok(invalidRequestFindings({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error' } } }));
  fails(invalidRequestFindings({ status: 200, json: message() }), /returned 200/);
  fails(invalidRequestFindings({ status: 400, json: { error: { type: 'permission_error' } } }), /permission_error/);
});

test('message: text, usage and the requested stop reason pass; each missing part fails', () => {
  ok(messageFindings({ status: 200, json: message() }, { stop: 'end_turn' }));
  fails(messageFindings({ status: 500, json: { error: { message: 'boom' } } }), /status 500: boom/);
  fails(messageFindings({ status: 200, json: message({ content: [] }) }), /no text block/);
  fails(messageFindings({ status: 200, json: message({ usage: { input_tokens: 12, output_tokens: 0 } }) }), /usage\.output_tokens is 0/);
  fails(messageFindings({ status: 200, json: message({ stop_reason: 'max_tokens' }) }, { stop: 'stop_sequence' }), /stop_reason max_tokens, expected stop_sequence/);
  fails(messageFindings({ status: 200, json: message({ role: 'user' }) }), /not an assistant message/);
  // Thinking tokens count toward max_tokens, so a max_tokens stop can come before any text; only that stop may lack a
  // text block (https://platform.claude.com/docs/en/build-with-claude/thinking; live run of 2026-09-28).
  const thoughtOnly = message({ content: [{ type: 'thinking', thinking: '', signature: 's' }], stop_reason: 'max_tokens' });
  ok(messageFindings({ status: 200, json: thoughtOnly }, { stop: 'max_tokens', requireText: false }));
  fails(messageFindings({ status: 200, json: thoughtOnly }, { stop: 'max_tokens' }), /no text block/);
  fails(messageFindings({ status: 200, json: { ...thoughtOnly, stop_reason: 'end_turn' } }, { stop: 'max_tokens', requireText: false }), /stop_reason end_turn, expected max_tokens/);
  // Without text, the stop still holds a thinking block: an empty answer is not one (QA review of the live-run fixes).
  fails(messageFindings({ status: 200, json: message({ content: [], stop_reason: 'max_tokens' }) }, { stop: 'max_tokens', requireText: false }), /no text or thinking block/);
  fails(messageFindings({ status: 200, json: message({ content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }], stop_reason: 'max_tokens' }) }, { stop: 'max_tokens', requireText: false }), /no text or thinking block/);
});

test('stream: the documented order passes, with ping anywhere', () => {
  ok(streamFindings(sse('message_start', 'ping', 'content_block_start', 'content_block_delta', 'ping', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop')));
});

test('stream: a wrong first or last event, an unclosed block, no delta, an error event or content after message_delta fails', () => {
  fails(streamFindings(sse('content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop')), /first event is content_block_start/);
  fails(streamFindings(sse('message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta')), /last event is message_delta/);
  fails(streamFindings(sse('message_start', 'content_block_start', 'content_block_delta', 'message_delta', 'message_stop')), /never stopped/);
  fails(streamFindings(sse('message_start', 'content_block_start', 'content_block_stop', 'message_delta', 'message_stop')), /no content_block_delta/);
  fails(streamFindings(sse('message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'error', 'message_stop')), /error event/);
  fails(streamFindings([...sse('message_start', 'content_block_start', 'content_block_delta', 'content_block_stop'), { event: 'message_delta', data: {} }, ...sse('message_stop')]), /no usage\.output_tokens/);
  fails(streamFindings(sse('message_start', 'content_block_start', 'content_block_delta', 'message_delta', 'content_block_stop', 'message_stop')), /content events after message_delta/);
  fails(streamFindings(sse('message_start', 'content_block_delta', 'message_delta', 'message_stop')), /outside its start and stop/);
});

test('count_tokens: within 10% passes; outside fails; a zero count fails; missing usage blocks', () => {
  ok(countFindings({ input_tokens: 105 }, { input_tokens: 100 }));
  fails(countFindings({ input_tokens: 111 }, { input_tokens: 100 }), /by 11\.0%/);
  fails(countFindings({ input_tokens: 0 }, { input_tokens: 100 }), /input_tokens 0/);
  assert.equal(countFindings({ input_tokens: 10 }, {}).block.length, 1);
});

test('tool use: a tool_use stop naming the tool passes; another tool, no block or a non-object input fails', () => {
  const use = (over) => ({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' }, ...over }] });
  ok(toolUseFindings(use(), 'get_weather'));
  fails(toolUseFindings(use({ name: 'other' }), 'get_weather'), /names other/);
  fails(toolUseFindings({ stop_reason: 'end_turn', content: [] }, 'get_weather'), /not tool_use/);
  fails(toolUseFindings(use({ input: 'Paris' }), 'get_weather'), /not an object/);
  fails(toolUseFindings(use({ id: undefined }), 'get_weather'), /no id/);
});

test('thinking: a thinking or redacted block before the text passes; a text block before it fails; none is BLOCKED', () => {
  ok(thinkingFindings({ content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: '42' }] }));
  ok(thinkingFindings({ content: [{ type: 'redacted_thinking', data: 'x' }, { type: 'text', text: '42' }] }));
  // Thinking is adaptive: no effort level guarantees a thinking block, so a turn without one decides nothing
  // (https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost).
  const none = thinkingFindings({ content: [{ type: 'text', text: '42' }] });
  assert.deepEqual(none.fail, []);
  assert.match(none.block.join(), /no thinking block/);
  fails(thinkingFindings({ content: [{ type: 'text', text: '42' }, { type: 'thinking', thinking: '...' }] }), /a text block comes before the thinking/);
  // An empty text block counts for the order, while the answer is the non-empty text after the thinking (QA follow-up
  // review of the live-run fixes).
  fails(thinkingFindings({ content: [{ type: 'text', text: '' }, { type: 'thinking', thinking: 'summary' }, { type: 'text', text: '21' }] }, { summarized: true }), /a text block comes before the thinking/);
  ok(thinkingFindings({ content: [{ type: 'thinking', thinking: 'summary' }, { type: 'text', text: '' }, { type: 'text', text: '21' }] }, { summarized: true }));
  // The answer follows the thinking, and a summary asked for is not empty (QA review of the live-run fixes).
  fails(thinkingFindings({ content: [{ type: 'thinking', thinking: '...' }] }), /no text block after the thinking/);
  fails(thinkingFindings({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '21' }] }, { summarized: true }), /empty thinking summary/);
  ok(thinkingFindings({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '21' }] }));
  ok(thinkingFindings({ content: [{ type: 'redacted_thinking', data: 'x' }, { type: 'text', text: '21' }] }, { summarized: true }));
});

test('cache: a write then a read passes; no write or no read fails', () => {
  ok(cacheFindings({ usage: { cache_creation_input_tokens: 2048 } }, { usage: { cache_read_input_tokens: 2048 } }));
  fails(cacheFindings({ usage: { cache_creation_input_tokens: 0 } }, { usage: { cache_read_input_tokens: 2048 } }), /cache_creation_input_tokens 0/);
  fails(cacheFindings({ usage: { cache_creation_input_tokens: 2048 } }, { usage: {} }), /cache_read_input_tokens undefined/);
});

test('concurrency: all 200 with distinct request IDs and a 401 without a token pass; each departure fails or blocks', () => {
  const eight = Array.from({ length: 8 }, (_, i) => ({ status: 200, requestId: `r${i}` }));
  ok(concurrencyFindings(eight, { status: 401 }));
  fails(concurrencyFindings([...eight.slice(1), { status: 429, requestId: 'r9' }], { status: 401 }), /1 of 8 parallel requests failed: 429/);
  fails(concurrencyFindings([...eight.slice(1), { status: 200, requestId: 'r1' }], { status: 401 }), /share an x-request-id/);
  fails(concurrencyFindings(eight, { status: 200 }), /without a token returned 200/);
  assert.equal(concurrencyFindings([...eight.slice(1), { status: 200 }], { status: 401 }).block.length, 1);
});

test('latency: nearest-rank p50 and p95; a route with any failure reports its failures and no percentiles', () => {
  const samples = Array.from({ length: 20 }, (_, i) => ({ ok: true, ms: (i + 1) * 10 }));
  assert.deepEqual(latencySummary(samples), { n: 20, failures: 0, p50: 100, p95: 190, min: 10, max: 200 });
  const broken = latencySummary([...samples.slice(1), { ok: false, error: 'HTTP 429' }]);
  assert.deepEqual(broken, { n: 20, failures: 1, errors: ['HTTP 429'] });
  assert.equal('p50' in broken, false);
});

test('solid PNG: valid signature, chunk CRCs and pixel data', () => {
  assert.equal(crc32(Buffer.from('IEND')), 0xae426082, 'the CRC of an empty IEND chunk (PNG specification)');
  const png = solidPng(4, 3, [255, 0, 0]);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8;
  const chunks = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('ascii');
    const data = png.subarray(at + 8, at + 8 + length);
    assert.equal(png.readUInt32BE(at + 8 + length), crc32(png.subarray(at + 4, at + 8 + length)), `${type} CRC`);
    chunks.push({ type, data });
    at += 12 + length;
  }
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  assert.equal(chunks[0].data.readUInt32BE(0), 4);
  assert.equal(chunks[0].data.readUInt32BE(4), 3);
  const pixels = zlib.inflateSync(chunks[1].data);
  assert.equal(pixels.length, 3 * (1 + 4 * 3));
  assert.deepEqual([...pixels.subarray(0, 4)], [0, 255, 0, 0]);
});
