// Shared by the developer-script tests (T-48 to T-50): where the scripts are, how Windows PowerShell 5.1 and
// cmd run them, and per-test sandboxes. DEVELOPER_SCRIPTS_DIR points the tests at a copy of the scripts, which is
// how tests/mutate-developer.ps1 runs them against mutants without touching the tree.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProgramAsync } from '../../infra/azure-test/lib/spawn.mjs';
import { startFakeGateway } from './fake-gateway.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const scripts = process.env.DEVELOPER_SCRIPTS_DIR ?? path.join(root, 'scripts', 'developer');
export const windowsPowerShell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const pwsh = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
// CGW_REQUIRE_WINDOWS=1 (the Windows CI job) turns these skips into failures, so a missing platform cannot pass as green.
export const skip = process.platform !== 'win32' && !process.env.CGW_REQUIRE_WINDOWS && 'Windows PowerShell 5.1, cmd and DPAPI';

// A fresh directory with a space in its path, as under many Windows profiles; removed after the test. Its long path: a
// GitHub-hosted runner's temporary directory is under C:\Users\RUNNER~1, and the installer writes the long form (U-55).
export function sandbox(t, label = 'cgw dev ') {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), label)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export async function gateway(t, script) {
  const fake = await startFakeGateway(script);
  t.after(() => fake.close());
  return fake;
}

// The PowerShell statements that end a run with pipeline logging on: a logged Write-Output of a random end marker, then
// a poll of this process's 4103 events from $start until the marker's binding has arrived or 60 seconds have passed,
// written to out. The log is machine-wide and delivers asynchronously, so a fixed sleep could read it before the run's
// events arrived (QA review, round 4). The marker is made inside PowerShell: every event quotes the command line, so a
// marker written into it would be in every event. The test requires END_MARKER in the written log.
export const END_MARKER = /ParameterBinding\(Write-Output\): name="InputObject"; value="CGW-END-[0-9a-f]{32}"/;
export function collectEventLog(out) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const events = "@(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-PowerShell/Operational'; Id = 4103; StartTime = $start } -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -eq $PID })";
  return [
    "$end = 'CGW-END-' + [guid]::NewGuid().ToString('N')",
    'Write-Output $end | Out-Null',
    `$deadline = (Get-Date).AddSeconds(60); do { Start-Sleep -Milliseconds 500; $events = ${events} } until (@($events | Where-Object { "$($_.Message)".Contains("value=\`"$end\`"") }).Count -or (Get-Date) -gt $deadline)`,
    `$events | ForEach-Object { $_.Message } | Set-Content -LiteralPath ${q(out)} -Encoding UTF8`,
  ];
}

// Runs a script file the way the apiKeyHelper command does: -NoProfile -NonInteractive, no shell.
// ANTHROPIC_BASE_URL is not inherited: the helper refuses a value that names another host, and a developer shell may set one.
const inherited = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'ANTHROPIC_BASE_URL'));
export const runScript = (file, args, env = {}, shell = windowsPowerShell) => runProgramAsync(shell,
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
  { env: { ...inherited(), ...env }, timeoutMs: 120_000 });

// Runs a command line through cmd.exe as Node's shell option does: cmd /d /s /c "<line>", arguments verbatim.
// On timeout the whole process tree is stopped, because a program cmd started would otherwise outlive it, and the
// result has timedOut set: the status of a stopped tree comes from taskkill, not from the program (QA follow-up review
// of the live-run fixes).
// The default stays below the 150-second test timeout of tests/mutate-developer.ps1, so the tree is stopped first.
export function runCmd(line, { env = process.env, cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
      ['/d', '/s', '/c', `"${line}"`], { env, cwd, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, timedOut }); });
  });
}

// The environment with cmd's default command search: NoDefaultCurrentDirectoryInExePath, when set, stops cmd from
// looking in the current directory first, which would hide the hazard a planted-file test checks for.
export function withDefaultCmdSearch(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.toLowerCase() !== 'nodefaultcurrentdirectoryinexepath'));
}

// A LOCALAPPDATA of its own, with a space in its path.
export const localAppData = (t) => path.join(sandbox(t, 'cgw helper '), 'Local AppData');
export const connect = (fake, local, extra = ['-Force'], shell = windowsPowerShell) =>
  runScript(path.join(scripts, 'Connect-ClaudeGateway.ps1'), ['-GatewayUrl', fake.origin, '-NoBrowser', ...extra], { LOCALAPPDATA: local }, shell);
// With the gateway as ANTHROPIC_BASE_URL, as the profile sets it for Claude Code.
export const getToken = (fake, local, env = {}) => runScript(path.join(scripts, 'Get-ClaudeGatewayToken.ps1'), ['-GatewayUrl', fake.origin],
  { LOCALAPPDATA: local, ANTHROPIC_BASE_URL: fake.origin, ...env });

