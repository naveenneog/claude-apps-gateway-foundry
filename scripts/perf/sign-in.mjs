// Signs in to a gateway whose OIDC issuer approves at once (scripts/perf/fake-idp.mjs) and prints nothing but
// the outcome; the access token goes to the file named by --out, never to stdout (P-36).
// Run: node scripts/perf/sign-in.mjs --gateway http://127.0.0.1:18080 --out <token-file>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const form = (fields) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(), redirect: 'manual' });

// Follows redirects by hand so the gateway's cookies, set on the approval POST, reach its callback.
async function follow(response, jar) {
  let r = response;
  for (let hops = 0; hops < 10 && r.status >= 300 && r.status < 400; hops++) {
    for (const c of r.headers.getSetCookie?.() ?? []) jar.set(new URL(r.url).host, [...(jar.get(new URL(r.url).host) ?? []), c.split(';')[0]]);
    const next = new URL(r.headers.get('location'), r.url);
    r = await fetch(next, { redirect: 'manual', headers: { cookie: (jar.get(next.host) ?? []).join('; ') } });
  }
  return r;
}

export async function signIn(gateway) {
  const device = await (await fetch(`${gateway}/oauth/device_authorization`, form({}))).json();
  if (!device.device_code) throw new Error('device_authorization returned no device_code');
  const jar = new Map();
  const host = new URL(gateway).host;
  const page = await fetch(device.verification_uri_complete, { redirect: 'manual' });
  jar.set(host, (page.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]));
  const html = await page.text();
  const hidden = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]));
  const approval = form({ user_code: device.user_code, ...hidden });
  approval.headers = { ...approval.headers, cookie: jar.get(host).join('; '), origin: new URL(gateway).origin, referer: device.verification_uri_complete, 'sec-fetch-site': 'same-origin' };
  const approve = await fetch(`${gateway}/device`, approval);
  const landed = await follow(approve, jar);
  if (landed.status >= 400) throw new Error(`approval ended with ${landed.status}`);
  const deadline = Date.now() + Math.min(device.expires_in, 60) * 1000;
  while (Date.now() < deadline) {
    const r = await fetch(`${gateway}/oauth/token`, form({ grant_type: DEVICE_GRANT, device_code: device.device_code }));
    const body = await r.json().catch(() => ({}));
    if (r.ok && body.access_token) return body.access_token;
    if (body.error && body.error !== 'authorization_pending' && body.error !== 'slow_down') throw new Error(`token endpoint: ${body.error}`);
    await sleep(Math.min(1000, (device.interval ?? 5) * 1000));
  }
  throw new Error('device code expired');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { gateway: { type: 'string', default: 'http://127.0.0.1:18080' }, out: { type: 'string' } } });
  const { gateway, out } = values;
  if (!out) { console.error('--out <token-file> is required'); process.exit(2); }
  const token = await signIn(gateway);
  fs.writeFileSync(out, token, { mode: 0o600 });
  console.log(`signed in to ${gateway}; token written to ${out}`);
}
