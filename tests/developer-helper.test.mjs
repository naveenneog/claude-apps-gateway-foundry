// T-49 (docs/TEST-PLAN.md): Get-ClaudeGatewayToken.ps1, the apiKeyHelper of the developer profile (ADR-0004), run in
// Windows PowerShell 5.1 against the loopback fake gateway (tests/developer/).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runProgramAsync } from '../infra/azure-test/lib/spawn.mjs';
import { END_MARKER, collectEventLog, connect, gateway, getToken, localAppData, runScript, sandbox, scripts, sessionFiles, skip, startScript, unprotect, windowsPowerShell } from './developer/harness.mjs';

const signInNamed = (origin) => new RegExp(`Connect-ClaudeGateway\\.ps1.*-GatewayUrl ${origin.replace(/[.]/g, '\\.')}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, what, ms = 60_000) {
  for (const end = Date.now() + ms; !condition(); await sleep(100)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}

async function signedIn(t, script) {
  const fake = await gateway(t, script);
  const local = localAppData(t);
  const r = await connect(fake, local);
  assert.equal(r.status, 0, r.stderr);
  return { fake, local };
}

test('T-49 prints the cached access token, and only that, with no request while more than five minutes remain', { skip }, async (t) => {
  const { fake, local } = await signedIn(t);
  const before = fake.requests.length;
  const r = await getToken(fake, local);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, fake.lastAccessToken);
  assert.equal(r.stderr, '');
  assert.equal(fake.requests.length, before, 'no request to the gateway');
});

test('T-49 refreshes when fewer than five minutes remain and stores the rotated refresh token', { skip }, async (t) => {
  const { fake, local } = await signedIn(t, { expiresIn: [240, 3600] });
  const firstRefresh = fake.refreshToken;
  const r = await getToken(fake, local);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, fake.lastAccessToken);
  const [grant, ...more] = fake.grants('refresh_token');
  assert.equal(more.length, 0);
  assert.equal(grant.form.refresh_token, firstRefresh);
  const session = await unprotect(sessionFiles(local)[0], fake.origin);
  assert.equal(session.refreshToken, fake.refreshToken);
  assert.notEqual(session.refreshToken, firstRefresh);
  const again = await getToken(fake, local);
  assert.equal(again.stdout, fake.lastAccessToken);
  assert.equal(fake.grants('refresh_token').length, 1, 'the refreshed token is cached');
});

test('T-49 invalid_grant deletes the session, names the sign-in command on stderr and exits 1', { skip }, async (t) => {
  const { fake, local } = await signedIn(t, { expiresIn: 240, refresh: ['invalid_grant'] });
  const r = await getToken(fake, local);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /invalid_grant/);
  assert.match(r.stderr, signInNamed(fake.origin));
  assert.deepEqual(sessionFiles(local), []);
});

for (const [outcome, shown] of [['unavailable', /HTTP 503/], ['reset', /Could not reach/], ['no_token', /without an access token/],
  ['no_lifetime', /without an access token and a valid expires_in/], ['garbage', /without an access token/]]) {
  test(`T-49 a refresh answered with ${outcome} keeps the session and serves the unexpired token`, { skip }, async (t) => {
    const { fake, local } = await signedIn(t, { expiresIn: 240, refresh: [outcome] });
    const current = fake.lastAccessToken;
    const r = await getToken(fake, local);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, current);
    assert.match(r.stderr, shown);
    assert.equal(sessionFiles(local).length, 1);
    assert.equal((await unprotect(sessionFiles(local)[0], fake.origin)).accessToken, current);
  });
}

test('T-49 a failed refresh with an expired token exits 1 without a token and keeps the session', { skip }, async (t) => {
  const { fake, local } = await signedIn(t, { expiresIn: 1, refresh: ['reset'] });
  const r = await getToken(fake, local);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  // A new sign-in does not help while the gateway does not answer (UX review, round 4).
  assert.match(r.stderr, /The session is kept: run the command again when the gateway answers\./);
  assert.doesNotMatch(r.stderr, /Connect-ClaudeGateway\.ps1/);
  for (const secret of fake.secrets()) assert.equal(r.stderr.includes(secret), false, 'a token is in the message');
  assert.equal(sessionFiles(local).length, 1, 'a failure that is not invalid_grant keeps the session');
});

// The gateway answered, but with no usable token and no invalid_grant refusal: waiting for an answer does not help, and
// a new sign-in is not the fix either (UX review, round 5). An invalid_grant body counts only with an HTTP 4xx status
// other than 429 (UX review, round 6).
for (const [outcome, status] of [['no_token', 'HTTP 200 without an access token and a valid expires_in'], ['unavailable', 'HTTP 503'], ['throttled', 'HTTP 429'],
  ['ok_invalid_grant', 'HTTP 200 without an access token and a valid expires_in'], ['throttled_invalid_grant', 'HTTP 429']]) {
  test(`T-49 a refresh answered with ${outcome} after the token expired names the gateway operator and keeps the session`, { skip }, async (t) => {
    const { fake, local } = await signedIn(t, { expiresIn: 1, refresh: [outcome] });
    const r = await getToken(fake, local);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, new RegExp(`The refresh failed \\(${status}\\) and the saved token has expired\\. The session is kept: run the command again, and ask the gateway operator to check the gateway's log when it repeats\\.`));
    assert.doesNotMatch(r.stderr, /Connect-ClaudeGateway\.ps1/);
    for (const secret of fake.secrets()) assert.equal(r.stderr.includes(secret), false, 'a token is in the message');
    assert.equal(sessionFiles(local).length, 1);
  });
}

