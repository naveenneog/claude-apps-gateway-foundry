#!/usr/bin/env node
// Renders the Azure test deployment's gateway configuration from one admin file (ADR-0004, T-52): the app roles the
// gateway admits, the Foundry deployments it serves as models, and optionally one managed policy per role with that
// role's model allowlist, which the gateway enforces at /v1/messages
// (https://code.claude.com/docs/en/claude-apps-gateway-config#managed). The other sections are the ADR-0003 topology.
//   node scripts/admin/new-gateway-config.mjs [--admin config/gateway-admin.azure-test.json] [--out config/gateway.azure-test.yaml] [--check]
// Exit 1, writing nothing, when the admin file is invalid, or with --check when the output file differs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
const ROLE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// A YAML scalar: bare when YAML reads it back as the same string, JSON-quoted (valid YAML) otherwise. The gateway
// replaces ${VAR} in a value, also inside a longer string, and a whole ${file:/path} value with the file's content
// (https://code.claude.com/docs/en/claude-apps-gateway-config#secret-expansion), so no admin value holds a $.
function scalar(value) {
  if (value.includes('$')) throw new Error(`${JSON.stringify(value)} holds a $, which the gateway would read as a \${...} reference`);
  const bare = /^[A-Za-z][A-Za-z0-9 ._()/-]*$/.test(value) && !/\s$/.test(value) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(value);
  return bare ? value : JSON.stringify(value);
}
const flow = (values) => `[${values.map(scalar).join(', ')}]`;

// Every problem in the admin file, as messages that name the field; empty when it can be rendered.
export function adminErrors(admin, knownRoles) {
  if (admin === null || typeof admin !== 'object' || Array.isArray(admin)) return ['the admin file must hold a JSON object'];
  const errors = [];
  // A misspelt "policies" would otherwise drop every policy without a word.
  for (const key of Object.keys(admin)) {
    if (!['$comment', 'roles', 'models', 'policies', 'deployment'].includes(key)) errors.push(`${key}: unknown key; the keys are roles, models, policies, deployment and $comment`);
  }
  const list = (value, field) => {
    if (Array.isArray(value)) return value;
    if (value !== undefined) errors.push(`${field}: must be a list`);
    return [];
  };
  const roles = list(admin.roles, 'roles');
  if (!roles.length) errors.push('roles: list at least one app role to admit');
  const seenRoles = new Set();
  for (const role of roles) {
    if (typeof role !== 'string' || !ROLE.test(role)) errors.push(`roles: ${JSON.stringify(role)} is not an app role value`);
    else if (!knownRoles.includes(role)) errors.push(`roles: ${role} is not an app role in the Entra app manifest (${knownRoles.join(', ')})`);
    if (seenRoles.has(role)) errors.push(`roles: ${role} is listed twice`);
    seenRoles.add(role);
  }
  const models = list(admin.models, 'models');
  if (!models.length) errors.push('models: list at least one model');
  const ids = new Set();
  models.forEach((model, i) => {
    if (model === null || typeof model !== 'object' || Array.isArray(model)) { errors.push(`models[${i}]: must be an object with id and deployment`); return; }
    for (const key of ['id', 'deployment']) {
      if (typeof model[key] !== 'string' || !MODEL_NAME.test(model[key])) errors.push(`models[${i}].${key}: missing, or not a model ID or deployment name`);
    }
    // The gateway serves each label to every signed-in user as display_name, after expanding ${VAR} in it (see scalar).
    if (model.label !== undefined && (typeof model.label !== 'string' || !/^[^\x00-\x1f\x7f$]{1,100}$/.test(model.label))) {
      errors.push(`models[${i}].label: must be 1 to 100 characters without control characters or $, which the gateway reads as the start of a \${...} reference`);
    }
    if (ids.has(model.id)) errors.push(`models: ${model.id} is listed twice`);
    ids.add(model.id);
  });
  if (admin.policies !== undefined) {
    const covered = new Set();
    list(admin.policies, 'policies').forEach((policy, i) => {
      if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) { errors.push(`policies[${i}]: must be an object with role and models`); return; }
      if (!roles.includes(policy.role)) errors.push(`policies[${i}].role: ${policy.role} is not in roles`);
      if (covered.has(policy.role)) errors.push(`policies: ${policy.role} has two policies`);
      covered.add(policy.role);
      const allowed = list(policy.models, `policies[${i}].models`);
      if (!allowed.length) errors.push(`policies[${i}].models: list at least one model`);
      for (const id of allowed) if (!ids.has(id)) errors.push(`policies[${i}].models: ${id} is not in models`);
    });
    // A role without a policy would match none, and a user who matches no policy may use every model.
    for (const role of roles) if (!covered.has(role)) errors.push(`policies: the admitted role ${role} has no policy`);
  }
  if (admin.deployment !== undefined) errors.push(...deploymentErrors(admin.deployment, admin.policies));
  return errors;
}

