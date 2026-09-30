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
import { renderGatewayConfig } from '../scripts/admin/new-gateway-config.mjs';

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
