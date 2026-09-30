#!/usr/bin/env node
// Inference through the Claude apps gateway on the Azure test deployment (P-20, and T-51 of P-18; docs/TEST-PLAN.md).
// The session comes from the developer credential helper (scripts/developer, ADR-0004): one browser sign-in with
// Connect-ClaudeGateway.ps1 serves every later run until the gateway refuses the refresh token.
//   node tests/live/inference-suite.mjs [--check models,messages,stream,count,tools,thinking,cache,image,concurrency,latency,profile,agentic]
//     [--samples 20] [--apim-url <APIM route base URL, https, for the APIM half of latency; no default>]
//     [--apim-tenant <tenant of the APIM route's token; default the deployment's tenant>]
// The checks are in inference-checks.mjs and the runner in inference-runner.mjs; this file connects them to the
// gateway, its log, the developer scripts and Claude Code. Every 200 answer on /v1/messages from the gateway, sent by
// a check or by Claude Code through the capture relay, is matched to its inference audit event by x-request-id; the
// APIM route of T-64 has no gateway audit. Results go to tests/live/out/ with statuses, request IDs and event fields
// only; tokens stay in memory and are registered for redaction. A check whose evidence is missing is BLOCKED, never
// PASS. Exit code 0: all PASS; 1: a FAIL; 2: a BLOCKED.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readState } from '../../infra/azure-test/deploy.mjs';
import { redactSecrets, registerSecret } from '../../infra/azure-test/lib/secrets.mjs';
import { runAz, runProgramAsync } from '../../infra/azure-test/lib/spawn.mjs';
import { runCmd } from '../developer/harness.mjs';
import { TESTS, checks } from './inference-checks.mjs';
import { apimBaseUrl, azureAccountProblem, createHelperProfile, createRunner, exitCodeOf } from './inference-runner.mjs';
import { createSend } from './inference-http.mjs';
import { parseLogLines, runThroughRelay } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const { values: opts } = parseArgs({ options: {
  check: { type: 'string', default: Object.keys(TESTS).join(',') },
  'resource-group': { type: 'string', default: 'rg-claude-apps-gateway-test' },
  samples: { type: 'string', default: '20' },
  'apim-url': { type: 'string' },
  'apim-tenant': { type: 'string' },
} });
const state = readState(opts['resource-group']);
if (!state.gatewayFqdn) throw new Error(`no state for ${opts['resource-group']}; run infra/azure-test/deploy.mjs first`);
const base = `https://${state.gatewayFqdn}`;
const SAMPLES = Number(opts.samples);
if (!Number.isInteger(SAMPLES) || SAMPLES < 1 || SAMPLES > 200) throw new Error(`--samples must be a whole number from 1 to 200, not ${opts.samples}`);
const MODELS = JSON.parse(fs.readFileSync(path.join(root, 'config', 'gateway-admin.azure-test.json'), 'utf8')).models.map((m) => m.id);
const FAST = MODELS.at(-1);
const developer = path.join(root, 'scripts', 'developer');
const windowsPowerShell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (m) => console.log(redactSecrets(`[infer] ${m}`));

// The helper prints the token on stdout and exits 0, or names the sign-in command on stderr and exits 1. It prints
// the token only for the base URL Claude Code would send it to, which here is the gateway.
async function sessionToken() {
  const r = await runProgramAsync(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(developer, 'Get-ClaudeGatewayToken.ps1'), '-GatewayUrl', base], { env: { ...process.env, ANTHROPIC_BASE_URL: base }, timeoutMs: 120_000 });
  if (r.timedOut || r.status !== 0 || !r.stdout.trim()) return { blocked: `no session token: ${r.timedOut ? 'the helper was stopped at the time limit' : r.stderr.trim()}` };
  return { token: registerSecret(r.stdout.trim()) };
}

// One Messages API request to the gateway, or to the APIM route through ctx.sendExternal (tests/live/inference-http.mjs).
const send = createSend(base);