// Another refusal than invalid_grant: how the gateway refuses a dead refresh token is open (U-48), so the message names
// the sign-in command, and the session is kept (Coder review, round 5).
test('T-49 a refresh refused with HTTP 400 after the token expired names the sign-in command and keeps the session', { skip }, async (t) => {
  const { fake, local } = await signedIn(t, { expiresIn: 1, refresh: ['invalid_request'] });
  const r = await getToken(fake, local);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /The gateway refused the refresh token \(HTTP 400\) and the saved token has expired\. The session is kept\. To sign in again, run: /);
  assert.match(r.stderr, signInNamed(fake.origin));
  for (const secret of fake.secrets()) assert.equal(r.stderr.includes(secret), false, 'a token is in the message');
  assert.equal(sessionFiles(local).length, 1);
});

test('T-49 a refresh answer without a refresh token keeps the saved one', { skip }, async (t) => {
  const { fake, local } = await signedIn(t, { expiresIn: [240, 240, 3600], rotate: false });
  const original = fake.refreshToken;
  assert.equal((await getToken(fake, local)).status, 0);
  const second = await getToken(fake, local);
  assert.equal(second.status, 0, second.stderr);
  const grants = fake.grants('refresh_token');
  assert.equal(grants.length, 2);
  assert.equal(grants[1].form.refresh_token, original);
  assert.equal(second.stdout, fake.lastAccessToken);
});

test('T-49 a session without a refresh token is served until it expires, then deleted', { skip }, async (t) => {
  const { fake, local } = await signedIn(t, { expiresIn: 240, issueRefreshToken: false });
  const r = await getToken(fake, local);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, fake.lastAccessToken);
  assert.match(r.stderr, /no refresh token/);
  assert.equal(fake.grants('refresh_token').length, 0);
  const short = await signedIn(t, { expiresIn: 1, issueRefreshToken: false });
  const late = await getToken(short.fake, short.local);
  assert.equal(late.status, 1);
  assert.equal(late.stdout, '');
  assert.match(late.stderr, /Connect-ClaudeGateway\.ps1/);
  assert.deepEqual(sessionFiles(short.local), []);
});

