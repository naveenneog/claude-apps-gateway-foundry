#!/usr/bin/env node
// Writes the client-side payloads for a Claude apps gateway (ADR-0004, T-54) into two folders, one per way of connecting;
// a machine takes one of them, because under forceLoginMethod Claude Code blocks an apiKeyHelper credential at startup
// (https://code.claude.com/docs/en/authentication):
//   login/      managed-settings.json, ClaudeCode-HKLM.reg, ClaudeCode.mobileconfig: the keys that send Claude Code's /login to
//               the gateway (https://code.claude.com/docs/en/claude-apps-gateway#set-the-gateway-url), as a file, a Windows
//               HKLM policy and a macOS configuration profile, for MDM, Group Policy or an installer.
//   developer/  every script of scripts/developer and START-HERE.txt, for the apiKeyHelper profile that needs no
//               administrator rights.
//   node scripts/admin/new-client-policy.mjs --gateway-url https://claude-gateway.corp.example.com --out <dir> [--fast-model <id>] [--policy-id <id>] [--force]
// Exit 1, writing nothing, on a gateway URL /login would refuse, or on an output directory that is not empty without --force.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cidrContains } from '../../infra/azure-test/lib/plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Every script the developer folder needs: the whole scripts/developer folder, so a new runtime file cannot be left out.
export const developerFiles = () => fs.readdirSync(path.join(root, 'scripts', 'developer')).filter((f) => /\.(ps1|psm1)$/.test(f)).sort();
// The private address space /login accepts without gatewayInternalNetworks
// (https://code.claude.com/docs/en/claude-apps-gateway#allow-a-gateway-on-public-address-space-you-own).
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', '100.64.0.0/10'];

