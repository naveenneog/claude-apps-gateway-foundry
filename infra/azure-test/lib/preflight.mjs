// ADR-0018: the read-only checks the installer runs before it changes anything (P-48), as the preflight stage and
// under -Plan. arm(method, path, body, { ok }) -> { status, json } is lib/azure-rest.mjs's; only GET is called.
import { groupDecision, nameClashes } from './existing-group.mjs';
import { databaseRegions } from './plan.mjs';

const GROUP_API = 'api-version=2022-09-01';
const RESOURCES_API = 'api-version=2021-04-01';
const AI_API = 'api-version=2024-10-01';
const PG_API = 'api-version=2024-08-01';
const PROVIDER_API = 'api-version=2022-09-01';
const PG_VERSION = '16';
const PG_EDITION = 'Burstable';
const PG_SKU = 'Standard_B1ms';

/**
 * Whether a region's PostgreSQL flexible-server capabilities, as this subscription sees them, offer what
 * gateway-test.json creates. capabilities is the JSON of GET .../locations/{region}/capabilities (U-135).
 */
export function regionCapability(capabilities) {
  const c = capabilities?.value?.[0];
  if (!c) return { ok: false, reason: 'no capabilities returned for this region' };
  if (String(c.restricted).toLowerCase() === 'enabled') return { ok: false, reason: 'the subscription is restricted from creating PostgreSQL servers here' };
  const edition = (c.supportedServerEditions ?? []).find((e) => e.name === PG_EDITION);
  if (!edition?.supportedServerSkus?.some((s) => s.name === PG_SKU)) return { ok: false, reason: `${PG_EDITION} ${PG_SKU} is not offered` };
  if (!(c.supportedServerVersions ?? []).some((v) => v.name === PG_VERSION)) return { ok: false, reason: `PostgreSQL ${PG_VERSION} is not offered` };
  return { ok: true, reason: `PostgreSQL ${PG_VERSION}, ${PG_EDITION} ${PG_SKU} offered` };
}

// The refusals that mean "try another region" (https://learn.microsoft.com/azure/postgresql/troubleshoot/how-to-resolve-capacity-errors,
// the SkuNotAvailable a customer install got in eastus2 on 2026-11-03, and Contoso's eastus answer, U-135). Anything else
// stops the install.
const REFUSALS = [
  /"code"\s*:\s*"SkuNotAvailable"/, /\bSkuNotAvailable\b/, /Provisioning is restricted in this region/i, /is not accepting creation of new/i,
  /exceeding approved .* quota/i, /restricted from provisioning in this region/i, /not allowed to provision in/i,
  /Specified SKU is not supported in this region/i, /does not have access to create a server in the selected region/i,
  /not available for subscription .* due to capacity constraints/i, /\bLocationIsOfferRestricted\b/,
  // A region whose capabilities say restricted: Enabled answers a create with an empty allowed-version list (U-135).
  /ParameterOutOfRange.*should be in: \[\]/s,
];
export const isRegionRefusal = (message) => REFUSALS.some((re) => re.test(String(message)));

/** Deployment names the admin file's models use that the Foundry account's deployment list lacks. */
export function missingDeployments(listed, models) {
  const have = new Set((listed?.value ?? []).map((d) => d.name));
  return [...new Set(models.map((m) => m.deployment))].filter((d) => !have.has(d));
}

const line = (level, text) => `${level.padEnd(5)} ${text}`;

/**
 * Runs every check and returns { ok, lines, databaseRegions } without changing anything. databaseRegions lists, in
 * order, the regions the database step may try.
 */