test('T-49 a second process waits on the lock and uses the first one\'s refresh', { skip }, async (t) => {
  const { fake, local } = await signedIn(t, { expiresIn: [240, 3600], holdRefresh: true });
  const first = getToken(fake, local);
  await fake.refreshArrived;
  const second = startScript(path.join(scripts, 'Get-ClaudeGatewayToken.ps1'), ['-GatewayUrl', fake.origin], { LOCALAPPDATA: local, ANTHROPIC_BASE_URL: fake.origin });
  // The second process says when it finds the lock taken, so the test knows it is contending before the release.
  await until(() => second.stderr().includes('Waiting for the session lock'), 'the second process to wait for the lock', 30_000);
  assert.equal(fake.grants('refresh_token').length, 1, 'the second process sent no refresh while the first held the lock');
  fake.releaseRefresh();
  const [a, b] = await Promise.all([first, second.done]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(fake.grants('refresh_token').length, 1);
  assert.equal(a.stdout, fake.lastAccessToken);
  assert.equal(b.stdout, fake.lastAccessToken);
});

for (const outcome of ['token', 'invalid_grant']) {
  test(`T-49 a sign-in during a refresh that ends in ${outcome} keeps the new session`, { skip }, async (t) => {
    const { fake, local } = await signedIn(t, { expiresIn: [240, 3600, 3600], holdRefresh: true, refresh: [outcome] });
    const refreshing = getToken(fake, local);
    await fake.refreshArrived;
    const reconnect = startScript(path.join(scripts, 'Connect-ClaudeGateway.ps1'), ['-GatewayUrl', fake.origin, '-NoBrowser', '-Force'], { LOCALAPPDATA: local });
    // The sign-in says when it finds the lock taken; only then is the refresh released, so a sign-in that ignored the
    // lock would already have saved, and fails this wait.
    await until(() => reconnect.stderr().includes('Waiting for the session lock'), 'the sign-in to wait for the lock', 30_000);
    const newest = fake.lastAccessToken;
    fake.releaseRefresh();
    const [helper, signIn] = await Promise.all([refreshing, reconnect.done]);
    assert.equal(signIn.status, 0, signIn.stderr);
    assert.equal(helper.status, outcome === 'token' ? 0 : 1, helper.stderr);
    const [file] = sessionFiles(local);
    assert.ok(file, 'a session remains');
    assert.equal((await unprotect(file, fake.origin)).accessToken, newest, 'the session is the one the sign-in saved');
  });
}

test('T-49 a refresh saves the rotated token while another process has the session file open for reading', { skip }, async (t) => {
  const { fake, local } = await signedIn(t, { expiresIn: [240, 3600], holdRefresh: true });
  const file = sessionFiles(local)[0];
  const refreshing = getToken(fake, local);
  await fake.refreshArrived;
  // Opened with FileShare.Read only, as File.ReadAllBytes opens it, for two seconds.
  const mark = `${sandbox(t)}\\open`;
  const reader = runProgramAsync(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-Command',
    "$s = [IO.File]::Open($env:CGW_FILE, 'Open', 'Read', 'Read'); New-Item -ItemType File -Path $env:CGW_MARK | Out-Null; Start-Sleep -Seconds 2; $s.Dispose()"],
  { env: { ...process.env, CGW_FILE: file, CGW_MARK: mark }, timeoutMs: 60_000 });
  await until(() => fs.existsSync(mark), 'the reader to open the session file');
  fake.releaseRefresh();
  const [r] = await Promise.all([refreshing, reader]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, fake.lastAccessToken);
  assert.equal((await unprotect(file, fake.origin)).refreshToken, fake.refreshToken, 'the rotated refresh token was saved');
});

test('T-49 a refreshed session that cannot be saved exits 1 without the sign-in command, which saves the same way', { skip }, async (t) => {
  const { fake, local } = await signedIn(t, { expiresIn: [240, 3600], holdRefresh: true });
  const file = sessionFiles(local)[0];
  const refreshing = getToken(fake, local);
  await fake.refreshArrived;
  // Opened with FileShare.Read for ten seconds, longer than the save's five seconds of retries (Architect review, round 5).
  const mark = `${sandbox(t)}\\open`;
  const reader = runProgramAsync(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-Command',
    "$s = [IO.File]::Open($env:CGW_FILE, 'Open', 'Read', 'Read'); New-Item -ItemType File -Path $env:CGW_MARK | Out-Null; Start-Sleep -Seconds 10; $s.Dispose()"],
  { env: { ...process.env, CGW_FILE: file, CGW_MARK: mark }, timeoutMs: 60_000 });
  await until(() => fs.existsSync(mark), 'the reader to open the session file');
  fake.releaseRefresh();
  const [r] = await Promise.all([refreshing, reader]);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^Get-ClaudeGatewayToken: /);
  assert.doesNotMatch(r.stderr, /Connect-ClaudeGateway\.ps1/);
  for (const secret of fake.secrets()) assert.equal(r.stderr.includes(secret), false, 'a token is in the message');
});

