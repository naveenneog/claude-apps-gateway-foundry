// The inference suite's HTTP sender (tests/live/inference-suite.mjs), in its own module so that offline tests run it
// against a loopback server (tests/inference-runner.test.mjs). A stream is parsed into events; cut closes it after the
// first text it receives, so a stream that starts with thinking stays open until its answer begins. Redirects are not
// followed, so a token stays with the host it was sent to.
import { SseParser } from './lib.mjs';

const tryJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

export function createSend(base, { timeoutMs = 180_000 } = {}) {
  return async function send(pathname, body, { token, url = base, cut = false } = {}) {
    const controller = new AbortController();
    const started = performance.now();
    // Every request has a deadline, so an answer that never ends cannot hold the suite.
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    const response = await fetch(`${url}${pathname}`, { method: body ? 'POST' : 'GET', signal, redirect: 'manual',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'anthropic-version': '2023-06-01', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const requestId = response.headers.get('x-request-id');
    if (!body?.stream || response.status !== 200) return { status: response.status, json: tryJson(await response.text()), requestId };
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const events = [];
    let firstTokenMs = null;
    try {
      reading: for await (const chunk of response.body) {
        for (const e of parser.feed(decoder.decode(chunk, { stream: true }))) {
          const data = tryJson(e.data);
          events.push({ event: e.event, data });
          if (e.event !== 'content_block_delta') continue;
          // Time to first token counts the first delta of any kind; the cut waits for text (QA review of the live-run fixes).
          if (firstTokenMs === null) firstTokenMs = performance.now() - started;
          if (cut && data?.delta?.type === 'text_delta' && data.delta.text) {
            controller.abort();
            break reading;
          }
        }
      }
    } catch (error) {
      // Leaving the loop of an aborted body rejects with the abort; that is the close the check asked for (the live
      // run of 2026-09-28 failed with "This operation was aborted").
      if (!(cut && controller.signal.aborted)) throw error;
    }
    if (cut && controller.signal.aborted) return { status: 200, events, requestId, firstTokenMs, cut: true };
    return { status: response.status, events, requestId, firstTokenMs };
  };
}
