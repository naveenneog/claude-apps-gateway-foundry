// T-54 (docs/TEST-PLAN.md): scripts/admin/new-client-policy.mjs writes the client-side payloads (ADR-0004): the
// managed settings that send Claude Code's /login to the gateway, as a file, a Windows HKLM .reg and a macOS
// configuration profile, and a developer bundle for the apiKeyHelper profile of scripts/developer/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runProgramAsync } from '../infra/azure-test/lib/spawn.mjs';
import { runCmd, skip as windowsSkip, windowsPowerShell } from './developer/harness.mjs';
import { partsInOrder, scriptMessages } from './message-rules.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'admin', 'new-client-policy.mjs');
const URL_OK = 'https://claude-gateway.corp.contoso.example';
const SETTINGS = { forceLoginMethod: 'gateway', forceLoginGatewayUrl: URL_OK, parentSettingsBehavior: 'merge' };

function outDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'out');
}
const policy = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
const read = (dir, file) => fs.readFileSync(path.join(dir, file));
const login = (out) => path.join(out, 'login');
const runtimeFiles = () => fs.readdirSync(path.join(root, 'scripts', 'developer')).filter((f) => /\.(ps1|psm1)$/.test(f)).sort();

test('T-54 writes managed-settings.json, an HKLM .reg and a .mobileconfig with the gateway login keys', (t) => {
  const out = outDir(t);
  const r = policy(['--gateway-url', `${URL_OK}/`, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(read(login(out), 'managed-settings.json')), SETTINGS);

  const reg = read(login(out), 'ClaudeCode-HKLM.reg');
  assert.deepEqual([...reg.subarray(0, 2)], [0xff, 0xfe], 'UTF-16LE byte order mark, as regedit writes');
  const lines = reg.subarray(2).toString('utf16le').split('\r\n');
  assert.equal(lines[0], 'Windows Registry Editor Version 5.00');
  assert.ok(lines.includes('[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode]'));
  const value = lines.find((l) => l.startsWith('"Settings"="'));
  assert.ok(value, 'a Settings value');
  assert.match(value, /^"Settings"="(?:[^"\\]|\\.)*"$/, 'every quote and backslash inside the value is escaped, as regedit requires');
  assert.deepEqual(JSON.parse(value.slice('"Settings"="'.length, -1).replace(/\\(.)/g, '$1')), SETTINGS);

  const profile = read(login(out), 'ClaudeCode.mobileconfig').toString('utf8');
  assert.match(profile, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
  assert.match(profile, /<key>PayloadType<\/key>\s*<string>com\.anthropic\.claudecode<\/string>/);
  for (const [key, text] of Object.entries(SETTINGS)) assert.match(profile, new RegExp(`<key>${key}</key>\\s*<string>${text.replace(/[.]/g, '\\.')}</string>`));
  assert.match(r.stdout, /private address/);
});

test('T-54 the payloads are the same bytes on every run, so an MDM sees no change', (t) => {
  const a = outDir(t);
  const b = outDir(t);
  assert.equal(policy(['--gateway-url', URL_OK, '--out', a]).status, 0);
  assert.equal(policy(['--gateway-url', URL_OK, '--out', b]).status, 0);
  for (const f of ['managed-settings.json', 'ClaudeCode-HKLM.reg', 'ClaudeCode.mobileconfig']) assert.ok(read(login(a), f).equals(read(login(b), f)), f);
});

test('T-54 the developer bundle holds the developer scripts and a START-HERE with the prerequisites, the commands to run from the folder and the recovery', (t) => {
  const out = outDir(t);
  const r = policy(['--gateway-url', URL_OK, '--fast-model', 'claude-sonnet-5', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const files = runtimeFiles();
  assert.ok(files.length >= 5 && files.includes('Disconnect-ClaudeGateway.ps1'), files.join(', '));
  for (const f of files) assert.ok(read(path.join(out, 'developer'), f).equals(fs.readFileSync(path.join(root, 'scripts', 'developer', f))), f);
  const start = read(path.join(out, 'developer'), 'START-HERE.txt').toString('utf8');
  const lines = start.split('\r\n');
  const command = (name, args = `-GatewayUrl ${URL_OK}`) => `   powershell -NoProfile -ExecutionPolicy Bypass -File .\\${name} ${args}`;
  assert.ok(lines.includes(command('Install-ClaudeGatewayProfile.ps1', `-GatewayUrl ${URL_OK} -FastModel claude-sonnet-5`)), start);
  assert.ok(lines.includes('   & "$env:USERPROFILE\\.claude-apps-gateway\\claude-gateway.cmd"'), 'the launcher, with PowerShell\'s call operator');
  for (const name of ['Connect-ClaudeGateway.ps1', 'Disconnect-ClaudeGateway.ps1']) assert.ok(lines.includes(command(name)), `${name} from this folder`);
  const flat = start.replace(/\r\n\s*/g, ' ');
  assert.match(flat, /under forceLoginMethod, Claude Code blocks an apiKeyHelper credential \(https:\/\/code\.claude\.com\/docs\/en\/authentication\)\. A machine takes one of the two\./);
  for (const need of [/Windows PowerShell 5\.1/, /Claude Code 2\.1\.272 or later/, /A network from which the gateway answers/, /A gateway role on your account/]) assert.match(flat, need);
  // The Discovery fix for each status class the troubleshooting article covers, and no sign-in advice for Claude Code's
  // generic apiKeyHelper failure, which a gateway outage or a held lock also causes (UX review, round 5).
  for (const status of [/with 403, the gateway does not admit this network/, /With 404, check the gateway URL/, /With 500 to 599, run the command again/, /With 200, the answer was not JSON: a proxy's sign-in page, or a fault in the gateway or its ingress/]) assert.match(flat, status);
  assert.match(flat, /Claude Code reports that apiKeyHelper is failing: in a new Windows PowerShell window, run the helper with the launcher's settings to see its own message, which starts with Get-ClaudeGatewayToken:, and follow it\./);
  assert.doesNotMatch(flat, /apiKeyHelper is failing[^-]*sign in again/);
  // A declined code is tried again before the operator is asked for a role (UX review, round 6).
  assert.match(flat, /"The sign-in was declined \(access_denied\)": if you declined the code, run step 2 again and confirm it\. When the gateway refuses your account again, ask the operator for a gateway role\./);
  // Every message START-HERE quotes is one a developer script prints: a throw, Write-Diagnostic or stderr message whose
  // literal parts, the text between the quote's <placeholders>, it holds in order (QA review, rounds 4 and 5). Text in
  // a comment, or elsewhere in a file, does not count.
  const printed = files.filter((f) => /\.(ps1|psm1)$/.test(f))
    .flatMap((f) => scriptMessages(fs.readFileSync(path.join(root, 'scripts', 'developer', f), 'utf8')).map((m) => m.text));
  const prints = (messages, quote) => messages.some((text) => partsInOrder(quote)?.test(text));
  const quoted = [...start.matchAll(/"([A-Z][^"\r\n]{12,})"/g)].map((m) => m[1]);
  assert.ok(quoted.length >= 3, `START-HERE quotes ${quoted.length} messages`);
  for (const q of quoted) assert.ok(prints(printed, q), `START-HERE quotes a message the scripts do not print: ${q}`);
  // The matcher refuses a message with an invented part after a placeholder, one with its parts reversed, and one the
  // script keeps only in a comment.
  assert.ok(prints(printed, 'No saved session for <gateway>.'));
  assert.ok(!prints(printed, 'No saved session for <gateway>. Completely invented recovery.'));
  assert.ok(!prints(printed, 'To keep it, install <gateway> The profile <dir> is for'));
  assert.ok(!prints(scriptMessages('# throw "No saved session for $origin."\nthrow "Another message for $origin."').map((m) => m.text), 'No saved session for <gateway>.'));
});

test('T-54 a private IPv4 literal is accepted as the gateway host', (t) => {
  assert.equal(policy(['--gateway-url', 'https://10.20.30.40:8443', '--out', outDir(t)]).status, 0);
});

for (const [label, url, message] of [
  ['plain http', 'http://claude-gateway.corp.contoso.example', /https/],
  ['a path', `${URL_OK}/v1`, /path, query or fragment/],
  ['a query', `${URL_OK}/?a=1`, /path, query or fragment/],
  ['credentials', 'https://admin:pw@claude-gateway.corp.contoso.example', /user name or password/],
  ['a public IPv4 literal', 'https://20.10.5.1', /20\.10\.5\.1 is not a private address/],
  ['an IPv6 literal', 'https://[fd00::1]', /IPv6/],
  ['a host outside letters, digits, dots and hyphens', 'https://claude_gw.corp.contoso.example', /host/],
]) {
  test(`T-54 a gateway URL with ${label} is refused and nothing is written`, (t) => {
    const out = outDir(t);
    const r = policy(['--gateway-url', url, '--out', out]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, message);
    assert.equal(fs.existsSync(out), false);
  });
}

test('T-54 an output directory that is not empty is refused unless --force is given', (t) => {
  const out = outDir(t);
  assert.equal(policy(['--gateway-url', URL_OK, '--out', out]).status, 0);
  const again = policy(['--gateway-url', 'https://other.corp.contoso.example', '--out', out]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /--force/);
  assert.equal(JSON.parse(read(login(out), 'managed-settings.json')).forceLoginGatewayUrl, URL_OK);
  assert.equal(policy(['--gateway-url', 'https://other.corp.contoso.example', '--out', out, '--force']).status, 0);
  assert.equal(JSON.parse(read(login(out), 'managed-settings.json')).forceLoginGatewayUrl, 'https://other.corp.contoso.example');
});

test('T-54 the macOS profile keeps its identity when the gateway URL changes, and --policy-id separates two profiles', (t) => {
  const ids = (out) => [...read(login(out), 'ClaudeCode.mobileconfig').toString('utf8').matchAll(/<key>Payload(?:UUID|Identifier)<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => m[1]);
  const [a, b, c] = [outDir(t), outDir(t), outDir(t)];
  assert.equal(policy(['--gateway-url', URL_OK, '--out', a]).status, 0);
  assert.equal(policy(['--gateway-url', 'https://renamed.corp.contoso.example', '--out', b]).status, 0);
  assert.equal(policy(['--gateway-url', URL_OK, '--out', c, '--policy-id', 'pilot']).status, 0);
  assert.equal(ids(a).length, 4);
  assert.deepEqual(ids(b), ids(a), 'a new URL updates the same MDM profile');
  assert.equal(ids(c).some((id) => ids(a).includes(id)), false, 'another policy ID is another profile');
  const bad = policy(['--gateway-url', URL_OK, '--out', outDir(t), '--policy-id', 'a b<x>']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--policy-id/);
});

test('T-54 the install command START-HERE gives runs from the developer folder and installs every runtime file, and its helper diagnostic prints the helper\'s own message', { skip: windowsSkip }, async (t) => {
  const out = outDir(t);
  assert.equal(policy(['--gateway-url', URL_OK, '--fast-model', 'claude-sonnet-5', '--out', out]).status, 0);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw bundle home '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'stub'));
  fs.writeFileSync(path.join(home, 'stub', 'claude.cmd'), '@echo off\r\n');
  const env = { USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
  const developer = path.join(out, 'developer');
  // The command as START-HERE gives it, run through cmd from the folder, with a stub Claude Code and no sign-in.
  const install = read(developer, 'START-HERE.txt').toString('utf8').split('\r\n').find((l) => l.includes('Install-ClaudeGatewayProfile.ps1')).trim();
  const r = await runCmd(`${install} -ClaudePath "${path.join(home, 'stub', 'claude.cmd')}" -NoSignIn`, { cwd: developer, env: { ...process.env, ...env }, timeoutMs: 110_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const bin = path.join(env.LOCALAPPDATA, 'ClaudeAppsGateway', 'bin');
  const [version] = fs.readdirSync(bin);
  const installed = fs.readdirSync(path.join(bin, version)).sort();
  assert.deepEqual(installed, runtimeFiles().filter((f) => f !== 'Install-ClaudeGatewayProfile.ps1'));
  assert.ok(fs.existsSync(path.join(home, '.claude-apps-gateway', 'settings.json')));
  // The diagnostic lines as START-HERE gives them, in Windows PowerShell: the helper runs with the launcher's pinned env
  // values, so a stale provider switch or base URL in the shell does not hide the real failure (Architect review,
  // round 6); its own message, here for a profile with no sign-in, reaches the console while the token output is
  // discarded.
  const diagnostic = read(developer, 'START-HERE.txt').toString('utf8').split('\r\n').map((l) => l.trim())
    .filter((l) => l.startsWith('$pinned =') || l.startsWith('foreach ($p in $pinned.env.PSObject.Properties)') || l.startsWith('cmd /d /c $pinned.apiKeyHelper'));
  assert.equal(diagnostic.length, 3, 'START-HERE gives the three diagnostic lines');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'ANTHROPIC_BASE_URL'));
  const stale = { CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_BASE_URL: 'https://stale.contoso.example' };
  const d = await runProgramAsync(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-Command', diagnostic.join('; ')], { env: { ...inherited, ...env, ...stale }, timeoutMs: 110_000 });
  assert.equal(d.stdout.trim(), '', 'no token is printed');
  assert.match(d.stderr, new RegExp(`Get-ClaudeGatewayToken: No saved session for ${URL_OK.replace(/[.]/g, '\\.')}\\.`));
});