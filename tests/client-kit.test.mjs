// T-124 (docs/TEST-PLAN.md): the client files, one function for new-client-policy.mjs and the admin console's
// GET /api/client-kit, with the Claude Desktop policy as a .reg file and an Intune platform script (P-41).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { handleApi } from '../admin-ui/server/api.mjs';
import { readZip, zipFiles } from '../admin-ui/server/client-kit.mjs';
import { clientPolicyFiles } from '../scripts/admin/new-client-policy.mjs';

const root = path.join(import.meta.dirname, '..');
const ORIGIN = 'https://gw.contoso.example';
const kit = () => clientPolicyFiles({ origin: ORIGIN, fastModel: 'claude-sonnet-5', model: 'claude-sonnet-5' });
const bytes = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v));

test('T-124 the client files hold login, developer, intune and desktop folders', () => {
  const files = Object.keys(kit());
  for (const f of ['login/managed-settings.json', 'login/ClaudeCode-HKLM.reg', 'login/ClaudeCode.mobileconfig', 'developer/START-HERE.txt',
    'developer/Install-ClaudeGatewayProfile.ps1', 'intune/INTUNE.txt', 'intune/2-gateway-profile/Install-Profile.ps1',
    'desktop/ClaudeDesktop-HKLM.reg', 'desktop/Set-ClaudeDesktopPolicy.ps1', 'desktop/DESKTOP.txt', 'New-IntunePackage.ps1']) {
    assert.ok(files.includes(f), `${f} is missing from ${files.join(', ')}`);
  }
});

