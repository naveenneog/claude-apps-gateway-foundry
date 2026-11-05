#!/usr/bin/env node
// The admin-ui's process entry point: a plain node:http server serving the static frontend (web/) and the API
// (api.mjs) under /api/*. No framework, per this repository's "Node.js 22 or later and no packages" convention
// (README.md). Configuration comes entirely from environment variables, set as Container App secrets/env in
// admin-ui/infra/main.bicep (ADR-0008).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './api.mjs';
import { createArmClient } from './arm-client.mjs';
import { capabilities, environmentPermissions, tokenRoles } from './capabilities.mjs';
import { buildChargeback, chargebackCsv, collectEffective, findUser, listBusinessUnits, PERIODS } from './chargeback.mjs';
import { createConfigStore } from './gateway-config.mjs';
import { createGraphClient } from './graph-client.mjs';
import { createSignInCredential } from './signin-credential.mjs';
import { getManagedIdentityToken } from './managed-identity.mjs';
import { createRole, gatewayApplication, listRoles } from './roles.mjs';
import { createTagStore, gatewayDatabase } from './user-tags.mjs';
import { adminErrors } from '../../scripts/admin/new-gateway-config.mjs';
import { listDevelopers, setDeveloper } from '../../scripts/admin/set-developer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, '..', 'web');

function requireEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} must be set; see admin-ui/README.md`);
  return value;
}

/** Builds the deps object api.mjs needs, read once at startup so a misconfiguration fails fast, not on first request. */
export function buildDeps({ env = process.env, fetchImpl = fetch, log = console.error } = {}) {
  const gatewayUrl = requireEnv(env, 'GATEWAY_URL');
  const writeKey = requireEnv(env, 'GATEWAY_ADMIN_WRITE_KEY');
  const clientId = requireEnv(env, 'AZURE_CLIENT_ID');
  const servicePrincipalId = requireEnv(env, 'GATEWAY_SERVICE_PRINCIPAL_ID');
  const appRoles = JSON.parse(requireEnv(env, 'GATEWAY_APP_ROLES')); // [{id, value}, ...], the Entra app manifest's appRoles
  // The same admin file new-gateway-config.mjs renders the gateway's own config from (config/gateway-admin.azure-private.json),
  // passed as content here because this deployed service has no repository checkout to read it from, unlike an operator's machine.
  const admin = JSON.parse(requireEnv(env, 'GATEWAY_ADMIN_FILE_JSON'));
  const knownRoles = appRoles.map((r) => r.value);
  // 'test': admin-ui reads only roles, policies and models (for the Developers and Budgets pages) and never
  // deployment.developerCidrs, a gateway network-access-control concern on the private topology only (ADR-0005).
  // Passing the default 'private' here made admin-ui require developerCidrs even for a test-topology admin file
  // such as config/gateway-admin.azure-test-demo.json, whose deployment block is just { adminApi: true } - found
  // live 2026-10-17, crash-looping both deployments the test-topology admin file was ever pushed to.
  const errors = adminErrors(admin, knownRoles, 'test');
  if (errors.length) throw new Error(`GATEWAY_ADMIN_FILE_JSON has ${errors.length} problem(s):\n  ${errors.join('\n  ')}`);
  const admittedRoles = admin.roles;
  const graphCache = new Map();
  const graph = createGraphClient({ clientId, fetch: fetchImpl, cache: graphCache });
  const gateway = { baseUrl: gatewayUrl, writeKey, fetch: fetchImpl };

  // ADR-0010. ADMIN_UI_SIGN_IN is 'required' only when main.bicep also configured Container Apps authentication,
  // the only thing that makes X-MS-CLIENT-PRINCIPAL trustworthy (U-87); any other value is a deployment mistake.
  const signIn = env.ADMIN_UI_SIGN_IN ?? 'off';
  if (!['required', 'off'].includes(signIn)) throw new Error(`ADMIN_UI_SIGN_IN must be 'required' or 'off', not '${signIn}'`);
  const topology = env.GATEWAY_TOPOLOGY ?? 'test';
  if (!['test', 'private'].includes(topology)) throw new Error(`GATEWAY_TOPOLOGY must be 'test' or 'private', not '${topology}'`);
  const resourceId = env.GATEWAY_RESOURCE_ID;
  if (resourceId && !/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.App\/containerApps\/[^/?#]+$/i.test(resourceId)) {
    throw new Error('GATEWAY_RESOURCE_ID must be the gateway container app\'s resource ID, /subscriptions/.../providers/Microsoft.App/containerApps/<name>');
  }
  const adminFilePath = env.GATEWAY_ADMIN_FILE_PATH ?? 'the admin file';
  const liveRoleValues = async () => (await gatewayApplication({ graph, servicePrincipalId })).appRoles.map((r) => r.value);

  let configStore;
  let arm;
  let developersLive;
  if (resourceId) {
    arm = createArmClient({ clientId, fetch: fetchImpl, cache: graphCache });
    configStore = createConfigStore({ arm, resourceId, deployAdmin: admin, topology, adminFilePath, knownRoles: liveRoleValues });
    developersLive = async () => {
      const [application, current] = await Promise.all([gatewayApplication({ graph, servicePrincipalId }), configStore.read()]);
      return { graph, servicePrincipalId, appRoles: application.appRoles.map((r) => ({ id: r.id, value: r.value })), admittedRoles: current.admin.roles, adminFile: 'the admin file' };
    };
  }
  const currentAdmin = async () => (configStore ? (await configStore.read()).admin : admin);
  // ADR-0015: business-unit tags in the gateway's managed PostgreSQL, reached with the gateway app's own credential.
  const tags = createTagStore({
    credential: async () => (arm ? gatewayDatabase({ arm, resourceId }) : { unavailable: true, reason: 'GATEWAY_RESOURCE_ID is not set, so admin-ui has no gateway app to read the database from.' }),
  });
  const tagsOrReason = async () => {
    const status = await tags.status();
    if (!status.available) return { unavailable: true, reason: status.reason };
    try { return await tags.all(); } catch (e) { return { unavailable: true, reason: `Business-unit tags could not be read: ${e.message}` }; }
  };
  const resolveUser = async (value) => {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      const r = await graph('GET', `/users/${encodeURIComponent(value)}?$select=id`, undefined, { ok: [200, 404] });
      return r.status === 200 ? r.json.id : null;
    }
    return (await findUser(graph, value.toLowerCase()))?.id ?? null;
  };
  const graphRoles = async () => tokenRoles(await getManagedIdentityToken({ resource: 'https://graph.microsoft.com', clientId, fetch: fetchImpl, cache: graphCache, env }));

  return {
    gateway,
    developers: { setDeveloper, listDevelopers },
    developersDeps: { graph, servicePrincipalId, appRoles, admittedRoles, adminFile: 'the admin file' },
    developersLive,
    auth: { signIn },
    configStore,
    roles: {
      list: async () => listRoles({ graph, servicePrincipalId, admin: await currentAdmin() }),
      create: (body) => createRole({ graph, servicePrincipalId }, body),
      canCreate: async () => (await graphRoles()).some((r) => ['Application.ReadWrite.OwnedBy', 'Application.ReadWrite.All'].includes(r)),
    },
    tags,
    resolveUser,
    // ADR-0016: present when the deployment names the gateway's app registration (main.bicep, GATEWAY_APPLICATION_OBJECT_ID).
    signInCredential: arm && env.GATEWAY_APPLICATION_OBJECT_ID ? createSignInCredential({ arm, graph, resourceId, applicationId: env.GATEWAY_APPLICATION_OBJECT_ID,
      months: Number(env.SIGNIN_CERTIFICATE_MONTHS || 12), secretDays: Number(env.SIGNIN_SECRET_DAYS || 365) }) : undefined,
    chargeback: {
      build: async ({ period, groupBy }) => buildChargeback({ rows: PERIODS.includes(period) ? await collectEffective({ gateway, period }) : [], graph, period, groupBy, tags: await tagsOrReason() }),
      csv: chargebackCsv,
    },
    businessUnits: {
      list: async () => listBusinessUnits({ graph, developers: await listDevelopers(developersLive ? await developersLive() : { graph, servicePrincipalId, appRoles }), tags: await tagsOrReason() }),
    },
    // P-41: the gateway's address from its ingress when admin-ui manages it, otherwise the address admin-ui calls.
    clientKit: {
      origin: async () => (configStore ? (await configStore.read()).gateway?.url ?? null : gatewayUrl),
      models: async () => (await currentAdmin()).models.map((m) => m.id),
    },
    capabilities: (signInInfo) => capabilities({
      signIn: signInInfo,
      graphToken: () => getManagedIdentityToken({ resource: 'https://graph.microsoft.com', clientId, fetch: fetchImpl, cache: graphCache, env }),
      tagsStatus: () => tags.status(),
      armPermissions: async () => {
        if (!arm) throw new Error('GATEWAY_RESOURCE_ID is not set, so admin-ui has no gateway app to check');
        return (await arm('GET', `${resourceId}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`)).json?.value ?? [];
      },
      environmentPermissions: async () => {
        if (!arm) throw new Error('GATEWAY_RESOURCE_ID is not set, so admin-ui has no gateway environment to check');
        return environmentPermissions({ arm, resourceId });
      },
    }),
    log,
  };
}

// ADR-0011: sent on every response. The frontend has no inline script or style, so the CSP allows only same-origin
// files, plus data: images for the SVG icons in style.css. https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin', // Easy Auth's CSRF check needs a Referer on same-origin writes.
};
const MAX_BODY_BYTES = 1024 * 1024;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

function serveStatic(res, pathname) {
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(webRoot, safe === '/' ? 'index.html' : safe);
  if (!file.startsWith(webRoot)) { res.writeHead(403).end('forbidden'); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(webRoot, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const refuse = (status, error) => Object.assign(new Error(error), { status });

// ADR-0011, U-95: the sign-in cookie is SameSite=None, so a body must be JSON (which a page on another site cannot send
// without a CORS preflight admin-ui never answers), and a browser that marks a write as cross-site is refused outright.
async function readBody(req) {
  if (!['GET', 'HEAD'].includes(req.method) && req.headers['sec-fetch-site'] === 'cross-site') throw refuse(403, 'cross-site requests are refused');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw refuse(413, 'request body is larger than 1 MiB');
    chunks.push(chunk);
  }
  if (!chunks.length) return undefined;
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) throw refuse(415, 'request body must be application/json');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createServer(deps) {
  return http.createServer(async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
    res.setHeader('Cache-Control', 'no-store');
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      const status = error.status ?? 400;
      res.writeHead(status, { 'Content-Type': 'application/json', ...(status === 413 ? { Connection: 'close' } : {}) })
        .end(JSON.stringify({ error: error.status ? error.message : 'invalid JSON body' }));
      return;
    }
    const { status, body: responseBody, raw, headers } = await handleApi({ method: req.method, pathname: url.pathname, searchParams: url.searchParams, body, headers: req.headers }, deps);
    if (raw !== undefined) { res.writeHead(status, headers ?? {}).end(raw); return; }
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(responseBody));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  createServer(buildDeps({})).listen(port, () => console.log(`admin-ui listening on :${port}`));
}
