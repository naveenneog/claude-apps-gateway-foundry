// T-52 (docs/TEST-PLAN.md): scripts/admin/new-gateway-config.mjs renders the Azure test deployment's gateway.yaml
// from one admin file (ADR-0004): the app roles admitted, the Foundry deployments served, and one managed policy per
// role with its model allowlist.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderGatewayConfig, adminErrors } from '../scripts/admin/new-gateway-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const script = path.join(root, 'scripts', 'admin', 'new-gateway-config.mjs');
const twoRoles = () => ({
  roles: ['Gateway.Standard', 'Gateway.Premium'],
  models: [
    { id: 'claude-opus-5', label: 'Claude Opus 5', deployment: 'opus-deployment' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', deployment: 'sonnet-deployment' },
  ],
  policies: [
    { role: 'Gateway.Premium', models: ['claude-opus-5', 'claude-sonnet-5'] },
    { role: 'Gateway.Standard', models: ['claude-sonnet-5'] },
  ],
});

function workdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-admin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const generate = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
function runWith(t, admin) {
  const dir = workdir(t);
  const file = path.join(dir, 'admin.json');
  fs.writeFileSync(file, typeof admin === 'string' ? admin : JSON.stringify(admin));
  const out = path.join(dir, 'gateway.yaml');
  return { ...generate(['--admin', file, '--out', out]), file, out };
}

test('T-52 the checked-in gateway config is the rendering of its admin file, which passes validation', () => {
  assert.equal(renderGatewayConfig(JSON.parse(read('config/gateway-admin.azure-test.json'))), read('config/gateway.azure-test.yaml'));
  const check = generate(['--check']);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /matches/);
});

test('T-52 two roles and two models render one policy per role in file order and a model entry per deployment', (t) => {
  const r = runWith(t, twoRoles());
  assert.equal(r.status, 0, r.stderr);
  const yaml = fs.readFileSync(r.out, 'utf8');
  assert.match(yaml, /^ {2}allowed_groups: \[Gateway\.Standard, Gateway\.Premium\]$/m);
  assert.match(yaml, /^ {2}- id: claude-opus-5\n {4}label: Claude Opus 5\n {4}upstream_model: \{ foundry: opus-deployment \}$/m);
  assert.match(yaml, /^ {2}- id: claude-sonnet-5\n {4}label: Claude Sonnet 5\n {4}upstream_model: \{ foundry: sonnet-deployment \}$/m);
  const managed = yaml.slice(yaml.indexOf('\nmanaged:\n') + 1).split('\naccess_control:')[0].trimEnd();
  assert.equal(managed, [
    'managed:', '  policies:',
    '    - match: { groups: [Gateway.Premium] }', '      cli:', '        availableModels: [claude-opus-5, claude-sonnet-5]', '        enforceAvailableModels: true',
    '    - match: { groups: [Gateway.Standard] }', '      cli:', '        availableModels: [claude-sonnet-5]', '        enforceAvailableModels: true',
  ].join('\n'), 'each policy keeps the Default model inside its availableModels, or a developer\'s first request gets 400');
  assert.doesNotMatch(yaml, /match: \{\}/, 'every admitted role has its own policy, so there is no match-all policy');
  assert.match(r.stdout, /--step app/);
});

test('T-52 values that YAML would read as another type are quoted', () => {
  const admin = twoRoles();
  admin.models[0].label = 'yes';
  admin.models[1].deployment = '2024';
  const yaml = renderGatewayConfig(admin);
  assert.match(yaml, /^ {4}label: "yes"$/m);
  assert.match(yaml, /^ {4}upstream_model: \{ foundry: "2024" \}$/m);
});