// A console program that receives arguments the way a C runtime parses its command line, so a test sees the arguments
// claude.exe would get. It prints each on its own line after ARGV:, or, when CGW_ARGV_OUT names a file, writes them there
// as UTF-8, one per line, which no console code page can change. Compiled with Add-Type, which Windows PowerShell 5.1 runs
// with the .NET Framework compiler; the source travels in an environment variable, so no command line quotes it.
export function compileArgvPrinter(file) {
  const source = [
    'public static class P { public static void Main(string[] a) {',
    '  string o = System.Environment.GetEnvironmentVariable("CGW_ARGV_OUT");',
    '  if (!string.IsNullOrEmpty(o)) { System.IO.File.WriteAllText(o, string.Join("\\n", a), new System.Text.UTF8Encoding(false)); return; }',
    '  System.Console.WriteLine("ARGV:"); foreach (string s in a) System.Console.WriteLine(s);',
    '} }',
  ].join('\n');
  const r = spawnSync(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -OutputType ConsoleApplication -OutputAssembly $env:CGW_STUB -TypeDefinition $env:CGW_STUB_SOURCE'],
  { env: { ...process.env, CGW_STUB: file, CGW_STUB_SOURCE: source }, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  return file;
}

export function sessionFiles(local) {
  const dir = path.join(local, 'ClaudeAppsGateway', 'sessions');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.bin')).map((f) => path.join(dir, f)) : [];
}

// Decrypts a session file independently of the scripts, with the entropy the module documents.
export async function unprotect(file, origin) {
  const command = "Add-Type -AssemblyName System.Security; $b = [IO.File]::ReadAllBytes($env:CGW_FILE); "
    + "$e = [Text.Encoding]::UTF8.GetBytes('claude-apps-gateway/v1 ' + $env:CGW_ORIGIN); "
    + "[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b, $e, 'CurrentUser')))";
  const r = await runProgramAsync(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-Command', command],
    { env: { ...process.env, CGW_FILE: file, CGW_ORIGIN: origin }, timeoutMs: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// DPAPI blob header, measured 2026-09-28 in Windows PowerShell 5.1: version 1 at offset 0, the provider GUID
// df9d8cd0-1501-11d1-8c7a-00c04fc297eb at 4-19, and flags at 40, where 0x4 is CRYPTPROTECT_LOCAL_MACHINE.
export function assertUserScopedDpapi(bytes) {
  assert.equal(bytes.readUInt32LE(0), 1, 'DPAPI blob version');
  assert.equal(bytes.subarray(4, 20).toString('hex'), 'd08c9ddf0115d1118c7a00c04fc297eb', 'DPAPI provider GUID');
  assert.equal(bytes.readUInt32LE(40) & 0x4, 0, 'protected for the Windows user, not the machine');
}

export const holds = (bytes, secret) => bytes.includes(Buffer.from(secret, 'utf8')) || bytes.includes(Buffer.from(secret, 'utf16le'));

// Runs a script in a session whose Start-Process is a function that records its -FilePath, so a test sees what the
// script would open without opening a browser. A function takes precedence over the cmdlet of the same name.
export function runWithRecordedStartProcess(file, args, env, record) {
  // Parameter names stay bare; every value is a single-quoted literal.
  const quoted = [file, ...args].map((a, i) => (i > 0 && /^-[A-Za-z]+$/.test(a) ? a : `'${String(a).replace(/'/g, "''")}'`));
  const command = `function Start-Process { param([string]$FilePath) Add-Content -LiteralPath $env:CGW_OPENED -Value $FilePath }; & ${quoted[0]} ${quoted.slice(1).join(' ')}; exit $LASTEXITCODE`;
  return runProgramAsync(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { env: { ...process.env, ...env, CGW_OPENED: record }, timeoutMs: 120_000 });
}

// openssl from Git for Windows, used to make a throwaway certificate for the intercepting proxy below.
export const openssl = [process.env.CGW_OPENSSL, path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe')].find((p) => p && fs.existsSync(p)) ?? null;

// An HTTP proxy that terminates TLS for one host with a one-day self-signed certificate, which only a client given
// NODE_EXTRA_CA_CERTS=caPath trusts. It records each request line and whether any of secrets() appears in its
// Authorization or X-Api-Key header, answers 404, and refuses tunnels to every other host.
export async function startInterceptingProxy(t, host, secrets) {
  const dir = sandbox(t, 'cgw tls ');
  const [key, cert] = [path.join(dir, 'key.pem'), path.join(dir, 'cert.pem')];
  const made = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
    '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`], { encoding: 'utf8', windowsHide: true });
  assert.equal(made.status, 0, made.stderr);
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({ host: req.headers.host, line: `${req.method} ${req.url}` }); res.writeHead(403); res.end(); });
  server.on('connect', (req, socket) => {
    if (req.url !== `${host}:443`) { seen.push({ host: req.url, line: 'CONNECT refused' }); return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const secure = new tls.TLSSocket(socket, { isServer: true, key: fs.readFileSync(key), cert: fs.readFileSync(cert) });
    let head = '';
    secure.on('error', () => {});
    secure.on('data', (chunk) => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      const [line, ...fields] = head.slice(0, end).split('\r\n');
      const headers = Object.fromEntries(fields.map((f) => [f.slice(0, f.indexOf(':')).toLowerCase(), f.slice(f.indexOf(':') + 1).trim()]));
      const carries = (value) => typeof value === 'string' && secrets().some((s) => value.includes(s));
      seen.push({ host, line: line.split('?')[0], token: carries(headers.authorization) || carries(headers['x-api-key']) });
      secure.end('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
      head = '';
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}`, caPath: cert, seen };
}

// Starts a script like runScript, with its stderr readable while it runs, so a test can wait for a line it prints.
export function startScript(file, args, env = {}) {
  const child = spawn(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
    { env: { ...inherited(), ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  return { stderr: () => stderr, done };
}