test('T-124 ClaudeDesktop-HKLM.reg sets bootstrapUrl under HKLM\\SOFTWARE\\Policies\\Claude, as regedit exports it', () => {
  const reg = bytes(kit()['desktop/ClaudeDesktop-HKLM.reg']);
  assert.deepEqual([...reg.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(reg.subarray(2).toString('utf16le'), [
    'Windows Registry Editor Version 5.00', '', '[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Claude]',
    `"bootstrapUrl"="${ORIGIN}/user/bootstrap"`, ''].join('\r\n'));
});

test('T-124 DESKTOP.txt gives the Intune platform-script settings, 64-bit host included', () => {
  const text = String(kit()['desktop/DESKTOP.txt']);
  for (const s of ['Platform scripts', 'Set-ClaudeDesktopPolicy.ps1', 'Run this script using the logged on credentials: No',
    'Run script in 64-bit PowerShell host: Yes', `${ORIGIN}/user/bootstrap`, 'ClaudeDesktop-HKLM.reg']) {
    assert.ok(text.includes(s), `DESKTOP.txt lacks "${s}"`);
  }
});

const windowsPowerShell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const wow64PowerShell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

test('T-124 Set-ClaudeDesktopPolicy.ps1 writes bootstrapUrl, and refuses a 32-bit host on 64-bit Windows', { skip: process.platform !== 'win32' && 'Windows PowerShell only' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-policy-'));
  const script = path.join(dir, 'Set-ClaudeDesktopPolicy.ps1');
  fs.writeFileSync(script, kit()['desktop/Set-ClaudeDesktopPolicy.ps1']);
  const key = `HKCU:\\Software\\ClaudeGatewayTest\\T124-${process.pid}`;
  try {
    const ok = spawnSync(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Key', key], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    const read = spawnSync(windowsPowerShell, ['-NoProfile', '-Command', `(Get-ItemProperty -LiteralPath '${key}').bootstrapUrl`], { encoding: 'utf8' });
    assert.equal(read.stdout.trim(), `${ORIGIN}/user/bootstrap`);
    if (fs.existsSync(wow64PowerShell)) {
      const wow = spawnSync(wow64PowerShell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Key', `${key}-wow`], { encoding: 'utf8' });
      assert.equal(wow.status, 1, 'a 32-bit host must be refused');
      assert.match(wow.stderr + wow.stdout, /64-bit/);
    }
  } finally {
    spawnSync(windowsPowerShell, ['-NoProfile', '-Command', "Remove-Item -LiteralPath 'HKCU:\\Software\\ClaudeGatewayTest' -Recurse -Force -ErrorAction SilentlyContinue"]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-124 new-client-policy.mjs writes exactly the files clientPolicyFiles returns', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'client-policy-'));
  try {
    const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'admin', 'new-client-policy.mjs'), '--gateway-url', ORIGIN,
      '--fast-model', 'claude-sonnet-5', '--model', 'claude-sonnet-5', '--out', out, '--force'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const written = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else written.push(path.relative(out, p).split(path.sep).join('/')); } };
    walk(out);
    const expected = kit();
    assert.deepEqual(written.sort(), Object.keys(expected).sort());
    for (const [rel, content] of Object.entries(expected)) assert.ok(fs.readFileSync(path.join(out, ...rel.split('/'))).equals(bytes(content)), rel);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('T-124 zipFiles round-trips every file with its CRC, and readZip refuses a damaged archive', () => {
  const files = kit();
  const zip = zipFiles(files);
  const back = readZip(zip);
  assert.deepEqual(Object.keys(back).sort(), Object.keys(files).sort());
  for (const [rel, content] of Object.entries(files)) assert.ok(back[rel].equals(bytes(content)), rel);
  const damaged = Buffer.from(zip);
  damaged[60] ^= 0xff;
  assert.throws(() => readZip(damaged), /CRC|inflate|invalid/i);
});

test('T-124 Windows tar extracts the zip the console serves', { skip: process.platform !== 'win32' && 'Windows bsdtar only' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-zip-'));
  try {
    fs.writeFileSync(path.join(dir, 'client-policy.zip'), zipFiles(kit()));
    const run = spawnSync('tar', ['-xf', 'client-policy.zip'], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(fs.readFileSync(path.join(dir, 'desktop', 'ClaudeDesktop-HKLM.reg')).equals(bytes(kit()['desktop/ClaudeDesktop-HKLM.reg'])));
    assert.ok(fs.existsSync(path.join(dir, 'New-IntunePackage.ps1')), 'New-IntunePackage.ps1 is not at the root of the zip');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const req = (pathAndQuery, headers = {}) => {
  const [pathname, qs] = pathAndQuery.split('?');
  return { method: 'GET', pathname, searchParams: new URLSearchParams(qs ?? ''), headers };
};
const deps = (over = {}) => ({ clientKit: { origin: async () => ORIGIN, models: async () => ['claude-sonnet-5', 'claude-opus-5'], ...over } });

test('T-124 GET /api/client-kit answers the whole kit as a zip for the gateway\'s address', async () => {
  const res = await handleApi(req('/api/client-kit?model=claude-sonnet-5&fastModel=claude-sonnet-5'), deps());
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'application/zip');
  assert.equal(res.headers['Content-Disposition'], 'attachment; filename="client-policy.zip"');
  const back = readZip(res.raw);
  assert.ok(back['desktop/ClaudeDesktop-HKLM.reg'].equals(bytes(kit()['desktop/ClaudeDesktop-HKLM.reg'])));
  assert.ok(String(back['intune/INTUNE.txt']).includes(ORIGIN));
});

test('T-124 GET /api/client-kit?file= answers that one file, by its own name', async () => {
  const res = await handleApi(req('/api/client-kit?model=claude-opus-5&file=desktop/ClaudeDesktop-HKLM.reg'), deps());
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Disposition'], 'attachment; filename="ClaudeDesktop-HKLM.reg"');
  assert.ok(res.raw.equals(bytes(kit()['desktop/ClaudeDesktop-HKLM.reg'])));
  const json = await handleApi(req('/api/client-kit?model=claude-opus-5&file=login/managed-settings.json'), deps());
  assert.deepEqual(JSON.parse(json.raw), { forceLoginMethod: 'gateway', forceLoginGatewayUrl: ORIGIN, parentSettingsBehavior: 'merge' });
});

test('T-124 GET /api/client-kit refuses a missing or unknown model, an unknown file and a gateway without an address', async () => {
  assert.equal((await handleApi(req('/api/client-kit'), deps())).status, 400);
  assert.equal((await handleApi(req('/api/client-kit?model=gpt-9'), deps())).status, 400);
  assert.equal((await handleApi(req('/api/client-kit?model=claude-sonnet-5&fastModel=gpt-9'), deps())).status, 400);
  assert.equal((await handleApi(req('/api/client-kit?model=claude-sonnet-5&file=../../server/server.mjs'), deps())).status, 404);
  assert.equal((await handleApi(req('/api/client-kit?model=claude-sonnet-5'), deps({ origin: async () => null }))).status, 503);
  assert.equal((await handleApi(req('/api/client-kit?model=claude-sonnet-5'), {})).status, 503);
});

test('T-124 GET /api/client-kit is for administrators only when sign-in is on', async () => {
  const principal = Buffer.from(JSON.stringify({ auth_typ: 'aad', claims: [{ typ: 'name', val: 'Dev' }] })).toString('base64');
  const res = await handleApi(req('/api/client-kit?model=claude-sonnet-5', { 'x-ms-client-principal': principal }), { ...deps(), auth: { signIn: 'required' } });
  assert.equal(res.status, 403);
});

// The admin-ui image copies only some folders (admin-ui/Dockerfile); a module the server imports from elsewhere would
// crash the container at start, not in any test that runs from the repository.
test('T-124 the admin-ui image holds every module the server imports', () => {
  const docker = fs.readFileSync(path.join(root, 'admin-ui', 'Dockerfile'), 'utf8');
  const copied = [...docker.matchAll(/^COPY\s+(\S+)\s+\S+/gm)].map((m) => path.join(root, m[1]));
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/^\s*import\s[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)) visit(path.resolve(path.dirname(file), m[1]));
  };
  visit(path.join(root, 'admin-ui', 'server', 'server.mjs'));
  const outside = [...seen].filter((f) => !copied.some((c) => f === c || f.startsWith(c + path.sep))).map((f) => path.relative(root, f));
  assert.deepEqual(outside, []);
  assert.ok([...seen].some((f) => f.endsWith(`client-kit.mjs`)), 'server.mjs does not reach client-kit.mjs');
});

