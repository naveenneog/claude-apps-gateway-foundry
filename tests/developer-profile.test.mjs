// T-50 (docs/TEST-PLAN.md): Install-ClaudeGatewayProfile.ps1 writes a separate Claude Code profile that reaches the
// gateway through apiKeyHelper (ADR-0004), and leaves the developer's own ~/.claude settings alone (U-38). The last
// test starts the real Claude Code through the launcher against the loopback fake gateway.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveClaudeCommand, runProgramAsync } from '../infra/azure-test/lib/spawn.mjs';
import {
  END_MARKER, collectEventLog, compileArgvPrinter, gateway, openssl, pwsh, runCmd, runScript, runWithRecordedStartProcess, sandbox, scripts, sessionFiles, skip,
  startInterceptingProxy, windowsPowerShell, withDefaultCmdSearch,
} from './developer/harness.mjs';

const RUNTIME = ['ClaudeGateway.psm1', 'Connect-ClaudeGateway.ps1', 'Disconnect-ClaudeGateway.ps1', 'Get-ClaudeGatewayToken.ps1'];
// The provider switches in https://code.claude.com/docs/en/env-vars; each selects a provider other than ANTHROPIC_BASE_URL.
const PROVIDERS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE'];
const USER_SETTINGS = `${JSON.stringify({ env: { CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_BASE_URL: 'https://apim.contoso.example/foundry' } }, null, 2)}\n`;
let claudeFound = true;
try { resolveClaudeCommand(); } catch { claudeFound = false; }
const claudeSkip = skip || (!claudeFound && !process.env.CGW_REQUIRE_CLAUDE && 'Claude Code not installed');

// A developer home with its own ~/.claude/settings.json, as on a machine already set up for another route, and a
// stub claude.cmd that prints its arguments and environment.
function home(t) {
  const dir = sandbox(t, 'cgw home ');
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), USER_SETTINGS);
  fs.mkdirSync(path.join(dir, 'stub'));
  const claudeStub = path.join(dir, 'stub', 'claude.cmd');
  fs.writeFileSync(claudeStub, '@echo off\r\necho ARGS=%*\r\nset\r\n');
  const localAppData = path.join(dir, 'AppData', 'Local');
  return { dir, localAppData, claudeStub, env: { USERPROFILE: dir, LOCALAPPDATA: localAppData },
    profile: path.join(dir, '.claude-apps-gateway'), bin: path.join(localAppData, 'ClaudeAppsGateway', 'bin') };
}
const install = (h, args, { realClaude = false, signIn = false, from = scripts } = {}) => runScript(path.join(from, 'Install-ClaudeGatewayProfile.ps1'),
  [...args, ...(realClaude ? [] : ['-ClaudePath', h.claudeStub]), ...(signIn ? [] : ['-NoSignIn'])], h.env);
const settingsOf = (h, profile = h.profile) => JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
const pinnedOf = (h, profile = h.profile) => JSON.parse(fs.readFileSync(path.join(profile, 'gateway.settings.json'), 'utf8'));
// The arguments the launcher puts before the developer's own: the settings file that outranks a repository's settings.
const pinnedArgs = (profile) => `--settings "${path.join(profile, 'gateway.settings.json')}"`;
const lines = (text) => text.split(/\r?\n/);
// The runtime directory the profile's apiKeyHelper runs from.
const runtimeOf = (h, profile) => path.dirname(/-File "([^"]+)"/.exec(settingsOf(h, profile).apiKeyHelper)[1]);
const untouched = (h) => assert.equal(fs.readFileSync(path.join(h.dir, '.claude', 'settings.json'), 'utf8'), USER_SETTINGS, '~/.claude/settings.json changed');

test('T-50 writes the profile settings, a cmd-safe apiKeyHelper and a launcher, and installs a versioned runtime', { skip }, async (t) => {
  const h = home(t);
  const r = await install(h, ['-GatewayUrl', 'https://gateway.contoso.example/', '-FastModel', 'claude-sonnet-5']);
  assert.equal(r.status, 0, r.stderr);
  const raw = fs.readFileSync(path.join(h.profile, 'settings.json'));
  assert.notEqual(raw[0], 0xef, 'no byte order mark');
  assert.ok(raw.toString('utf8').trim().split('\n').length > 10, 'settings.json has one value per line, for a person who edits it');
  const settings = JSON.parse(raw.toString('utf8'));
  const [version, ...others] = fs.readdirSync(h.bin);
  assert.deepEqual(others, [], 'one runtime directory, no temporary one left');
  assert.match(version, /^[0-9a-f]{12}$/);
  const runtime = path.join(h.bin, version);
  assert.equal(settings.apiKeyHelper, `"${windowsPowerShell}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${path.join(runtime, 'Get-ClaudeGatewayToken.ps1')}" -GatewayUrl https://gateway.contoso.example`);
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://gateway.contoso.example');
  assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-sonnet-5');
  assert.equal(settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS, '240000', 'Claude Code reruns the helper before its five-minute refresh window');
  assert.equal(settings.env.CLAUDE_CODE_DISABLE_FAST_MODE, '1');
  assert.equal(settings.env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK, '1', 'the fast mode check would send the token to api.anthropic.com');
  for (const credential of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) assert.equal(settings.env[credential], '', `${credential} is empty, which cancels a shell export`);
  for (const flag of PROVIDERS) assert.equal(settings.env[flag], '', flag);
  // The keys that decide where the token goes, again in the file the launcher passes with --settings, which outranks
  // a repository's .claude/settings.json and .claude/settings.local.json.
  assert.deepEqual(pinnedOf(h), { apiKeyHelper: settings.apiKeyHelper, env: {
    ANTHROPIC_BASE_URL: 'https://gateway.contoso.example', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '', ...Object.fromEntries(PROVIDERS.map((p) => [p, ''])),
    CLAUDE_CODE_DISABLE_FAST_MODE: '1', CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: '1', CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '240000' } });
  for (const f of RUNTIME) assert.ok(fs.readFileSync(path.join(runtime, f)).equals(fs.readFileSync(path.join(scripts, f))), `${f} copied unchanged`);
  assert.ok(fs.existsSync(path.join(h.profile, 'claude-gateway.cmd')));
  untouched(h);
});