export function gatewayOrigin(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`the gateway URL ${JSON.stringify(text)} is not an absolute URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`the gateway URL must use https: ${text}`);
  if (url.username || url.password) throw new Error('the gateway URL must not contain a user name or password');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error(`the gateway URL must be an origin, with no path, query or fragment: ${text}`);
  const host = url.hostname;
  if (host.startsWith('[')) throw new Error('an IPv6 literal is not accepted as the gateway host; use a host name');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (!PRIVATE.some((range) => cidrContains(range, host))) throw new Error(`${host} is not a private address; /login accepts a gateway on private addresses only`);
  } else if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
    throw new Error(`the gateway host ${host} must hold only letters, digits, dots and hyphens`);
  }
  return url.origin;
}

export const loginSettings = (origin) => ({ forceLoginMethod: 'gateway', forceLoginGatewayUrl: origin, parentSettingsBehavior: 'merge' });

// A .reg file as regedit exports it: UTF-16LE with a byte order mark and CRLF line breaks; the JSON is the REG_SZ value
// "Settings" under HKLM\SOFTWARE\Policies\ClaudeCode (https://code.claude.com/docs/en/managed-settings).
export function registryFile(settings) {
  const value = JSON.stringify(settings).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const text = ['Windows Registry Editor Version 5.00', '', '[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode]', `"Settings"="${value}"`, ''].join('\r\n');
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// A UUID derived from the policy ID, so every run writes the same profile, and a changed gateway URL updates it.
function stableUuid(seed) {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

// A configuration profile whose payload is the com.anthropic.claudecode managed preferences domain, with the same
// top-level keys as managed-settings.json (https://code.claude.com/docs/en/managed-settings).
export function mobileconfig(settings, policyId) {
  const keys = Object.entries(settings).map(([k, v]) => `\t\t\t<key>${xml(k)}</key>\n\t\t\t<string>${xml(v)}</string>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>PayloadContent</key>',
    '\t<array>',
    '\t\t<dict>',
    '\t\t\t<key>PayloadType</key>', '\t\t\t<string>com.anthropic.claudecode</string>',
    '\t\t\t<key>PayloadIdentifier</key>', `\t\t\t<string>com.anthropic.claudecode.gateway.${xml(policyId)}</string>`,
    '\t\t\t<key>PayloadUUID</key>', `\t\t\t<string>${stableUuid(`payload ${policyId}`)}</string>`,
    '\t\t\t<key>PayloadVersion</key>', '\t\t\t<integer>1</integer>',
    '\t\t\t<key>PayloadDisplayName</key>', '\t\t\t<string>Claude Code gateway sign-in</string>',
    ...keys,
    '\t\t</dict>',
    '\t</array>',
    '\t<key>PayloadDisplayName</key>', '\t<string>Claude Code: Claude apps gateway</string>',
    '\t<key>PayloadIdentifier</key>', `\t<string>com.anthropic.claudecode.gateway.profile.${xml(policyId)}</string>`,
    '\t<key>PayloadScope</key>', '\t<string>System</string>',
    '\t<key>PayloadType</key>', '\t<string>Configuration</string>',
    '\t<key>PayloadUUID</key>', `\t<string>${stableUuid(`profile ${policyId}`)}</string>`,
    '\t<key>PayloadVersion</key>', '\t<integer>1</integer>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// START-HERE.txt of the developer folder: what the developer needs, the commands to run from the folder, the messages
// they may meet and how to sign out, for a folder handed out without the rest of the repository (UX review, round 3).
// CRLF, for Notepad.
export function startHere(origin, fastModel) {
  const fast = fastModel ? ` -FastModel ${fastModel}` : '';
  const run = (script, args = `-GatewayUrl ${origin}`) => `   powershell -NoProfile -ExecutionPolicy Bypass -File .\\${script} ${args}`;
  return [
    `Claude Code through the Claude apps gateway at ${origin}`,
    '',
    'This folder sets up a separate Claude Code profile on Windows. It signs in to the gateway once, then reaches it',
    'through the apiKeyHelper setting. Your own %USERPROFILE%\\.claude settings stay as they are. It is for a machine',
    'without the policy in the login folder: under forceLoginMethod, Claude Code blocks an apiKeyHelper credential',
    '(https://code.claude.com/docs/en/authentication). A machine takes one of the two.',
    '',
    'Before you start',
    '- Windows PowerShell 5.1, which Windows includes, and Claude Code 2.1.272 or later on PATH',
    '  (https://code.claude.com/docs/en/setup). No administrator rights are needed.',
    '- A network from which the gateway answers. The gateway admits only the networks its operator allows.',
    '- A gateway role on your account. The operator grants it.',
    '',
    'Set up',
    '1. Open Windows PowerShell in this folder.',
    '2. Run:',
    run('Install-ClaudeGatewayProfile.ps1', `-GatewayUrl ${origin}${fast}`),
    '3. In the browser window that opens, confirm the code the script shows; then confirm the account it names.',
    '4. Start Claude Code with the launcher the script prints:',
    '   & "$env:USERPROFILE\\.claude-apps-gateway\\claude-gateway.cmd"',
    '   A --settings argument of your own replaces the launcher\'s gateway settings. Settings of your own go in',
    '   %USERPROFILE%\\.claude-apps-gateway\\settings.json.',
    '',
    'If a step fails',
    '- "Discovery at <url> returned HTTP <status>.": with 403, the gateway does not admit this network; connect from a',
    '  network it admits, or ask the operator. With 404, check the gateway URL with the operator. With 500 to 599,',
    '  run the command again, and ask the operator when it repeats. With 200, the answer was not JSON: a proxy\'s',
    '  sign-in page, or a fault in the gateway or its ingress. Sign in to the proxy when it asks for it; otherwise ask',
    '  the operator to check the gateway\'s log.',
    '- "The sign-in was declined (access_denied)": if you declined the code, run step 2 again and confirm it. When the',
    '  gateway refuses your account again, ask the operator for a gateway role.',
    '- "The sign-in code expired before it was confirmed (expired_token).": run step 2 again and confirm the new code.',
    '- "No saved session for <gateway>.": sign in again with the command below.',
    '- Claude Code reports that apiKeyHelper is failing: in a new Windows PowerShell window, run the helper with the',
    '  launcher\'s settings to see its own message, which starts with Get-ClaudeGatewayToken:, and follow it. The token',
    '  it prints is discarded:',
    '   $pinned = Get-Content "$env:USERPROFILE\\.claude-apps-gateway\\gateway.settings.json" -Raw | ConvertFrom-Json',
    '   foreach ($p in $pinned.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value) }',
    '   cmd /d /c $pinned.apiKeyHelper 1>$null',
    '- "ANTHROPIC_BASE_URL is <url>, not <gateway>": Claude Code was started without the launcher, or with a',
    '  --settings argument of your own. Start it with the launcher.',
    '',
    'Sign in again, for example after the gateway ends your session:',
    run('Connect-ClaudeGateway.ps1'),
    '',
    'Sign out, then remove the profile:',
    run('Disconnect-ClaudeGateway.ps1'),
    '   Remove-Item -Recurse "$env:USERPROFILE\\.claude-apps-gateway"',
    '',
  ].join('\r\n');
}

function main() {
  const { values } = parseArgs({ options: {
    'gateway-url': { type: 'string' },
    out: { type: 'string' },
    'fast-model': { type: 'string' },
    'policy-id': { type: 'string', default: 'default' },
    force: { type: 'boolean', default: false },
  } });
  if (!values['gateway-url'] || !values.out) throw new Error('pass --gateway-url <https://host> --out <dir> [--fast-model <id>] [--policy-id <id>] [--force]');
  const origin = gatewayOrigin(values['gateway-url']);
  const fastModel = values['fast-model'];
  if (fastModel !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(fastModel)) throw new Error(`--fast-model ${JSON.stringify(fastModel)} is not a model ID`);
  const policyId = values['policy-id'];
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/.test(policyId)) throw new Error(`--policy-id ${JSON.stringify(policyId)} must be letters, digits, dots and hyphens`);
  const out = path.resolve(values.out);
  if (fs.existsSync(out) && fs.readdirSync(out).length && !values.force) throw new Error(`${out} is not empty; pass --force to write into it`);
  const settings = loginSettings(origin);
  const login = path.join(out, 'login');
  const developer = path.join(out, 'developer');
  fs.mkdirSync(login, { recursive: true });
  fs.mkdirSync(developer, { recursive: true });
  fs.writeFileSync(path.join(login, 'managed-settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
  fs.writeFileSync(path.join(login, 'ClaudeCode-HKLM.reg'), registryFile(settings));
  fs.writeFileSync(path.join(login, 'ClaudeCode.mobileconfig'), mobileconfig(settings, policyId));
  for (const f of developerFiles()) fs.copyFileSync(path.join(root, 'scripts', 'developer', f), path.join(developer, f));
  fs.writeFileSync(path.join(developer, 'START-HERE.txt'), startHere(origin, fastModel));
  console.log(`wrote ${out}: login\\ (managed-settings.json, ClaudeCode-HKLM.reg, ClaudeCode.mobileconfig) and developer\\.`);
  console.log('A machine takes one of the two: under forceLoginMethod, Claude Code blocks the developer folder\'s apiKeyHelper credential.');
  console.log(`/login accepts ${origin} only when the name resolves to a private address, and only from a managed source on the device`);
  console.log('(https://code.claude.com/docs/en/claude-apps-gateway#prerequisites); the developer folder needs neither.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[new-client-policy] ${error.message}`);
    process.exitCode = 1;
  }
}
