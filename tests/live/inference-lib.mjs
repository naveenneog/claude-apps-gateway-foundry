// Pure evaluators for the inference suite (tests/live/inference-suite.mjs, T-55 to T-65 in docs/TEST-PLAN.md). Each
// takes what a check observed and returns { fail, block } lists: fail when the gateway behaved differently from the
// Messages API contract, block when the evidence to decide is missing. Unit tests: tests/inference-lib.test.mjs.
import zlib from 'node:zlib';

const findings = () => ({ fail: [], block: [] });
const textOf = (json) => (json?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');

// T-55: /v1/models lists exactly the configured model IDs.
export function modelListFindings(json, expectedIds) {
  const f = findings();
  const listed = (json?.data ?? []).map((m) => m.id).sort();
  const expected = [...expectedIds].sort();
  if (JSON.stringify(listed) !== JSON.stringify(expected)) f.fail.push(`/v1/models lists [${listed.join(', ')}]; the config lists [${expected.join(', ')}]`);
  return f;
}

// The negatives of T-55 to T-62: a model outside the config, or a request the Messages API refuses, gets
// 400 invalid_request_error.
export function invalidRequestFindings({ status, json }) {
  const f = findings();
  if (status !== 400) f.fail.push(`the request returned ${status}, not 400`);
  else if (json?.error?.type !== 'invalid_request_error') f.fail.push(`the 400 has error type ${json?.error?.type ?? 'none'}, not invalid_request_error`);
  return f;
}

// T-56: a non-streaming answer with text, usage and the stop reason the request asked for. Thinking tokens count toward
// max_tokens, so a max_tokens stop can come before any text; requireText false accepts that when the answer holds a
// thinking block instead (https://platform.claude.com/docs/en/build-with-claude/thinking).
export function messageFindings({ status, json }, { stop, requireText = true } = {}) {
  const f = findings();
  if (status !== 200) return { ...f, fail: [`status ${status}: ${json?.error?.message ?? 'no error message'}`] };
  if (json?.type !== 'message' || json?.role !== 'assistant') f.fail.push(`not an assistant message: type ${json?.type}, role ${json?.role}`);
  const thought = (json?.content ?? []).some((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
  if (requireText && !textOf(json)) f.fail.push('no text block');
  else if (!requireText && !textOf(json) && !thought) f.fail.push('no text or thinking block');
  for (const key of ['input_tokens', 'output_tokens']) if (!(json?.usage?.[key] > 0)) f.fail.push(`usage.${key} is ${json?.usage?.[key]}`);
  if (stop && json?.stop_reason !== stop) f.fail.push(`stop_reason ${json?.stop_reason}, expected ${stop}`);
  return f;
}

// T-57: the SSE event order of https://platform.claude.com/docs/en/build-with-claude/streaming. ping may appear anywhere.
export function streamFindings(events) {
  const f = findings();
  const names = events.map((e) => e.event).filter((n) => n !== 'ping');
  if (names.includes('error')) f.fail.push(`the stream carried an error event: ${JSON.stringify(events.find((e) => e.event === 'error')?.data)}`);
  if (names[0] !== 'message_start') f.fail.push(`the first event is ${names[0] ?? 'missing'}, not message_start`);
  if (names.at(-1) !== 'message_stop') f.fail.push(`the last event is ${names.at(-1) ?? 'missing'}, not message_stop`);
  const open = new Set();
  let deltas = 0;
  for (const e of events) {
    const index = e.data?.index;
    if (e.event === 'content_block_start') open.add(index);
    if (e.event === 'content_block_delta') { deltas += 1; if (!open.has(index)) f.fail.push(`a delta for block ${index} outside its start and stop`); }
    if (e.event === 'content_block_stop') { if (!open.has(index)) f.fail.push(`block ${index} stopped without a start`); open.delete(index); }
  }
  if (open.size) f.fail.push(`blocks ${[...open].join(', ')} never stopped`);
  if (!deltas) f.fail.push('no content_block_delta');
  const delta = events.find((e) => e.event === 'message_delta');
  if (!(delta?.data?.usage?.output_tokens > 0)) f.fail.push('message_delta carries no usage.output_tokens');
  const stopAt = names.indexOf('message_delta');
  if (stopAt >= 0 && names.slice(stopAt + 1).some((n) => n.startsWith('content_block'))) f.fail.push('content events after message_delta');
  return f;
}

// T-58: count_tokens within 10% of the usage the same body reports on /v1/messages.
export function countFindings(count, usage, tolerance = 0.1) {
  const f = findings();
  const counted = count?.input_tokens;
  if (!(counted > 0)) return { ...f, fail: [`count_tokens returned input_tokens ${counted}`] };
  if (!(usage?.input_tokens > 0)) return { ...f, block: ['the matching /v1/messages answer has no usage.input_tokens'] };
  const drift = Math.abs(counted - usage.input_tokens) / usage.input_tokens;
  if (drift > tolerance) f.fail.push(`count_tokens ${counted} differs from usage.input_tokens ${usage.input_tokens} by ${(drift * 100).toFixed(1)}%`);
  return f;
}

// T-59: a tool_use stop with a tool_use block naming the tool and carrying an object input.
export function toolUseFindings(json, toolName) {
  const f = findings();
  const use = (json?.content ?? []).find((b) => b.type === 'tool_use');
  if (json?.stop_reason !== 'tool_use') f.fail.push(`stop_reason ${json?.stop_reason}, not tool_use`);
  if (!use) f.fail.push('no tool_use block');
  else {
    if (use.name !== toolName) f.fail.push(`the tool_use block names ${use.name}, not ${toolName}`);
    if (!use.id) f.fail.push('the tool_use block has no id');
    if (use.input === null || typeof use.input !== 'object') f.fail.push('the tool_use input is not an object');
  }
  return f;
}

// T-60: a thinking block, then the answer's text. Thinking is adaptive, and no effort level guarantees a thinking
// block, so a turn without one is BLOCKED, not failed; with summarized set, a thinking block holds its summary, while a
// redacted one holds none (https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost,
// https://platform.claude.com/docs/en/build-with-claude/thinking).
export function thinkingFindings(json, { summarized = false } = {}) {
  const f = findings();
  const blocks = json?.content ?? [];
  const types = blocks.map((b) => b.type);
  const thinking = types.findIndex((t) => t === 'thinking' || t === 'redacted_thinking');
  if (thinking < 0) {
    f.block.push(`no thinking block: the model chose not to think on this turn; blocks: ${types.join(', ') || 'none'}`);
    return f;
  }
  // The order counts every text block, an empty one included; the answer is a non-empty text block after the thinking
  // (QA follow-up review of the live-run fixes).
  const firstText = types.indexOf('text');
  if (firstText >= 0 && firstText < thinking) f.fail.push('a text block comes before the thinking');
  if (!blocks.some((b, i) => i > thinking && b.type === 'text' && b.text)) f.fail.push('no text block after the thinking');
  if (summarized && blocks.some((b) => b.type === 'thinking' && !b.thinking)) f.fail.push('an empty thinking summary, although display summarized was asked for');
  return f;
}

// T-61: the first request writes the cache and the second reads it.
export function cacheFindings(first, second) {
  const f = findings();
  if (!(first?.usage?.cache_creation_input_tokens > 0)) f.fail.push(`first request: cache_creation_input_tokens ${first?.usage?.cache_creation_input_tokens}`);
  if (!(second?.usage?.cache_read_input_tokens > 0)) f.fail.push(`second request: cache_read_input_tokens ${second?.usage?.cache_read_input_tokens}`);
  return f;
}

// T-57's negative: a stream the client closes before the upstream's final usage frame is billed at the gateway's floor
// estimate of about four characters per output token for the text already sent to the client
// (https://code.claude.com/docs/en/claude-apps-gateway-spend-limits#how-requests-are-priced). The gateway sent at least
// the text the client received, so the event's output tokens are at least ceil(received characters / 4) and at most the
// request's max_tokens, and its total cost is above zero. The per-token rate is Claude Code's cost table on the gateway,
// which this does not check.
export function closedStreamFindings(e, { receivedText, maxTokens }) {
  const f = findings();
  if (e?.evt !== 'inference') {
    f.block.push('no inference event for the stream closed after its first text');
    return f;
  }
  const fields = Object.keys(e).sort().join(',');
  const output = [e.output_tokens, e.usage?.output_tokens].find((v) => typeof v === 'number');
  const cost = [e.cost_usd, e.cost].find((v) => typeof v === 'number');
  if (output === undefined) f.block.push(`no output token field (fields: ${fields}; U-52)`);
  if (cost === undefined) f.block.push(`no total cost field (fields: ${fields}; U-52)`);
  if (f.block.length) return f;
  const received = String(receivedText ?? '').length;
  // With no text received, the floor is zero and the check would pass for any count (QA review of the live-run fixes).
  if (!received) return { ...f, block: ['no text was received before the close, so the floor price is not tested'] };
  const floor = Math.ceil(received / 4);
  if (output < floor) f.fail.push(`output tokens ${output}, below the floor of ${floor} for the ${received} characters received`);
  if (output > maxTokens) f.fail.push(`output tokens ${output}, above max_tokens ${maxTokens}`);
  if (!(cost > 0)) f.fail.push(`cost ${cost}, not above zero`);
  return f;
}

// T-63: every parallel request answered 200 with its own request ID, and the token-less one got 401.
export function concurrencyFindings(results, unauthenticated) {
  const f = findings();
  const bad = results.filter((r) => r.status !== 200);
  if (bad.length) f.fail.push(`${bad.length} of ${results.length} parallel requests failed: ${bad.map((r) => r.status).join(', ')}`);
  const ids = results.map((r) => r.requestId).filter(Boolean);
  if (ids.length !== results.length) f.block.push(`${results.length - ids.length} answers carry no x-request-id`);
  if (new Set(ids).size !== ids.length) f.fail.push('two answers share an x-request-id');
  if (unauthenticated?.status !== 401) f.fail.push(`the request without a token returned ${unauthenticated?.status}, not 401`);
  return f;
}

// T-64: nearest-rank percentiles; a route with a failed request is reported with its failures and not summarised.
export function latencySummary(samples) {
  const failures = samples.filter((s) => !s.ok);
  if (failures.length) return { n: samples.length, failures: failures.length, errors: [...new Set(failures.map((s) => s.error))] };
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const rank = (p) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
  return { n: sorted.length, failures: 0, p50: rank(50), p95: rank(95), min: sorted[0], max: sorted.at(-1) };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// T-62: a PNG of one solid colour, RGB 8-bit (https://www.w3.org/TR/png-3/).
export function solidPng(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}

export { textOf };