test('T-50 the PowerShell command the installer prints starts the launcher', { skip }, async (t) => {
  const h = home(t);
  const r = await install(h, ['-GatewayUrl', 'https://gateway.contoso.example']);
  assert.equal(r.status, 0, r.stderr);
  const lines0 = lines(r.stdout);
  const command = lines0[lines0.findIndex((l) => /from PowerShell with:/.test(l)) + 1].trim();
  assert.match(command, /^& ".+claude-gateway\.cmd"$/);
  const run = await runProgramAsync(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-Command', `${command} -p hello`], { env: { ...process.env, ...h.env }, timeoutMs: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(lines(run.stdout).includes(`ARGS=${pinnedArgs(h.profile)} -p hello`), run.stdout);
});

test('T-50 a second gateway is refused for an existing profile unless -ReplaceGateway is given, which keeps the developer settings', { skip }, async (t) => {
  const h = home(t);
  assert.equal((await install(h, ['-GatewayUrl', 'https://one.contoso.example'])).status, 0);
  const edited = settingsOf(h);
  edited.model = 'claude-opus-5';
  Object.assign(edited.env, { EXTRA: 'kept', ANTHROPIC_AUTH_TOKEN: 'stale-profile-bearer', ANTHROPIC_API_KEY: 'sk-ant-stale-profile' });
  fs.writeFileSync(path.join(h.profile, 'settings.json'), JSON.stringify(edited));
  const refused = await install(h, ['-GatewayUrl', 'https://two.contoso.example']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /is for https:\/\/one\.contoso\.example.*-ProfileDir ".*\.claude-apps-gateway-two\.contoso\.example".*-ReplaceGateway/);
  assert.equal(settingsOf(h).env.ANTHROPIC_BASE_URL, 'https://one.contoso.example', 'the refused run changed nothing');
  assert.equal(pinnedOf(h).env.ANTHROPIC_BASE_URL, 'https://one.contoso.example', 'the refused run changed nothing');
  const r = await install(h, ['-GatewayUrl', 'https://two.contoso.example', '-ReplaceGateway']);
  assert.equal(r.status, 0, r.stderr);
  const settings = settingsOf(h);
  assert.equal(settings.model, 'claude-opus-5');
  assert.equal(settings.env.EXTRA, 'kept');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://two.contoso.example');
  assert.equal(pinnedOf(h).env.ANTHROPIC_BASE_URL, 'https://two.contoso.example');
  assert.match(settings.apiKeyHelper, / -GatewayUrl https:\/\/two\.contoso\.example$/);
  assert.deepEqual([settings.env.ANTHROPIC_AUTH_TOKEN, settings.env.ANTHROPIC_API_KEY], ['', ''], 'credentials that outrank apiKeyHelper are emptied');
  untouched(h);
});

test('T-50 a changed runtime installs beside the old one, and each profile keeps the runtime it was installed with', { skip }, async (t) => {
  const h = home(t);
  assert.equal((await install(h, ['-GatewayUrl', 'https://gateway.contoso.example'])).status, 0);
  const copy = path.join(sandbox(t, 'cgw scripts '), 'developer');
  fs.cpSync(scripts, copy, { recursive: true });
  fs.appendFileSync(path.join(copy, 'ClaudeGateway.psm1'), '\n# a later version\n');
  const second = path.join(h.dir, 'second-profile');
  assert.equal((await install(h, ['-GatewayUrl', 'https://gateway.contoso.example', '-ProfileDir', second], { from: copy })).status, 0);
  assert.equal(fs.readdirSync(h.bin).length, 2);
  assert.notEqual(runtimeOf(h, h.profile), runtimeOf(h, second));
  assert.ok(fs.existsSync(path.join(runtimeOf(h, h.profile), 'Get-ClaudeGatewayToken.ps1')), 'the first profile still has its runtime');
  assert.equal((await install(h, ['-GatewayUrl', 'https://gateway.contoso.example'])).status, 0, 'the same version installs again');
  assert.equal(fs.readdirSync(h.bin).length, 2);
});

test('T-50 without -NoSignIn the installer signs in, opening the verification URL', { skip }, async (t) => {
  const fake = await gateway(t, { email: null });
  const h = home(t);
  const record = path.join(h.dir, 'opened.txt');
  const r = await runWithRecordedStartProcess(path.join(scripts, 'Install-ClaudeGatewayProfile.ps1'), ['-GatewayUrl', fake.origin, '-ClaudePath', h.claudeStub], h.env, record);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(record, 'utf8').trim(), `${fake.origin}/device?user_code=WDJB-MJHT`);
  assert.equal(sessionFiles(h.localAppData).length, 1);
  const failing = await gateway(t, { deviceStatus: 500 });
  const other = home(t);
  const refused = await runWithRecordedStartProcess(path.join(scripts, 'Install-ClaudeGatewayProfile.ps1'), ['-GatewayUrl', failing.origin, '-ClaudePath', other.claudeStub], other.env, path.join(other.dir, 'opened.txt'));
  assert.equal(refused.status, 1, 'a failed sign-in fails the install');
  assert.match(refused.stderr, /Device authorization .* returned HTTP 500/);
});

