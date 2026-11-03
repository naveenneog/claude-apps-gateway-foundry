// ADR-0018: installing into a resource group this tool did not create (P-46). Pure functions; deploy.mjs and
// teardown.mjs make the Azure calls.

const PURPOSE = 'claude-apps-gateway-test';

// The names gateway-test.json and admin-ui/infra/main.bicep give the resources they create, and the Key Vault the
// installer can create (P-45). A resource with one of these names that lacks this run's tag would be changed by the
// deployment, so it is a clash.
const OWN_NAMES = [
  /^id-claude-gw$/, /^crclaudegw[a-z0-9]{8}$/, /^log-claude-gw-[a-z0-9]+$/, /^cae-claude-gw$/, /^ca-claude-gw$/, /^psql-claude-gw-[a-z0-9]+-[a-z0-9]+$/,
  /^id-admin-ui$/, /^ca-admin-ui$/, /^job-spend-pacer$/, /^job-signin-renewer$/, /^kv-claude-gw-[a-z0-9]+$/,
];

// Deleted tier by tier: apps and jobs run in the environment, which uses the workspace; the rest have no order.
const API = {
  'microsoft.app/containerapps': ['2024-03-01', 0],
  'microsoft.app/jobs': ['2024-03-01', 0],
  'microsoft.app/managedenvironments': ['2024-03-01', 1],
  'microsoft.managedidentity/userassignedidentities': ['2023-01-31', 2],
  'microsoft.containerregistry/registries': ['2023-07-01', 2],
  'microsoft.operationalinsights/workspaces': ['2022-10-01', 2],
  'microsoft.dbforpostgresql/flexibleservers': ['2024-08-01', 2],
  'microsoft.keyvault/vaults': ['2023-07-01', 2],
};

/**
 * What the base stage does with the resource group. status is the GET status, tags the group's tags, state the state
 * file, useExisting the --use-existing-resource-group option. Returns { action: 'create' | 'use' | 'adopt',
 * existingGroup, runId? }; throws when the group may not be used.
 */
export function groupDecision({ status, tags = {}, state = {}, useExisting = false }) {
  if (status === 404) return { action: 'create', existingGroup: false };
  if (state.existingGroup) return { action: 'adopt', existingGroup: true, runId: state.runId };
  if (tags.purpose === PURPOSE && tags.runId && (!state.runId || tags.runId === state.runId)) return { action: 'use', existingGroup: false, runId: tags.runId };
  if (tags.purpose === PURPOSE && state.runId && tags.runId !== state.runId) {
    throw new Error(`the resource group carries runId ${tags.runId}, but the state file records ${state.runId}; refusing to use it`);
  }
  if (useExisting) return { action: 'adopt', existingGroup: true };
  throw new Error('the resource group exists and was not created by this tool. To install into it, run the installer with '
    + '-UseExistingResourceGroup (deploy.mjs --use-existing-resource-group): resources are added next to what is there, and '
    + 'teardown removes only what the installer added.');
}

const runIdOf = (r) => r.tags?.runId;

/** Resources named like ones this tool creates that do not carry this run's runId, as "type/name (why)". */
export function nameClashes(resources, runId) {
  return resources
    .filter((r) => OWN_NAMES.some((re) => re.test(r.name)) && (!runId || runIdOf(r) !== runId))
    .map((r) => `${r.type}/${r.name} (${runIdOf(r) ? `runId ${runIdOf(r)}` : 'no runId'})`);
}

/**
 * The resources teardown deletes from an existing group: those tagged with this run's runId and named as the installer
 * names them, in deletion tiers, each with the api-version to delete it. unknown lists the other tagged resources, which
 * teardown reports and leaves.
 */
export function teardownTiers(resources, runId) {
  const tiers = [[], [], []];
  const unknown = [];
  for (const r of resources) {
    if (runIdOf(r) !== runId) continue;
    const known = API[String(r.type).toLowerCase()];
    // Both the tag and an installer-made name: a runId copied onto a customer resource does not get it deleted.
    if (!known || !OWN_NAMES.some((re) => re.test(r.name))) { unknown.push(r); continue; }
    tiers[known[1]].push({ ...r, apiVersion: known[0] });
  }
  return { tiers: tiers.filter((t) => t.length), unknown };
}