test('T-52 deployment.adminApi renders the same admin: block as the private topology, and is off by default', () => {
  const admin = twoRoles();
  const without = renderGatewayConfig(admin);
  assert.doesNotMatch(without, /\nadmin:\n/, 'no deployment block at all means no admin: block');
  admin.deployment = { adminApi: true };
  const withIt = renderGatewayConfig(admin);
  assert.match(withIt, /\nadmin:\n {2}write_keys:\n {4}- id: admin-ui\n {6}key: "\$\{GATEWAY_ADMIN_WRITE_KEY\}"\n {2}spend_retention_months: 13\n {2}audit_retention_days: 365\n/);
  admin.deployment = { adminApi: false };
  assert.doesNotMatch(renderGatewayConfig(admin), /\nadmin:\n/, 'deployment present but adminApi false renders no admin: block');
});

test('T-52 deployment.adminApi on the test topology also allowlists the environment\'s own reserved routing range', () => {
  const admin = twoRoles();
  const without = renderGatewayConfig(admin);
  assert.match(without, /^ {2}allow_cidrs: \["\$\{TESTER_CIDR\}"\]$/m, 'without adminApi, only the tester CIDR is allowed');
  admin.deployment = { adminApi: true };
  const withIt = renderGatewayConfig(admin);
  // admin-ui calls this gateway from within the same Consumption-topology environment, over the environment's own
  // internal DNS; that traffic still arrives at the gateway's own access_control check from the environment's
  // reserved routing range (measured 100.100.0.190, 2026-10-17), which is not the tester's own CIDR.
  assert.match(withIt, /^ {2}allow_cidrs: \["\$\{TESTER_CIDR\}", 100\.100\.0\.0\/17\]$/m);
});

test('T-52 a policy\'s own desktop flag works on the test topology too, so one role can get Claude Code/VS Code only and another also gets Desktop', () => {
  const admin = twoRoles(); // Gateway.Premium and Gateway.Standard, neither opted in by default
  const base = renderGatewayConfig(admin);
  assert.doesNotMatch(base, /desktop: \{\}/, 'no policy carries desktop by default, on either topology');
  admin.policies[0].desktop = true; // Gateway.Premium only
  const mixed = renderGatewayConfig(admin);
  const policiesBlock = mixed.slice(mixed.indexOf('\nmanaged:\n'));
  assert.equal(policiesBlock.match(/^ {6}desktop: \{\}$/gm)?.length, 1, policiesBlock);
  assert.match(policiesBlock.split('Gateway.Standard')[0], /desktop: \{\}/, 'Premium (listed first in policies) carries it');
  assert.doesNotMatch(policiesBlock.split('Gateway.Standard')[1], /desktop: \{\}/, 'Standard does not');
  assert.deepEqual(adminErrors(admin, admin.roles, 'test'), []);
});

test('T-52 deployment.emailClaim renders oidc.email_claim, for an IdP whose id_token carries no email claim', () => {
  const admin = twoRoles();
  const without = renderGatewayConfig(admin);
  assert.doesNotMatch(without, /email_claim/, 'without deployment.emailClaim, oidc reads the id_token\'s own email claim');
  admin.deployment = { emailClaim: 'preferred_username' };
  const withIt = renderGatewayConfig(admin);
  assert.match(withIt, /^ {2}allowed_email_domains: \["\$\{ALLOWED_EMAIL_DOMAIN\}"\]\n {2}email_claim: preferred_username$/m);
  assert.deepEqual(adminErrors(admin, admin.roles, 'test'), []);
  for (const bad of ['', 42, true, null]) {
    admin.deployment = { emailClaim: bad };
    assert.ok(adminErrors(admin, admin.roles, 'test').some((e) => e.startsWith('deployment.emailClaim')), `${JSON.stringify(bad)} was accepted`);
  }
});

