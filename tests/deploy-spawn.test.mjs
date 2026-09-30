import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ensureAbsolute, failureMessage, resolveAzCommand, resolveClaudeCommand, runProgramAsync } from '../infra/azure-test/lib/spawn.mjs';
import { assertNoSecretIn, clearSecrets, redactSecrets, registerSecret } from '../infra/azure-test/lib/secrets.mjs';

const present = (...paths) => {
  const set = new Set(paths);
  return (p) => set.has(p);
};

// Resolver cases vendored from tests/runner.test.mjs:176-241 of the owner's CODEX project (U-68).
describe('resolveAzCommand', () => {
  const AZ_DIR = 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin';
  const AZ_PYTHON = path.win32.resolve(AZ_DIR, '..', 'python.exe');

  test('resolves the MSI wrapper to its python entry, not a bare name', { skip: process.platform !== 'win32' && 'Windows paths' }, () => {
    const r = resolveAzCommand({ platform: 'win32', env: { PATH: AZ_DIR }, exists: present(path.join(AZ_DIR, 'az.cmd'), AZ_PYTHON) });
    assert.equal(r.command, AZ_PYTHON);
    assert.deepEqual(r.prefixArgs, ['-IBm', 'azure.cli']);
    assert.equal(r.extraEnv.AZ_INSTALLER, 'MSI');
  });

  test('ignores empty and relative PATH entries, which resolve from the current directory', () => {
    for (const entry of ['', '.', '..', 'bin', './tools']) {
      assert.throws(() => resolveAzCommand({ platform: 'win32', env: { PATH: entry }, exists: () => true }), /Azure CLI not found/,
        `PATH entry ${JSON.stringify(entry)} was searched`);
    }
  });

  test('refuses a wrapper without its python entry, and an AZ_BIN that does not exist', { skip: process.platform !== 'win32' && 'Windows paths' }, () => {
    assert.throws(() => resolveAzCommand({ platform: 'win32', env: { PATH: AZ_DIR }, exists: present(path.join(AZ_DIR, 'az.cmd')) }), /Azure CLI not found/);
    assert.throws(() => resolveAzCommand({ platform: 'win32', env: { AZ_BIN: 'C:\\nope\\az.exe', PATH: AZ_DIR }, exists: present() }), /C:\\nope\\az\.exe/);
  });

  test('ensureAbsolute refuses a bare command name', () => {
    assert.throws(() => ensureAbsolute({ command: 'az', prefixArgs: [] }), /absolute path/);
  });
});

describe('resolveClaudeCommand', () => {
  const NPM = 'C:\\Users\\x\\AppData\\Roaming\\npm';
  const EXE = path.join(NPM, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

  test('finds the native claude.exe behind the npm .cmd shim', { skip: process.platform !== 'win32' && 'Windows paths' }, () => {
    const r = resolveClaudeCommand({ platform: 'win32', env: { PATH: NPM }, exists: present(path.join(NPM, 'claude.cmd'), EXE) });
    assert.equal(r.command, EXE);
    assert.deepEqual(r.prefixArgs, []);
  });

  test('honours CLAUDE_BIN only when it exists, and ignores relative PATH entries', () => {
    assert.throws(() => resolveClaudeCommand({ platform: 'win32', env: { CLAUDE_BIN: 'C:\\nope\\claude.exe' }, exists: present() }), /CLAUDE_BIN/);
    assert.throws(() => resolveClaudeCommand({ platform: 'win32', env: { PATH: '.' }, exists: () => true }), /Claude Code not found/);
  });
});

describe('secret registry', () => {
  afterEach(() => clearSecrets());

  test('a registered secret in any az argument stops the call', () => {
    registerSecret('0123456789abcdef');
    assert.throws(() => assertNoSecretIn(['containerapp', 'secret', 'set', '--secrets', 'x=0123456789abcdef']), /secret/);
    assert.doesNotThrow(() => assertNoSecretIn(['group', 'show', '--name', 'rg-claude-apps-gateway-test']));
  });

  test('a failure message redacts before it truncates, so no fragment of a secret survives the cut', () => {
    const secret = registerSecret('s3cr3t-' + 'q'.repeat(30) + '-tail');
    const message = failureMessage(['acr', 'build', '--registry', 'x'], 1, 'A'.repeat(20) + secret + 'B'.repeat(1490));
    for (let i = 0; i + 12 <= secret.length; i++) assert.ok(!message.includes(secret.slice(i, i + 12)), 'no 12-character piece of the secret');
    assert.match(message, /^az acr build exited with 1: /);
    assert.equal(failureMessage(['group', 'show'], 3), 'az group show exited with 3');
  });

  test('registered secrets are redacted from text, and short or empty values are refused', () => {
    registerSecret('fedcba9876543210');
    assert.equal(redactSecrets('error near fedcba9876543210'), 'error near [redacted]');
    assert.throws(() => registerSecret('short'), /8 characters/);
    assert.throws(() => registerSecret(''), /8 characters/);
  });
});

test('runProgramAsync runs without a shell and leaves the event loop free while the program runs', async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 10);
  const r = await runProgramAsync(process.execPath, ['-e', 'setTimeout(() => { console.log(process.argv[1]); process.exit(3); }, 300)', 'a&echo hi %PATH%']);
  clearInterval(timer);
  assert.deepEqual({ status: r.status, stdout: r.stdout.trim(), timedOut: r.timedOut }, { status: 3, stdout: 'a&echo hi %PATH%', timedOut: false });
  assert.ok(ticks >= 5, `the event loop ran ${ticks} times while the program ran`);
});

test('runProgramAsync stops a program that outlives its timeout and reports it', async () => {
  const started = Date.now();
  const r = await runProgramAsync(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.status, 0);
  assert.ok(Date.now() - started < 10_000, 'it returned soon after the timeout');
  await assert.rejects(runProgramAsync(path.join(process.cwd(), 'no-such-program.exe'), []), /ENOENT/);
});