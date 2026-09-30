#!/usr/bin/env node
// Grants, removes and lists the gateway's app roles through Microsoft Graph (ADR-0004, T-53). The gateway admits a user
// whose token carries one of its roles (oidc.allowed_groups on the roles claim, config/gateway.azure-test.yaml); an
// assignment change reaches the gateway at the user's next sign-in or session refresh.
//   node scripts/admin/set-developer.mjs --upn dev@contoso.com --role Gateway.Standard [--remove] [--admin <file>]
//   node scripts/admin/set-developer.mjs --list
// A grant needs a role that the admin file admits, the file new-gateway-config.mjs renders the gateway configuration
// from (default config/gateway-admin.azure-test.json); the file is read and checked before any Graph request.
// Uses the Azure CLI sign-in; the caller must be allowed to manage the app's role assignments (for example as owner
// of the service principal). https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-approleassignedto
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { adminErrors } from './new-gateway-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_ADMIN = path.join(root, 'config', 'gateway-admin.azure-test.json');
// A path inside the repository as the renderer names it, anything else in full.
const shownPath = (file) => (path.relative(root, file).startsWith('..') ? file : path.relative(root, file).replaceAll('\\', '/'));
const LISTING = '?$select=id,principalId,principalDisplayName,appRoleId,resourceId&$top=999';

async function assignmentsOf(graph, servicePrincipalId) {
  const all = [];
  let next = `/servicePrincipals/${servicePrincipalId}/appRoleAssignedTo${LISTING}`;
  while (next) {
    const page = (await graph('GET', next)).json;
    all.push(...(page.value ?? []));
    next = page['@odata.nextLink'] ?? null;
  }
  // The listing is the gateway app's; an assignment of another resource is never acted on.
  return all.filter((a) => a.resourceId === servicePrincipalId);
}

function roleNamed(appRoles, role) {
  const found = appRoles.find((r) => r.value === role);
  if (!found) throw new Error(`${role} is not an app role of the gateway app; the roles are ${appRoles.map((r) => r.value).join(', ')}`);
  return found;
}

/** The roles the gateway admits, from an admin file that passes the renderer's validation (T-52). */
export function admittedRolesFrom(adminFile, knownRoles) {
  let admin;
  try {
    admin = JSON.parse(fs.readFileSync(adminFile, 'utf8'));
  } catch (error) {
    throw new Error(`${shownPath(adminFile)} is not readable JSON: ${error.message}`);
  }
  const errors = adminErrors(admin, knownRoles);
  if (errors.length) throw new Error(`${shownPath(adminFile)} has ${errors.length} problem(s):\n  ${errors.join('\n  ')}`);
  return admin.roles;
}

/**
 * Grants role to upn, or removes it; returns { changed, message }. Throws, changing nothing, on an unknown role or user,
 * on a grant without admittedRoles, the roles the gateway admits, and on a grant of a role they do not include: its
 * holder could not sign in. A removal needs no admitted roles.
 */
export async function setDeveloper({ graph, servicePrincipalId, appRoles, admittedRoles, adminFile = 'the admin file', upn, role, remove = false }) {
  const appRole = roleNamed(appRoles, role);
  if (!remove) {
    if (!Array.isArray(admittedRoles)) throw new Error('a grant needs the roles the gateway admits, from the admin file');
    if (!admittedRoles.includes(role)) {
      throw new Error(`the gateway does not admit ${role}: ${adminFile} lists ${admittedRoles.join(', ')}; add it there and deploy the configuration first`);
    }
  }
  const user = await graph('GET', `/users/${encodeURIComponent(upn)}?$select=id,displayName,userPrincipalName`, undefined, { ok: [200, 404] });
  if (user.status === 404) throw new Error(`no user ${upn} in the directory`);
  const who = `${user.json.displayName} (${user.json.userPrincipalName})`;
  const mine = (await assignmentsOf(graph, servicePrincipalId)).filter((a) => a.principalId === user.json.id && a.appRoleId === appRole.id);
  if (remove) {
    if (!mine.length) return { changed: false, message: `${who} does not hold ${role}; nothing to remove` };
    for (const a of mine) await graph('DELETE', `/servicePrincipals/${servicePrincipalId}/appRoleAssignedTo/${a.id}`);
    return { changed: true, message: `${role} removed from ${who}` };
  }
  if (mine.length) return { changed: false, message: `${who} already holds ${role}` };
  await graph('POST', `/servicePrincipals/${servicePrincipalId}/appRoleAssignedTo`, { principalId: user.json.id, resourceId: servicePrincipalId, appRoleId: appRole.id });
  return { changed: true, message: `${role} granted to ${who}` };
}

/** Holders of each gateway role, in the manifest's role order. */
export async function listDevelopers({ graph, servicePrincipalId, appRoles }) {
  const assignments = await assignmentsOf(graph, servicePrincipalId);
  return appRoles.flatMap((r) => assignments.filter((a) => a.appRoleId === r.id)
    .map((a) => ({ role: r.value, name: a.principalDisplayName, principalId: a.principalId })));
}

/**
 * The command line; returns what it prints. deps replaces Graph, the deployment state and the app roles, for tests.
 * The admin file is read and checked before any Graph request, so a wrong file changes nothing.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const { values } = parseArgs({ args: argv, options: {
    upn: { type: 'string' },
    role: { type: 'string' },
    remove: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    admin: { type: 'string', default: DEFAULT_ADMIN },
    'resource-group': { type: 'string', default: 'rg-claude-apps-gateway-test' },
  } });
  if (!values.list && (!values.upn || !values.role)) throw new Error('pass --upn <user> --role <role> [--remove] [--admin <file>], or --list');
  const appRoles = deps.appRoles ?? JSON.parse(fs.readFileSync(path.join(root, 'infra', 'azure-test', 'entra-app.json'), 'utf8')).appRoles;
  const adminFile = path.resolve(values.admin);
  const admittedRoles = values.list ? null : admittedRolesFrom(adminFile, appRoles.map((r) => r.value));
  const readState = deps.readState ?? (await import('../../infra/azure-test/deploy.mjs')).readState;
  const graph = deps.graph ?? (await import('../../infra/azure-test/lib/azure-rest.mjs')).graph;
  const servicePrincipalId = readState(values['resource-group']).servicePrincipal?.id;
  if (!servicePrincipalId) throw new Error(`no service principal recorded for ${values['resource-group']}; run infra/azure-test/deploy.mjs --step entra first`);
  if (values.list) {
    const rows = await listDevelopers({ graph, servicePrincipalId, appRoles });
    return rows.length ? rows.map((row) => `${row.role}\t${row.name}\t${row.principalId}`).join('\n') : 'no user holds a gateway role';
  }
  const { message } = await setDeveloper({ graph, servicePrincipalId, appRoles, admittedRoles, adminFile: shownPath(adminFile),
    upn: values.upn, role: values.role, remove: values.remove });
  return message;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((out) => console.log(out), (error) => {
    console.error(`[set-developer] ${error.message}`);
    process.exitCode = 1;
  });
}