// An IPv4 block written as its first address and a prefix length, the form access_control.allow_cidrs takes.
function cidrProblem(value) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(typeof value === 'string' ? value : '');
  if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || Number(m[5]) > 32) return 'is not an IPv4 block such as 10.40.0.0/16';
  const address = m.slice(1, 5).reduce((a, o) => a * 256 + Number(o), 0);
  const size = 2 ** (32 - Number(m[5]));
  return address % size === 0 ? null : 'has host bits set; write the block\'s first address';
}

// The network-restricted topology's settings (ADR-0005): the developer networks the gateway admits, the per-address
// sign-in limits for a large rollout (https://code.claude.com/docs/en/claude-apps-gateway-deploy#large-rollouts), the
// PostgreSQL connections per replica, and the Claude Desktop opt-in, which needs a policy to carry it.
function deploymentErrors(deployment, policies) {
  if (deployment === null || typeof deployment !== 'object' || Array.isArray(deployment)) return ['deployment: must be an object'];
  const errors = [];
  const keys = ['developerCidrs', 'signInsPerAddress', 'codeSubmissionsPerAddress', 'storeConnectionsPerReplica', 'desktop', 'telemetry'];
  for (const key of Object.keys(deployment)) if (!keys.includes(key)) errors.push(`deployment.${key}: unknown key; the keys are ${keys.join(', ')}`);
  const cidrs = deployment.developerCidrs;
  if (!Array.isArray(cidrs) || !cidrs.length) errors.push('deployment.developerCidrs: list at least one IPv4 block that developers connect from');
  else for (const cidr of cidrs) { const problem = cidrProblem(cidr); if (problem) errors.push(`deployment.developerCidrs: ${JSON.stringify(cidr)} ${problem}`); }
  for (const [key, max] of [['signInsPerAddress', 100000], ['codeSubmissionsPerAddress', 100000], ['storeConnectionsPerReplica', 1000]]) {
    const value = deployment[key];
    if (value !== undefined && !(Number.isInteger(value) && value >= 1 && value <= max)) errors.push(`deployment.${key}: must be a whole number from 1 to ${max}`);
  }
  if (deployment.desktop !== undefined && typeof deployment.desktop !== 'boolean') errors.push('deployment.desktop: must be true or false');
  if (deployment.desktop === true && !Array.isArray(policies)) errors.push('deployment.desktop: the Claude Desktop opt-in is set on each policy, so list policies');
  if (deployment.telemetry !== undefined && typeof deployment.telemetry !== 'boolean') errors.push('deployment.telemetry: must be true or false');
  return errors;
}

