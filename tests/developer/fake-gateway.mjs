// A loopback stand-in for the Claude apps gateway, for the developer-script tests: discovery, the RFC 8628 device grant,
// the refresh grant (tests/live/out/protocol.txt:100-112), RFC 7009 revocation and a minimal /v1 API that answers PONG
// to an access token it issued. Each test scripts the outcomes; every request is recorded.
import crypto from 'node:crypto';
import http from 'node:http';

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const fakeJwt = (claims) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.${crypto.randomBytes(16).toString('base64url')}`;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
// Merges overrides into an answer; an override of undefined removes the key.
const shaped = (answer, overrides) => Object.fromEntries(Object.entries({ ...answer, ...overrides }).filter(([, v]) => v !== undefined));

const SSE_PONG = [
  ['message_start', { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PONG' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
  ['message_stop', { type: 'message_stop' }],
];

/**
 * @param {object} [script]
 * @param {string[]} [script.device] outcomes of successive device-grant polls: pending, slow_down, denied, expired, token
 * @param {string[]} [script.refresh] outcomes of successive refresh grants: token, invalid_grant, invalid_request (400),
 *   throttled (429), ok_invalid_grant (200 with invalid_grant), throttled_invalid_grant (429 with invalid_grant),
 *   unavailable, reset, no_token, no_lifetime, garbage (then token)
 * @param {number|number[]} [script.expiresIn] expires_in of issued access tokens in seconds; a list gives one per token, the last repeating
 * @param {string|null} [script.email] the account the device grant names; null leaves it out
 * @param {boolean} [script.rotate] false answers a refresh grant without a new refresh token
 * @param {boolean} [script.holdRefresh] holds every refresh answer until releaseRefresh(); refreshArrived resolves on the first
 * @param {object|Function} [script.deviceAnswer] overrides for the device authorization answer (undefined removes a key), or a function of the origin that returns them
 * @param {object} [script.tokenAnswer] overrides for the device grant's token answer (undefined removes a key)
 * @param {number} [script.deviceStatus] answers device authorization with this status and an error
 * @param {'token'|'verification'|'revocation'} [script.foreign] points that endpoint or URL at another origin
 * @param {string} [script.redirectRefreshTo] answers every refresh grant with 307 to this origin's token endpoint
 * @param {boolean} [script.revocation] advertises revocation_endpoint and records revocations
 * @param {string} [script.host] the loopback address to listen on: 127.0.0.1 (default) or ::1
 */
export async function startFakeGateway({ device = ['token'], refresh = [], expiresIn = 3600, email = 'dev@contoso.example',
  interval = 1, refreshDelayMs = 0, issueRefreshToken = true, rotate = true, holdRefresh = false, deviceAnswer = {},
  tokenAnswer = {}, deviceStatus = 200, foreign = null, redirectRefreshTo = null, revocation = false, host = '127.0.0.1' } = {}) {
  const requests = [];
  const access = new Set();
  const issued = [];
  const validRefresh = new Set();
  let lastRefresh = null;
  let serial = 0;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let arrived;
  const refreshArrived = new Promise((resolve) => { arrived = resolve; });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const form = /x-www-form-urlencoded/.test(req.headers['content-type'] ?? '') ? Object.fromEntries(new URLSearchParams(text)) : null;
      let json = null;
      try { json = form ? null : JSON.parse(text); } catch { /* not JSON */ }
      const record = { method: req.method, path: req.url, headers: req.headers, form, json, at: Date.now() };
      requests.push(record);
      handle(record, res).catch((error) => { res.writeHead(500); res.end(String(error)); });
    });
  });
  await new Promise((resolve) => server.listen(0, host, resolve));
  const origin = `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`;
  const elsewhere = 'http://127.0.0.2:9';

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const lifetimes = [expiresIn].flat();
  // A refresh chain: each device grant starts one; a rotating refresh replaces the token it was given.
  const issue = ({ replacing = null } = {}) => {
    serial += 1;
    const lifetime = lifetimes.length > 1 ? lifetimes.shift() : lifetimes[0];
    const token = fakeJwt({ sub: 'dev', n: serial, exp: Math.floor(Date.now() / 1000) + lifetime });
    access.add(token);
    issued.push(token);
    const answer = { access_token: token, token_type: 'Bearer', expires_in: lifetime };
    if (replacing && !rotate) return answer;
    if (replacing) validRefresh.delete(replacing);
    if (!issueRefreshToken) return answer;
    lastRefresh = `rt-${serial}-${crypto.randomBytes(12).toString('hex')}`;
    issued.push(lastRefresh);
    validRefresh.add(lastRefresh);
    return { ...answer, refresh_token: lastRefresh };
  };

  async function handle(r, res) {
    if (r.method === 'GET' && r.path === '/.well-known/oauth-authorization-server') {
      return send(res, 200, { issuer: origin, device_authorization_endpoint: `${origin}/oauth/device_authorization`,
        token_endpoint: `${foreign === 'token' ? elsewhere : origin}/oauth/token`, grant_types_supported: [DEVICE_GRANT, 'refresh_token'],
        ...(revocation || foreign === 'revocation' ? { revocation_endpoint: `${foreign === 'revocation' ? elsewhere : origin}/oauth/revoke` } : {}) });
    }
    if (r.method === 'POST' && r.path === '/oauth/device_authorization') {
      if (deviceStatus !== 200) return send(res, deviceStatus, { error: 'server_error' });
      const verification = `${foreign === 'verification' ? elsewhere : origin}/device`;
      return send(res, 200, shaped({ device_code: crypto.randomBytes(32).toString('base64url'), user_code: 'WDJB-MJHT', verification_uri: verification,
        verification_uri_complete: `${verification}?user_code=WDJB-MJHT`, expires_in: 600, interval }, typeof deviceAnswer === 'function' ? deviceAnswer(origin) : deviceAnswer));
    }
    if (r.method === 'POST' && r.path === '/oauth/token' && r.form?.grant_type === DEVICE_GRANT) {
      const outcome = device.length > 1 ? device.shift() : device[0];
      if (outcome === 'token') return send(res, 200, shaped({ ...issue(), ...(email ? { email } : {}) }, tokenAnswer));
      const error = { pending: 'authorization_pending', slow_down: 'slow_down', denied: 'access_denied', expired: 'expired_token' }[outcome];
      return send(res, 400, { error });
    }
    if (r.method === 'POST' && r.path === '/oauth/token' && r.form?.grant_type === 'refresh_token') {
      if (holdRefresh) { arrived(); await held; }
      if (refreshDelayMs) await new Promise((resolve) => setTimeout(resolve, refreshDelayMs));
      if (redirectRefreshTo) return send(res, 307, {}, { location: `${redirectRefreshTo}/oauth/token` });
      const outcome = refresh.length ? refresh.shift() : 'token';
      if (outcome === 'unavailable') return send(res, 503, { error: 'temporarily_unavailable' });
      if (outcome === 'invalid_request') return send(res, 400, { error: 'invalid_request' });
      if (outcome === 'throttled') return send(res, 429, { error: 'rate_limited' });
      if (outcome === 'ok_invalid_grant') return send(res, 200, { error: 'invalid_grant' });
      if (outcome === 'throttled_invalid_grant') return send(res, 429, { error: 'invalid_grant' });
      if (outcome === 'reset') return res.socket.destroy();
      if (outcome === 'no_token') return send(res, 200, { token_type: 'Bearer' });
      if (outcome === 'no_lifetime') { const { expires_in: _, ...rest } = issue({ replacing: r.form.refresh_token }); return send(res, 200, rest); }
      if (outcome === 'garbage') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>maintenance</html>'); }
      if (outcome === 'invalid_grant' || !validRefresh.has(r.form.refresh_token)) return send(res, 401, { error: 'invalid_grant' });
      return send(res, 200, issue({ replacing: r.form.refresh_token }));
    }
    if (r.method === 'POST' && r.path === '/oauth/revoke' && revocation) return send(res, 200, {});
    if (r.path.startsWith('/v1/')) {
      const bearer = /^Bearer (.+)$/.exec(r.headers.authorization ?? '')?.[1];
      if (!access.has(bearer)) return send(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid token' } }, { 'x-should-retry': 'false' });
    }
    if (r.method === 'GET' && r.path.startsWith('/v1/models')) {
      return send(res, 200, { data: [{ type: 'model', id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-01-01T00:00:00Z' }],
        has_more: false, first_id: 'claude-sonnet-5', last_id: 'claude-sonnet-5' });
    }
    if (r.method === 'POST' && r.path.startsWith('/v1/messages')) {
      if (r.path.startsWith('/v1/messages/count_tokens')) return send(res, 200, { input_tokens: 10 });
      if (!r.json?.stream) {
        return send(res, 200, { id: 'msg_fake', type: 'message', role: 'assistant', model: r.json?.model ?? 'claude-sonnet-5', content: [{ type: 'text', text: 'PONG' }],
          stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const [event, data] of SSE_PONG) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return res.end();
    }
    return send(res, 404, { type: 'error', error: { type: 'not_found_error', message: `no route ${r.method} ${r.path}` } });
  }

  return {
    origin,
    requests,
    refreshArrived,
    releaseRefresh: () => release(),
    grants: (type) => requests.filter((r) => r.path === '/oauth/token' && r.form?.grant_type === (type === 'device' ? DEVICE_GRANT : type)),
    revocations: () => requests.filter((r) => r.path === '/oauth/revoke'),
    // Every access and refresh token issued so far, and every device code.
    secrets: () => [...issued, ...requests.filter((r) => r.form?.device_code).map((r) => r.form.device_code)],
    get refreshToken() { return lastRefresh; },
    get lastAccessToken() { return [...access].at(-1) ?? null; },
    close: () => { release(); return new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }); },
  };
}