// The audit events of the given request IDs, from the gateway's console log; null when the log does not show, for each
// ID, an event that matches the predicate (by default any event).
async function eventsFor(requestIds, matches = () => true) {
  const wanted = new Set(requestIds.filter(Boolean));
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(attempt ? 8000 : 5000);
    const log = runAz(['containerapp', 'logs', 'show', '--name', state.appName, '--resource-group', opts['resource-group'],
      '--subscription', state.subscriptionId, '--container', 'gateway', '--type', 'console', '--tail', '300', '--format', 'json']);
    const own = parseLogLines(log.stdout.split(/\r?\n/)).audit.filter((e) => wanted.has(e.request_id));
    if (new Set(own.filter(matches).map((e) => e.request_id)).size === wanted.size) return own;
  }
  return null;
}

// A throwaway helper profile whose ANTHROPIC_BASE_URL is a loopback relay to the gateway, so the CLI's own requests
// are known by request ID. The session stays the developer's: it is kept per gateway origin in LOCALAPPDATA.
const install = (profile) => runProgramAsync(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
  path.join(developer, 'Install-ClaudeGatewayProfile.ps1'), '-GatewayUrl', base, '-ProfileDir', profile, '-FastModel', FAST, '-NoSignIn'], { timeoutMs: 120_000 });
const runClaude = ({ work, profile, helper, prompt, extraArgs, env, helperGateway }) => runThroughRelay(base, async (relayUrl) => {
  // The helper prints the token only for the base URL it expects, so the relay is named to it, in the profile's
  // settings and in the gateway.settings.json the launcher passes with --settings, which outranks them.
  // helperGateway points the helper at an origin with no saved session.
  const command = helperGateway ? helper.replace(/-GatewayUrl \S+$/, `-GatewayUrl ${helperGateway}`) : helper;
  for (const file of [path.join(profile, 'settings.json'), path.join(profile, 'gateway.settings.json')]) {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    settings.env.ANTHROPIC_BASE_URL = relayUrl;
    settings.apiKeyHelper = `${command} -ExpectedBaseUrl ${relayUrl}`;
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  }
  return runCmd(`"${path.join(profile, 'claude-gateway.cmd')}" -p "${prompt}" ${extraArgs.join(' ')}`, { cwd: work, timeoutMs: 110_000,
    env: { ...process.env, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_MAX_RETRIES: '0', ...env } });
});

// The APIM route to compare with (T-64) comes only from --apim-url, checked before any request. Without it the suite
// sends nothing to an APIM route, and the APIM half of latency is BLOCKED. Its token is for --apim-tenant, by default
// the deployment's tenant, which the account check below confirms the Azure CLI holds.
const run = createRunner({
  send,
  sendExternal: send,
  eventsFor,
  sessionToken,
  helperProfile: createHelperProfile({ install, runClaude }),
  apimToken: () => registerSecret(runAz(['account', 'get-access-token', '--resource', 'https://cognitiveservices.azure.com', '--tenant', opts['apim-tenant'] ?? state.tenantId,
    '--query', 'accessToken', '--output', 'tsv']).stdout.trim()),
  config: { models: MODELS, fast: FAST, unlisted: 'claude-haiku-4-5', samples: SAMPLES, base, apimUrl: opts['apim-url'] === undefined ? undefined : apimBaseUrl(opts['apim-url']) },
  say,
});
const wanted = opts.check.split(',').map((s) => s.trim()).filter(Boolean);
const unknown = wanted.filter((c) => !TESTS[c]);
if (unknown.length) throw new Error(`unknown check ${unknown.join(', ')}; use ${Object.keys(TESTS).join(', ')}`);
// Every check audits its answers in the gateway's log, so without the deployment's subscription nothing is decided.
const accountProblem = azureAccountProblem({ runAz, state });
if (accountProblem) {
  say(`BLOCKED: ${accountProblem}`);
  process.exit(2);
}
const results = [];
for (const name of wanted) results.push(await run(name, checks[name], TESTS[name]));
const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `inference-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, `${redactSecrets(JSON.stringify({ gateway: base, when: new Date().toISOString(), results }, null, 2))}\n`);
say(`results: ${results.map((r) => `${r.check}=${r.result}`).join(' ')}; saved ${path.relative(root, file)}`);
process.exitCode = exitCodeOf(results);