test('T-52 the renderer refuses a $ in any value from the admin file, even one that skipped validation', () => {
  for (const change of [(a) => { a.models[0].label = 'Opus ${GATEWAY_JWT_SECRET}'; }, (a) => { a.models[1].deployment = '${OIDC_CLIENT_SECRET}'; },
    (a) => { a.roles[0] = '${GATEWAY_PG_PASSWORD}'; }, (a) => { a.policies[0].models[0] = '${file:/proc/self/environ}'; }]) {
    const admin = twoRoles();
    change(admin);
    assert.throws(() => renderGatewayConfig(admin), /\$/);
  }
  const values = renderGatewayConfig(twoRoles()).split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
  const references = [...new Set(values.match(/\$\{[^}]*\}/g))].sort();
  assert.deepEqual(references, ['${ALLOWED_EMAIL_DOMAIN}', '${FOUNDRY_RESOURCE}', '${GATEWAY_JWT_SECRET}', '${GATEWAY_PG_PASSWORD}', '${GATEWAY_PUBLIC_URL}',
    '${OIDC_CLIENT_ID}', '${OIDC_CLIENT_SECRET}', '${OIDC_ISSUER}', '${TESTER_CIDR}'], 'the only references are the template\'s own');
});

test('T-52 the header names the admin file the configuration was rendered from', (t) => {
  const r = runWith(t, twoRoles());
  assert.equal(r.status, 0, r.stderr);
  const header = fs.readFileSync(r.out, 'utf8').split('\n')[1];
  assert.equal(header, `# Generated from ${r.file} by the admin script new-gateway-config.mjs (ADR-0004).`);
  assert.match(renderGatewayConfig(twoRoles()).split('\n')[1], /^# Generated from config\/gateway-admin\.azure-test\.json by/, 'the default is the repository\'s admin file');
});

test('T-52 an admin file path with a character a YAML parser may read as a line break is refused, so the header stays one comment line', () => {
  // YAML 1.1 reads NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR as line breaks (Security review, round 4).
  for (const ch of ['\x00', '\n', '\r', '\t', '\x1f', '\x7f', '\x85', '\x9f', '\u2028', '\u2029']) {
    assert.throws(() => renderGatewayConfig(twoRoles(), { adminFile: `config/admin${ch}x.json` }), /has a control character or a line separator/, JSON.stringify(ch));
  }
  assert.match(renderGatewayConfig(twoRoles(), { adminFile: 'C:\\admins\\gateway-admin é.json' }).split('\n')[1], /gateway-admin é\.json/, 'other characters outside ASCII are kept');
});

test('T-52 --check exits 0 for an up-to-date file and 1 for a changed one, and writes nothing', (t) => {
  const r = runWith(t, twoRoles());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(generate(['--admin', r.file, '--out', r.out, '--check']).status, 0);
  fs.appendFileSync(r.out, '# edited by hand\n');
  const changed = generate(['--admin', r.file, '--out', r.out, '--check']);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /differs/);
  assert.match(fs.readFileSync(r.out, 'utf8'), /# edited by hand\n$/);
});

for (const [label, change, message] of [
  ['a role that entra-app.json does not define', (a) => { a.roles.push('Gateway.Unknown'); a.policies.push({ role: 'Gateway.Unknown', models: ['claude-sonnet-5'] }); }, /Gateway\.Unknown is not an app role/],
  ['a model with no deployment', (a) => { delete a.models[0].deployment; }, /models\[0\]\.deployment/],
  ['a policy model missing from models', (a) => { a.policies[1].models.push('claude-haiku-4-5'); }, /claude-haiku-4-5 is not in models/],
  ['a policy for a role that is not admitted', (a) => { a.roles = ['Gateway.Standard']; }, /Gateway\.Premium is not in roles/],
  ['an admitted role without a policy', (a) => { a.policies.pop(); }, /Gateway\.Standard has no policy/],
  ['a model listed twice', (a) => { a.models.push({ ...a.models[0] }); }, /claude-opus-5 is listed twice/],
  ['a label with a line break', (a) => { a.models[0].label = 'Opus\nsecret: x'; }, /models\[0\]\.label/],
  // The gateway replaces ${NAME} with an environment variable and a whole ${file:/path} value with the file's content,
  // with no escape, and serves each label to every signed-in user as display_name.
  ['a label holding a ${VAR} reference', (a) => { a.models[0].label = 'Claude Opus 5 ${GATEWAY_JWT_SECRET}'; }, /models\[0\]\.label: .*without control characters or \$/],
  ['a label that is a ${file:} reference', (a) => { a.models[1].label = '${file:/proc/self/environ}'; }, /models\[1\]\.label: .*without control characters or \$/],
  ['an unknown key, such as a misspelt policies', (a) => { a.polices = a.policies; delete a.policies; }, /polices: unknown key/],
  ['a model entry that is null', (a) => { a.models = [null, null]; }, /models\[1\]: must be an object/],
  ['a policy entry that is null', (a) => { a.policies = [null, null]; }, /policies\[1\]: must be an object/],
  ['invalid JSON', () => '{ "roles": [', /JSON/],
]) {
  test(`T-52 ${label} stops the script with exit code 1 and writes nothing`, (t) => {
    const admin = twoRoles();
    const r = runWith(t, change(admin) ?? admin);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, message);
    assert.equal(fs.existsSync(r.out), false);
  });
}