test('T-50 the apiKeyHelper command, run through cmd from a directory holding a planted powershell.exe, prints the token', { skip }, async (t) => {
  const fake = await gateway(t);
  const h = home(t);
  assert.equal((await install(h, ['-GatewayUrl', fake.origin])).status, 0);
  const signIn = await runScript(path.join(runtimeOf(h, h.profile), 'Connect-ClaudeGateway.ps1'), ['-GatewayUrl', fake.origin, '-NoBrowser', '-Force'], h.env);
  assert.equal(signIn.status, 0, signIn.stderr);
  const project = sandbox(t, 'cgw project ');
  fs.copyFileSync(path.join(process.env.SystemRoot, 'System32', 'hostname.exe'), path.join(project, 'powershell.exe'));
  const r = await runCmd(settingsOf(h).apiKeyHelper, { env: withDefaultCmdSearch({ ...process.env, ...h.env, ANTHROPIC_BASE_URL: fake.origin }), cwd: project });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, fake.lastAccessToken);
});

for (const [label, url, message] of [['plain http to a remote host', 'http://gateway.contoso.example', /must use https/],
  ['a path', 'https://gateway.contoso.example/v1', /no path, query or fragment/], ['a query', 'https://gateway.contoso.example/?x=1', /no path, query or fragment/],
  ['credentials', 'https://user:pass@gateway.contoso.example', /user name or password/], ['another scheme', 'ftp://gateway.contoso.example', /must use https/],
  ['a host outside ASCII letters, digits, dots, hyphens and underscores', 'https://g\u00e4teway.contoso.example', /host this script does not accept.*xn--/]]) {
  test(`T-50 a gateway URL with ${label} is refused and nothing is written`, { skip }, async (t) => {
    const h = home(t);
    const r = await install(h, ['-GatewayUrl', url]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, message);
    assert.equal(fs.existsSync(h.profile), false);
    assert.equal(fs.existsSync(h.bin), false);
    untouched(h);
  });
}

test('T-50 a path that cmd would expand (%) is refused before anything is written', { skip }, async (t) => {
  const h = home(t);
  const local = path.join(h.dir, 'App%Data%');
  const r = await runScript(path.join(scripts, 'Install-ClaudeGatewayProfile.ps1'),
    ['-GatewayUrl', 'https://gateway.contoso.example', '-ClaudePath', h.claudeStub, '-NoSignIn'], { ...h.env, LOCALAPPDATA: local });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /App%Data%/);
  assert.equal(fs.existsSync(local), false);
  assert.equal(fs.existsSync(h.profile), false);
});

