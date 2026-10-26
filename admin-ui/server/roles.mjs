// The gateway application's Entra app roles (ADR-0010): listed live from Microsoft Graph, and created by admin-ui as an
// owner of that application with Application.ReadWrite.OwnedBy (U-86). appRoles is replaced as a whole collection by
// PATCH /applications/{id}, so a create sends every existing role back unchanged, without the read-only origin.
// https://learn.microsoft.com/en-us/graph/api/application-update
// https://learn.microsoft.com/en-us/graph/api/resources/approle
import crypto from 'node:crypto';

// A subset of the characters Graph allows in a role value: the roles claim is matched by the gateway's own
// managed.policies and by adminErrors(), whose role pattern this stays inside.
const VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const TEXT = /^[^\x00-\x1f\x7f]{1,256}$/;

function fail(status, message) { return Object.assign(new Error(message), { status }); }

/** The application object behind the gateway's service principal: { id, appId, appRoles }. */
export async function gatewayApplication({ graph, servicePrincipalId }) {
  const sp = (await graph('GET', `/servicePrincipals/${encodeURIComponent(servicePrincipalId)}?$select=id,appId`)).json;
  return (await graph('GET', `/applications(appId='${encodeURIComponent(sp.appId)}')?$select=id,appId,appRoles`)).json;
}

/** Every app role with whether the admin file admits it and, if so, its policy. */
export async function listRoles({ graph, servicePrincipalId, admin }) {
  const app = await gatewayApplication({ graph, servicePrincipalId });
  const admitted = new Set(Array.isArray(admin?.roles) ? admin.roles : []);
  const policies = new Map((Array.isArray(admin?.policies) ? admin.policies : []).map((p) => [p.role, p]));
  return (app.appRoles ?? []).map((r) => {
    const p = policies.get(r.value);
    return {
      id: r.id, value: r.value, displayName: r.displayName, description: r.description, isEnabled: r.isEnabled,
      admitted: admitted.has(r.value),
      policy: admitted.has(r.value) && p ? { models: [...(p.models ?? [])], desktop: typeof p.desktop === 'boolean' ? p.desktop : null } : null,
    };
  });
}

/** Adds one enabled, user-assignable app role. Refuses an invalid value (400) or one that exists in any case (409). */
export async function createRole({ graph, servicePrincipalId, newId = () => crypto.randomUUID() }, { value, displayName, description } = {}) {
  if (typeof value !== 'string' || !VALUE.test(value)) throw fail(400, 'value must be 1 to 120 letters, digits, dots, underscores or hyphens, starting with a letter or digit');
  if (typeof displayName !== 'string' || !TEXT.test(displayName)) throw fail(400, 'displayName must be 1 to 256 characters without control characters');
  if (typeof description !== 'string' || !TEXT.test(description)) throw fail(400, 'description must be 1 to 256 characters without control characters');
  const app = await gatewayApplication({ graph, servicePrincipalId });
  const existing = app.appRoles ?? [];
  if (existing.some((r) => String(r.value).toLowerCase() === value.toLowerCase())) throw fail(409, `the app role ${value} already exists`);
  const role = { id: newId(), value, displayName, description, isEnabled: true, allowedMemberTypes: ['User'] };
  const appRoles = [...existing.map(({ origin, ...rest }) => rest), role];
  await graph('PATCH', `/applications/${encodeURIComponent(app.id)}`, { appRoles });
  return { id: role.id, value, displayName, description, isEnabled: true };
}
