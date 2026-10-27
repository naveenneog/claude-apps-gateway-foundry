#!/usr/bin/env node
// The spend pacer (ADR-0014), run by the Container Apps job job-spend-pacer every five minutes from the admin-ui image.
// It reads the admin file and the gateway's admin keys from the gateway app's own secrets, with the Container Apps
// Contributor role admin-ui's identity already holds on that app, so no key is passed to the job. It then applies
// pacePlan through the gateway's admin API: caps are set with the spend-pacer key, so /audit shows the job as their
// author. It logs one summary line a run, with counts only: no user ID, name or address.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArmClient } from './arm-client.mjs';
import { ARM_API_VERSION } from './gateway-config.mjs';
import { deleteSpendLimit, listAudit, listEffectiveSpend, listSpendLimits, setSpendLimit } from './gateway-client.mjs';
import { PACER_SECRET, pacePlan } from '../../scripts/admin/spend-pacing.mjs';

const MAX_PAGES = 100;

async function allPages(fetchPage, nextOf) {
  const rows = [];
  let cursor;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const res = await fetchPage(cursor);
    rows.push(...(res?.data ?? []));
    cursor = nextOf(res);
    if (!cursor) return rows;
  }
  throw new Error(`more than ${MAX_PAGES} pages`);
}

/** One run. Returns { exitCode, summary }. deployAdmin applies until the app holds a gateway-admin-file secret. */
export async function runPacer({ arm, resourceId, gatewayUrl, fetch: fetchImpl = fetch, now = () => new Date(), log = console.log, deployAdmin }) {
  const line = (o) => log(JSON.stringify(o));
  const summary = { evt: 'spend_pacer.run', percent: null, paced: 0, set: 0, removed: 0, notPaced: 0, errors: 0 };
  try {
    const listed = (await arm('POST', `${resourceId}/listSecrets?api-version=${ARM_API_VERSION}`)).json?.value ?? [];
    const secrets = Object.fromEntries(listed.map((s) => [s.name, s.value]));
    const admin = secrets['gateway-admin-file'] ? JSON.parse(secrets['gateway-admin-file']) : deployAdmin;
    if (!admin) throw new Error('no admin file: the gateway app has no gateway-admin-file secret and GATEWAY_ADMIN_FILE_JSON is not set');
    if (admin.deployment?.adminApi !== true) { line({ ...summary, note: 'the admin API is off, so nothing is paced' }); return { exitCode: 0, summary }; }
    const percent = admin.spendPacing?.softLimitPercent ?? null;
    summary.percent = percent;
    const adminKey = secrets['admin-write-key'];
    const pacerKey = secrets[PACER_SECRET];
    if (percent !== null && !pacerKey) throw new Error(`the soft limit is on but the gateway app has no ${PACER_SECRET} secret; run the installer's app stage`);
    if (!adminKey && !pacerKey) throw new Error('the gateway app has no admin-write-key secret');
    // While pacing is on the gateway accepts the pacer key; once it is off, only admin-ui's key, which then deletes.
    const writer = { baseUrl: gatewayUrl, writeKey: percent !== null ? pacerKey : adminKey, fetch: fetchImpl };
    const reader = { baseUrl: gatewayUrl, writeKey: adminKey ?? pacerKey, fetch: fetchImpl };

    const effective = await allPages((page) => listEffectiveSpend(reader, { period: ['monthly', 'daily'], limit: 1000, page }), (r) => r?.next_page ?? null);
    const caps = await allPages((afterId) => listSpendLimits(reader, { limit: 1000, afterId }), (r) => (r?.has_more ? r.data?.at(-1)?.id : null));
    // The audit trail is read only as far back as needed to find the newest event of every per-user daily cap.
    const waiting = new Set(caps.filter((c) => c?.scope?.type === 'user' && c.period === 'daily').map((c) => c.scope.user_id));
    const audit = [];
    let afterId;
    for (let i = 0; i < MAX_PAGES && waiting.size; i += 1) {
      const page = await listAudit(reader, { limit: 1000, afterId });
      for (const e of page?.data ?? []) {
        audit.push(e);
        const cap = e?.after ?? e?.before;
        if (cap?.scope?.type === 'user' && cap.period === 'daily') waiting.delete(cap.scope.user_id);
      }
      afterId = page?.has_more ? page.data?.at(-1)?.id : null;
      if (!afterId) break;
    }

    const plan = pacePlan({ percent, now: now(), effective, caps, audit });
    summary.paced = plan.paced.length;
    summary.notPaced = plan.notPaced.length;
    // POST creates or replaces, with no condition, so a daily cap an administrator set while this run was planning would
    // be overwritten and then look like the job's. The per-user caps are listed again just before writing, and a person
    // whose daily cap changed since the plan's read is left alone.
    const dailyOf = (list) => new Map(list.filter((c) => c?.scope?.type === 'user' && c.period === 'daily').map((c) => [c.scope.user_id, `${c.id}|${c.amount}`]));
    const planned = dailyOf(caps);
    const fresh = plan.set.length
      ? dailyOf(await allPages((afterId) => listSpendLimits(reader, { scopeType: 'user', limit: 1000, afterId }), (r) => (r?.has_more ? r.data?.at(-1)?.id : null)))
      : planned;
    for (const { userId, amountCents } of plan.set) {
      if (fresh.get(userId) !== planned.get(userId)) { summary.paced -= 1; summary.notPaced += 1; continue; }
      try { await setSpendLimit(writer, { scope: { type: 'user', user_id: userId }, amountCents, period: 'daily' }); summary.set += 1; } catch (error) {
        summary.errors += 1;
        line({ evt: 'spend_pacer.error', action: 'set', status: error.status ?? null });
      }
    }
    for (const { id } of plan.remove) {
      try { await deleteSpendLimit(writer, id); summary.removed += 1; } catch (error) {
        summary.errors += 1;
        line({ evt: 'spend_pacer.error', action: 'remove', status: error.status ?? null });
      }
    }
  } catch (error) {
    summary.errors += 1;
    line({ evt: 'spend_pacer.error', action: 'run', message: error.message });
    return { exitCode: 1, summary };
  }
  line(summary);
  return { exitCode: summary.errors ? 1 : 0, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const missing = ['AZURE_CLIENT_ID', 'GATEWAY_RESOURCE_ID', 'GATEWAY_URL'].filter((n) => !env[n]);
  if (missing.length) {
    console.error(`spend pacer: ${missing.join(', ')} must be set (admin-ui/infra/main.bicep, job-spend-pacer)`);
    process.exitCode = 1;
  } else {
    const arm = createArmClient({ clientId: env.AZURE_CLIENT_ID, cache: new Map() });
    const deployAdmin = env.GATEWAY_ADMIN_FILE_JSON ? JSON.parse(env.GATEWAY_ADMIN_FILE_JSON) : undefined;
    runPacer({ arm, resourceId: env.GATEWAY_RESOURCE_ID, gatewayUrl: env.GATEWAY_URL, deployAdmin })
      .then((r) => { process.exitCode = r.exitCode; });
  }
}