test('T-89 a valid budgets array passes validation and renders a byte-identical gateway.yaml to the same file without it', () => {
  const admin = twoRoles();
  const withoutBudgets = renderGatewayConfig(admin);
  admin.budgets = [
    { scope: { type: 'organization' }, amountUsd: 500, period: 'monthly' },
    { scope: { type: 'rbac_group', rbac_group_id: 'Gateway.Premium' }, amountUsd: 200, period: 'monthly' },
    { scope: { type: 'user', user_id: 'a1b2c3' }, amountUsd: null, period: 'daily' },
  ];
  assert.deepEqual(adminErrors(admin, admin.roles, 'test'), []);
  assert.equal(renderGatewayConfig(admin), withoutBudgets, 'budgets are admin-API-only; never rendered into gateway.yaml');
});

for (const [label, change, message] of [
  ['not a list', (a) => { a.budgets = { scope: { type: 'organization' }, amountUsd: 1, period: 'monthly' }; }, /budgets: must be a list/],
  ['an entry that is null', (a) => { a.budgets = [null]; }, /budgets\[0\]: must be an object/],
  ['an unknown scope.type', (a) => { a.budgets = [{ scope: { type: 'team' }, amountUsd: 1, period: 'monthly' }]; }, /budgets\[0\]\.scope\.type: must be user, rbac_group or organization/],
  ['an rbac_group scope with no rbac_group_id', (a) => { a.budgets = [{ scope: { type: 'rbac_group' }, amountUsd: 1, period: 'monthly' }]; }, /budgets\[0\]\.scope\.rbac_group_id: required/],
  ['an rbac_group_id not in roles', (a) => { a.budgets = [{ scope: { type: 'rbac_group', rbac_group_id: 'Gateway.Unknown' }, amountUsd: 1, period: 'monthly' }]; }, /budgets\[0\]\.scope\.rbac_group_id: Gateway\.Unknown is not in roles/],
  ['a user scope with no user_id', (a) => { a.budgets = [{ scope: { type: 'user' }, amountUsd: 1, period: 'monthly' }]; }, /budgets\[0\]\.scope\.user_id: required/],
  ['an invalid period', (a) => { a.budgets = [{ scope: { type: 'organization' }, amountUsd: 1, period: 'yearly' }]; }, /budgets\[0\]\.period: must be daily, weekly, monthly/],
  ['a negative amountUsd', (a) => { a.budgets = [{ scope: { type: 'organization' }, amountUsd: -1, period: 'monthly' }]; }, /budgets\[0\]\.amountUsd: must be null .* or a non-negative number/],
  ['a non-numeric amountUsd', (a) => { a.budgets = [{ scope: { type: 'organization' }, amountUsd: '500', period: 'monthly' }]; }, /budgets\[0\]\.amountUsd: must be null/],
  ['two caps for the same scope and period', (a) => { a.budgets = [{ scope: { type: 'organization' }, amountUsd: 1, period: 'monthly' }, { scope: { type: 'organization' }, amountUsd: 2, period: 'monthly' }]; }, /budgets: organization has two monthly caps/],
]) {
  test(`T-89 budgets with ${label} is refused by adminErrors before anything is rendered`, () => {
    const admin = twoRoles();
    change(admin);
    const errors = adminErrors(admin, admin.roles, 'test');
    assert.ok(errors.some((e) => message.test(e)), `expected one of ${JSON.stringify(errors)} to match ${message}`);
  });
}

