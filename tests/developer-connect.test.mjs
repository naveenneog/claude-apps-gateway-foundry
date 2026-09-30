// T-48 (docs/TEST-PLAN.md): Connect-ClaudeGateway.ps1 and Disconnect-ClaudeGateway.ps1 (ADR-0004), run in Windows
// PowerShell 5.1 against the loopback fake gateway (tests/developer/).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { runProgramAsync } from '../infra/azure-test/lib/spawn.mjs';
import {
  assertUserScopedDpapi, connect, gateway, getToken, holds, localAppData, pwsh, runScript, runWithRecordedStartProcess,
  sandbox, scripts, sessionFiles, skip, unprotect, windowsPowerShell,
} from './developer/harness.mjs';

const disconnect = (fake, local) => runScript(path.join(scripts, 'Disconnect-ClaudeGateway.ps1'), ['-GatewayUrl', fake.origin], { LOCALAPPDATA: local });
const retryNamed = /To sign in, run: .*Connect-ClaudeGateway\.ps1.* -GatewayUrl http:\/\/127\.0\.0\.1:\d+/;

test('T-48 device flow: prints the verification URL, polls to a token and stores the session under user DPAPI', { skip }, async (t) => {
  const fake = await gateway(t, { device: ['pending', 'token'] });
  const local = localAppData(t);
  const r = await connect(fake, local);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, new RegExp(`${fake.origin}/device\\?user_code=WDJB-MJHT`));
  assert.match(r.stdout, /dev@contoso\.example/);
  assert.equal(fake.grants('device').length, 2);
  const [file, ...others] = sessionFiles(local);
  assert.equal(others.length, 0);
  const bytes = fs.readFileSync(file);
  assertUserScopedDpapi(bytes);
  assert.equal(holds(bytes, fake.refreshToken) || holds(bytes, fake.lastAccessToken), false, 'no token in the clear');
  const session = await unprotect(file, fake.origin);
  assert.equal(session.refreshToken, fake.refreshToken);
  assert.equal(session.accessToken, fake.lastAccessToken);
  assert.equal(session.tokenEndpoint, `${fake.origin}/oauth/token`);
});

test('T-48 without -NoBrowser the verification URL is opened', { skip }, async (t) => {
  const fake = await gateway(t);
  const local = localAppData(t);
  const record = path.join(sandbox(t), 'opened.txt');
  const r = await runWithRecordedStartProcess(path.join(scripts, 'Connect-ClaudeGateway.ps1'), ['-GatewayUrl', fake.origin, '-Force'], { LOCALAPPDATA: local }, record);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(record, 'utf8').trim(), `${fake.origin}/device?user_code=WDJB-MJHT`);
  assert.equal(sessionFiles(local).length, 1);
});

test('T-48 the parsed verification URL is shown and opened, not the raw string the gateway sent', { skip }, async (t) => {
  const fake = await gateway(t, { deviceAnswer: (origin) => ({ verification_uri_complete: `${origin}/device?user_code=WDJB-MJHT" --incognito` }) });
  const record = path.join(sandbox(t), 'opened.txt');
  const r = await runWithRecordedStartProcess(path.join(scripts, 'Connect-ClaudeGateway.ps1'), ['-GatewayUrl', fake.origin, '-Force'], { LOCALAPPDATA: localAppData(t) }, record);
  assert.equal(r.status, 0, r.stderr);
  const opened = fs.readFileSync(record, 'utf8').trim();
  assert.equal(opened, `${fake.origin}/device?user_code=WDJB-MJHT%22%20--incognito`);
  assert.doesNotMatch(r.stdout, /" --incognito/);
});
test('T-48 slow_down adds five seconds to the poll interval', { skip }, async (t) => {
  const fake = await gateway(t, { device: ['slow_down', 'token'] });
  const r = await connect(fake, localAppData(t));
  assert.equal(r.status, 0, r.stderr);
  const [first, second] = fake.grants('device');
  assert.ok(second.at - first.at >= 5900, `second poll ${second.at - first.at} ms after the first`);
});

for (const [outcome, error] of [['denied', 'access_denied'], ['expired', 'expired_token']]) {
  test(`T-48 ${error} stops the sign-in with exit code 1, names the command to start again and stores nothing`, { skip }, async (t) => {
    const fake = await gateway(t, { device: [outcome] });
    const local = localAppData(t);
    const r = await connect(fake, local);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(error));
    assert.match(r.stderr, retryNamed);
    assert.equal(fake.grants('device').length, 1, 'no poll after a terminal error');
    assert.deepEqual(sessionFiles(local), []);
  });
}

