#!/usr/bin/env node
// T-106: the admin-ui configuration save, role creation and chargeback report, run live against a deployed gateway
// through admin-ui's own server modules (gateway-config.mjs, roles.mjs, chargeback.mjs, arm-client.mjs,
// graph-client.mjs). Tokens come from the operator's `az` sign-in through the fetch and env parameters
// getManagedIdentityToken already takes, so the ARM and Graph clients run unchanged; the deployed managed identity's
// own grants are checked separately by the Settings page (T-102).
//
//   node tests/live/admin-ui-t106.mjs --resource-group rg-claude-gw-contoso --phase check
//   node tests/live/admin-ui-t106.mjs --resource-group rg-claude-gw-contoso --phase save --acknowledge-data-loss
//   node tests/live/admin-ui-t106.mjs --resource-group rg-claude-gw-contoso --phase persist
// persist (T-116, ADR-0012): on a gateway using the managed database, an unchanged save without acknowledgeDataLoss,
//        then month-to-date spend and every cap compared before and after the new revision. Uses no Microsoft Graph.
//
// check: chargeback total against the Dashboard total, a save without acknowledgement (428, app unchanged), and the
//        Gateway.Trial app role (created if absent). Changes nothing on the gateway app.
// save:  a save racing a simulated concurrent change (expects 409 and no PUT; U-94), then an unchanged save, a
//        save admitting Gateway.Trial, and a save restoring the original admin file, each waited on until its revision
//        is healthy. On a gateway whose PostgreSQL is on EmptyDir every revision resets spend, caps, the audit trail and
//        stored sign-in state (U-92): the check phase writes the spend rows and caps to tests/live/out first.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const ALLOWED_NEW_SECRETS = new Set(['gateway-admin-file']);
const ALLOWED_NEW_ENV = new Set(['CONFIG_UPDATED_AT']);
const TRIAL = { value: 'Gateway.Trial', displayName: 'Gateway Trial', description: 'Trial access created by the T-106 live check' };

/** Secret names and each container's environment variable names, sorted. */
export function appShape(app) {
  const p = app?.properties ?? {};
  const env = {};
  for (const c of p.template?.containers ?? []) env[c.name] = (c.env ?? []).map((e) => e.name).sort();
  return { secrets: (p.configuration?.secrets ?? []).map((s) => s.name).sort(), env };
}

/** What changed in the app's shape that a configuration save must not change. */
export function shapeFindings(before, after) {
  const out = [];
  for (const s of before.secrets) if (!after.secrets.includes(s)) out.push(`secret ${s} is missing after the save`);
  for (const s of after.secrets) if (!before.secrets.includes(s) && !ALLOWED_NEW_SECRETS.has(s)) out.push(`secret ${s} appeared after the save`);
  for (const [c, names] of Object.entries(before.env)) {
    const now = after.env[c];
    if (!now) { out.push(`container ${c} is missing after the save`); continue; }
    for (const n of names) if (!now.includes(n)) out.push(`${c}: environment variable ${n} is missing after the save`);
    for (const n of now) if (!names.includes(n) && !ALLOWED_NEW_ENV.has(n)) out.push(`${c}: environment variable ${n} appeared after the save`);
  }
  return out;
}

/** The Dashboard's "Spend this month": the sum of spendRow(r).spendCents over its /effective rows (admin-ui/web/app.js). */
export function dashboardTotalCents(rows, spendRow) {
  return rows.reduce((sum, r) => sum + spendRow(r).spendCents, 0);
}