// T-113 (ADR-0012): deployment.database chooses the test topology's store. "sidecar", the default, is today's in-app
// PostgreSQL on 127.0.0.1; "managed" is a Flexible Server reached over TLS at ${GATEWAY_PG_HOST}.
const storeBlock = (yaml) => yaml.slice(yaml.indexOf('\nstore:\n') + 1).split('\n\n')[0];

test('T-113 deployment.database absent or "sidecar" renders today\'s store, byte for byte', () => {
  const admin = twoRoles();
  const base = renderGatewayConfig(admin);
  assert.equal(storeBlock(base), 'store:\n  postgres_url: postgres://gateway@127.0.0.1:5432/gateway\n  password: "${GATEWAY_PG_PASSWORD}"\n  connect_timeout_seconds: 10');
  admin.deployment = { database: 'sidecar' };
  assert.equal(renderGatewayConfig(admin), base);
  assert.deepEqual(adminErrors(admin, admin.roles, 'test'), []);
});

test('T-113 deployment.database "managed" connects to ${GATEWAY_PG_HOST} with sslmode=require and changes nothing else', () => {
  const admin = twoRoles();
  const base = renderGatewayConfig(admin);
  admin.deployment = { database: 'managed' };
  const managed = renderGatewayConfig(admin);
  assert.equal(storeBlock(managed), 'store:\n  postgres_url: "postgres://gateway@${GATEWAY_PG_HOST}:5432/gateway?sslmode=require"\n  password: "${GATEWAY_PG_PASSWORD}"\n  connect_timeout_seconds: 10');
  assert.equal(managed.replace(storeBlock(managed), ''), base.replace(storeBlock(base), ''), 'only the store block differs');
  assert.deepEqual(adminErrors(admin, admin.roles, 'test'), []);
});

test('T-113 any other deployment.database value is refused, and the private topology, always managed, refuses "sidecar"', () => {
  const admin = twoRoles();
  for (const bad of ['Managed', 'azurefiles', '', 1, true, null]) {
    admin.deployment = { database: bad };
    assert.ok(adminErrors(admin, admin.roles, 'test').some((e) => e.startsWith('deployment.database')), `${JSON.stringify(bad)} was accepted`);
  }
  admin.deployment = { database: 'sidecar', developerCidrs: ['10.0.0.0/16'] };
  assert.ok(adminErrors(admin, admin.roles, 'private').some((e) => e.startsWith('deployment.database')), 'the private topology has no sidecar');
  admin.deployment = { database: 'managed', developerCidrs: ['10.0.0.0/16'] };
  assert.ok(!adminErrors(admin, admin.roles, 'private').some((e) => e.startsWith('deployment.database')));
});

// T-118 (P-39): the example a first install copies is valid as shipped, so a reader who only changes the model
// deployment names gets a working admin file, with the admin API, the managed database and one spend cap.
test('T-118 config/gateway-admin.example.json passes validation and turns on what a first install needs', () => {
  const example = JSON.parse(read('config/gateway-admin.example.json'));
  const roles = JSON.parse(read('infra/azure-test/entra-app.json')).appRoles.map((r) => r.value);
  assert.deepEqual(adminErrors(example, roles, 'test'), []);
  assert.equal(example.deployment.adminApi, true, 'the admin console and the budgets stage need the admin API');
  assert.equal(example.deployment.database, 'managed', 'spend and chargeback survive configuration saves');
  assert.ok(example.budgets.some((b) => b.scope.type === 'organization'), 'an organization-wide cap from the first day');
  assert.deepEqual(example.policies.map((p) => p.role).sort(), [...example.roles].sort(), 'every admitted role has a policy');
  assert.match(renderGatewayConfig(example), /sslmode=require/);
});

