#!/usr/bin/env node
// Upgrades only the gateway container image of a deployed Claude apps gateway, keeping its data (P-51, ADR-0021).
//   node scripts/admin/upgrade-gateway.mjs --resource-group <rg> (--image <registry>/claude-gateway@sha256:<digest> | --build)
//     [--app ca-claude-gw] [--profile <developer profile dir>] [--temporary-firewall <ipv4>[-<ipv4>]] [--plan] [--no-rollback]
// --build      builds infra/azure-test/image at its pinned Claude Code version with ACR Tasks and uses its digest.
// --profile    a signed-in developer profile (Install-ClaudeGatewayProfile.ps1); adds inference and Desktop bootstrap checks.
// --temporary-firewall  adds a database firewall rule for this machine for the run only and always removes it.
// --plan       reads everything and takes the "before" snapshot; changes nothing.
// Managed PostgreSQL only: the in-app database of the test topology is emptied by any new revision (ADR-0010, U-92).
// Before: snapshot (our admin_console schema by read-only SQL; caps, audit and spend through the admin API; checks).
// Then: swap only the gateway image, wait for a ready revision, snapshot again, compare. Any failure rolls the image back.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runUpgrade, dbSnapshot, summarizeApi, periodKeys, AUDIT_PAGE } from './gateway-upgrade.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,89}$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The developer profile's own token helper, as Claude Code runs it (Get-ClaudeGatewayToken.ps1).
function profileToken(profileDir) {
  const pinned = JSON.parse(fs.readFileSync(path.join(profileDir, 'gateway.settings.json'), 'utf8'));
  const m = /-File "([^"]+)" -GatewayUrl (\S+)/.exec(pinned.apiKeyHelper ?? '');
  if (!m) throw new Error('the profile has no Get-ClaudeGatewayToken.ps1 apiKeyHelper');
  const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', m[1], '-GatewayUrl', m[2]],
    { encoding: 'utf8', env: { ...process.env, ANTHROPIC_BASE_URL: m[2] } });
  if (r.status !== 0) throw new Error(`the profile's token helper failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return { origin: m[2], token: r.stdout.trim() };
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export async function main(argv = process.argv.slice(2)) {
  const { values: o } = parseArgs({ args: argv, options: {
    'resource-group': { type: 'string' }, app: { type: 'string', default: 'ca-claude-gw' }, image: { type: 'string' }, build: { type: 'boolean', default: false },
    profile: { type: 'string' }, 'temporary-firewall': { type: 'string' }, plan: { type: 'boolean', default: false }, 'no-rollback': { type: 'boolean', default: false },
  } });
  const rg = o['resource-group'];
  if (!rg || !NAME.test(rg) || !NAME.test(o.app)) throw new Error('pass --resource-group <name> [--app <name>]');
  if (!o.image === !o.build) throw new Error('pass exactly one of --image <registry>/claude-gateway@sha256:<digest> or --build');
  const fw = o['temporary-firewall'] ? o['temporary-firewall'].split('-') : null;
  if (fw && (fw.length > 2 || !fw.every((ip) => IPV4.test(ip)))) throw new Error('--temporary-firewall takes <ipv4> or <ipv4>-<ipv4>');
  const { azJson, runAz } = await import('../../infra/azure-test/lib/spawn.mjs');
  const { arm } = await import('../../infra/azure-test/lib/azure-rest.mjs');
  const { connect } = await import(pathToFileURL(path.join(root, 'admin-ui/server/pg-wire.mjs')).href);

  const readApp = () => azJson(['containerapp', 'show', '-g', rg, '-n', o.app]);
  const app0 = readApp();
  const env = Object.fromEntries((app0.properties.template.containers ?? []).flatMap((c) => c.env ?? []).filter((e) => e.value !== undefined && e.value !== null).map((e) => [e.name, e.value]));
  if (!env.GATEWAY_PG_HOST) throw new Error('this gateway uses the in-app database, which a new revision empties; move it to managed PostgreSQL first (scripts/admin/move-to-managed-database.mjs)');
  const secret = (name) => runAz(['containerapp', 'secret', 'show', '-g', rg, '-n', o.app, '--secret-name', name, '--query', 'value', '-o', 'tsv'], { allowFailure: true }).stdout.trim() || null;
  const pgPassword = secret('pg-password');
  const writeKey = secret('admin-write-key');
  const origin = env.GATEWAY_PUBLIC_URL;

  let image = o.image;
  if (o.build) {
    const registry = app0.properties.template.containers.find((c) => c.name === 'gateway').image.split('/')[0];
    const acr = registry.split('.')[0];
    const version = /^ARG CLAUDE_VERSION=(\S+)$/m.exec(fs.readFileSync(path.join(root, 'infra/azure-test/image/Dockerfile'), 'utf8'))[1];
    const tag = `claude-gateway:${version}-${new Date().toISOString().replace(/\D/g, '').slice(0, 12)}`;
    if (!o.plan) {
      console.log(`building ${tag} with ACR Tasks`);
      runAz(['acr', 'build', '--registry', acr, '--image', tag, path.join(root, 'infra/azure-test/image'), '--no-logs', '-o', 'none'], { inherit: true });
      image = `${registry}/claude-gateway@${azJson(['acr', 'repository', 'show', '--name', acr, '--image', tag]).digest}`;
    } else image = `${registry}/claude-gateway@sha256:${'0'.repeat(64)}`;
  }

  let fwRule = null;
  const groupPath = `/subscriptions/${app0.id.split('/')[2]}/resourceGroups/${rg}`;
  const server = env.GATEWAY_PG_HOST.split('.')[0];
  const profile = o.profile ? profileToken(o.profile) : null;
  // Called inside the try below, so the finally removes the rule whatever fails after it is requested.
  const openFirewall = async () => {
    fwRule = `${groupPath}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${server}/firewallRules/upgrade-gateway-temporary?api-version=2024-08-01`;
    console.log(`adding temporary database firewall rule ${fw.join('-')}`);
    await arm('PUT', fwRule, { properties: { startIpAddress: fw[0], endIpAddress: fw[1] ?? fw[0] } });
    const until = Date.now() + 5 * 60_000;
    while ((await arm('GET', fwRule, undefined, { ok: [200, 404] })).status !== 200) {
      if (Date.now() > until) throw new Error('the temporary firewall rule was not created within 5 minutes');
      await sleep(10_000);
    }
  };
  const snapshot = async () => {
    const out = { periods: periodKeys(new Date()) };
    const db = await connect({ host: env.GATEWAY_PG_HOST, user: env.GATEWAY_PG_USER ?? 'gateway', password: pgPassword, database: 'gateway' });
    try { out.db = await dbSnapshot(db); } finally { await db.close(); }
    out.checks = { health: (await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(30_000) })).status };
    if (writeKey) {
      const h = { 'x-api-key': writeKey };
      const caps = await getJson(`${origin}/v1/organizations/spend_limits?limit=1000`, h);
      const audit = await getJson(`${origin}/v1/organizations/spend_limits/audit?limit=${AUDIT_PAGE}`, h);
      const effective = [];
      let page = null;
      for (let i = 0; i < 100; i += 1) {
        const r = await getJson(`${origin}/v1/organizations/spend_limits/effective?period[]=monthly&limit=1000${page ? `&page=${encodeURIComponent(page)}` : ''}`, h);
        if (r.status !== 200) throw new Error(`/effective answered ${r.status}`);
        effective.push(...(r.body?.data ?? []));
        page = r.body?.next_page;
        if (!page) break;
      }
      if (caps.status !== 200 || audit.status !== 200) throw new Error(`the admin API answered caps ${caps.status}, audit ${audit.status}`);
      out.api = summarizeApi({ caps: caps.body?.data ?? [], audit: audit.body?.data ?? [], effective });
    }
    if (profile) {
      const auth = { Authorization: `Bearer ${profileToken(o.profile).token}` };
      const models = await getJson(`${origin}/v1/models`, auth);
      const model = models.body?.data?.[0]?.id;
      const inf = model ? await fetch(`${origin}/v1/messages`, { method: 'POST', signal: AbortSignal.timeout(120_000), headers: { ...auth, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with OK' }] }) }).catch((e) => ({ status: `error ${e.message}` })) : { status: `no model listed (/v1/models ${models.status})` };
      const boot = await getJson(`${origin}/user/bootstrap`, auth);
      Object.assign(out.checks, { inference: inf.status, bootstrap: boot.status,
        connectors: (boot.body?.managedMcpServers ?? []).map((s) => s.name), marketplaces: (boot.body?.allowedPluginMarketplaces ?? []).length });
    }
    return out;
  };
  const statePath = path.join(root, 'infra/azure-test/.state', `${rg}.json`);
  const io = {
    readApp,
    snapshot: async (phase) => { const s = await snapshot(); console.log(`snapshot ${phase}: ${JSON.stringify({ tables: s.db.tables.length, migrations: s.db.migrations, ours: s.db.ours, spendContract: s.db.spendContract, api: s.api && { caps: s.api.caps.count, users: Object.keys(s.api.monthly).length }, checks: s.checks })}`); return s; },
    swapImage: async (img) => { runAz(['containerapp', 'update', '-g', rg, '-n', o.app, '--container-name', 'gateway', '--image', img, '-o', 'none']); },
    waitReady: async (prev) => {
      const deadline = Date.now() + 15 * 60_000;
      while (Date.now() < deadline) {
        const a = readApp();
        const latest = a.properties.latestRevisionName;
        if (latest !== prev) {
          const rev = azJson(['containerapp', 'revision', 'show', '-g', rg, '-n', o.app, '--revision', latest]);
          const state = rev.properties.runningState;
          if (/Failed/i.test(state ?? '') || a.properties.provisioningState === 'Failed') return { ok: false, reason: `${latest} is ${state}` };
          if (a.properties.latestReadyRevisionName === latest && rev.properties.healthState === 'Healthy') return { ok: true, revision: latest };
        }
        await sleep(15_000);
      }
      return { ok: false, reason: 'no ready revision within 15 minutes' };
    },
    saveState: (img) => {
      if (!fs.existsSync(statePath)) return console.log(`no installer state file at ${statePath}; record the image yourself before a later app stage`);
      const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      st.images = { ...st.images, gateway: img, ...(o.build ? { gatewayTag: `upgrade-gateway ${new Date().toISOString()}` } : {}) };
      fs.writeFileSync(statePath, `${JSON.stringify(st, null, 2)}\n`);
      console.log(`installer state records ${img}, so a later app stage keeps it`);
    },
    log: (m) => console.log(m),
  };
  try {
    if (fw) await openFirewall();
    const r = await runUpgrade({ io, image, plan: o.plan, noRollback: o['no-rollback'], resourceGroup: rg, appName: o.app });
    console.log(`result: ${r.status}`);
    for (const n of r.notes ?? []) console.log(`note: ${n}`);
    for (const f of r.failures ?? []) console.log(`failure: ${f}`);
    return ['upgraded', 'unchanged', 'plan'].includes(r.status) ? 0 : 1;
  } finally {
    if (fwRule) {
      try {
        await arm('DELETE', fwRule, undefined, { ok: [200, 202, 204, 404] });
        console.log('temporary database firewall rule removed');
      } catch (e) {
        console.error(`REMOVE THE DATABASE FIREWALL RULE upgrade-gateway-temporary BY HAND: ${e.message}`);
        process.exitCode = 2;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`upgrade-gateway: ${e.message}`); process.exitCode = 2; });
}