/** T-116: what a save on the managed database lost. Spend may grow (a request during the save); caps must not change. */
export function persistFindings(before, after) {
  if (!before.rows.length && !before.caps.length) return ['nothing to compare: no spend and no cap before the save'];
  const key = (r) => `${r.scope?.user_id ?? r.scope?.type} ${r.period}`;
  const now = new Map(after.rows.map((r) => [key(r), Number(r.period_to_date_spend)]));
  const out = [];
  for (const r of before.rows) {
    const was = Number(r.period_to_date_spend);
    if (!now.has(key(r))) out.push(`${key(r)} spend ${was} is gone after the save`);
    else if (now.get(key(r)) < was) out.push(`${key(r)} spend fell from ${was} to ${now.get(key(r))}`);
  }
  const caps = new Map(after.caps.map((c) => [c.id, c]));
  for (const c of before.caps) {
    if (!caps.has(c.id)) out.push(`cap ${c.id} is gone after the save`);
    else if (JSON.stringify([c.scope, c.period, c.amount]) !== JSON.stringify([caps.get(c.id).scope, caps.get(c.id).period, caps.get(c.id).amount])) out.push(`cap ${c.id} changed`);
  }
  return out;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;

function az(args) {
  // Every argument is a constant, a NAME-checked value or a token resource checked against two fixed origins, so none
  // carries a shell metacharacter and joining them for cmd.exe (which runs az.cmd on Windows) is safe.
  if (args.some((a) => /[\s"&|<>^%()]/.test(a))) throw new Error('refusing an az argument with a shell metacharacter');
  const r = process.platform === 'win32'
    ? spawnSync(['az', ...args].join(' '), { encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 })
    : spawnSync('az', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`az ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || '').trim().slice(0, 400)}`);
  return JSON.parse(r.stdout);
}

function azFetch() {
  // No cache here: getManagedIdentityToken caches each token and asks again within five minutes of expiry, and each
  // ask runs `az`, which refreshes from its own sign-in when needed.
  return async (url, init) => {
    if (!String(url).startsWith('http://t106-identity/')) return fetch(url, init);
    const resource = new URL(url).searchParams.get('resource');
    if (!/^https:\/\/(management\.azure\.com|graph\.microsoft\.com)\/?$/.test(resource)) throw new Error(`unexpected token resource ${resource}`);
    const t = az(['account', 'get-access-token', '--resource', resource, '-o', 'json']);
    return new Response(JSON.stringify({ access_token: t.accessToken, expires_on: String(t.expires_on) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

function loadSpendRow() {
  const context = { URL };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'admin-ui', 'web', 'spend-view.js'), 'utf8'), context);
  return (r) => context.spendView.spendRow(r);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    'resource-group': { type: 'string' }, 'admin-ui-app': { type: 'string', default: 'ca-admin-ui' },
    phase: { type: 'string' }, 'acknowledge-data-loss': { type: 'boolean', default: false },
  } });
  const rg = values['resource-group'];
  const adminUiApp = values['admin-ui-app'];
  if (!rg || !NAME.test(rg) || !NAME.test(adminUiApp)) throw new Error('pass --resource-group <name> [--admin-ui-app <name>]');
  if (!['check', 'save', 'persist'].includes(values.phase)) throw new Error('pass --phase check, save or persist');
  if (values.phase === 'save' && !values['acknowledge-data-loss']) throw new Error('--phase save starts new gateway revisions; pass --acknowledge-data-loss');

  const { createArmClient } = await import('../../admin-ui/server/arm-client.mjs');
  const { createGraphClient } = await import('../../admin-ui/server/graph-client.mjs');
  const { createConfigStore } = await import('../../admin-ui/server/gateway-config.mjs');
  const { createRole, gatewayApplication } = await import('../../admin-ui/server/roles.mjs');
  const { buildChargeback, collectEffective } = await import('../../admin-ui/server/chargeback.mjs');
  const { listEffectiveSpend, listSpendLimits } = await import('../../admin-ui/server/gateway-client.mjs');

  // The deployed admin-ui's own settings, so this drives the same gateway, admin file and topology it does.
  const ui = az(['containerapp', 'show', '-g', rg, '-n', adminUiApp, '-o', 'json']);
  const envOf = Object.fromEntries((ui.properties.template.containers[0].env ?? []).filter((e) => e.value !== undefined).map((e) => [e.name, e.value]));
  const secret = (name) => az(['containerapp', 'secret', 'show', '-g', rg, '-n', adminUiApp, '--secret-name', name, '-o', 'json']).value;
  const clientId = envOf.AZURE_CLIENT_ID;
  const resourceId = envOf.GATEWAY_RESOURCE_ID;
  const servicePrincipalId = envOf.GATEWAY_SERVICE_PRINCIPAL_ID;
  const deployAdmin = JSON.parse(secret('gateway-admin-file-json'));
  // admin-ui reaches the gateway by its environment-internal name (http://ca-claude-gw), which resolves only inside the
  // Container Apps environment; from the operator's machine the same API is on the gateway's public ingress.
  const gatewayFqdn = az(['containerapp', 'show', '--ids', resourceId, '--query', 'properties.configuration.ingress.fqdn', '-o', 'json']);
  const gatewayUrl = `https://${gatewayFqdn}`;
  const gateway = { baseUrl: gatewayUrl, writeKey: secret('gateway-admin-write-key'), fetch };

  const fetchImpl = azFetch();
  const env = { IDENTITY_ENDPOINT: 'http://t106-identity/token', IDENTITY_HEADER: 't106' };
  const cache = new Map();
  const arm = createArmClient({ clientId, fetch: fetchImpl, cache, env });
  const graph = createGraphClient({ clientId, fetch: fetchImpl, cache, env });
  const knownRoles = async () => (await gatewayApplication({ graph, servicePrincipalId })).appRoles.map((r) => r.value);
  const storeWith = (a) => createConfigStore({ arm: a, resourceId, deployAdmin, topology: envOf.GATEWAY_TOPOLOGY ?? 'test', adminFilePath: envOf.GATEWAY_ADMIN_FILE_PATH ?? 'the admin file', knownRoles });
  const store = storeWith(arm);
  const getApp = async () => (await arm('GET', `${resourceId}?api-version=2025-07-01`)).json;

  const results = [];
  const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`); };
  const expectStatus = async (fn) => { try { await fn(); return { status: 'no error' }; } catch (e) { return { status: e.status, message: e.message }; } };
  const health = async () => (await fetch(`${gatewayUrl}/healthz`)).status;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(here, 'out');
  fs.mkdirSync(outDir, { recursive: true });

  const waitRollout = async (previous, label) => {
    const deadline = Date.now() + 15 * 60_000;
    let last;
    while (Date.now() < deadline) {
      last = await store.rollout(previous);
      if (last.done || last.failed) break;
      await sleep(10_000);
    }
    record(`${label}: new revision ready and healthy`, Boolean(last?.done), last?.message);
    return last;
  };

  const listCaps = async () => {
    const caps = [];
    let after;
    for (let i = 0; i < 100; i += 1) {
      const page = await listSpendLimits(gateway, { limit: 100, afterId: after });
      caps.push(...(page.data ?? []));
      const next = page.last_id ?? page.data?.at(-1)?.id;
      if (!page.has_more || !next) break;
      after = next;
    }
    return caps;
  };

  if (values.phase === 'persist') {
    // The save changes no role, so validation uses the roles the live admin file admits (no Graph token needed).
    let admitted = [];
    const persistStore = createConfigStore({ arm, resourceId, deployAdmin, topology: envOf.GATEWAY_TOPOLOGY ?? 'test', adminFilePath: envOf.GATEWAY_ADMIN_FILE_PATH ?? 'the admin file', knownRoles: async () => admitted });
    const current = await persistStore.read();
    admitted = current.admin.roles;
    if (current.restart.temporaryDatabase) throw new Error('--phase persist needs a gateway on the managed database; this one keeps PostgreSQL on EmptyDir');
    record('the gateway uses the managed database', current.admin.deployment?.database === 'managed', `revision ${current.gateway.revision}`);
    const snap = async () => ({ rows: await collectEffective({ gateway, period: 'monthly' }), caps: await listCaps() });
    const before = await snap();
    const total = (x) => x.rows.reduce((t, r) => t + Number(r.period_to_date_spend), 0);
    fs.writeFileSync(path.join(outDir, `admin-ui-t116-before-${stamp}.json`), `${JSON.stringify(before, null, 2)}\n`);
    const res = await persistStore.write({ admin: current.admin, baseVersion: current.version });
    record('an unchanged save is accepted without acknowledgeDataLoss', true, `previous revision ${res.rollout.previousRevision}`);
    await waitRollout(res.rollout.previousRevision, 'unchanged save on the managed database');
    const ready = (await fetch(`${gatewayUrl}/readyz`)).status;
    record('/healthz and /readyz after the save', (await health()) === 200 && ready === 200, `/readyz ${ready}`);
    const after = await snap();
    const lost = persistFindings(before, after);
    record('month-to-date spend and every cap survive the save', lost.length === 0,
      lost.join('; ') || `spend ${(total(before) / 100).toFixed(4)} -> ${(total(after) / 100).toFixed(4)} USD, ${before.rows.length} users, ${after.caps.length} caps`);
  } else if (values.phase === 'check') {
    const current = await store.read();
    record('read the live configuration', true, `revision ${current.gateway.revision}, source ${current.source}, temporary database ${current.restart.temporaryDatabase}`);

    const rows = await collectEffective({ gateway, period: 'monthly' });
    const report = await buildChargeback({ rows, graph, period: 'monthly', groupBy: 'department' });
    const dashRows = (await listEffectiveSpend(gateway, { period: ['monthly'], sort: 'spend_desc', limit: 100 })).data ?? [];
    const dash = dashboardTotalCents(dashRows, loadSpendRow());
    const groups = report.groups.map((g) => `${g.key} ${(g.totalCents / 100).toFixed(2)}`).join('; ');
    record('chargeback by department equals the Dashboard total', Math.abs(report.totalCents - dash) < 1e-6,
      `report ${(report.totalCents / 100).toFixed(4)} USD, Dashboard ${(dash / 100).toFixed(4)} USD, ${report.rows.length} users; ${groups}`);
    const caps = await listCaps();
    const snapshot = path.join(outDir, `admin-ui-t106-spend-${stamp}.json`);
    fs.writeFileSync(snapshot, `${JSON.stringify({ takenAt: new Date().toISOString(), revision: current.gateway.revision, effective: rows, caps }, null, 2)}\n`);
    record('spend rows and caps saved before any save', true, `${rows.length} rows, ${caps.length} caps, ${path.relative(root, snapshot)}`);

    // Only a temporary-database gateway answers 428; on any other this would be a real save, so it is skipped, and the
    // store used here refuses every PUT in case a future write() path skips the 428.
    if (current.restart.temporaryDatabase) {
      const noPut = (method, p, body, opts) => (method === 'PUT' ? Promise.reject(Object.assign(new Error('the check phase sends no PUT'), { status: 'PUT refused' })) : arm(method, p, body, opts));
      const before = await getApp();
      const unacked = await expectStatus(() => storeWith(noPut).write({ admin: current.admin, baseVersion: current.version }));
      const same = await getApp();
      record('a save without acknowledgeDataLoss answers 428 and starts no revision',
        unacked.status === 428 && same.systemData?.lastModifiedAt === before.systemData?.lastModifiedAt && same.properties.latestRevisionName === before.properties.latestRevisionName,
        `status ${unacked.status}, revision ${same.properties.latestRevisionName}`);
    } else {
      record('a save without acknowledgeDataLoss answers 428 (skipped: this gateway\'s database is persistent, so no 428 applies)', true);
    }

    const created = await expectStatus(() => createRole({ graph, servicePrincipalId }, TRIAL));
    const roles = await knownRoles();
    record(`${TRIAL.value} exists in Entra`, roles.includes(TRIAL.value), created.status === 'no error' ? 'created now' : `create answered ${created.status} (${created.message})`);
  } else {
    const first = await getApp();
    const firstShape = appShape(first);
    const original = await store.read();

    // U-94: Container Apps returns no ETag, so a concurrent change is detected by reading the app again just before the
    // PUT. This simulates one: the re-read reports a later lastModifiedAt. Expect 409, no PUT, and the app unchanged.
    let appGets = 0;
    let puts = 0;
    const racingArm = async (method, p, body, opts) => {
      if (method === 'PUT') puts += 1;
      const res = await arm(method, p, body, opts);
      if (method === 'GET' && p.split('?')[0] === resourceId && (appGets += 1) === 2) {
        res.json.systemData = { ...res.json.systemData, lastModifiedAt: new Date().toISOString() };
      }
      return res;
    };
    const raced = await expectStatus(() => storeWith(racingArm).write({ admin: original.admin, baseVersion: original.version, acknowledgeDataLoss: true }));
    const afterRace = await getApp();
    const untouched = afterRace.properties.latestRevisionName === first.properties.latestRevisionName
      && afterRace.systemData?.lastModifiedAt === first.systemData?.lastModifiedAt;
    record('a change made after the app was read is refused (409), no PUT is sent, and the app is unchanged',
      raced.status === 409 && /changed while/.test(raced.message ?? '') && puts === 0 && untouched,
      `status ${raced.status}, PUTs ${puts}, ARM ETag ${first.etag ? 'present' : 'absent'}, revision ${afterRace.properties.latestRevisionName}`);

    const saves = [
      ['unchanged save', original.admin],
      ['save admitting Gateway.Trial', (() => {
        const a = structuredClone(original.admin);
        a.roles = [...a.roles, TRIAL.value];
        if (Array.isArray(a.policies)) {
          const cheapest = a.policies.find((p) => p.role === a.roles[0])?.models ?? [];
          a.policies = [...a.policies, { role: TRIAL.value, models: cheapest.slice(0, 1), desktop: false }];
        }
        return a;
      })()],
      ['save restoring the original admin file', original.admin],
    ];
    const saveAndVerify = async (label, admin) => {
      const now = await store.read();
      const res = await store.write({ admin, baseVersion: now.version, acknowledgeDataLoss: true });
      record(`${label}: accepted`, true, `previous revision ${res.rollout.previousRevision}`);
      await waitRollout(res.rollout.previousRevision, label);
      const live = await store.read();
      record(`${label}: the live admin file is the one saved`, live.version === res.version && live.source === 'live', `admits ${live.admin.roles.join(', ')}`);
      const shape = shapeFindings(firstShape, appShape(await getApp()));
      record(`${label}: secret and environment names unchanged`, shape.length === 0, shape.join('; '));
      const status = await health();
      record(`${label}: /healthz`, status === 200, `HTTP ${status}`);
    };
    try {
      for (const [label, admin] of saves.slice(0, 2)) await saveAndVerify(label, admin);
    } finally {
      // Always put the original admin file back, also after a failure part-way, so the gateway is not left admitting
      // Gateway.Trial.
      if ((await store.read()).version !== original.version) await saveAndVerify(...saves[2]);
      else record(`${saves[2][0]}: not needed, the live admin file is already the original`, true);
    }
    const final = await store.read();
    record('the live admin file matches the one before the run', final.version === original.version, `revision ${final.gateway.revision}`);
  }

  const out = path.join(outDir, `admin-ui-t106-${values.phase}-${stamp}.json`);
  fs.writeFileSync(out, `${JSON.stringify({ phase: values.phase, at: new Date().toISOString(), results }, null, 2)}\n`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed} passed, ${failed} failed; ${path.relative(root, out)}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 2; });
}
