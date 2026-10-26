// T-120 (P-39): the Intune package new-client-policy.mjs writes for a gateway on a public address, where Claude Code's
// /login cannot be forced (https://code.claude.com/docs/en/claude-apps-gateway#prerequisites) and developers use the
// gateway profile instead. Two Win32 apps: Claude Code, pinned and checksum-checked, then the profile, installed per
// user without signing in. The scripts run here in Windows PowerShell 5.1, the host Intune runs them in, against a
// sandboxed user profile.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLAUDE_CODE_WINDOWS, intuneFiles } from '../scripts/admin/intune-package.mjs';
import { pwsh as pwshPath, runScript, sandbox, skip } from './developer/harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://ca-claude-gw.example.eastus2.azurecontainerapps.io';

function writePackage(dir, origin = ORIGIN) {
  for (const [rel, content] of Object.entries(intuneFiles({ origin, fastModel: 'claude-sonnet-5' }))) {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

test('T-120 the package holds two Win32 app folders and INTUNE.txt with every field Intune asks for', () => {
  const files = Object.keys(intuneFiles({ origin: ORIGIN }));
  for (const f of ['1-claude-code/Install-ClaudeCode.ps1', '1-claude-code/Uninstall-ClaudeCode.ps1',
    '2-gateway-profile/Install-Profile.ps1', '2-gateway-profile/Uninstall-Profile.ps1', '2-gateway-profile/Detect-Profile.ps1',
    '2-gateway-profile/Install-ClaudeGatewayProfile.ps1', '2-gateway-profile/ClaudeGateway.psm1', 'INTUNE.txt']) {
    assert.ok(files.includes(f), f);
  }
  const text = intuneFiles({ origin: ORIGIN })['INTUNE.txt'];
  for (const field of ['Install command', 'Uninstall command', 'Install behavior', 'Detection rules', 'Dependencies', 'IntuneWinAppUtil.exe']) assert.match(text, new RegExp(field), field);
  assert.match(text, /Install behavior: System/);
  assert.match(text, /Install behavior: User/);
  assert.match(text, /Sysnative/, '64-bit PowerShell, as Intune documents for the install command');
  assert.match(text, new RegExp(ORIGIN.replace(/[.]/g, '\\.')));
});

test('P-39 the SYSTEM install logs inside its Program Files folder, which standard users cannot redirect', () => {
  const script = intuneFiles({ origin: 'https://gw.example.com' })['1-claude-code/Install-ClaudeCode.ps1'];
  assert.match(script, /\[string\]\$LogFile = \(Join-Path \$InstallDir 'install-claude-code\.log'\)/);
  assert.doesNotMatch(script, /ProgramData/, 'no write under the user-creatable %ProgramData%');
});

test('P-39 another Claude Code release is packaged from its version and SHA-256, without editing source', () => {
  const files = intuneFiles({ origin: 'https://gw.example.com', claude: { version: '2.1.290', sha256: 'a'.repeat(64) } });
  assert.match(files['1-claude-code/Install-ClaudeCode.ps1'], /claude-code-releases\/2\.1\.290\/win32-x64\/claude\.exe/);
  assert.match(files['1-claude-code/Install-ClaudeCode.ps1'], new RegExp(`'${'a'.repeat(64)}'`));
  assert.match(files['1-claude-code/Install-ClaudeCode.ps1'], /claude-code-2\.1\.290\.installed/);
  assert.ok(files['INTUNE.txt'].includes('File or folder: claude-code-2.1.290.installed'));
  assert.throws(() => intuneFiles({ origin: 'https://gw.example.com', claude: { version: '2.1.290', sha256: 'xyz' } }), /SHA-256/);
  assert.throws(() => intuneFiles({ origin: 'https://gw.example.com', claude: { version: 'latest', sha256: 'a'.repeat(64) } }), /version/);
});

test('T-120 the Claude Code pin is the one the network-restricted deployment uses, so the two cannot drift', () => {
  const deploy = fs.readFileSync(path.join(root, 'infra', 'azure-private', 'Deploy-Gateway.ps1'), 'utf8');
  assert.equal(CLAUDE_CODE_WINDOWS.version, /ClaudeCodeVersion = '([^']+)'/.exec(deploy)[1]);
  assert.equal(CLAUDE_CODE_WINDOWS.sha256, /ClaudeCodeWindowsSha256 = '([0-9a-f]{64})'/.exec(deploy)[1]);
  const install = intuneFiles({ origin: ORIGIN })['1-claude-code/Install-ClaudeCode.ps1'];
  assert.match(install, new RegExp(`claude-code-releases/${CLAUDE_CODE_WINDOWS.version.replace(/[.]/g, '\\.')}/win32-x64/claude\\.exe`));
  assert.match(install, new RegExp(CLAUDE_CODE_WINDOWS.sha256));
});

test('T-120 Install-ClaudeCode.ps1 keeps a file whose checksum matches and deletes one that does not', { skip }, async (t) => {
  const dir = writePackage(sandbox(t));
  const install = path.join(dir, '1-claude-code', 'Install-ClaudeCode.ps1');
  const source = path.join(dir, 'source.exe');
  fs.writeFileSync(source, 'not really claude');
  const good = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const target = path.join(dir, 'Program Files', 'Anthropic', 'ClaudeCode');
  const log = path.join(target, 'install-claude-code.log');
  const env = { ProgramData: path.join(dir, 'ProgramData') };
  const bad = await runScript(install, ['-SourceUrl', `file:///${source.replace(/\\/g, '/')}`, '-Sha256', '0'.repeat(64), '-InstallDir', target], env);
  assert.notEqual(bad.status, 0);
  assert.match(fs.readFileSync(log, 'utf8'), /failed: The download has checksum/, 'the reason is in the install log, which Intune does not keep');
  assert.match(bad.stderr + bad.stdout, /checksum/);
  assert.equal(fs.existsSync(path.join(target, 'claude.exe')), false, 'a file with the wrong checksum is removed');
  const marker = `claude-code-${CLAUDE_CODE_WINDOWS.version}.installed`;
  assert.equal(fs.existsSync(path.join(target, marker)), false, 'no release marker without a matching checksum');
  fs.writeFileSync(path.join(target, 'claude-code-0.0.1.installed'), 'old');
  const ok = await runScript(install, ['-SourceUrl', `file:///${source.replace(/\\/g, '/')}`, '-Sha256', good, '-InstallDir', target], env);
  assert.match(fs.readFileSync(log, 'utf8'), /installed .*claude\.exe/);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.readFileSync(path.join(target, 'claude.exe'), 'utf8'), 'not really claude');
  assert.ok(fs.existsSync(path.join(target, marker)), 'the release marker Intune detects');
  assert.equal(fs.existsSync(path.join(target, 'claude-code-0.0.1.installed')), false, 'an older release marker is removed');
  assert.ok(intuneFiles({ origin: 'https://gw.example.com' })['INTUNE.txt'].includes(`File or folder: ${marker}`), 'INTUNE.txt detects the release marker');
  const un = await runScript(path.join(dir, '1-claude-code', 'Uninstall-ClaudeCode.ps1'), ['-InstallDir', target]);
  assert.equal(un.status, 0, un.stderr);
  assert.equal(fs.existsSync(target), false);
});

