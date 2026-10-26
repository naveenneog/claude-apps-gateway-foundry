// P-36 harness: the fake OpenID Connect provider and the scripted device sign-in that let a gateway in
// load_test_mode be signed in to without a browser (docs/learn/how-to-load-test-and-size.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { startFakeIdp } from '../scripts/perf/fake-idp.mjs';
import { signIn } from '../scripts/perf/sign-in.mjs';

const tokenRequest = (origin, fields) => fetch(`${origin}/token`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(),
});

test('P-36 fake IdP issues a signed id_token carrying the email, roles and nonce, once per code', async () => {
  const idp = await startFakeIdp({ email: 'dev@contoso.com', groups: ['Gateway.Standard'], clientId: 'lt' });
  try {
    const disco = await (await fetch(`${idp.origin}/.well-known/openid-configuration`)).json();
    assert.equal(disco.issuer, idp.origin);
    const auth = await fetch(`${idp.origin}/authorize?redirect_uri=${encodeURIComponent('http://127.0.0.1:1/cb')}&state=s1&nonce=n1`, { redirect: 'manual' });
    assert.equal(auth.status, 302);
    const back = new URL(auth.headers.get('location'));
    assert.equal(back.searchParams.get('state'), 's1');
    const code = back.searchParams.get('code');
    const tokens = await (await tokenRequest(idp.origin, { grant_type: 'authorization_code', code })).json();
    const [h, p, s] = tokens.id_token.split('.');
    const { keys: [jwk] } = await (await fetch(disco.jwks_uri)).json();
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url')));
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    assert.equal(claims.iss, idp.origin);
    assert.equal(claims.aud, 'lt');
    assert.equal(claims.email, 'dev@contoso.com');
    assert.deepEqual(claims.roles, ['Gateway.Standard']);
    assert.equal(claims.nonce, 'n1');
    const again = await tokenRequest(idp.origin, { grant_type: 'authorization_code', code });
    assert.equal(again.status, 400);
    const noRedirect = await fetch(`${idp.origin}/authorize`, { redirect: 'manual' });
    assert.equal(noRedirect.status, 400);
  } finally { await idp.close(); }
});

test('P-36 fake IdP listens only on a loopback address', async () => {
  for (const host of ['0.0.0.0', '::']) {
    let idp;
    try { idp = await startFakeIdp({ host }); } catch (e) { assert.match(e.message, /loopback/); continue; }
    await idp.close();
    assert.fail(`the fake IdP listened on ${host}`);
  }
});

// A stand-in for the gateway's device flow: a verification page that sets a cookie and a hidden CSRF field,
// an approval POST that checks both plus Origin, and a token endpoint that is pending once.
function fakeGateway() {
  const seen = { approval: null, polls: 0 };
  const server = http.createServer((req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const f = Object.fromEntries(new URLSearchParams(body));
      if (req.url === '/oauth/device_authorization') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ device_code: 'dc', user_code: 'UC-1', verification_uri_complete: `${origin}/device?user_code=UC-1`, expires_in: 30, interval: 0 }));
      }
      if (req.method === 'GET' && req.url.startsWith('/device')) {
        res.writeHead(200, { 'set-cookie': 'csrf=c1; HttpOnly', 'content-type': 'text/html' });
        return res.end('<form><input type="hidden" name="csrf" value="h1"></form>');
      }
      if (req.method === 'POST' && req.url === '/device') {
        seen.approval = { cookie: req.headers.cookie, origin: req.headers.origin, site: req.headers['sec-fetch-site'], form: f };
        const okay = req.headers.cookie === 'csrf=c1' && f.csrf === 'h1' && req.headers.origin === origin;
        res.writeHead(okay ? 302 : 403, okay ? { location: '/done', 'set-cookie': 'sess=1' } : {});
        return res.end();
      }
      if (req.url === '/done') { res.writeHead(req.headers.cookie?.includes('sess=1') ? 200 : 401); return res.end('ok'); }
      if (req.url === '/oauth/token') {
        seen.polls += 1;
        res.writeHead(seen.polls === 1 ? 400 : 200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(seen.polls === 1 ? { error: 'authorization_pending' } : { access_token: 'gw-token' }));
      }
      res.writeHead(404); res.end();
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((c) => server.close(c)) })));
}

test('P-36 scripted sign-in sends the page cookie, hidden fields and Origin, then polls past authorization_pending', async () => {
  const gw = await fakeGateway();
  try {
    assert.equal(await signIn(gw.url), 'gw-token');
    assert.equal(gw.seen.approval.cookie, 'csrf=c1');
    assert.equal(gw.seen.approval.form.csrf, 'h1');
    assert.equal(gw.seen.approval.form.user_code, 'UC-1');
    assert.equal(gw.seen.approval.site, 'same-origin');
    assert.equal(gw.seen.polls, 2);
  } finally { await gw.close(); }
});