// T-122 (P-40): per-role Claude Desktop settings. Desktop applies the gateway's bootstrap values over local settings
// and makes them read-only (https://claude.com/docs/third-party/claude-desktop/configuration, bootstrapUrl).
const desktopAdmin = (desktopSettings, desktop = true) => ({
  roles: ['Gateway.Standard', 'Gateway.Premium'],
  models: [{ id: 'claude-sonnet-5', deployment: 'claude-sonnet-5' }],
  policies: [
    { role: 'Gateway.Premium', models: ['claude-sonnet-5'], desktop, ...(desktopSettings === undefined ? {} : { desktopSettings }) },
    { role: 'Gateway.Standard', models: ['claude-sonnet-5'] },
  ],
});

test('T-122 desktopSettings renders Chat, Cowork and Code switches into the policy\'s desktop block', () => {
  const yaml = renderGatewayConfig(desktopAdmin({ chatTabEnabled: true, coworkTabEnabled: false, isClaudeCodeForDesktopEnabled: false }), { topology: 'test' });
  assert.match(yaml, /      desktop:\n        chatTabEnabled: true\n        coworkTabEnabled: false\n        isClaudeCodeForDesktopEnabled: false\n/);
  assert.match(renderGatewayConfig(desktopAdmin(undefined), { topology: 'test' }), /      desktop: \{\}\n/, 'no settings: the empty opt-in as before');
  assert.match(renderGatewayConfig(desktopAdmin({}), { topology: 'test' }), /      desktop: \{\}\n/, 'an empty settings object is the plain opt-in');
});

test('T-122 desktopSettings is refused unless it holds known switches as true or false, and is not rendered with Desktop off', () => {
  for (const [settings, desktop, message] of [
    [{ chatTabEnabled: 'yes' }, true, /desktopSettings\.chatTabEnabled: must be true or false/],
    [{ bootstrapUrl: 'https://x' }, true, /desktopSettings\.bootstrapUrl: not a supported Claude Desktop setting/],
    [['chatTabEnabled'], true, /desktopSettings: must be an object/],
  ]) {
    assert.match(adminErrors(desktopAdmin(settings, desktop), ['Gateway.Standard', 'Gateway.Premium'], 'test').join('\n'), message);
  }
  assert.deepEqual(adminErrors(desktopAdmin({ coworkTabEnabled: false }), ['Gateway.Standard', 'Gateway.Premium'], 'test'), []);
  // The console's Desktop switch can turn a role off without removing its settings; they stay, unrendered.
  const off = desktopAdmin({ chatTabEnabled: true }, false);
  assert.deepEqual(adminErrors(off, ['Gateway.Standard', 'Gateway.Premium'], 'test'), []);
  assert.doesNotMatch(renderGatewayConfig(off, { topology: 'test' }), /desktop/);
});

test('T-167 Desktop import and plugin capabilities render only for the selected Desktop policy', () => {
  const settings = { userPluginMarketplacesEnabled: true, userPluginUploadsEnabled: false, skillCreationEnabled: true,
    isDesktopExtensionEnabled: true, claudeAiImport: { enabled: true, exportEnabled: false } };
  const admin = desktopAdmin(settings);
  assert.deepEqual(adminErrors(admin, admin.roles, 'test'), []);
  const yaml = renderGatewayConfig(admin, { topology: 'test' });
  const [premium, standard] = yaml.slice(yaml.indexOf('\nmanaged:\n')).split('Gateway.Standard');
  for (const [key, value] of Object.entries(settings).filter(([key]) => key !== 'claudeAiImport')) assert.ok(premium.includes(`${key}: ${value}`), key);
  assert.match(premium, /claudeAiImport:\n          enabled: true\n          exportEnabled: false/);
  assert.doesNotMatch(standard, /userPlugin|claudeAiImport|skillCreation|isDesktopExtension/);
  assert.doesNotMatch(yaml, /automatic3pImport/, 'enabling import is not automatic migration');
  assert.doesNotMatch(renderGatewayConfig(desktopAdmin(settings, false), { topology: 'test' }), /userPlugin|claudeAiImport/);
});

