// Launches az and claude without a shell. searchPath, ensureAbsolute and resolveAzCommand are vendored
// from src/runner.mjs:29-152 of the owner's CODEX project (its ADR-0003; U-68): on Windows `az` is a
// .cmd wrapper, which Node spawns only through cmd.exe, and cmd.exe re-parses arguments, expands %VAR%
// inside quotes and resolves a bare name from the current directory before PATH. Resolving the Python
// entry behind the wrapper, and the native claude.exe behind the npm shim, removes the shell.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { assertNoSecretIn, redactSecrets } from './secrets.mjs';

function searchPath(env) {
  const raw = env.PATH ?? env.Path ?? env.path ?? '';
  // An empty entry means the current directory on Windows, and a relative entry collapses to a bare
  // name that libuv resolves from the current directory before PATH, so only absolute entries count.
  return raw.split(path.delimiter).map((entry) => entry.trim()).filter((entry) => entry !== '' && path.isAbsolute(entry));
}

export function ensureAbsolute(result) {
  if (!path.isAbsolute(result.command)) {
    throw new Error(`refusing to spawn "${result.command}": a command must resolve to an absolute path`);
  }
  return result;
}

export function resolveAzCommand({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const override = env.AZ_BIN?.trim();
  if (override) {
    if (!exists(override)) throw new Error(`AZ_BIN is set to "${override}", which does not exist.`);
    return ensureAbsolute({ command: path.resolve(override), prefixArgs: [], extraEnv: {} });
  }
  const dirs = searchPath(env);
  if (platform === 'win32') {
    for (const dir of dirs) {
      const exe = path.join(dir, 'az.exe');
      if (exists(exe)) return ensureAbsolute({ command: exe, prefixArgs: [], extraEnv: {} });
    }
    for (const dir of dirs) {
      if (!exists(path.join(dir, 'az.cmd'))) continue;
      const python = path.resolve(dir, '..', 'python.exe');
      if (exists(python)) return ensureAbsolute({ command: python, prefixArgs: ['-IBm', 'azure.cli'], extraEnv: { AZ_INSTALLER: 'MSI' } });
    }
  } else {
    for (const dir of dirs) {
      const file = path.join(dir, 'az');
      if (exists(file)) return ensureAbsolute({ command: file, prefixArgs: [], extraEnv: {} });
    }
  }
  throw new Error('Azure CLI not found. Install it: https://learn.microsoft.com/cli/azure/install-azure-cli (or set AZ_BIN to the executable).');
}

// Claude Code: the native installer's claude.exe, or the native binary the npm package's claude.cmd runs.
export function resolveClaudeCommand({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const override = env.CLAUDE_BIN?.trim();
  if (override) {
    if (!exists(override)) throw new Error(`CLAUDE_BIN is set to "${override}", which does not exist.`);
    return ensureAbsolute({ command: path.resolve(override), prefixArgs: [] });
  }
  const dirs = searchPath(env);
  if (platform === 'win32') {
    for (const dir of dirs) {
      const exe = path.join(dir, 'claude.exe');
      if (exists(exe)) return ensureAbsolute({ command: exe, prefixArgs: [] });
    }
    for (const dir of dirs) {
      if (!exists(path.join(dir, 'claude.cmd'))) continue;
      const exe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (exists(exe)) return ensureAbsolute({ command: exe, prefixArgs: [] });
    }
  } else {
    for (const dir of dirs) {
      const file = path.join(dir, 'claude');
      if (exists(file)) return ensureAbsolute({ command: file, prefixArgs: [] });
    }
  }
  throw new Error('Claude Code not found on PATH (or set CLAUDE_BIN to the executable).');
}

// Runs a resolved program with an argument vector and no shell. Output is captured unless inherit is set.
export function runProgram(command, args, { env = process.env, inherit = false, timeoutMs } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// runProgram without blocking the event loop, which keeps serving, for example, the loopback relay the
// program talks to (tests/live/lib.mjs, startCaptureRelay). No shell. A program that outlives timeoutMs
// is stopped and reported with timedOut.
export function runProgramAsync(command, args, { env = process.env, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs) : null;
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, timedOut }); });
  });
}

// Redacts the whole output before it is shortened: a secret cut in half would no longer match.
export function failureMessage(args, status, stderr) {
  const tail = stderr === undefined ? '' : `: ${redactSecrets(stderr).trim().slice(-1500)}`;
  return redactSecrets(`az ${args.slice(0, 2).join(' ')} exited with ${status}${tail}`);
}

export function runAz(args, { inherit = false, allowFailure = false } = {}) {
  assertNoSecretIn(args);
  const { command, prefixArgs, extraEnv } = resolveAzCommand();
  const result = runProgram(command, [...prefixArgs, ...args], { env: { ...process.env, ...extraEnv }, inherit });
  if (result.status !== 0 && !allowFailure) throw new Error(failureMessage(args, result.status, inherit ? undefined : result.stderr));
  return result;
}

export function azJson(args) {
  const { stdout } = runAz([...args, '--output', 'json']);
  return stdout.trim() ? JSON.parse(stdout) : null;
}
