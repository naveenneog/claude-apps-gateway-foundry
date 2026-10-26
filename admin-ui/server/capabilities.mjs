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

const toRegex = (pattern) => new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`, 'i');

/** Whether permissions [{actions, notActions}] allow one action, as Azure RBAC evaluates wildcards and notActions. */
export function actionAllowed(permissions, action) {
  return (permissions ?? []).some((p) => (p.actions ?? []).some((a) => toRegex(a).test(action)) && !(p.notActions ?? []).some((n) => toRegex(n).test(action)));
}

const GRAPH_GRANT = 'No Microsoft Entra admin-center portal workflow is available for granting Microsoft Graph application permissions to a managed identity. A Privileged Role Administrator or Global Administrator must create the app-role assignment through Microsoft Graph: https://learn.microsoft.com/en-us/graph/permissions-grant-via-msgraph.';
const SIGN_IN_GRANT = 'If the admin-ui sign-in app registration or role does not exist, first create the app registration in Microsoft Entra admin center > App registrations, add an enabled user role with value AdminUi.Admin under App roles, enable ID token issuance, and add the Web redirect URI https://<ca-admin-ui-fqdn>/.auth/login/aad/callback. Then in Azure Portal, open Container Apps > ca-admin-ui > Security > Authentication and enable the Microsoft Entra provider with that registration. Once the role exists, assign it in Microsoft Entra admin center > Enterprise applications > the admin-ui app > Users and groups > Add user/group. See https://learn.microsoft.com/en-us/azure/container-apps/authentication-entra and https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal.';

/** graphToken: async () => an app-only Graph token. armPermissions: async () => [{actions, notActions}] on the gateway app. */
export async function capabilities({ graphToken, armPermissions, signIn }) {
  const problems = [];
  let roles = [];
  let perms = [];
  try { roles = tokenRoles(await graphToken()); } catch (e) { problems.push(`Microsoft Graph token: ${e.message}`); }
  try { perms = await armPermissions(); } catch (e) { problems.push(`Azure permissions on the gateway app: ${e.message}`); }
  const has = (...names) => names.some((n) => roles.includes(n));
  const graph = {
    readUsers: has('User.Read.All', 'User.ReadWrite.All', 'Directory.Read.All', 'Directory.ReadWrite.All'),
    assignRoles: has('AppRoleAssignment.ReadWrite.All'),
    readApps: has('Application.Read.All', 'Application.ReadWrite.OwnedBy', 'Application.ReadWrite.All', 'Directory.Read.All'),
    writeOwnedApps: has('Application.ReadWrite.OwnedBy', 'Application.ReadWrite.All'),
    writeUsers: has('User.ReadWrite.All', 'Directory.ReadWrite.All'),
  };
  const arm = {
    readGateway: actionAllowed(perms, 'Microsoft.App/containerApps/read'),
    writeGateway: ['Microsoft.App/containerApps/read', 'Microsoft.App/containerApps/write', 'Microsoft.App/containerApps/listSecrets/action'].every((a) => actionAllowed(perms, a)),
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
    { key: 'graph.writeUsers', label: 'User.ReadWrite.All (Microsoft Graph)', granted: graph.writeUsers,
      unlocks: "Setting a user's department or cost center from the Chargeback page.", howToGrant: `${GRAPH_GRANT} Without it, set these in the Microsoft Entra admin center > Users > the user > Properties.` },
    { key: 'arm.writeGateway', label: 'Container Apps Contributor on the gateway app (Azure RBAC)', granted: arm.writeGateway,
      unlocks: 'Reading and saving the gateway configuration on the Access & models page.', howToGrant: 'Azure Portal: open the gateway Container App > Access control (IAM) > Add role assignment > Container Apps Contributor > select the id-admin-ui managed identity. Keep the scope at the gateway app. The person assigning it needs Owner or User Access Administrator. See https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-portal.' },
  ];
  return { signIn, items, graph, arm, problems };
}
