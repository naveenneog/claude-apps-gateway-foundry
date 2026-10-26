// T-123 (P-40): Claude Desktop through the public Contoso gateway (U-106), driven live. Sets a role's desktop and
// desktopSettings through admin-ui's own configuration store (the console's save path), waits for the new gateway
// revision, then reads /user/bootstrap with the developer profile's gateway token, as Claude Desktop does with its own.
//
//   node tests/live/desktop-p40.mjs --resource-group rg-claude-gw-contoso --profile <profile dir> --phase bootstrap
//   node tests/live/desktop-p40.mjs --resource-group rg-claude-gw-contoso --profile <profile dir> --phase apply
//     --role Gateway.Premium --desktop true|false [--settings '{"chatTabEnabled":true,"coworkTabEnabled":false}']
// bootstrap: prints the status of /user/bootstrap and, on 200, the Desktop keys it serves; the token is never printed.
// apply:     writes the admin file with the role's desktop and desktopSettings, waits for a healthy revision, then reads
//            /user/bootstrap again.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,89}$/;
const SHOWN = ['chatTabEnabled', 'coworkTabEnabled', 'isClaudeCodeForDesktopEnabled', 'desktopHome', 'inferenceProvider', 'inferenceGatewayBaseUrl'];

function az(args) {
  if (args.some((a) => /[\s"&|<>^%()]/.test(a))) throw new Error('refusing an az argument with a shell metacharacter');
  const r = process.platform === 'win32'
    ? spawnSync(['az', ...args].join(' '), { encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 })
    : spawnSync('az', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`az ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || '').trim().slice(0, 400)}`);
  return JSON.parse(r.stdout);
}

// The profile's own token helper, as Claude Code runs it, with the gateway as ANTHROPIC_BASE_URL.
export function profileToken(profileDir) {
  const pinned = JSON.parse(fs.readFileSync(path.join(profileDir, 'gateway.settings.json'), 'utf8'));
  const m = /-File "([^"]+)" -GatewayUrl (\S+)/.exec(pinned.apiKeyHelper);
  if (!m) throw new Error('the profile has no Get-ClaudeGatewayToken.ps1 apiKeyHelper');
  const ps = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', m[1], '-GatewayUrl', m[2]],
    { encoding: 'utf8', env: { ...process.env, ANTHROPIC_BASE_URL: m[2] } });
  if (r.status !== 0) throw new Error(`the token helper failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return { origin: m[2], token: r.stdout.trim() };
}

// The Desktop keys the bootstrap response serves, at any depth, without the inference credentials it may carry.
export function servedKeys(body) {
  const found = {};
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) { if (SHOWN.includes(k) && typeof x !== 'object') found[k] = x; else walk(x); }
  };
  walk(body);
  return found;
}

async function bootstrap(profileDir) {
  const { origin, token } = profileToken(profileDir);
  const res = await fetch(`${origin}/user/bootstrap`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  const keys = res.status === 200 && body ? servedKeys(body) : null;
  console.log(`/user/bootstrap ${res.status}${keys ? ` ${JSON.stringify(keys)}` : ` ${text.slice(0, 160)}`}`);
  return { status: res.status, keys, topKeys: body && typeof body === 'object' ? Object.keys(body) : [] };
}

async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    'resource-group': { type: 'string' }, profile: { type: 'string' }, phase: { type: 'string' },
    role: { type: 'string' }, desktop: { type: 'string' }, settings: { type: 'string' }, 'admin-ui-app': { type: 'string', default: 'ca-admin-ui' },
  } });
  const rg = values['resource-group'];
  if (!rg || !NAME.test(rg) || !values.profile) throw new Error('pass --resource-group <name> --profile <profile dir>');
  if (values.phase === 'bootstrap') return bootstrap(values.profile);
  if (values.phase !== 'apply') throw new Error('pass --phase bootstrap or apply');
  if (!values.role || !['true', 'false'].includes(values.desktop)) throw new Error('apply needs --role <role> --desktop true|false');
  const settings = values.settings ? JSON.parse(values.settings) : undefined;

  const { createArmClient } = await import('../../admin-ui/server/arm-client.mjs');
  const { createConfigStore } = await import('../../admin-ui/server/gateway-config.mjs');
  const ui = az(['containerapp', 'show', '-g', rg, '-n', values['admin-ui-app'], '-o', 'json']);
  const envOf = Object.fromEntries((ui.properties.template.containers[0].env ?? []).filter((e) => e.value !== undefined).map((e) => [e.name, e.value]));
  const deployAdmin = JSON.parse(az(['containerapp', 'secret', 'show', '-g', rg, '-n', values['admin-ui-app'], '--secret-name', 'gateway-admin-file-json', '-o', 'json']).value);
  const fetchImpl = async (url, init) => {
    if (!String(url).startsWith('http://p40-identity/')) return fetch(url, init);
    const t = az(['account', 'get-access-token', '--resource', 'https://management.azure.com/', '-o', 'json']);
    return new Response(JSON.stringify({ access_token: t.accessToken, expires_on: String(t.expires_on) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const arm = createArmClient({ clientId: envOf.AZURE_CLIENT_ID, fetch: fetchImpl, cache: new Map(), env: { IDENTITY_ENDPOINT: 'http://p40-identity/token', IDENTITY_HEADER: 'p40' } });
  const store = createConfigStore({ arm, resourceId: envOf.GATEWAY_RESOURCE_ID, deployAdmin, topology: envOf.GATEWAY_TOPOLOGY ?? 'test',
    adminFilePath: envOf.GATEWAY_ADMIN_FILE_PATH ?? 'the admin file', knownRoles: async () => deployAdmin.roles });

  const current = await store.read();
  const admin = structuredClone(current.admin);
  const policy = admin.policies.find((p) => p.role === values.role);
  if (!policy) throw new Error(`no policy for ${values.role}`);
  policy.desktop = values.desktop === 'true';
  if (settings === undefined || Object.keys(settings).length === 0) delete policy.desktopSettings; else policy.desktopSettings = settings;
  const previous = current.gateway.revision;
  const res = await store.write({ admin, baseVersion: current.version });
  console.log(`saved: ${values.role} desktop=${policy.desktop} settings=${JSON.stringify(policy.desktopSettings ?? {})}; ${res?.message ?? ''}`);
  const deadline = Date.now() + 15 * 60_000;
  let last;
  while (Date.now() < deadline) {
    last = await store.rollout(previous);
    if (last.done || last.failed) break;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log(`rollout: ${last?.done ? 'ready' : 'not ready'} ${last?.message ?? ''}`);
  if (!last?.done) process.exit(1);
  return bootstrap(values.profile);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`desktop-p40: ${e.message}`); process.exit(1); });
}