test('T-167 Desktop capability input is strict, including nested import options', () => {
  for (const settings of [
    { userPluginUploadsEnabled: 'true' }, { claudeAiImport: true }, { claudeAiImport: [] },
    { claudeAiImport: { enabled: 'true' } }, { claudeAiImport: { automatic3pImport: true } },
    { claudeAiImport: { enabled: true, unsupported: true } }, { skillCreationEnabled: null },
  ]) {
    const admin = desktopAdmin(settings);
    assert.ok(adminErrors(admin, admin.roles, 'test').length > 0, JSON.stringify(settings));
  }
});

// T-135 (ADR-0014): spendPacing turns on the soft limit. The job writes with its own key, so the admin block lists it,
// and the 429 a paced person gets explains the daily cap.
const pacing = (spendPacing, deployment = { adminApi: true }) => ({ ...twoRoles(), deployment, spendPacing });
const ROLES2 = ['Gateway.Standard', 'Gateway.Premium'];

test('T-135 spendPacing renders the spend-pacer write key and a blocked message in the shared admin block', () => {
  const yaml = renderGatewayConfig(pacing({ softLimitPercent: 80 }));
  assert.match(yaml, /\nadmin:\n {2}write_keys:\n {4}- id: admin-ui\n {6}key: "\$\{GATEWAY_ADMIN_WRITE_KEY\}"\n {4}- id: spend-pacer\n {6}key: "\$\{GATEWAY_ADMIN_PACER_KEY\}"\n/);
  const message = /^ {2}blocked_message: "(.+)"$/m.exec(yaml)?.[1];
  assert.ok(message, 'a blocked_message is rendered');
  assert.match(message, /passed 80% of your monthly budget/);
  assert.match(message, /00:00 UTC/);
  const without = renderGatewayConfig({ ...twoRoles(), deployment: { adminApi: true } });
  assert.doesNotMatch(without, /spend-pacer|blocked_message|GATEWAY_ADMIN_PACER_KEY/, 'without spendPacing the admin block is unchanged');
  assert.deepEqual(adminErrors(pacing({ softLimitPercent: 80 }), ROLES2, 'test'), []);
});

test('T-135 negative: spendPacing is refused unless softLimitPercent is a whole number from 1 to 99 and the admin API is on', () => {
  for (const [value, message] of [
    [{ softLimitPercent: 0 }, /spendPacing\.softLimitPercent: must be a whole number from 1 to 99/],
    [{ softLimitPercent: 100 }, /spendPacing\.softLimitPercent: must be a whole number from 1 to 99/],
    [{ softLimitPercent: 80.5 }, /spendPacing\.softLimitPercent: must be a whole number from 1 to 99/],
    [{ softLimitPercent: '80' }, /spendPacing\.softLimitPercent: must be a whole number from 1 to 99/],
    [{}, /spendPacing\.softLimitPercent: must be a whole number from 1 to 99/],
    [{ softLimitPercent: 80, window: 30 }, /spendPacing\.window: unknown key; the key is softLimitPercent/],
    [[80], /spendPacing: must be an object/],
  ]) {
    assert.match(adminErrors(pacing(value), ROLES2, 'test').join('\n'), message, JSON.stringify(value));
  }
  assert.match(adminErrors(pacing({ softLimitPercent: 80 }, { adminApi: false }), ROLES2, 'test').join('\n'), /spendPacing: needs deployment\.adminApi true/);
  assert.match(adminErrors({ ...twoRoles(), spendPacing: { softLimitPercent: 80 } }, ROLES2, 'test').join('\n'), /spendPacing: needs deployment\.adminApi true/);
  assert.doesNotMatch(adminErrors({ ...twoRoles(), spendPacing: { softLimitPercent: 80 } }, ROLES2, 'test').join('\n'), /unknown key/, 'spendPacing is a known top-level key');
});
