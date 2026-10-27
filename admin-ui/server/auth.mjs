// Who is calling admin-ui (ADR-0010, U-87). With Container Apps authentication on, the platform signs the user in
// and sets X-MS-CLIENT-PRINCIPAL (base64 JSON of the token's claims), removing any copy an external caller sent.
// With it off, anyone who reaches admin-ui can send that header, so it is read only when ADMIN_UI_SIGN_IN=required,
// which main.bicep sets only together with the authConfigs resource.
// https://learn.microsoft.com/en-us/azure/container-apps/authentication#access-user-claims-in-application-code

export const ADMIN_ROLE = 'AdminUi.Admin';
const ROLE_TYPES = ['roles', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role'];

/** { signIn, user: {name, upn} | null, roles, isAdmin } for one request. headers: lower-cased, as node:http gives them. */
export function principalFrom(headers = {}, signIn = 'off') {
  const mode = signIn === 'required' ? 'required' : 'off';
  const none = { signIn: mode, user: null, roles: [], isAdmin: false };
  if (mode !== 'required') return none;
  const raw = headers['x-ms-client-principal'];
  if (typeof raw !== 'string' || !raw) return none;
  let p;
  try { p = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch { return none; }
  if (!p || !Array.isArray(p.claims)) return none;
  const roleTypes = [...ROLE_TYPES, p.role_typ].filter(Boolean);
  const claim = (...types) => p.claims.find((c) => types.includes(c?.typ))?.val ?? null;
  const roles = p.claims.filter((c) => roleTypes.includes(c?.typ) && typeof c.val === 'string').map((c) => c.val);
  const upn = claim('preferred_username', 'upn', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn', p.name_typ) ?? null;
  const id = claim('http://schemas.microsoft.com/identity/claims/objectidentifier', 'oid') ?? null;
  return { signIn: mode, user: { name: claim('name') ?? upn, upn, id }, roles, isAdmin: roles.includes(ADMIN_ROLE) };
}

/**
 * ADR-0011: with sign-in required, the whole API (except /api/health and /api/me) is for AdminUi.Admin holders only.
 * null when the caller may use the console; otherwise the 403 to answer with. Sign-in off: the IP allowlist decides.
 */
export function consoleRefusal(principal) {
  if (principal.signIn !== 'required' || principal.isAdmin) return null;
  const who = principal.user?.upn ? ` ${principal.user.upn} is signed in but` : ' The caller';
  return { status: 403, body: { error: `admin-ui is for administrators only.${who} does not hold the ${ADMIN_ROLE} app role on the admin-ui sign-in app. Assign it in Entra admin center > Enterprise applications > the admin-ui sign-in app > Users and groups.` } };
}

/** null when the caller may change things; otherwise the 403 to answer with. */
export function adminRefusal(principal) {
  if (principal.signIn !== 'required') {
    return { status: 403, body: { error: 'Changes need Microsoft Entra sign-in. The admin-ui sign-in app registration must define the AdminUi.Admin app role before it can be assigned. See Settings for the Azure Portal setup steps, then assign the role in Entra admin center > Enterprise applications > the admin-ui app > Users and groups.' } };
  }
  if (!principal.isAdmin) return { status: 403, body: { error: `Changes need the ${ADMIN_ROLE} app role on the admin-ui app registration.` } };
  return null;
}