test('T-120 the profile app installs without signing in, Detect-Profile.ps1 reports it, and uninstall removes it', { skip }, async (t) => {
  const dir = writePackage(sandbox(t));
  const home = sandbox(t, 'cgw intune home ');
  const env = { USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  const claude = path.join(home, 'claude.exe');
  fs.writeFileSync(claude, '');
  const profileDir = path.join(dir, '2-gateway-profile');
  const detect = () => runScript(path.join(profileDir, 'Detect-Profile.ps1'), [], env);
  const before = await detect();
  assert.equal(before.stdout.trim(), '', 'nothing on STDOUT: Intune reads the app as not installed');
  const install = await runScript(path.join(profileDir, 'Install-Profile.ps1'), ['-ClaudePath', claude], env);
  assert.equal(install.status, 0, install.stderr + install.stdout);
  assert.doesNotMatch(install.stdout, /verification|device code|Opening/i, 'no sign-in during the Intune install');
  const launcher = path.join(home, '.claude-apps-gateway', 'claude-gateway.cmd');
  assert.ok(fs.existsSync(launcher));
  const pinned = JSON.parse(fs.readFileSync(path.join(home, '.claude-apps-gateway', 'gateway.settings.json'), 'utf8'));
  assert.equal(pinned.env.DISABLE_UPDATES, '1', 'the release Intune installs is not replaced by Claude Code itself');
  const signIn = fs.readFileSync(path.join(home, '.claude-apps-gateway', 'sign-in.cmd'), 'utf8');
  const connect = /-File "([^"]+Connect-ClaudeGateway\.ps1)" -GatewayUrl (\S+)/.exec(signIn);
  assert.ok(connect, signIn);
  assert.ok(fs.existsSync(connect[1].replace('%LOCALAPPDATA%', env.LOCALAPPDATA)), 'sign-in.cmd runs the Connect script of the installed runtime');
  assert.equal(connect[2], ORIGIN);
  const after = await detect();
  assert.equal(after.status, 0);
  assert.match(after.stdout, /installed/);
  const un = await runScript(path.join(profileDir, 'Uninstall-Profile.ps1'), [], env);
  assert.equal(un.status, 0, un.stderr);
  assert.equal(fs.existsSync(launcher), false);
  assert.equal((await detect()).stdout.trim(), '');
});