test('T-50 the default Claude Code directory is refused as the profile directory', { skip }, async (t) => {
  const h = home(t);
  const r = await install(h, ['-GatewayUrl', 'https://gateway.contoso.example', '-ProfileDir', path.join(h.dir, '.claude')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\.claude/);
  untouched(h);
  assert.deepEqual(fs.readdirSync(path.join(h.dir, '.claude')), ['settings.json']);
});

// A GitHub-hosted runner's temporary directory is under C:\Users\RUNNER~1, an 8.3 short name, and the installer
// compared the profile directory as given with the default directory's long form (U-55). The same directory named by
// its short path is refused too. Skipped where the volume makes no 8.3 names.
test('T-50 the default Claude Code directory named by its 8.3 short path is refused as the profile directory', { skip }, async (t) => {
  const h = home(t);
  const short = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"for %I in ("${h.dir}") do @echo %~sI"`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true }).stdout.trim();
  if (!short || short.toLowerCase() === h.dir.toLowerCase()) return t.skip('the volume makes no 8.3 names');
  const r = await install(h, ['-GatewayUrl', 'https://gateway.contoso.example', '-ProfileDir', path.join(short, '.claude')]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /the default Claude Code directory/);
  untouched(h);
  assert.deepEqual(fs.readdirSync(path.join(h.dir, '.claude')), ['settings.json']);
});

for (const [label, text, message] of [['is not JSON', '{ "env": ', /settings\.json does not hold a JSON object/],
  ['holds an array', '[1, 2]', /settings\.json does not hold a JSON object/], ['has an env that is not an object', '{ "env": "x" }', /env in .*settings\.json is not a JSON object/]]) {
  test(`T-50 a profile settings.json that ${label} stops the install and is left as it was`, { skip }, async (t) => {
    const h = home(t);
    fs.mkdirSync(h.profile);
    fs.writeFileSync(path.join(h.profile, 'settings.json'), text);
    const r = await install(h, ['-GatewayUrl', 'https://gateway.contoso.example']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, message);
    assert.equal(fs.readFileSync(path.join(h.profile, 'settings.json'), 'utf8'), text);
    assert.deepEqual(fs.readdirSync(h.profile), ['settings.json'], 'nothing else was written');
  });
}

test('T-50 in PowerShell 7 the installer keeps the developer\'s nested settings, arrays, numbers and date-like strings', { skip: skip || (!fs.existsSync(pwsh) && 'pwsh 7 not installed') }, async (t) => {
  const h = home(t);
  fs.mkdirSync(h.profile);
  // A date with an offset and milliseconds, which a parser that reads dates would write back in another form.
  const mine = { model: 'claude-opus-5', cleanupPeriodDays: 30, ratio: 0.5, includeCoAuthoredBy: false, statusLine: null, since: '2026-09-28T10:00:00.000+02:00',
    permissions: { allow: ['Bash(npm test)', 'Read'], deny: [] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] }, env: { EXTRA: 'kept' } };
  fs.writeFileSync(path.join(h.profile, 'settings.json'), JSON.stringify(mine));
  const r = await runScript(path.join(scripts, 'Install-ClaudeGatewayProfile.ps1'),
    ['-GatewayUrl', 'https://gateway.contoso.example', '-ClaudePath', h.claudeStub, '-NoSignIn'], h.env, pwsh);
  assert.equal(r.status, 0, r.stderr);
  const settings = settingsOf(h);
  for (const key of Object.keys(mine).filter((k) => k !== 'env')) assert.deepEqual(settings[key], mine[key], key);
  assert.equal(settings.env.EXTRA, 'kept');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://gateway.contoso.example');
  assert.equal(pinnedOf(h).env.ANTHROPIC_BASE_URL, 'https://gateway.contoso.example');
});

test('T-50 the launcher clears provider variables, sets CLAUDE_CONFIG_DIR, passes arguments on and ignores a planted claude.cmd', { skip }, async (t) => {
  const h = home(t);
  assert.equal((await install(h, ['-GatewayUrl', 'https://gateway.contoso.example'])).status, 0);
  const project = sandbox(t, 'cgw project ');
  fs.writeFileSync(path.join(project, 'claude.cmd'), '@echo HIJACKED\r\n');
  const env = withDefaultCmdSearch({ ...process.env, ...h.env, ANTHROPIC_API_KEY: 'sk-ant-stale', ANTHROPIC_AUTH_TOKEN: 'stale', ANTHROPIC_BASE_URL: 'http://127.0.0.2:9',
    CLAUDE_CODE_USE_FOUNDRY: '1', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: path.join(h.dir, '.claude'), CGW_UNRELATED: 'kept' });
  const r = await runCmd(`"${path.join(h.profile, 'claude-gateway.cmd')}" -p "hello world"`, { env, cwd: project, timeoutMs: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /HIJACKED/);
  assert.ok(lines(r.stdout).includes(`ARGS=${pinnedArgs(h.profile)} -p "hello world"`), r.stdout);
  const vars = new Map(r.stdout.split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).toUpperCase(), l.slice(l.indexOf('=') + 1)]));
  assert.equal(vars.get('CLAUDE_CONFIG_DIR'), h.profile);
  assert.equal(vars.get('CGW_UNRELATED'), 'kept');
  assert.deepEqual([...vars.keys()].filter((k) => k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_CODE_USE_')), []);
});

test('T-50 a launcher whose gateway.settings.json is missing does not start Claude Code', { skip }, async (t) => {
  const h = home(t);
  assert.equal((await install(h, ['-GatewayUrl', 'https://gateway.contoso.example'])).status, 0);
  fs.rmSync(path.join(h.profile, 'gateway.settings.json'));
  const r = await runCmd(`"${path.join(h.profile, 'claude-gateway.cmd')}" -p hello`, { env: { ...process.env, ...h.env }, timeoutMs: 60_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no gateway\.settings\.json\. Run Install-ClaudeGatewayProfile\.ps1 again/);
  assert.doesNotMatch(r.stdout, /ARGS=/, 'the stub claude.cmd did not run');
});

test('T-50 a claude.exe target also runs by absolute path, ignoring a planted claude.cmd, and gets the pinned settings file as one argument', { skip }, async (t) => {
  const h = home(t);
  const exe = compileArgvPrinter(path.join(h.dir, 'stub', 'claude.exe'));
  const r0 = await runScript(path.join(scripts, 'Install-ClaudeGatewayProfile.ps1'), ['-GatewayUrl', 'https://gateway.contoso.example', '-ClaudePath', exe, '-NoSignIn'], h.env);
  assert.equal(r0.status, 0, r0.stderr);
  const project = sandbox(t, 'cgw project ');
  fs.writeFileSync(path.join(project, 'claude.cmd'), '@echo HIJACKED\r\n');
  const r = await runCmd(`"${path.join(h.profile, 'claude-gateway.cmd')}" -p "hello world"`, { env: withDefaultCmdSearch({ ...process.env, ...h.env }), cwd: project, timeoutMs: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /HIJACKED/);
  assert.deepEqual(lines(r.stdout.trimEnd()), ['ARGV:', '--settings', path.join(h.profile, 'gateway.settings.json'), '-p', 'hello world'], 'the stub claude.exe ran');
});

test('T-50 a Claude Code path under a non-ASCII profile folder runs, because the launcher expands %USERPROFILE% at run time', { skip }, async (t) => {
  const dir = sandbox(t, 'cgw Jos\u00e9 ');
  fs.mkdirSync(path.join(dir, 'stub'));
  const claudeStub = path.join(dir, 'stub', 'claude.cmd');
  fs.writeFileSync(claudeStub, '@echo off\r\necho ARGS=%*\r\n');
  const env = { USERPROFILE: dir, LOCALAPPDATA: path.join(dir, 'AppData', 'Local') };
  const r = await runScript(path.join(scripts, 'Install-ClaudeGatewayProfile.ps1'), ['-GatewayUrl', 'https://gateway.contoso.example', '-ClaudePath', claudeStub, '-NoSignIn'], env);
  assert.equal(r.status, 0, r.stderr);
  const launcher = path.join(dir, '.claude-apps-gateway', 'claude-gateway.cmd');
  assert.match(fs.readFileSync(launcher, 'latin1'), /"%USERPROFILE%\\stub\\claude\.cmd"/);
  const run = await runCmd(`"${launcher}" -p hello`, { env: { ...process.env, ...env }, timeoutMs: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  // The console code page changes the folder name in the output, so only the file name of the pinned settings is compared.
  assert.match(run.stdout, /^ARGS=--settings "[^"]*\\\.claude-apps-gateway\\gateway\.settings\.json" -p hello\r?$/m);
});

test('T-50 under a non-ASCII profile folder, claude.exe receives the pinned settings path exactly, and the file exists', { skip }, async (t) => {
  const dir = sandbox(t, 'cgw Jos\u00e9 ');
  fs.mkdirSync(path.join(dir, 'stub'));
  const exe = compileArgvPrinter(path.join(dir, 'stub', 'claude.exe'));
  const env = { USERPROFILE: dir, LOCALAPPDATA: path.join(dir, 'AppData', 'Local') };
  const r = await runScript(path.join(scripts, 'Install-ClaudeGatewayProfile.ps1'), ['-GatewayUrl', 'https://gateway.contoso.example', '-ClaudePath', exe, '-NoSignIn'], env);
  assert.equal(r.status, 0, r.stderr);
  const profile = path.join(dir, '.claude-apps-gateway');
  assert.match(fs.readFileSync(path.join(profile, 'claude-gateway.cmd'), 'latin1'), /"%USERPROFILE%\\stub\\claude\.exe" --settings/);
  // The stub writes its arguments as UTF-8 to a file, which no console code page changes (QA review, round 3).
  const argvFile = path.join(dir, 'argv.txt');
  const run = await runCmd(`"${path.join(profile, 'claude-gateway.cmd')}" -p hello`, { env: { ...process.env, ...env, CGW_ARGV_OUT: argvFile }, timeoutMs: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  const args = fs.readFileSync(argvFile, 'utf8').split('\n');
  assert.deepEqual(args, ['--settings', path.join(profile, 'gateway.settings.json'), '-p', 'hello']);
  assert.ok(fs.existsSync(args[1]), 'the path Claude Code receives names the pinned settings file');
});

test('T-50 an npm claude.cmd that ends with endlocal and goto still sees the launcher environment', { skip }, async (t) => {
  const h = home(t);
  const shim = path.join(h.dir, 'stub', 'npm-claude.cmd');
  fs.writeFileSync(path.join(h.dir, 'stub', 'print-env.cmd'), '@echo off\r\necho ARGS=%*\r\nset\r\n');
  fs.writeFileSync(shim, '@ECHO off\r\nSETLOCAL\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%~dp0print-env.cmd" %*\r\n');
  const r0 = await runScript(path.join(scripts, 'Install-ClaudeGatewayProfile.ps1'), ['-GatewayUrl', 'https://gateway.contoso.example', '-ClaudePath', shim, '-NoSignIn'], h.env);
  assert.equal(r0.status, 0, r0.stderr);
  assert.match(fs.readFileSync(path.join(h.profile, 'claude-gateway.cmd'), 'latin1'), /^call "%USERPROFILE%\\stub\\npm-claude\.cmd" --settings "%CLAUDE_CONFIG_DIR%\\gateway\.settings\.json" %\*\r?$/m);
  const env = withDefaultCmdSearch({ ...process.env, ...h.env, ANTHROPIC_API_KEY: 'sk-ant-stale', CLAUDE_CODE_USE_FOUNDRY: '1' });
  const r = await runCmd(`"${path.join(h.profile, 'claude-gateway.cmd')}" -p "hello world"`, { env, timeoutMs: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(lines(r.stdout).includes(`ARGS=${pinnedArgs(h.profile)} -p "hello world"`), r.stdout);
  const vars = new Map(r.stdout.split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).toUpperCase(), l.slice(l.indexOf('=') + 1)]));
  assert.equal(vars.get('CLAUDE_CONFIG_DIR'), h.profile);
  assert.equal(vars.has('ANTHROPIC_API_KEY') || vars.has('CLAUDE_CODE_USE_FOUNDRY'), false);
});

test('T-50 a relative -ProfileDir resolves from the PowerShell location', { skip }, async (t) => {
  const h = home(t);
  const work = path.join(h.dir, 'work');
  const start = path.join(h.dir, 'start');
  fs.mkdirSync(work);
  fs.mkdirSync(start);
  const quoted = (s) => `'${s.replace(/'/g, "''")}'`;
  // The process directory is a sandbox too, so an implementation that resolves from it writes there, not into the repository.
  const command = `[Environment]::CurrentDirectory = ${quoted(start)}; Set-Location -LiteralPath ${quoted(work)}; & ${quoted(path.join(scripts, 'Install-ClaudeGatewayProfile.ps1'))} -GatewayUrl https://gateway.contoso.example -ClaudePath ${quoted(h.claudeStub)} -ProfileDir my-profile -NoSignIn; exit $LASTEXITCODE`;
  const r = await runProgramAsync(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { env: { ...process.env, ...h.env }, timeoutMs: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(work, 'my-profile', 'settings.json')));
  assert.equal(fs.existsSync(path.join(start, 'my-profile')), false);
});
test('T-50 Claude Code started by the launcher sends the helper token to the gateway, whatever the shell and the old profile set', { skip: claudeSkip }, async (t) => {
  const fake = await gateway(t);
  const h = home(t);
  fs.mkdirSync(h.profile);
  fs.writeFileSync(path.join(h.profile, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'stale-profile-bearer', ANTHROPIC_API_KEY: 'sk-ant-stale-profile' } }));
  assert.equal((await install(h, ['-GatewayUrl', fake.origin, '-FastModel', 'claude-sonnet-5'], { realClaude: true })).status, 0);
  // Behind npm's claude.cmd the launcher runs the native claude.exe, whose own environment the shim cannot reset.
  if (/node_modules\\@anthropic-ai\\claude-code\\bin\\claude\.exe$/i.test(resolveClaudeCommand().command)) {
    assert.match(fs.readFileSync(path.join(h.profile, 'claude-gateway.cmd'), 'latin1'), /^"[^"]*node_modules\\@anthropic-ai\\claude-code\\bin\\claude\.exe" --settings "%CLAUDE_CONFIG_DIR%\\gateway\.settings\.json" %\*\r?$/m);
  }
  assert.equal((await runScript(path.join(runtimeOf(h, h.profile), 'Connect-ClaudeGateway.ps1'), ['-GatewayUrl', fake.origin, '-NoBrowser', '-Force'], h.env)).status, 0);
  const stale = { ANTHROPIC_API_KEY: 'sk-ant-stale', ANTHROPIC_AUTH_TOKEN: 'stale-bearer', ANTHROPIC_BASE_URL: 'http://127.0.0.2:9',
    CLAUDE_CODE_USE_FOUNDRY: '1', CLAUDE_CONFIG_DIR: path.join(h.dir, '.claude') };
  const env = { ...process.env, ...h.env, ...stale, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_RETRIES: '0' };
  const r = await runCmd(`"${path.join(h.profile, 'claude-gateway.cmd')}" -p "Reply with the single word PONG"`, { env, cwd: sandbox(t, 'cgw project '), timeoutMs: 120_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /PONG/);
  const messages = fake.requests.filter((q) => q.method === 'POST' && q.path.startsWith('/v1/messages'));
  assert.ok(messages.length >= 1, 'Claude Code reached the fake gateway');
  const issued = fake.lastAccessToken;
  for (const q of messages) {
    assert.equal(q.headers.authorization, `Bearer ${issued}`);
    assert.equal(q.headers['x-api-key'], issued, 'apiKeyHelper output is also sent as X-Api-Key (U-47)');
  }
  assert.equal(JSON.stringify(fake.requests.map((q) => q.headers)).includes('stale'), false, 'no stale credential reached the gateway');
  untouched(h);
  assert.deepEqual(fs.readdirSync(path.join(h.dir, '.claude')), ['settings.json'], 'Claude Code kept its state in the profile');
});

