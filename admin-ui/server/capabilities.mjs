// What admin-ui's own identity may do (ADR-0010): Microsoft Graph application permissions from the roles claim of
// its app-only Graph token (U-88), and Azure RBAC actions on the gateway app from the permissions API
// (https://learn.microsoft.com/en-us/rest/api/authorization/permissions/list-for-resource).

/** The roles claim of a JWT, without verifying it: admin-ui only reads the token it was just issued. */
export function tokenRoles(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return Array.isArray(payload.roles) ? payload.roles : [];
  } catch { return []; }
}

const toRegex = (pattern) => new RegExp(`^${pattern.split('/').map((part, i, parts) => {
  // An interior wildcard also covers the resource itself, e.g. containerApps/*/read.
  if (part === '*' && i < parts.length - 1) return '(?:[^/]+/)*';
  return part.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (i < parts.length - 1 ? '/' : '');
}).join('')}$`, 'i');

/** Whether permissions [{actions, notActions}] allow one action, as Azure RBAC evaluates wildcards and notActions. */
export function actionAllowed(permissions, action) {
  return (permissions ?? []).some((p) => (p.actions ?? []).some((a) => toRegex(a).test(action)) && !(p.notActions ?? []).some((n) => toRegex(n).test(action)));
}

const ENVIRONMENT_ID = /^\/subscriptions\/[^/?#]+\/resourceGroups\/[^/?#]+\/providers\/Microsoft\.App\/managedEnvironments\/[A-Za-z0-9-]+$/i;
const USER_ASSIGNED_IDENTITY_ID = /^\/subscriptions\/[^/?#]+\/resourceGroups\/[^/?#]+\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[A-Za-z0-9_-]+$/i;

/** admin-ui's permissions on the Container Apps environment the gateway app names; the ID comes from ARM and is checked before the token goes anywhere with it. */
export async function environmentPermissions({ arm, resourceId }) {
  const app = (await arm('GET', `${resourceId}?api-version=2024-03-01`)).json;
  const environmentId = app?.properties?.managedEnvironmentId ?? app?.properties?.environmentId;
  if (typeof environmentId !== 'string' || !ENVIRONMENT_ID.test(environmentId)) throw new Error('the gateway app names no Container Apps environment');
  return (await arm('GET', `${environmentId}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`)).json?.value ?? [];
}

/** admin-ui's assign/action permission on every user-assigned identity attached to the gateway app. */
export async function gatewayIdentityPermissions({ arm, resourceId }) {
  const app = (await arm('GET', `${resourceId}?api-version=2024-03-01`)).json;
  const identityIds = Object.keys(app?.identity?.userAssignedIdentities ?? {});
  if (!identityIds.length || identityIds.some((id) => !USER_ASSIGNED_IDENTITY_ID.test(id))) {
    throw new Error('the gateway app names no valid user-assigned identity');
  }
  return Promise.all(identityIds.map(async (identityId) =>
    (await arm('GET', `${identityId}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`)).json?.value ?? []));
}

const GRAPH_GRANT = 'No Microsoft Entra admin-center portal workflow is available for granting Microsoft Graph application permissions to a managed identity. A Privileged Role Administrator or Global Administrator must create the app-role assignment through Microsoft Graph: https://learn.microsoft.com/en-us/graph/permissions-grant-via-msgraph.';
const SIGN_IN_GRANT = 'If the admin-ui sign-in app registration or role does not exist, first create the app registration in Microsoft Entra admin center > App registrations, add an enabled user role with value AdminUi.Admin under App roles, enable ID token issuance, and add the Web redirect URI https://<ca-admin-ui-fqdn>/.auth/login/aad/callback. Then in Azure Portal, open Container Apps > ca-admin-ui > Security > Authentication and enable the Microsoft Entra provider with that registration. Once the role exists, assign it in Microsoft Entra admin center > Enterprise applications > the admin-ui app > Users and groups > Add user/group. See https://learn.microsoft.com/en-us/azure/container-apps/authentication-entra and https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal.';

/**
 * graphToken: async () => an app-only Graph token. armPermissions: async () => [{actions, notActions}] on the gateway app.
 * tagsStatus: async () => {available, reason} of the business-unit tag store in the gateway database (ADR-0015).
 */
export async function capabilities({ graphToken, armPermissions, environmentPermissions = async () => [], gatewayIdentityPermissions = async () => [], signIn, tagsStatus = async () => ({ available: false, reason: 'Business-unit tags are not configured.' }) }) {
  const problems = [];
  let roles = [];
  let perms = [];
  let envPerms = [];
  let gatewayIdentityPerms = [];
  try { roles = tokenRoles(await graphToken()); } catch (e) { problems.push(`Microsoft Graph token: ${e.message}`); }
  try { perms = await armPermissions(); } catch (e) { problems.push(`Azure permissions on the gateway app: ${e.message}`); }
  try { envPerms = await environmentPermissions(); } catch (e) { problems.push(`Azure permissions on the gateway environment: ${e.message}`); }
  try { gatewayIdentityPerms = await gatewayIdentityPermissions(); } catch (e) { problems.push(`Azure permissions on the gateway identity: ${e.message}`); }
  let tags;
  try { tags = await tagsStatus(); } catch (e) { tags = { available: false, reason: e.message }; }
  if (!tags.available && tags.reason) problems.push(`Business-unit tags: ${tags.reason}`);
  const has = (...names) => names.some((n) => roles.includes(n));
  const graph = {
    readUsers: has('User.Read.All', 'User.ReadWrite.All', 'Directory.Read.All', 'Directory.ReadWrite.All'),
    assignRoles: has('AppRoleAssignment.ReadWrite.All'),
    readApps: has('Application.Read.All', 'Application.ReadWrite.OwnedBy', 'Application.ReadWrite.All', 'Directory.Read.All'),
    writeOwnedApps: has('Application.ReadWrite.OwnedBy', 'Application.ReadWrite.All'),
  };
  const arm = {
    readGateway: actionAllowed(perms, 'Microsoft.App/containerApps/read'),
    writeGateway: ['Microsoft.App/containerApps/read', 'Microsoft.App/containerApps/write', 'Microsoft.App/containerApps/listSecrets/action'].every((a) => actionAllowed(perms, a)),
    // A full PUT of the gateway app is also checked against its environment (403 LinkedAuthorizationFailed without it).
    joinEnvironment: actionAllowed(envPerms, 'Microsoft.App/managedEnvironments/join/action'),
    // Reattaching the gateway's user-assigned identity is checked as a linked authorization on that identity.
    assignGatewayIdentity: gatewayIdentityPerms.length > 0 && gatewayIdentityPerms.every((identityPerms) =>
      actionAllowed(identityPerms, 'Microsoft.ManagedIdentity/userAssignedIdentities/assign/action')),
  };
  const items = [
    { key: 'signIn', label: 'Admin sign-in', granted: signIn?.mode === 'required' && signIn?.isAdmin === true,
      unlocks: 'Changing the gateway configuration, creating roles and tagging users. Without it these pages are read-only.',
      howToGrant: SIGN_IN_GRANT },
    { key: 'graph.readUsers', label: 'User.Read.All (Microsoft Graph)', granted: graph.readUsers,
      unlocks: 'Finding users by email for the Developers page and for chargeback business units.', howToGrant: GRAPH_GRANT },
    { key: 'graph.assignRoles', label: 'AppRoleAssignment.ReadWrite.All (Microsoft Graph)', granted: graph.assignRoles,
      unlocks: 'Granting and removing a developer role on the Developers page.', howToGrant: GRAPH_GRANT },
    { key: 'graph.readApps', label: 'Application.Read.All (Microsoft Graph)', granted: graph.readApps,
      unlocks: "Listing the gateway's app roles on the Roles page.", howToGrant: GRAPH_GRANT },
    { key: 'graph.writeOwnedApps', label: 'Application.ReadWrite.OwnedBy (Microsoft Graph), as an owner of the gateway app registration', granted: graph.writeOwnedApps,
      unlocks: 'Creating app roles on the Roles page.', howToGrant: `${GRAPH_GRANT} Add admin-ui as an owner of the gateway app registration in Entra admin center > App registrations > the gateway app > Owners.` },
    { key: 'database.tags', label: 'Business-unit tags in the gateway database', granted: tags.available === true,
      unlocks: "Setting each user's department, cost center, company, office and division on the Chargeback page, without writing to Entra ID.",
      howToGrant: "Tags are kept in the gateway's managed PostgreSQL, which admin-ui reads with its Container Apps Contributor role on the gateway app. A gateway on the in-app database needs the managed database option: see docs/learn/how-to-install-stage-by-stage.md, Choose the database." },
    { key: 'arm.writeGateway', label: 'Container Apps Contributor on the gateway app (Azure RBAC)', granted: arm.writeGateway,
      unlocks: 'Reading and saving the gateway configuration on the Access & models page.', howToGrant: 'Azure Portal: open the gateway Container App > Access control (IAM) > Add role assignment > Container Apps Contributor > select the id-admin-ui managed identity. Keep the scope at the gateway app. The person assigning it needs Owner or User Access Administrator. See https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-portal.' },
    { key: 'arm.joinEnvironment', label: "Container Apps Operator on the gateway's Container Apps environment (Azure RBAC)", granted: arm.joinEnvironment,
      unlocks: 'Applying a saved gateway configuration. Azure checks Microsoft.App/managedEnvironments/join/action on the environment for every update of the gateway app, and answers 403 LinkedAuthorizationFailed without it.',
      howToGrant: 'Azure Portal: open the gateway\'s Container Apps environment (for example cae-claude-gw) > Access control (IAM) > Add role assignment > Container Apps Operator > select the id-admin-ui managed identity. Keep the scope at the environment. Container Apps Operator has no write access to the environment or to any app. See https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/containers#container-apps-operator.' },
    { key: 'arm.assignGatewayIdentity', label: "Managed Identity Operator on the gateway's user-assigned identity (Azure RBAC)", granted: arm.assignGatewayIdentity,
      unlocks: 'Applying a saved gateway configuration. Azure checks Microsoft.ManagedIdentity/userAssignedIdentities/assign/action when the gateway app update reattaches its managed identity.',
      howToGrant: 'Azure Portal: open the gateway user-assigned identity (for example id-claude-gw) > Access control (IAM) > Add role assignment > Managed Identity Operator > select the id-admin-ui managed identity. Keep the scope at id-claude-gw. This role allows assigning the identity but not changing it. See https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/identity#managed-identity-operator.' },
  ];
  return { signIn, items, graph, arm, problems };
}