export async function runPreflight({ arm, subscriptionPath, groupPath, group, state = {}, useExisting = false, location, foundry, models = [], database, databaseOption }) {
  const lines = [];
  let ok = true;
  const pass = (t) => lines.push(line('PASS', t));
  const warn = (t) => lines.push(line('WARN', t));
  const fail = (t) => { ok = false; lines.push(line('FAIL', t)); };

  const rg = await arm('GET', `${groupPath}?${GROUP_API}`, undefined, { ok: [200, 404] });
  try {
    const decision = groupDecision({ status: rg.status, tags: rg.json?.tags ?? {}, state, useExisting });
    if (decision.action === 'create') pass(`resource group ${group}: does not exist; the base stage creates it in ${location}`);
    else if (!decision.existingGroup) pass(`resource group ${group}: created by an earlier run of the installer (runId ${decision.runId})`);
    else {
      const listed = (await arm('GET', `${groupPath}/resources?${RESOURCES_API}`)).json?.value ?? [];
      const clashes = nameClashes(listed, state.runId ?? decision.runId);
      if (clashes.length) fail(`resource group ${group}: holds ${clashes.join(', ')}, named like resources the installer creates; remove or rename them, or use another group`);
      else pass(`resource group ${group}: exists; the installer adds its resources next to the ${listed.length} already there and never deletes the group`);
    }
  } catch (error) { fail(`resource group ${group}: ${error.message}`); }

  if (foundry?.account) {
    const accountPath = `${subscriptionPath}/resourceGroups/${foundry.resourceGroup}/providers/Microsoft.CognitiveServices/accounts/${foundry.account}`;
    const account = await arm('GET', `${accountPath}?${AI_API}`, undefined, { ok: [200, 403, 404] });
    if (account.status === 404) fail(`Foundry account ${foundry.account}: not found in ${foundry.resourceGroup}; check -FoundryResourceGroup and -FoundryAccount`);
    else if (account.status === 403) fail(`Foundry account ${foundry.account}: the signed-in account may not read it; it needs Owner (or Reader and User Access Administrator) on the account`);
    else {
      const missing = missingDeployments((await arm('GET', `${accountPath}/deployments?${AI_API}`)).json, models);
      if (missing.length) fail(`Foundry account ${foundry.account}: no deployment named ${missing.join(', ')}; create it in Foundry or change models[].deployment in the admin file`);
      else pass(`Foundry account ${foundry.account}: holds ${[...new Set(models.map((m) => m.deployment))].join(', ') || 'the account (no models listed)'}`);
    }
  }

  const usable = [];
  if (database === 'managed') {
    let regions = [];
    try { regions = databaseRegions(databaseOption, location); } catch (error) { fail(`database: ${error.message}`); }
    const provider = await arm('GET', `${subscriptionPath}/providers/Microsoft.DBforPostgreSQL?${PROVIDER_API}`, undefined, { ok: [200, 404] });
    if (provider.json?.registrationState !== 'Registered') warn(`database: Microsoft.DBforPostgreSQL is ${provider.json?.registrationState ?? 'not registered'}; the base stage registers it`);
    for (const region of regions) {
      const caps = await arm('GET', `${subscriptionPath}/providers/Microsoft.DBforPostgreSQL/locations/${region}/capabilities?${PG_API}`, undefined, { ok: [200, 400, 404, 409] });
      // 409: the provider is not registered yet, so the region cannot be read; base registers it and then tries it.
      if (caps.status === 409) { usable.push(region); warn(`database region ${region}: not checked, because Microsoft.DBforPostgreSQL is not registered yet; the base stage tries it`); continue; }
      const verdict = caps.status === 200 ? regionCapability(caps.json) : { ok: false, reason: `not a PostgreSQL region (${caps.status})` };
      if (verdict.ok) { usable.push(region); pass(`database region ${region}: ${verdict.reason}`); } else warn(`database region ${region}: ${verdict.reason}; skipped`);
    }
    if (regions.length && !usable.length) {
      fail(`database: no region in ${regions.join(', ')} offers ${PG_EDITION} ${PG_SKU} with PostgreSQL ${PG_VERSION} to this subscription; add regions to -DatabaseLocation, for example centralus,westus3`);
    } else if (usable.length) {
      lines.push(line('INFO', 'database: a region can still refuse at creation time; the base stage creates the database first and moves to the next region if it does'));
    }
  } else {
    pass('database: in-app PostgreSQL (sidecar); no region check');
  }
  return { ok, lines, databaseRegions: usable };
}