test('T-120 Install-Profile.ps1 fails with a message naming the Claude Code app when claude.exe is missing', { skip }, async (t) => {
  const dir = writePackage(sandbox(t));
  const home = sandbox(t, 'cgw intune home ');
  const env = { USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), ProgramFiles: path.join(home, 'none'), PATH: path.join(process.env.SystemRoot, 'System32') };
  const r = await runScript(path.join(dir, '2-gateway-profile', 'Install-Profile.ps1'), [], env);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /Claude Code/);
  assert.match(fs.readFileSync(path.join(env.LOCALAPPDATA, 'ClaudeAppsGateway', 'install-profile.log'), 'utf8'), /failed: Claude Code was not found/);
});

test('P-39 an App 2 failure inside Install-ClaudeGatewayProfile.ps1 reaches the install log with its reason', { skip }, async (t) => {
  const dir = writePackage(sandbox(t));
  const home = sandbox(t, 'cgw intune fail ');
  const env = { USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  const notExe = path.join(home, 'claude.txt');
  fs.writeFileSync(notExe, '');
  const r = await runScript(path.join(dir, '2-gateway-profile', 'Install-Profile.ps1'), ['-ClaudePath', notExe], env);
  assert.notEqual(r.status, 0);
  assert.match(fs.readFileSync(path.join(env.LOCALAPPDATA, 'ClaudeAppsGateway', 'install-profile.log'), 'utf8'), /failed: .*Install-ClaudeGatewayProfile: ClaudePath/);
});

test('P-39 Install-ClaudeCode.ps1 names a running Claude Code instead of failing on the locked file', { skip }, async (t) => {
  const dir = writePackage(sandbox(t));
  const target = path.join(dir, 'Program Files', 'Anthropic', 'ClaudeCode');
  fs.mkdirSync(target, { recursive: true });
  const running = path.join(target, 'claude.exe');
  fs.copyFileSync(path.join(process.env.SystemRoot, 'System32', 'ping.exe'), running);
  const child = spawn(running, ['-n', '30', '127.0.0.1'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const source = path.join(dir, 'source.exe');
  fs.writeFileSync(source, 'not really claude');
  const good = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const log = path.join(dir, 'install.log');
  const r = await runScript(path.join(dir, '1-claude-code', 'Install-ClaudeCode.ps1'), ['-SourceUrl', `file:///${source.replace(/\\/g, '/')}`, '-Sha256', good, '-InstallDir', target, '-LogFile', log]);
  assert.notEqual(r.status, 0);
  assert.match(fs.readFileSync(log, 'utf8'), /failed: Claude Code is running/);
  } finally {
    child.kill();
    await exited;
  }
});

test('T-120 new-client-policy.mjs writes the intune folder next to login and developer', (t) => {
  const out = path.join(sandbox(t), 'out');
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'admin', 'new-client-policy.mjs'), '--gateway-url', ORIGIN, '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(out, 'intune', 'INTUNE.txt')));
  assert.ok(fs.existsSync(path.join(out, 'intune', '2-gateway-profile', 'Install-Profile.ps1')));
});

// scripts/admin/New-IntunePackage.ps1 runs the Content Prep Tool once per app folder and checks both files came out.
test('T-120 New-IntunePackage.ps1 packages both app folders with the Content Prep Tool and names the two files', { skip }, async (t) => {
  const dir = sandbox(t);
  writePackage(path.join(dir, 'client-policy', 'intune'));
  const log = path.join(dir, 'calls.txt');
  // A stand-in for IntuneWinAppUtil.exe: logs its arguments and writes <setup file name>.intunewin into -o.
  const tool = path.join(dir, 'IntuneWinAppUtil.cmd');
  fs.writeFileSync(tool, ['@echo off', `echo %*>>"${log}"`, 'set "O=%~6"', 'echo x>"%O%\\%~n4.intunewin"', ''].join('\r\n'));
  const out = path.join(dir, 'intunewin');
  fs.mkdirSync(out);
  const r = await runScript(path.join(root, 'scripts', 'admin', 'New-IntunePackage.ps1'), ['-PolicyFolder', path.join(dir, 'client-policy'), '-ToolPath', tool, '-OutputFolder', out], {}, pwshPath);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const calls = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /1-claude-code" -s "?Install-ClaudeCode\.ps1"? -o /);
  assert.match(calls[1], /2-gateway-profile" -s "?Install-Profile\.ps1"? -o /);
  assert.match(r.stdout, /Install-ClaudeCode\.intunewin/);
  assert.match(r.stdout, /Install-Profile\.intunewin/);
  const missing = await runScript(path.join(root, 'scripts', 'admin', 'New-IntunePackage.ps1'), ['-PolicyFolder', path.join(dir, 'nowhere'), '-ToolPath', tool], {}, pwshPath);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr + missing.stdout, /new-client-policy\.mjs/);
});

test('T-120 sign-in.cmd works for a user whose profile path is not ASCII', { skip }, async (t) => {
  const dir = writePackage(sandbox(t));
  const home = sandbox(t, 'cgw José home ');
  const env = { USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  const claude = path.join(env.LOCALAPPDATA, 'claude.exe');
  fs.writeFileSync(claude, '');
  const install = await runScript(path.join(dir, '2-gateway-profile', 'Install-Profile.ps1'), ['-ClaudePath', claude], env);
  assert.equal(install.status, 0, install.stderr + install.stdout);
  const signIn = fs.readFileSync(path.join(home, '.claude-apps-gateway', 'sign-in.cmd'), 'latin1');
  assert.doesNotMatch(signIn, /[^\x00-\x7f]|\?/, 'no character cmd would misread');
  const file = /-File "([^"]+)"/.exec(signIn)[1].replace('%LOCALAPPDATA%', env.LOCALAPPDATA);
  assert.ok(fs.existsSync(file), `${file} exists`);
});

test('T-120 sign-in.cmd names a real file when LOCALAPPDATA ends in a backslash', { skip }, async (t) => {
  const dir = writePackage(sandbox(t));
  const home = sandbox(t, 'cgw José slash ');
  const local = path.join(home, 'AppData', 'Local');
  fs.mkdirSync(local, { recursive: true });
  const env = { USERPROFILE: home, LOCALAPPDATA: local + '\\' };
  const claude = path.join(local, 'claude.exe');
  fs.writeFileSync(claude, '');
  const install = await runScript(path.join(dir, '2-gateway-profile', 'Install-Profile.ps1'), ['-ClaudePath', claude], env);
  assert.equal(install.status, 0, install.stderr + install.stdout);
  const signIn = fs.readFileSync(path.join(home, '.claude-apps-gateway', 'sign-in.cmd'), 'latin1');
  const named = /-File "([^"]+)"/.exec(signIn)[1];
  assert.match(named, /^%LOCALAPPDATA%\\/, 'the path keeps its separator after the variable');
  assert.ok(fs.existsSync(named.replace('%LOCALAPPDATA%', local)), `${named} exists`);
});
