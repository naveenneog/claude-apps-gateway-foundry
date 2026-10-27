#!/usr/bin/env node
// T-139 (P-43, ADR-0014): live check of the soft limit and daily pacing on a test deployment. Phases:
//   state   --email <user>                       the user's monthly and daily rows, their per-user caps, and each cap's newest audit actor
//   cap     --email <user> --period <p> --usd <n|delete>   set or delete the user's own cap (admin-ui's key)
//   soft    --percent <1-99|off>                 turn the soft limit on or off through admin-ui's own configuration store
//   job                                          start job-spend-pacer and wait for the execution's result
//   burst   --profile <dir> --count <n>          n parallel small requests with the developer profile's token; prints statuses and the 429 message
// Keys are read from the gateway app's secrets and never printed; user IDs are printed shortened.
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { profileToken } from './desktop-p40.mjs';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,89}$/;
function az(args) {
  if (args.some((a) => /[\s"&|<>^%()]/.test(a))) throw new Error('refusing an az argument with a shell metacharacter');
  const r = process.platform === 'win32'
    ? spawnSync(['az', ...args].join(' '), { encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 })
    : spawnSync('az', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`az ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || '').trim().slice(0, 400)}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
const short = (sub) => `${String(sub).slice(0, 6)}…`;

async function gatewayOf(rg) {
  const app = az(['containerapp', 'show', '-g', rg, '-n', 'ca-claude-gw', '-o', 'json']);
  const key = az(['containerapp', 'secret', 'show', '-g', rg, '-n', 'ca-claude-gw', '--secret-name', 'admin-write-key', '-o', 'json']).value;
  const { listAudit, listEffectiveSpend, listSpendLimits, setSpendLimit, deleteSpendLimit } = await import('../../admin-ui/server/gateway-client.mjs');
  const deps = { baseUrl: `https://${app.properties.configuration.ingress.fqdn}`, writeKey: key, fetch };
  return { deps, listAudit, listEffectiveSpend, listSpendLimits, setSpendLimit, deleteSpendLimit };
}

async function userOf(g, email) {
  const rows = (await g.listEffectiveSpend(g.deps, { q: email, period: ['monthly', 'daily', 'weekly'], limit: 100 })).data ?? [];
  const mine = rows.filter((r) => r.actor?.email_address?.toLowerCase() === email.toLowerCase());
  if (!mine.length) throw new Error('no /effective row for that user yet; send one request through the gateway first');
  return { sub: mine[0].scope.user_id, rows: mine };
}

async function state(g, email) {
  const { sub, rows } = await userOf(g, email);
  const caps = ((await g.listSpendLimits(g.deps, { scopeType: 'user', limit: 1000 })).data ?? []).filter((c) => c.scope?.user_id === sub);
  const audit = (await g.listAudit(g.deps, { limit: 200 })).data ?? [];
  console.log(`user ${short(sub)}`);
  for (const r of rows) console.log(`  ${r.period}: spend ${r.period_to_date_spend} cents, cap ${r.amount ?? 'unlimited'}`);
  for (const c of caps) {
    const e = audit.find((x) => (x.after ?? x.before)?.scope?.user_id === sub && (x.after ?? x.before)?.period === c.period);
    console.log(`  user cap ${c.period} ${c.amount} cents (${c.id}), newest audit actor ${e?.actor ?? 'none found'} at ${e?.created_at ?? '-'}`);
  }
  return { sub, rows, caps };
}

async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    'resource-group': { type: 'string' }, email: { type: 'string' }, period: { type: 'string' }, usd: { type: 'string' },
    percent: { type: 'string' }, profile: { type: 'string' }, count: { type: 'string', default: '4' },
  } });
  const rg = values['resource-group'];
  if (!rg || !NAME.test(rg)) throw new Error('pass --resource-group <name>');
  const phase = positionals[0];
  if (phase === 'job') {
    const started = az(['containerapp', 'job', 'start', '-g', rg, '-n', 'job-spend-pacer', '-o', 'json']);
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 10_000));
      const ex = az(['containerapp', 'job', 'execution', 'show', '-g', rg, '-n', 'job-spend-pacer', '--job-execution-name', started.name, '-o', 'json']);
      if (['Succeeded', 'Failed'].includes(ex.properties?.status)) { console.log(`execution ${started.name}: ${ex.properties.status}`); return; }
    }
    throw new Error('the execution did not finish in five minutes');
  }
  if (phase === 'burst') {
    const { origin, token } = profileToken(values.profile);
    const body = JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 400, messages: [{ role: 'user', content: 'Write about 250 words on rivers.' }] });
    const results = await Promise.all(Array.from({ length: Number(values.count) }, async () => {
      const res = await fetch(`${origin}/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer '.concat(token), 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, retryAfter: res.headers.get('retry-after'), message: json?.error?.message ?? null, output: json?.usage?.output_tokens ?? null };
    }));
    for (const r of results) console.log(JSON.stringify(r));
    return;
  }
  if (phase === 'soft') {
    const { createArmClient } = await import('../../admin-ui/server/arm-client.mjs');
    const { createConfigStore } = await import('../../admin-ui/server/gateway-config.mjs');
    const ui = az(['containerapp', 'show', '-g', rg, '-n', 'ca-admin-ui', '-o', 'json']);
    const envOf = Object.fromEntries((ui.properties.template.containers[0].env ?? []).filter((e) => e.value !== undefined).map((e) => [e.name, e.value]));
    const deployAdmin = JSON.parse(az(['containerapp', 'secret', 'show', '-g', rg, '-n', 'ca-admin-ui', '--secret-name', 'gateway-admin-file-json', '-o', 'json']).value);
    const fetchImpl = async (url, init) => {
      if (!String(url).startsWith('http://p43-identity/')) return fetch(url, init);
      const t = az(['account', 'get-access-token', '--resource', 'https://management.azure.com/', '-o', 'json']);
      return new Response(JSON.stringify({ access_token: t.accessToken, expires_on: String(t.expires_on) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const arm = createArmClient({ clientId: envOf.AZURE_CLIENT_ID, fetch: fetchImpl, cache: new Map(), env: { IDENTITY_ENDPOINT: 'http://p43-identity/token', IDENTITY_HEADER: 'p43' } });
    const store = createConfigStore({ arm, resourceId: envOf.GATEWAY_RESOURCE_ID, deployAdmin, topology: envOf.GATEWAY_TOPOLOGY ?? 'test',
      adminFilePath: envOf.GATEWAY_ADMIN_FILE_PATH ?? 'the admin file', knownRoles: async () => deployAdmin.roles });
    const current = await store.read();
    const admin = structuredClone(current.admin);
    if (values.percent === 'off') delete admin.spendPacing; else admin.spendPacing = { softLimitPercent: Number(values.percent) };
    const previous = current.gateway.revision;
    await store.write({ admin, baseVersion: current.version });
    console.log(`saved: soft limit ${values.percent}`);
    let last;
    for (const deadline = Date.now() + 15 * 60_000; Date.now() < deadline;) {
      last = await store.rollout(previous);
      if (last.done || last.failed) break;
      await new Promise((r) => setTimeout(r, 10_000));
    }
    console.log(`rollout: ${last?.done ? 'ready' : 'not ready'} ${last?.message ?? ''}`);
    if (!last?.done) process.exitCode = 1;
    return;
  }
  const g = await gatewayOf(rg);
  if (!values.email) throw new Error('pass --email <user>');
  if (phase === 'state') { await state(g, values.email); return; }
  if (phase === 'cap') {
    const { sub, caps } = await state(g, values.email);
    if (!['daily', 'weekly', 'monthly'].includes(values.period)) throw new Error('pass --period daily, weekly or monthly');
    if (values.usd === 'delete') {
      const cap = caps.find((c) => c.period === values.period);
      if (cap) await g.deleteSpendLimit(g.deps, cap.id);
      console.log(cap ? `deleted ${cap.id}` : 'no such cap');
    } else {
      const cents = Math.round(Number(values.usd) * 100);
      if (!(cents >= 0)) throw new Error('pass --usd <amount> or delete');
      const r = await g.setSpendLimit(g.deps, { scope: { type: 'user', user_id: sub }, amountCents: cents, period: values.period });
      console.log(`set ${values.period} ${cents} cents (${r.id})`);
    }
    await state(g, values.email);
    return;
  }
  throw new Error('phase must be state, cap, soft, job or burst');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`pacer-p43: ${e.message}`); process.exit(1); });
}