test('T-49 no saved session names the sign-in command', { skip }, async (t) => {
  const fake = await gateway(t);
  const r = await getToken(fake, localAppData(t));
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, new RegExp(`No saved session for ${fake.origin.replace(/[.]/g, '\\.')}\\. To sign in again, run: `));
  assert.match(r.stderr, signInNamed(fake.origin));
});

test('T-49 a session file that cannot be decrypted names the sign-in command, and signing in again replaces it', { skip }, async (t) => {
  const { fake, local } = await signedIn(t);
  fs.writeFileSync(sessionFiles(local)[0], 'not a DPAPI blob');
  const r = await getToken(fake, local);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /cannot be read by this Windows user/);
  assert.match(r.stderr, signInNamed(fake.origin));
  assert.equal((await connect(fake, local)).status, 0);
  assert.equal((await getToken(fake, local)).stdout, fake.lastAccessToken);
});

test('T-49 a lock held past the timeout serves a token that is still valid, and nothing once it has expired', { skip }, async (t) => {
  const { fake, local } = await signedIn(t, { expiresIn: 240 });
  const lock = fs.openSync(`${sessionFiles(local)[0]}.lock`, 'w');
  t.after(() => fs.closeSync(lock));
  const r = await getToken(fake, local, { CLAUDE_GATEWAY_LOCK_TIMEOUT_SECONDS: '2' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, fake.lastAccessToken);
  assert.match(r.stderr, /has held .* for 2 seconds/);
  assert.equal(fake.grants('refresh_token').length, 0);
  const expired = await signedIn(t, { expiresIn: 1 });
  const held = fs.openSync(`${sessionFiles(expired.local)[0]}.lock`, 'w');
  t.after(() => fs.closeSync(held));
  const late = await getToken(expired.fake, expired.local, { CLAUDE_GATEWAY_LOCK_TIMEOUT_SECONDS: '2' });
  assert.equal(late.status, 1);
  assert.equal(late.stdout, '');
  assert.match(late.stderr, /has held .* for 2 seconds\. Wait for the other Claude Code or helper process to finish, or close it, then run the command again\./);
  assert.doesNotMatch(late.stderr, /Connect-ClaudeGateway\.ps1/, 'a new sign-in does not release the lock');
});

test('T-49 a redirect from the token endpoint is not followed, so the refresh token stays on the gateway origin', { skip }, async (t) => {
  const target = await gateway(t);
  const { fake, local } = await signedIn(t, { expiresIn: 240, redirectRefreshTo: target.origin });
  const r = await getToken(fake, local);
  assert.equal(target.requests.length, 0, 'nothing reached the redirect target');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, fake.lastAccessToken);
  assert.match(r.stderr, /HTTP 307/);
});