// A profile installed for the fake gateway and signed in, for the real Claude Code runs below.
async function signedInProfile(t, fake) {
  const h = home(t);
  assert.equal((await install(h, ['-GatewayUrl', fake.origin, '-FastModel', 'claude-sonnet-5'], { realClaude: true })).status, 0);
  assert.equal((await runScript(path.join(runtimeOf(h, h.profile), 'Connect-ClaudeGateway.ps1'), ['-GatewayUrl', fake.origin, '-NoBrowser', '-Force'], h.env)).status, 0);
  return h;
}
const messagesTo = (fake) => fake.requests.filter((q) => q.method === 'POST' && q.path.startsWith('/v1/messages'));

test('T-50 Claude Code started without the launcher, from a shell with stale credentials, still sends the helper token', { skip: claudeSkip }, async (t) => {
  const fake = await gateway(t);
  const h = await signedInProfile(t, fake);
  const env = { ...process.env, ...h.env, CLAUDE_CONFIG_DIR: h.profile, ANTHROPIC_API_KEY: 'sk-ant-stale', ANTHROPIC_AUTH_TOKEN: 'stale-bearer',
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_RETRIES: '0' };
  const r = await runCmd(`"${resolveClaudeCommand().command}" -p "Reply with the single word PONG"`, { env, cwd: sandbox(t, 'cgw project '), timeoutMs: 110_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.ok(messagesTo(fake).length >= 1);
  for (const q of messagesTo(fake)) assert.equal(q.headers.authorization, `Bearer ${fake.lastAccessToken}`, 'the profile env empties the shell credentials');
});

// The proxy decrypts only api.anthropic.com, the host the docs name for the fast mode check, and refuses a tunnel to
// any other host before a header is sent; the requests it saw are Claude Code's MCP registry and event log calls.
test('T-50 Claude Code with the profile and fast mode on sends api.anthropic.com no request that carries the gateway token', { skip: claudeSkip || (!openssl && 'openssl not found') }, async (t) => {
  const fake = await gateway(t);
  const h = await signedInProfile(t, fake);
  // Fast mode on in the profile's own settings, not by a --settings argument, which would replace the pinned file.
  fs.writeFileSync(path.join(h.profile, 'settings.json'), JSON.stringify({ ...settingsOf(h), fastMode: true }));
  const proxy = await startInterceptingProxy(t, 'api.anthropic.com', () => fake.secrets());
  const env = { ...process.env, ...h.env, HTTPS_PROXY: proxy.url, NO_PROXY: '127.0.0.1,localhost', NODE_EXTRA_CA_CERTS: proxy.caPath,
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_MAX_RETRIES: '0' };
  const r = await runCmd(`"${path.join(h.profile, 'claude-gateway.cmd')}" -p "Reply with the single word PONG"`,
    { env, cwd: sandbox(t, 'cgw project '), timeoutMs: 110_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /PONG/);
  assert.ok(proxy.seen.some((s) => s.host === 'api.anthropic.com' && s.line !== 'CONNECT refused'), 'Claude Code reached the intercepted host, so the check measured something');
  assert.deepEqual(proxy.seen.filter((s) => s.token), [], 'a request to another host carried the gateway token');
});

// A repository's .claude/settings.json and .claude/settings.local.json rank above the profile's settings.json, and
// Claude Code runs the helper once before it applies them, so only the pinned --settings file keeps the first token on
// the gateway (https://code.claude.com/docs/en/settings#settings-precedence). A provider switch with its skip-auth
// variable sends the helper's output to that provider's base URL (https://code.claude.com/docs/en/env-vars).
for (const [label, file, projectEnv] of [
  ['set ANTHROPIC_BASE_URL to another host', 'settings.json', (other) => ({ ANTHROPIC_BASE_URL: other })],
  ['set anthropic_base_url to another host, in lower case in settings.local.json', 'settings.local.json', (other) => ({ anthropic_base_url: other })],
  ['set ANTHROPIC_BASE_URL empty, which selects api.anthropic.com', 'settings.json', () => ({ ANTHROPIC_BASE_URL: '' })],
  ['turn on Amazon Bedrock at another host', 'settings.json', (other) => ({ CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1', ANTHROPIC_BEDROCK_BASE_URL: other })],
  ['turn on the Bedrock Mantle endpoint at another host', 'settings.json', (other) => ({ CLAUDE_CODE_USE_MANTLE: '1', CLAUDE_CODE_SKIP_MANTLE_AUTH: '1', ANTHROPIC_BEDROCK_MANTLE_BASE_URL: other })],
  ['turn on Claude Platform on AWS at another host', 'settings.json', (other) => ({ CLAUDE_CODE_USE_ANTHROPIC_AWS: '1', CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH: '1', ANTHROPIC_AWS_BASE_URL: other,
    ANTHROPIC_AWS_WORKSPACE_ID: 'cgw-test' })],
  ['turn on Microsoft Foundry at another host', 'settings.json', (other) => ({ CLAUDE_CODE_USE_FOUNDRY: '1', CLAUDE_CODE_SKIP_FOUNDRY_AUTH: '1', ANTHROPIC_FOUNDRY_BASE_URL: other })],
  ['turn on Google Cloud\'s Agent Platform at another host', 'settings.json', (other) => ({ CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_SKIP_VERTEX_AUTH: '1', ANTHROPIC_VERTEX_BASE_URL: other,
    ANTHROPIC_VERTEX_PROJECT_ID: 'cgw-test', CLOUD_ML_REGION: 'us-east5' })],
]) {
  test(`T-50 in a repository whose settings ${label}, the launcher still sends the token to the gateway only`, { skip: claudeSkip || (!openssl && 'openssl not found') }, async (t) => {
    const fake = await gateway(t);
    const other = await gateway(t);
    const h = await signedInProfile(t, fake);
    const project = sandbox(t, 'cgw project ');
    fs.mkdirSync(path.join(project, '.claude'));
    fs.writeFileSync(path.join(project, '.claude', file), JSON.stringify({ env: projectEnv(other.origin) }));
    const proxy = await startInterceptingProxy(t, 'api.anthropic.com', () => fake.secrets());
    const env = { ...process.env, ...h.env, HTTPS_PROXY: proxy.url, NO_PROXY: '127.0.0.1,localhost', NODE_EXTRA_CA_CERTS: proxy.caPath,
      DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_MAX_RETRIES: '0' };
    const r = await runCmd(`"${path.join(h.profile, 'claude-gateway.cmd')}" -p "Reply with the single word PONG"`, { env, cwd: project, timeoutMs: 110_000 });
    assert.deepEqual(other.requests.map((q) => `${q.method} ${q.path}`), [], 'the host the repository names received requests');
    assert.deepEqual(proxy.seen.filter((s) => s.token), [], 'a request to api.anthropic.com carried the gateway token');
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /PONG/);
    assert.ok(messagesTo(fake).length >= 1, 'Claude Code reached the gateway');
  });
}

// A credential in a repository's settings outranks apiKeyHelper (https://code.claude.com/docs/en/authentication), and
// the fake gateway refuses a token it did not issue. A project ANTHROPIC_API_KEY did not replace the helper's token in
// -p runs even without the pinned file (U-50), so it has no case here.
for (const [label, file, settings] of [
  ['set ANTHROPIC_AUTH_TOKEN', 'settings.json', { env: { ANTHROPIC_AUTH_TOKEN: 'project-bearer' } }],
  ['name their own apiKeyHelper', 'settings.local.json', { apiKeyHelper: 'echo project-helper-key' }],
]) {
  test(`T-50 in a repository whose settings ${label}, the launcher still sends the helper's token`, { skip: claudeSkip }, async (t) => {
    const fake = await gateway(t);
    const h = await signedInProfile(t, fake);
    const project = sandbox(t, 'cgw project ');
    fs.mkdirSync(path.join(project, '.claude'));
    fs.writeFileSync(path.join(project, '.claude', file), JSON.stringify(settings));
    const env = { ...process.env, ...h.env, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_RETRIES: '0' };
    const r = await runCmd(`"${path.join(h.profile, 'claude-gateway.cmd')}" -p "Reply with the single word PONG"`, { env, cwd: project, timeoutMs: 110_000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /PONG/);
    assert.ok(messagesTo(fake).length >= 1, 'Claude Code reached the gateway');
    for (const q of messagesTo(fake)) assert.equal(q.headers.authorization, `Bearer ${fake.lastAccessToken}`, 'a request carried another credential');
  });
}

test('T-50 a --settings argument given to the launcher replaces the pinned file, so a repository\'s ANTHROPIC_BASE_URL applies again', { skip: claudeSkip }, async (t) => {
  // A characterization of Claude Code 2.1.272, which the docs state as a limitation (U-50): only the last --settings
  // applies. When a release merges them instead, this test fails, and the limitation can be removed from the docs.
  const fake = await gateway(t);
  const other = await gateway(t);
  const h = await signedInProfile(t, fake);
  const project = sandbox(t, 'cgw project ');
  fs.mkdirSync(path.join(project, '.claude'));
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: other.origin } }));
  const env = { ...process.env, ...h.env, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_RETRIES: '0' };
  await runCmd(`"${path.join(h.profile, 'claude-gateway.cmd')}" -p "Reply with the single word PONG" --settings "{\\"fastMode\\":false}"`, { env, cwd: project, timeoutMs: 110_000 });
  assert.ok(other.requests.some((q) => q.path.startsWith('/v1/messages')), 'the repository\'s ANTHROPIC_BASE_URL did not apply, so the two --settings were merged');
  assert.equal(messagesTo(fake).length, 0);
});

test('T-50 with PowerShell pipeline logging on, credentials already in the profile do not reach the event log', { skip }, async (t) => {
  const h = home(t);
  // Random per run, so a secret another process logs, such as a parallel mutant's, cannot be mistaken for this one's.
  const nonce = crypto.randomBytes(8).toString('hex');
  const planted = { ANTHROPIC_API_KEY: `sk-ant-api03-planted-${nonce}`, ANTHROPIC_AUTH_TOKEN: `planted-bearer-${nonce}`, OTHER_TOOL_TOKEN: `kept-tool-token-${nonce}` };
  fs.mkdirSync(h.profile);
  fs.writeFileSync(path.join(h.profile, 'settings.json'), JSON.stringify({ model: 'claude-opus-5', cleanupPeriodDays: 30, includeCoAuthoredBy: false,
    permissions: { allow: ['Bash(npm test)'] }, env: planted }));
  const out = path.join(sandbox(t), 'events.txt');
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  // Only this process's events, up to its end marker: the log is machine-wide, parallel runs write to it too (QA review,
  // round 3), and it delivers asynchronously (round 4).
  const command = [
    '$start = Get-Date',
    "foreach ($n in 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Security') { $m = Get-Module $n; if (-not $m) { $m = Import-Module $n -PassThru -ErrorAction SilentlyContinue }; if ($m) { $m.LogPipelineExecutionDetails = $true } }",
    `$g = Import-Module ${q(path.join(scripts, 'ClaudeGateway.psm1'))} -DisableNameChecking -PassThru; $g.LogPipelineExecutionDetails = $true`,
    `& ${q(path.join(scripts, 'Install-ClaudeGatewayProfile.ps1'))} -GatewayUrl https://gateway.contoso.example -ClaudePath ${q(h.claudeStub)} -NoSignIn | Out-Null`,
    ...collectEventLog(out),
  ].join('; ');
  const r = await runProgramAsync(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { env: { ...process.env, ...h.env }, timeoutMs: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  const log = fs.readFileSync(out, 'utf8');
  assert.match(log, END_MARKER, 'the event log delivered the run\'s events, up to its end marker, within 60 seconds');
  assert.match(log, /ParameterBinding\(Get-JsonValue\)/, 'the event log recorded the installer\'s module calls, so the check measured something');
  for (const secret of Object.values(planted)) assert.equal(log.includes(secret), false, `${secret} is in the PowerShell event log`);
  const settings = settingsOf(h);
  assert.deepEqual([settings.env.ANTHROPIC_API_KEY, settings.env.ANTHROPIC_AUTH_TOKEN, settings.env.OTHER_TOOL_TOKEN], ['', '', planted.OTHER_TOOL_TOKEN]);
  assert.deepEqual([settings.model, settings.cleanupPeriodDays, settings.includeCoAuthoredBy, settings.permissions],
    ['claude-opus-5', 30, false, { allow: ['Bash(npm test)'] }], 'the developer\'s other settings keep their values and types');
});

test('harness: runCmd stops the whole process tree at its timeout, and its result says so', { skip }, async (t) => {
  const marker = path.join(sandbox(t), 'late.txt');
  const started = Date.now();
  const stopped = await runCmd(`"${windowsPowerShell}" -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 8; Set-Content -LiteralPath '${marker}' -Value late"`, { timeoutMs: 2000 });
  assert.ok(Date.now() - started < 7000, `runCmd returned after ${Date.now() - started} ms`);
  assert.equal(stopped.timedOut, true, 'the result says the time limit stopped the run');
  await new Promise((resolve) => setTimeout(resolve, 9000));
  assert.equal(fs.existsSync(marker), false, 'the child was stopped with the cmd that started it');
  const exited = await runCmd('exit 3');
  assert.deepEqual([exited.status, exited.timedOut], [3, false], 'a program that exits by itself keeps its status');
});