// adminFile names the admin file in the header: repository-relative inside the repository, in full otherwise.
// topology 'test' is the ADR-0003 test deployment; 'private' is the network-restricted deployment of ADR-0005.
export function renderGatewayConfig(admin, { adminFile = 'config/gateway-admin.azure-test.json', topology = 'test' } = {}) {
  // The header is a YAML comment line; a line break in the path would end it. YAML 1.1 also reads NEL (U+0085), LINE
  // SEPARATOR and PARAGRAPH SEPARATOR as line breaks, so C1 controls and both separators are refused too.
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(adminFile)) throw new Error(`the admin file path ${JSON.stringify(adminFile)} has a control character or a line separator`);
  if (!['test', 'private'].includes(topology)) throw new Error(`--topology must be test or private, not ${JSON.stringify(topology)}`);
  const deployment = admin.deployment;
  if (topology === 'private' && !deployment) throw new Error('the private topology needs the admin file\'s deployment block, with developerCidrs (ADR-0005)');
  const desktop = topology === 'private' && deployment.desktop === true;
  const telemetry = topology === 'private' && deployment.telemetry === true;
  const models = admin.models.flatMap((m) => [`  - id: ${scalar(m.id)}`, ...(m.label ? [`    label: ${scalar(m.label)}`] : []),
    `    upstream_model: { foundry: ${scalar(m.deployment)} }`]);
  const managed = admin.policies ? [
    '',
    '# One policy per app role, in the admin file\'s order; the first match applies, and its availableModels list is',
    `# enforced at /v1/messages. Every admitted role has a policy (T-52).${desktop ? ' desktop: {} opts the policy in to Claude Desktop.' : ''}`,
    ...(telemetry ? ['# Client metrics carry neither a session nor an account ID, so a series is per user and model (ADR-0007).'] : []),
    'managed:',
    '  policies:',
    ...admin.policies.flatMap((p) => [`    - match: { groups: [${scalar(p.role)}] }`, '      cli:', `        availableModels: ${flow(p.models)}`,
      // The Default model option resolves inside availableModels, instead of a model the policy leaves out, which the
      // gateway refuses with 400 (https://code.claude.com/docs/en/claude-apps-gateway#whats-enforced-on-developers).
      '        enforceAvailableModels: true',
      ...(telemetry ? ['        env:', '          OTEL_METRICS_INCLUDE_SESSION_ID: "false"', '          OTEL_METRICS_INCLUDE_ACCOUNT_UUID: "false"'] : []),
      ...(desktop ? ['      desktop: {}'] : [])]),
  ] : [];
  const oidc = [
    'oidc:',
    '  issuer: "${OIDC_ISSUER}"',
    '  client_id: "${OIDC_CLIENT_ID}"',
    '  client_secret: "${OIDC_CLIENT_SECRET}"',
    '  allowed_email_domains: ["${ALLOWED_EMAIL_DOMAIN}"]',
    '  # The app does not require assignment (U-39), so admission is by app role in the roles claim.',
    '  groups_claim: roles',
    `  allowed_groups: ${flow(admin.roles)}`,
    '',
    'session:',
    '  jwt_secret: "${GATEWAY_JWT_SECRET}"',
    '  ttl_hours: 1',
    '',
  ];
  const upstreamAndModels = [
    'upstreams:',
    '  - provider: foundry',
    '    resource: "${FOUNDRY_RESOURCE}"',
    '    auth: { use_azure_ad: true }',
    '',
    '# Only the deployments the Foundry account serves (U-7); built-in IDs would be tried there too.',
    'auto_include_builtin_models: false',
    'models:',
    ...models,
    ...managed,
    '',
  ];
  if (topology === 'private') return renderPrivate(admin, adminFile, oidc, upstreamAndModels);
  return [
    '# Claude apps gateway: test deployment on Azure Container Apps (ADR-0003).',
    `# Generated from ${adminFile} by the admin script new-gateway-config.mjs (ADR-0004).`,
    '# Mounted at /etc/claude/gateway.yaml from the Container App secret "gateway-config".',
    '# Secrets and environment-specific values are ${VAR} references to variables that',
    '# infra/azure-test/gateway-test.json sets on the gateway container; an undefined one fails boot.',
    '# Needs Claude Code 2.1.274 or later on the gateway (store.connect_timeout_seconds); the image pins 2.1.280.',
    '',
    'listen:',
    '  host: 0.0.0.0',
    '  port: 8080',
    '  public_url: "${GATEWAY_PUBLIC_URL}"',
    '  # The Container Apps ingress connects from private addresses and appends the client address to',
    '  # X-Forwarded-For; only the rightmost entry comes from the platform (U-32).',
    '  trusted_proxies: [10.0.0.0/8, 100.64.0.0/10, 172.16.0.0/12, 192.168.0.0/16]',
    '',
    ...oidc,
    'store:',
    '  postgres_url: postgres://gateway@127.0.0.1:5432/gateway',
    '  password: "${GATEWAY_PG_PASSWORD}"',
    '  connect_timeout_seconds: 10',
    '',
    ...upstreamAndModels,
    'access_control:',
    '  allow_cidrs: ["${TESTER_CIDR}"]',
    '',
  ].join('\n');
}

