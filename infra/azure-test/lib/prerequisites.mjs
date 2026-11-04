// Prerequisites of a first install (docs/learn/tutorial-first-install.md, "Before you begin") that preflight reads
// before anything is built (P-48, ADR-0018). Pure functions; preflight.mjs makes the calls.

// Entra built-in role template IDs (https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference).
export const ROLE = Object.freeze({
  globalAdministrator: '62e90394-69f5-4237-9190-012177145e10',
  privilegedRoleAdministrator: 'e8611ab8-c189-46e8-94e1-60213ab1f814',
  applicationAdministrator: '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3',
  cloudApplicationAdministrator: '158c047a-c907-4556-b7ef-446551a6b5f7',
  applicationDeveloper: 'cf1c38e5-3621-4004-a7cb-879624dced7c',
});
const REGISTER = [ROLE.globalAdministrator, ROLE.applicationAdministrator, ROLE.cloudApplicationAdministrator, ROLE.applicationDeveloper];
const GRANT = [ROLE.globalAdministrator, ROLE.privilegedRoleAdministrator];

const glob = (pattern) => new RegExp(`^${String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');

/**
 * Whether ARM permissions (GET .../providers/Microsoft.Authorization/permissions: [{ actions, notActions }]) allow an
 * action: some entry's actions match it and that entry's notActions do not
 * (https://learn.microsoft.com/azure/role-based-access-control/role-definitions#notactions).
 */
export function permits(permissions, action) {
  return (permissions ?? []).some((p) => (p.actions ?? []).some((a) => glob(a).test(action)) && !(p.notActions ?? []).some((n) => glob(n).test(action)));
}

const older = (version, minimum) => {
  const v = String(version ?? '').split('.').map(Number); const m = minimum.split('.').map(Number);
  for (let i = 0; i < m.length; i++) if ((v[i] || 0) !== m[i]) return (v[i] || 0) < m[i];
  return false;
};

/** Problems with the tools on this machine. az is the JSON of `az version`. */
export function toolProblems({ node, az }) {
  const out = [];
  if (older(node, '22.0.0')) out.push(`Node.js ${node} is older than 22; install Node.js 22 or later (https://nodejs.org/en/download)`);
  if (!az?.['azure-cli']) out.push('the Azure CLI was not found; install it (https://learn.microsoft.com/cli/azure/install-azure-cli)');
  else if (older(az['azure-cli'], '2.60.0')) out.push(`Azure CLI ${az['azure-cli']} is older than 2.60; run az upgrade`);
  if (az?.['azure-cli'] && !az.extensions?.containerapp) out.push('the Azure CLI containerapp extension is missing, which the admin-ui stage uses; run az extension add --name containerapp --upgrade');
  return out;
}

/** What the signed-in account may do in Entra ID: register the gateway's app, and grant the console's Graph permissions. */
export function entraRights({ roles = [], allowedToCreateApps = false }) {
  return { canRegister: allowedToCreateApps === true || roles.some((r) => REGISTER.includes(r)), canGrant: roles.some((r) => GRANT.includes(r)) };
}

/** Why the gateway cannot use a Foundry account, from its ARM properties, or null. */
export function foundryNetworkProblem(account) {
  const p = account?.properties ?? {};
  if (String(p.publicNetworkAccess).toLowerCase() === 'disabled') return 'public network access is disabled, and the gateway reaches the account over the internet; enable it under Networking';
  if (p.customSubDomainName && p.customSubDomainName.toLowerCase() !== String(account.name).toLowerCase()) {
    return `its endpoint subdomain ${p.customSubDomainName} is not its name, and the gateway names the endpoint by the account name`;
  }
  return null;
}