test('T-49 with PowerShell pipeline logging on, no token or device code reaches the event log', { skip }, async (t) => {
  const { fake, local } = { fake: await gateway(t, { expiresIn: [240, 3600] }), local: localAppData(t) };
  const out = path.join(sandbox(t), 'events.txt');
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  // Only this process's events, up to its end marker: the log is machine-wide, parallel runs write to it too (QA review,
  // round 3), and it delivers asynchronously (round 4).
  const command = [
    '$start = Get-Date',
    "foreach ($n in 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Security') { $m = Get-Module $n; if (-not $m) { $m = Import-Module $n -PassThru -ErrorAction SilentlyContinue }; if ($m) { $m.LogPipelineExecutionDetails = $true } }",
    `$g = Import-Module ${q(path.join(scripts, 'ClaudeGateway.psm1'))} -DisableNameChecking -PassThru; $g.LogPipelineExecutionDetails = $true`,
    `& ${q(path.join(scripts, 'Connect-ClaudeGateway.ps1'))} -GatewayUrl ${fake.origin} -NoBrowser -Force | Out-Null`,
    `& ${q(path.join(scripts, 'Get-ClaudeGatewayToken.ps1'))} -GatewayUrl ${fake.origin} | Out-Null`,
    ...collectEventLog(out),
  ].join('; ');
  const r = await runProgramAsync(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { env: { ...process.env, LOCALAPPDATA: local, ANTHROPIC_BASE_URL: fake.origin }, timeoutMs: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fake.grants('refresh_token').length, 1, 'the run refreshed the token');
  const log = fs.readFileSync(out, 'utf8');
  assert.match(log, END_MARKER, 'the event log delivered the run\'s events, up to its end marker, within 60 seconds');
  assert.match(log, /ParameterBinding\(Get-JsonValue\)/, 'the event log recorded the module functions, so the check measured something');
  for (const secret of fake.secrets()) assert.equal(log.includes(secret), false, 'a token or device code is in the PowerShell event log');
});

test('T-49 the token is printed only when ANTHROPIC_BASE_URL names the gateway, so not when it is unset or empty', { skip }, async (t) => {
  const { fake, local } = await signedIn(t);
  // Unset or empty, Claude Code sends the token to api.anthropic.com; a project's settings can set the empty value.
  const unset = await runScript(path.join(scripts, 'Get-ClaudeGatewayToken.ps1'), ['-GatewayUrl', fake.origin], { LOCALAPPDATA: local });
  assert.equal(unset.status, 1);
  assert.equal(unset.stdout, '');
  assert.match(unset.stderr, /ANTHROPIC_BASE_URL is empty or not set, so Claude Code would send the token to https:\/\/api\.anthropic\.com/);
  const empty = await getToken(fake, local, { ANTHROPIC_BASE_URL: '' });
  assert.equal(empty.status, 1);
  assert.equal(empty.stdout, '');
  const elsewhere = await getToken(fake, local, { ANTHROPIC_BASE_URL: 'https://collector.contoso.example' });
  assert.equal(elsewhere.status, 1);
  assert.equal(elsewhere.stdout, '');
  assert.match(elsewhere.stderr, /ANTHROPIC_BASE_URL is https:\/\/collector\.contoso\.example, not .*, so the token is not printed/);
  const unparsable = await getToken(fake, local, { ANTHROPIC_BASE_URL: 'not a url' });
  assert.equal(unparsable.status, 1);
  assert.equal(unparsable.stdout, '');
  const own = await getToken(fake, local, { ANTHROPIC_BASE_URL: `${fake.origin}/` });
  assert.equal(own.stdout, fake.lastAccessToken, own.stderr);
  const relay = await runScript(path.join(scripts, 'Get-ClaudeGatewayToken.ps1'), ['-GatewayUrl', fake.origin, '-ExpectedBaseUrl', 'http://127.0.0.1:9'],
    { LOCALAPPDATA: local, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' });
  assert.equal(relay.stdout, fake.lastAccessToken, relay.stderr);
});

// With a provider switch on, Claude Code sends the helper's output to that provider's base URL, not ANTHROPIC_BASE_URL
// (https://code.claude.com/docs/en/env-vars).
test('T-49 the token is not printed while a provider switch is set', { skip }, async (t) => {
  const { fake, local } = await signedIn(t);
  for (const name of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE']) {
    const r = await getToken(fake, local, { [name]: '1' });
    assert.equal(r.status, 1, name);
    assert.equal(r.stdout, '', name);
    assert.match(r.stderr, new RegExp(`${name} is set, so Claude Code would send the token to that provider's endpoint`));
  }
  assert.equal((await getToken(fake, local, { CLAUDE_CODE_USE_BEDROCK: '' })).stdout, fake.lastAccessToken, 'an empty switch is off');
});
test('T-49 with no saved session the helper names the sign-in command and exits 1', { skip }, async (t) => {
  const fake = await gateway(t);
  const r = await getToken(fake, localAppData(t));
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, signInNamed(fake.origin));
  assert.equal(fake.requests.length, 0);
});