// The network-restricted deployment (ADR-0005): X-Forwarded-For trusted only from the environment's infrastructure
// subnet, since developers' own addresses are private too; PostgreSQL Flexible Server over TLS; the developer networks
// as the allow list; sign-in limits sized for a large rollout.
function renderPrivate(admin, adminFile, oidc, upstreamAndModels) {
  const d = admin.deployment;
  const rateLimits = d.signInsPerAddress || d.codeSubmissionsPerAddress ? [
    '',
    '# Per-address sign-in limits, sized for developers who share an address (P-28).',
    'rate_limits:',
    ...(d.signInsPerAddress ? [`  device_authorization: { max: ${d.signInsPerAddress}, window_seconds: 600 }`] : []),
    ...(d.codeSubmissionsPerAddress ? [`  device_verify: { max: ${d.codeSubmissionsPerAddress}, window_seconds: 600 }`] : []),
  ] : [];
  // ADR-0007: the OpenTelemetry Collector sidecar shares the gateway's loopback and exports to Application Insights;
  // metrics only (ADR-0002). Deploy-Gateway.ps1 sets CLAUDE_GATEWAY_ALLOW_LOOPBACK=1, which a loopback destination needs.
  const telemetry = d.telemetry === true ? [
    '',
    '# Client metrics go to the OpenTelemetry Collector sidecar on the gateway\'s loopback, which exports them to',
    '# Application Insights; logs and traces stay off (ADR-0002, ADR-0007). CLAUDE_GATEWAY_ALLOW_LOOPBACK=1 is set on',
    '# the gateway container, since the gateway refuses a loopback destination without it.',
    'telemetry:',
    '  forward_to:',
    '    - url: http://localhost:4318',
    '      metrics: true',
    '      logs: false',
    '      traces: false',
  ] : [];
  return [
    '# Claude apps gateway: network-restricted deployment on Azure Container Apps (ADR-0005).',
    `# Generated from ${adminFile} by the admin script new-gateway-config.mjs --topology private (ADR-0004).`,
    '# Mounted at /etc/claude/gateway.yaml from the Container App secret "gateway-config".',
    '# Environment-specific values and secrets are ${VAR} references to variables that',
    '# infra/azure-private/Deploy-Gateway.ps1 sets on the gateway container; an undefined one fails boot.',
    '# Needs Claude Code 2.1.282 or later on the gateway (store.readiness_grace_seconds); the image pins 2.1.284.',
    '',
    'listen:',
    '  host: 0.0.0.0',
    '  port: 8080',
    '  public_url: "${GATEWAY_PUBLIC_URL}"',
    '  # The Container Apps ingress connects from the ranges a workload profile environment reserves (measured: 100.100.0.168)',
    '  # and puts the client\'s address rightmost in X-Forwarded-For; no developer or app can hold these addresses (ADR-0005).',
    '  trusted_proxies: [100.100.0.0/17, 100.100.128.0/19, 100.100.160.0/19, 100.100.192.0/19]',
    '',
    ...oidc,
    'store:',
    '  postgres_url: "postgres://${GATEWAY_PG_USER}@${GATEWAY_PG_HOST}:5432/gateway?sslmode=require"',
    '  password: "${GATEWAY_PG_PASSWORD}"',
    '  connect_timeout_seconds: 10',
    ...(d.storeConnectionsPerReplica ? [`  max_connections: ${d.storeConnectionsPerReplica}`] : []),
    '  # A replica keeps passing /readyz through a database failover of up to five minutes.',
    '  readiness_grace_seconds: 300',
    '',
    ...upstreamAndModels,
    'access_control:',
    `  allow_cidrs: [${d.developerCidrs.join(', ')}]`,
    ...rateLimits,
    ...telemetry,
    '',
  ].join('\n');
}

function main() {
  const { values } = parseArgs({ options: {
    topology: { type: 'string', default: 'test' },
    admin: { type: 'string' },
    out: { type: 'string' },
    'entra-app': { type: 'string', default: path.join(root, 'infra', 'azure-test', 'entra-app.json') },
    check: { type: 'boolean', default: false },
  } });
  if (!['test', 'private'].includes(values.topology)) throw new Error(`--topology must be test or private, not ${JSON.stringify(values.topology)}`);
  values.admin ??= path.join(root, 'config', `gateway-admin.azure-${values.topology}.json`);
  values.out ??= path.join(root, 'config', `gateway.azure-${values.topology}.yaml`);
  let admin;
  try {
    admin = JSON.parse(fs.readFileSync(values.admin, 'utf8'));
  } catch (error) {
    throw new Error(`${values.admin} is not readable JSON: ${error.message}`);
  }
  const knownRoles = JSON.parse(fs.readFileSync(values['entra-app'], 'utf8')).appRoles.map((r) => r.value);
  const errors = adminErrors(admin, knownRoles);
  if (errors.length) throw new Error(`${values.admin} has ${errors.length} problem(s):\n  ${errors.join('\n  ')}`);
  const relative = path.relative(root, path.resolve(values.admin));
  const yaml = renderGatewayConfig(admin, { topology: values.topology,
    adminFile: relative.startsWith('..') || path.isAbsolute(relative) ? path.resolve(values.admin) : relative.replaceAll('\\', '/') });
  if (values.check) {
    const current = fs.existsSync(values.out) ? fs.readFileSync(values.out, 'utf8') : null;
    if (current !== yaml) throw new Error(`${values.out} differs from the rendering of ${values.admin}; run this script without --check to rewrite it`);
    console.log(`${values.out} matches ${values.admin}`);
    return;
  }
  fs.writeFileSync(values.out, yaml);
  const policies = admin.policies ? `, ${admin.policies.length} policies` : '';
  console.log(`wrote ${values.out}: ${admin.models.length} models, ${admin.roles.length} roles${policies}.`);
  console.log(values.topology === 'private'
    ? 'Deploy it with: pwsh -File infra/azure-private/Deploy-Gateway.ps1 -Step app'
    : 'Deploy it with: node infra/azure-test/deploy.mjs --tester-cidr <range> --step app');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[new-gateway-config] ${error.message}`);
    process.exitCode = 1;
  }
}
