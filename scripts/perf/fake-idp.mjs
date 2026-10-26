// A local OpenID Connect provider for load tests only (P-36). It approves every authorization request at once
// and signs RS256 id_tokens for one fixed developer, so a gateway in load_test_mode can be signed in to without
// a browser. Never point a gateway that developers use at it: anyone who reaches it signs in as that developer.
// Run: node scripts/perf/fake-idp.mjs --port 8081 [--email loadtest@contoso.com] [--groups claude-developers] [--client-id load-test]
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export async function startFakeIdp({ port = 0, host = '127.0.0.1', email = 'loadtest@contoso.com', groups = ['claude-developers'], clientId = 'load-test' } = {}) {
  if (!LOOPBACK.has(host)) throw new Error(`fake IdP listens only on a loopback address, not ${host}: anyone who reaches it signs in`);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = crypto.randomBytes(8).toString('hex');
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  const codes = new Map();
  const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
  let origin = '';

  const sign = (claims) => {
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT', kid })}.${b64(claims)}`;
    return `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
  };
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readForm = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(raw))));
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        jwks_uri: `${origin}/jwks`, userinfo_endpoint: `${origin}/userinfo`, response_types_supported: ['code'],
        subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'profile', 'email', 'offline_access'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'],
      });
    }
    if (req.method === 'GET' && url.pathname === '/jwks') return json(res, 200, { keys: [jwk] });
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const redirect = url.searchParams.get('redirect_uri');
      if (!redirect) return json(res, 400, { error: 'invalid_request' });
      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, { nonce: url.searchParams.get('nonce') ?? undefined });
      const back = new URL(redirect);
      back.searchParams.set('code', code);
      if (url.searchParams.has('state')) back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const form = await readForm(req);
      const grant = form.grant_type === 'authorization_code' ? codes.get(form.code) : form.grant_type === 'refresh_token' ? {} : null;
      if (!grant) return json(res, 400, { error: 'invalid_grant' });
      codes.delete(form.code);
      const now = Math.floor(Date.now() / 1000);
      const sub = `load-test-${crypto.createHash('sha256').update(email).digest('hex').slice(0, 16)}`;
      const idToken = sign({ iss: origin, aud: clientId, sub, email, email_verified: true, name: 'Load test', groups, roles: groups, iat: now, exp: now + 3600, nonce: grant.nonce });
      return json(res, 200, { token_type: 'Bearer', access_token: crypto.randomBytes(16).toString('hex'), id_token: idToken, refresh_token: crypto.randomBytes(16).toString('hex'), expires_in: 3600 });
    }
    return json(res, 404, { error: 'not_found' });
  });

  return new Promise((resolve) => server.listen(port, host, () => {
    origin = `http://${host}:${server.address().port}`;
    resolve({ origin, close: () => new Promise((r) => server.close(r)) });
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    port: { type: 'string', default: '8081' },
    email: { type: 'string', default: 'loadtest@contoso.com' },
    groups: { type: 'string', default: 'claude-developers' },
    'client-id': { type: 'string', default: 'load-test' },
  } });
  const idp = await startFakeIdp({ port: Number(values.port), email: values.email, groups: values.groups.split(','), clientId: values['client-id'] });
  console.log(`fake IdP at ${idp.origin}`);
}