for (const [label, script, polls] of [
  ['a device answer without expires_in', { deviceAnswer: { expires_in: undefined } }, 0],
  ['a device answer with expires_in 0', { deviceAnswer: { expires_in: 0 } }, 0],
  ['a device answer with expires_in as a string', { deviceAnswer: { expires_in: '600' } }, 0],
  ['a token answer without expires_in', { tokenAnswer: { expires_in: undefined } }, 1],
  ['a token answer with expires_in 0', { tokenAnswer: { expires_in: 0 } }, 1],
  ['a token answer with a negative expires_in', { tokenAnswer: { expires_in: -5 } }, 1],
  ['a token answer with expires_in as a string', { tokenAnswer: { expires_in: '3600' } }, 1],
  ['a token answer without access_token', { tokenAnswer: { access_token: undefined } }, 1],
]) {
  test(`T-48 ${label} stops the sign-in with exit code 1 and stores nothing`, { skip }, async (t) => {
    const fake = await gateway(t, script);
    const local = localAppData(t);
    const r = await connect(fake, local);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /expires_in|access_token/);
    assert.equal(fake.grants('device').length, polls);
    assert.deepEqual(sessionFiles(local), []);
  });
}

for (const foreign of ['token', 'verification', 'revocation']) {
  test(`T-48 a ${foreign} endpoint on another origin is refused before any code is shown or polled`, { skip }, async (t) => {
    const fake = await gateway(t, { foreign });
    const local = localAppData(t);
    const r = await connect(fake, local);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /origin/i);
    assert.doesNotMatch(r.stdout, /WDJB-MJHT/);
    assert.equal(fake.grants('device').length, 0);
    assert.deepEqual(sessionFiles(local), []);
  });
}

test('T-48 without -Force the named account must be confirmed, so a non-interactive sign-in stores nothing', { skip }, async (t) => {
  const fake = await gateway(t);
  const local = localAppData(t);
  const r = await connect(fake, local, []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /dev@contoso\.example/);
  assert.deepEqual(sessionFiles(local), []);
  const unnamed = await gateway(t, { email: null });
  assert.equal((await connect(unnamed, local, [])).status, 0, 'no account named, nothing to confirm');
  assert.equal(sessionFiles(local).length, 1);
});

test('T-48 a gateway that cannot be reached is reported with the proxy settings the scripts use', { skip }, async (t) => {
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const r = await connect({ origin: `http://127.0.0.1:${port}` }, localAppData(t));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Could not reach .*Windows proxy settings .*do not read HTTPS_PROXY/);
});

test('T-48 an IPv6 loopback session saved by PowerShell 7 is served by Windows PowerShell 5.1', { skip: skip || (!fs.existsSync(pwsh) && 'pwsh 7 not installed') }, async (t) => {
  const fake = await gateway(t, { host: '::1' });
  const local = localAppData(t);
  const r = await connect(fake, local, ['-Force'], pwsh);
  assert.equal(r.status, 0, r.stderr);
  const served = await getToken(fake, local);
  assert.equal(served.stdout, fake.lastAccessToken, served.stderr);
});

test('T-48 Disconnect revokes the access and refresh tokens when the gateway advertises revocation, then deletes the session', { skip }, async (t) => {
  const fake = await gateway(t, { revocation: true });
  const local = localAppData(t);
  assert.equal((await connect(fake, local)).status, 0);
  const [access, refresh] = [fake.lastAccessToken, fake.refreshToken];
  const r = await disconnect(fake, local);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fake.revocations().map((q) => q.form), [{ token: access }, { token: refresh, token_type_hint: 'refresh_token' }]);
  assert.deepEqual(sessionFiles(local), []);
  const again = await disconnect(fake, local);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /No saved session/);
});

test('T-48 Disconnect without a revocation endpoint, or with an unreadable session, deletes the session and sends no token', { skip }, async (t) => {
  const plain = await gateway(t);
  const local = localAppData(t);
  assert.equal((await connect(plain, local)).status, 0);
  assert.equal((await disconnect(plain, local)).status, 0);
  assert.deepEqual(sessionFiles(local), []);
  const revoking = await gateway(t, { revocation: true });
  assert.equal((await connect(revoking, local)).status, 0);
  fs.writeFileSync(sessionFiles(local)[0], 'not a DPAPI blob');
  const r = await disconnect(revoking, local);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /cannot be read/);
  assert.equal(revoking.revocations().length, 0);
  assert.deepEqual(sessionFiles(local), []);
});

test('T-48 the developer scripts are ASCII, which Windows PowerShell 5.1 reads without a byte order mark', { skip }, () => {
  const files = fs.readdirSync(scripts).filter((f) => /\.(ps1|psm1|cmd)$/.test(f));
  assert.ok(files.length >= 5, `scripts in ${scripts}`);
  for (const f of files) assert.equal(/[^\x00-\x7f]/.test(fs.readFileSync(path.join(scripts, f), 'latin1')), false, `${f} has a non-ASCII byte`);
});

test('T-48 the tests drive Windows PowerShell 5.1', { skip }, async () => {
  const r = await runProgramAsync(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { timeoutMs: 60_000 });
  assert.match(r.stdout.trim(), /^5\.1\./);
});
