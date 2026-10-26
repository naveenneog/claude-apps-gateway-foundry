// T-96: admin-ui/web/spend-view.js - how the Dashboard reads a row of GET /v1/organizations/spend_limits/effective,
// and how the Budgets form turns a user's e-mail address into the OIDC subject the gateway keys spend by.
// The rows below are copied from the live Contoso gateway's answer of 2026-10-23 (only the subject shortened).
// Field names: https://code.claude.com/docs/en/claude-apps-gateway-spend-limits (period_to_date_spend, amount, source).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const web = path.join(import.meta.dirname, '..', 'admin-ui', 'web');

function loadSpendView() {
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(web, 'spend-view.js'), 'utf8'), context);
  return context.spendView;
}

const actor = { type: 'user_actor', user_id: 'sub-1', name: 'Dev One', email_address: 'Dev.One@contoso.example', deleted: false };
const daily = { scope: { type: 'user', user_id: 'sub-1' }, groups: ['Gateway.Standard'], actor, amount: null, currency: 'USD', period: 'daily', source: null, spend_limit_id: null, period_to_date_spend: '10.454' };
const monthly = { ...daily, amount: '50000', period: 'monthly', source: { type: 'organization' }, spend_limit_id: 'spl_1' };

test('T-96 a live /effective row shows its period_to_date_spend and its amount, not $0.00 and Unlimited', () => {
  const view = loadSpendView().spendRow(monthly);
  assert.equal(view.name, 'Dev One');
  assert.equal(view.spendCents, 10.454);
  assert.equal(view.capCents, 50000);
  assert.equal(view.capSource, 'organization');
  assert.equal(view.groups, 'Gateway.Standard');
});

test('T-96 a row with amount null is unlimited, and a group cap names its group', () => {
  const sv = loadSpendView();
  assert.equal(sv.spendRow(daily).capCents, null);
  assert.equal(sv.spendRow(daily).capSource, '—');
  const group = { ...monthly, source: { type: 'rbac_group', rbac_group_id: 'Gateway.Standard' } };
  assert.equal(sv.spendRow(group).capSource, 'rbac_group: Gateway.Standard');
});

test('T-96 the Budgets target: an e-mail resolves to the subject /effective reports for it, any case', () => {
  const sv = loadSpendView();
  assert.equal(sv.resolveUserTarget('dev.one@CONTOSO.example', [daily]), 'sub-1');
  assert.equal(sv.resolveUserTarget('sub-1', [daily]), 'sub-1', 'a subject passes through unchanged');
});

test('T-96 an e-mail the gateway has never seen is refused, not sent as a user_id that matches no one', () => {
  const sv = loadSpendView();
  assert.throws(() => sv.resolveUserTarget('someone@contoso.example', [daily]), /someone@contoso\.example.*no request/);
  assert.throws(() => sv.resolveUserTarget('', [daily]), /target/);
});

test('T-96 index.html loads spend-view.js before app.js, and app.js reads rows only through it', () => {
  const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
  const sv = html.indexOf('<script src="spend-view.js">');
  assert.ok(sv >= 0, 'index.html has no <script src="spend-view.js">');
  assert.ok(sv < html.indexOf('<script src="app.js">'), 'spend-view.js must load before app.js');
  const app = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
  assert.doesNotMatch(app, /row\.(spend|cap)\b/, 'the /effective API has no spend or cap field');
  assert.match(app, /spendView\.spendRow\(/);
  assert.match(app, /spendView\.resolveUserTarget\(/);
});

// T-105 (ADR-0010): the view helpers behind Access & models, Roles, Chargeback and Settings. Each is a classic script
// that sets one global, loaded here in node:vm exactly as spend-view.js is. Values from another realm have other
// prototypes, so objects are compared after a JSON round trip.
function load(file, name) {
  const context = { URL };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(web, file), 'utf8'), context);
  return context[name];
}
const plain = (value) => JSON.parse(JSON.stringify(value));

// config/gateway-admin.azure-contoso.json as checked in on 2026-10-24, with $comment shortened.
const contoso = {
  $comment: 'Admin file for the Contoso-tenant deployment.',
  roles: ['Gateway.Standard', 'Gateway.Premium'],
  models: [
    { id: 'claude-opus-5', label: 'Claude Opus 5', deployment: 'claude-opus-5-5' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', deployment: 'claude-sonnet-5' },
  ],
  policies: [
    { role: 'Gateway.Premium', models: ['claude-opus-5', 'claude-sonnet-5'], desktop: true },
    { role: 'Gateway.Standard', models: ['claude-sonnet-5'], desktop: false },
  ],
  deployment: { adminApi: true, emailClaim: 'preferred_username' },
  budgets: [{ scope: { type: 'organization' }, amountUsd: 500, period: 'monthly' }],
};
const frozen = JSON.stringify(contoso);

test('T-105 the role × model matrix reads policies, and with no policies every admitted role has every model', () => {
  const cv = load('config-view.js', 'configView');
  assert.deepEqual(plain(cv.allowedModels(contoso, 'Gateway.Standard')), ['claude-sonnet-5']);
  assert.deepEqual(plain(cv.allowedModels(contoso, 'Gateway.Premium')), ['claude-opus-5', 'claude-sonnet-5']);
  assert.equal(cv.desktopOf(contoso, 'Gateway.Premium'), true);
  assert.equal(cv.desktopOf(contoso, 'Gateway.Standard'), false);
  const open = { roles: ['A', 'B'], models: contoso.models };
  assert.deepEqual(plain(cv.allowedModels(open, 'B')), ['claude-opus-5', 'claude-sonnet-5']);
  assert.equal(cv.desktopOf(open, 'B'), false, 'Claude Desktop needs a policy to carry desktop: {}');
  const inherits = { roles: ['A'], models: contoso.models, policies: [{ role: 'A', models: ['claude-sonnet-5'] }], deployment: { desktop: true } };
  assert.equal(cv.desktopOf(inherits, 'A'), true, 'a policy without desktop inherits deployment.desktop');
});

test('T-105 an edit changes only the policy it touches; $comment, deployment, budgets and key order stay exactly as read', () => {
  const cv = load('config-view.js', 'configView');
  const edited = cv.toggleModel(contoso, 'Gateway.Standard', 'claude-opus-5', true, contoso);
  assert.equal(JSON.stringify(contoso), frozen, 'the original is not mutated');
  assert.deepEqual(plain(edited.policies[1].models), ['claude-opus-5', 'claude-sonnet-5'], 'models keep the order of the models list');
  assert.deepEqual(plain(edited.policies[0]), contoso.policies[0]);
  for (const key of ['$comment', 'deployment', 'budgets', 'roles', 'models']) assert.deepEqual(plain(edited[key]), contoso[key], key);
  assert.deepEqual(plain(Object.keys(edited)), Object.keys(contoso));
  assert.equal(cv.isDirty(contoso, edited), true);
  const back = cv.toggleModel(edited, 'Gateway.Standard', 'claude-opus-5', false, contoso);
  assert.equal(cv.isDirty(contoso, back), false, 'unticking again is no change at all');
  assert.equal(cv.adminFileText(edited), `${JSON.stringify(edited, null, 2)}\n`);
});

test('T-105 the matrix marks what differs from the configuration as read: each changed cell, and a newly admitted row', () => {
  const cv = load('config-view.js', 'configView');
  assert.deepEqual(plain(cv.changedCells(contoso, contoso)), []);
  let draft = cv.toggleModel(contoso, 'Gateway.Standard', 'claude-opus-5', true, contoso);
  draft = cv.setDesktop(draft, 'Gateway.Premium', false, contoso);
  draft = cv.admitRole(draft, 'Gateway.Trial', contoso);
  assert.deepEqual(plain(cv.changedCells(contoso, draft)).sort(), ['desktop|Gateway.Premium', 'model|Gateway.Standard|claude-opus-5', 'row|Gateway.Trial']);
  const back = cv.toggleModel(draft, 'Gateway.Standard', 'claude-opus-5', false, contoso);
  assert.equal(plain(cv.changedCells(contoso, back)).includes('model|Gateway.Standard|claude-opus-5'), false);
});

test('T-105 with no policies in the file, the first matrix edit writes one policy per admitted role with every model', () => {
  const cv = load('config-view.js', 'configView');
  const open = { roles: ['A', 'B'], models: contoso.models };
  const edited = cv.toggleModel(open, 'B', 'claude-opus-5', false, open);
  assert.deepEqual(plain(edited.policies), [{ role: 'A', models: ['claude-opus-5', 'claude-sonnet-5'] }, { role: 'B', models: ['claude-sonnet-5'] }]);
  assert.equal(open.policies, undefined);
});

test('T-105 Claude Desktop is set per policy, and returning to the inherited value drops the key the file did not have', () => {
  const cv = load('config-view.js', 'configView');
  assert.equal(cv.setDesktop(contoso, 'Gateway.Standard', true, contoso).policies[1].desktop, true);
  const inherits = { roles: ['A'], models: contoso.models, policies: [{ role: 'A', models: ['claude-sonnet-5'] }], deployment: { desktop: true } };
  const off = cv.setDesktop(inherits, 'A', false, inherits);
  assert.equal(off.policies[0].desktop, false);
  const on = cv.setDesktop(off, 'A', true, inherits);
  assert.equal('desktop' in on.policies[0], false);
  assert.equal(cv.isDirty(inherits, on), false);
});

test('T-105 admitting a role creates its policy with no models, a problem until one is ticked; re-admitting restores the original', () => {
  const cv = load('config-view.js', 'configView');
  const admitted = cv.admitRole(contoso, 'Gateway.Trial', contoso);
  assert.deepEqual(plain(admitted.roles), ['Gateway.Standard', 'Gateway.Premium', 'Gateway.Trial']);
  assert.deepEqual(plain(admitted.policies[2]), { role: 'Gateway.Trial', models: [] });
  assert.deepEqual(plain(cv.problems(admitted).map((p) => p.role)), ['Gateway.Trial']);
  assert.match(cv.problems(admitted)[0].message, /model/);
  assert.equal(cv.problems(cv.toggleModel(admitted, 'Gateway.Trial', 'claude-sonnet-5', true, contoso)).length, 0);
  assert.equal(cv.isDirty(contoso, cv.unadmitRole(admitted, 'Gateway.Trial')), false);
  const dropped = cv.unadmitRole(contoso, 'Gateway.Standard');
  assert.deepEqual(plain(dropped.roles), ['Gateway.Premium']);
  assert.deepEqual(plain(dropped.policies.map((p) => p.role)), ['Gateway.Premium']);
  assert.equal(cv.isDirty(contoso, cv.admitRole(dropped, 'Gateway.Standard', contoso)), false, 'the original policy and position come back');
});

test('T-105 a role stays admitted while it is the last one or a budget in the admin file names it', () => {
  const cv = load('config-view.js', 'configView');
  assert.equal(cv.unadmitBlocker(contoso, 'Gateway.Premium'), null);
  const grouped = { ...contoso, budgets: [{ scope: { type: 'rbac_group', rbac_group_id: 'Gateway.Standard' }, amountUsd: 100, period: 'monthly' }] };
  assert.match(cv.unadmitBlocker(grouped, 'Gateway.Standard'), /budget/i);
  const single = { ...contoso, roles: ['Gateway.Premium'], policies: [contoso.policies[0]] };
  assert.match(cv.unadmitBlocker(single, 'Gateway.Premium'), /at least one role/i);
});

test('T-105 a model in use cannot be removed, and the reason names the roles that use it', () => {
  const cv = load('config-view.js', 'configView');
  const opus = cv.modelRemovalBlocker(contoso, 'claude-opus-5');
  assert.match(opus, /Gateway\.Premium/);
  assert.doesNotMatch(opus, /Gateway\.Standard/);
  assert.match(cv.modelRemovalBlocker(contoso, 'claude-sonnet-5'), /Gateway\.Premium.*Gateway\.Standard|Gateway\.Standard.*Gateway\.Premium/);
  const unused = cv.toggleModel(contoso, 'Gateway.Premium', 'claude-opus-5', false, contoso);
  assert.equal(cv.modelRemovalBlocker(unused, 'claude-opus-5'), null);
  assert.deepEqual(plain(cv.removeModel(unused, 'claude-opus-5').models.map((m) => m.id)), ['claude-sonnet-5']);
  assert.match(cv.modelRemovalBlocker({ roles: ['A'], models: [contoso.models[1]] }, 'claude-sonnet-5'), /at least one model/i);
});

test('T-105 the model form follows the gateway\'s patterns, keeps IDs unique, and a renamed ID follows into the policies', () => {
  const cv = load('config-view.js', 'configView');
  assert.match(cv.modelErrors(contoso, { id: 'claude-opus-5', deployment: 'x' }, null).id, /already/);
  const bad = cv.modelErrors(contoso, { id: '-opus', label: 'Costs $5', deployment: '' }, null);
  assert.deepEqual(plain(Object.keys(bad)).sort(), ['deployment', 'id', 'label']);
  assert.deepEqual(plain(cv.modelErrors(contoso, contoso.models[0], 'claude-opus-5')), {}, 'a model is not a duplicate of itself');
  const renamed = cv.upsertModel(contoso, { id: 'claude-opus-5-1', label: ' ', deployment: 'claude-opus-5-5' }, 'claude-opus-5');
  assert.deepEqual(plain(renamed.models[0]), { id: 'claude-opus-5-1', deployment: 'claude-opus-5-5' }, 'an empty label is left out');
  assert.deepEqual(plain(renamed.policies[0].models), ['claude-opus-5-1', 'claude-sonnet-5']);
  const added = cv.upsertModel(contoso, { id: 'claude-haiku-5', label: 'Claude Haiku 5', deployment: 'claude-haiku-5' }, null);
  assert.deepEqual(plain(added.models.map((m) => m.id)), ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5']);
  assert.deepEqual(plain(added.policies), contoso.policies);
});

test('T-105 preview errors are placed under the model, role or budget they name', () => {
  const cv = load('config-view.js', 'configView');
  const placed = plain(cv.describeErrors([
    'models[1].label: must be 1 to 100 characters',
    'policies[1].models: list at least one model',
    'policies: the admitted role Gateway.Premium has no policy',
    'budgets[0].scope.rbac_group_id: Gateway.X is not in roles',
    'the admin file must hold a JSON object',
  ], contoso));
  assert.deepEqual(placed.map((e) => [e.kind, e.key]), [['model', 'claude-sonnet-5'], ['role', 'Gateway.Standard'], ['role', 'Gateway.Premium'], ['budget', null], ['other', null]]);
  assert.match(placed[0].where, /claude-sonnet-5/);
  assert.equal(placed[1].message, 'list at least one model');
  assert.match(placed[3].where, /Budget 1/);
  assert.equal(placed[4].message, 'the admin file must hold a JSON object');
});

test('T-105 applying: 409 is a conflict to reload, 428 asks for the data-loss acknowledgement, 400 lists the errors', () => {
  const cv = load('config-view.js', 'configView');
  assert.deepEqual(plain(cv.applyError(409, { error: 'changed', currentVersion: 'abc' })), { kind: 'conflict', message: 'changed', currentVersion: 'abc' });
  // The server's other 409 (no container mounts the config secret) carries no currentVersion; reloading would not help.
  assert.deepEqual(plain(cv.applyError(409, { error: 'no container of gw mounts the gateway-config secret' })), { kind: 'error', message: 'no container of gw mounts the gateway-config secret' });
  assert.equal(cv.applyError(428, { error: 'reset', requiresAcknowledgement: true }).kind, 'acknowledge');
  assert.deepEqual(plain(cv.applyError(400, { error: '1 problem', errors: ['roles: x'] }).errors), ['roles: x']);
  assert.equal(cv.applyError(403, { error: 'sign in' }).kind, 'forbidden');
  assert.match(cv.applyError(502, {}).message, /502/);
});

test('T-105 a gateway on a temporary database warns before applying, and the budgets note follows the rollout', () => {
  const cv = load('config-view.js', 'configView');
  assert.equal(cv.dataLossWarning({ restart: { temporaryDatabase: true, warning: 'From the server.' } }), 'From the server.');
  assert.match(cv.dataLossWarning({ restart: { temporaryDatabase: true, warning: null } }), /spend totals, spend caps and the audit trail/);
  assert.equal(cv.dataLossWarning({ restart: { temporaryDatabase: false, warning: null } }), null);
  assert.equal(cv.dataLossWarning({}), null);
  assert.match(cv.budgetsNote(contoso), /1 spend cap\b.*Budgets page/);
});

test('T-105 the rollout steps follow the new revision to running and healthy, and a failure marks the step it stopped at', () => {
  const cv = load('config-view.js', 'configView');
  const base = { previousRevision: 'gw--r1', latestRevision: 'gw--r1', latestReadyRevision: 'gw--r1', provisioningState: 'InProgress', runningStatus: 'Running', healthy: true, done: false, failed: false, message: '' };
  const states = (status) => plain(cv.rolloutSteps(status)).map((s) => s.state);
  assert.deepEqual(states(base), ['done', 'current', 'pending', 'pending']);
  const created = { ...base, latestRevision: 'gw--r2', healthy: false };
  assert.deepEqual(states(created), ['done', 'done', 'current', 'pending']);
  assert.equal(cv.rolloutSteps(created)[1].detail, 'gw--r2');
  assert.deepEqual(states({ ...created, provisioningState: 'Succeeded' }), ['done', 'done', 'done', 'current']);
  const done = { ...created, latestReadyRevision: 'gw--r2', provisioningState: 'Succeeded', healthy: true, done: true };
  assert.deepEqual(states(done), ['done', 'done', 'done', 'done']);
  assert.equal(cv.rolloutOutcome(done), 'succeeded');
  const failed = { ...created, provisioningState: 'Failed', failed: true };
  assert.deepEqual(states(failed), ['done', 'done', 'failed', 'pending']);
  assert.equal(cv.rolloutOutcome(failed), 'failed');
  assert.equal(cv.rolloutOutcome(base), 'running');
  const starting = { ...done, healthy: false, done: false };
  assert.equal(cv.rolloutSteps(starting)[3].detail, 'Running · not healthy yet');
  assert.equal(cv.rolloutSteps(done)[3].detail, 'Running · healthy');
  assert.equal(cv.rolloutSteps({ ...starting, failed: true })[3].detail, 'Running · not healthy');
  assert.equal(cv.rolloutSteps({ ...done, runningStatus: null })[3].detail, 'Healthy');
  assert.equal(cv.rolloutMessage({ message: 'revision gw--r2 is Running' }), 'Revision gw--r2 is Running');
  assert.equal(cv.rolloutMessage({ message: '' }), 'Waiting for the new revision to be created');
  assert.equal(cv.rolloutMessage(null), 'Waiting for the new revision to be created');
});

test('T-105 the editor is read-only with a reason naming the missing permission', () => {
  const cv = load('config-view.js', 'configView');
  const caps = { signIn: { mode: 'required', user: { name: 'A' }, isAdmin: true }, arm: { readGateway: true, writeGateway: true }, graph: {} };
  assert.equal(cv.readOnlyReason({ canWrite: true }, caps), null);
  assert.match(cv.readOnlyReason({ canWrite: true }, { ...caps, arm: { readGateway: true, writeGateway: false } }), /Container Apps Contributor/);
  assert.match(cv.readOnlyReason({ canWrite: true }, { ...caps, signIn: { mode: 'off', user: null, isAdmin: false } }), /Sign-in is off/);
  assert.match(cv.readOnlyReason({ canWrite: true }, { ...caps, signIn: { mode: 'required', user: { name: 'A' }, isAdmin: false } }), /AdminUi\.Admin/);
  assert.equal(cv.readOnlyReason({ canWrite: false, readOnlyReason: 'From the server.' }, caps), 'From the server.');
});

test('T-105 a configuration that cannot be read names the missing Azure role first, and keeps the server message', () => {
  const cv = load('config-view.js', 'configView');
  const raw = 'POST https://management.azure.com/x/listSecrets returned 403 AuthorizationFailed';
  const item = { key: 'arm.writeGateway', label: 'Container Apps Contributor on the gateway app (Azure RBAC)', granted: false, unlocks: 'u', howToGrant: 'Deploy admin-ui/infra/main.bicep.' };
  assert.deepEqual(plain(cv.loadFailure(raw, { items: [{ key: 'signIn', granted: false }, item] })), {
    title: 'admin-ui cannot read the gateway configuration',
    lines: ['It does not have Container Apps Contributor on the gateway app (Azure RBAC), which reading the configuration needs.', 'Deploy admin-ui/infra/main.bicep.'],
    detail: raw,
  });
  const plainFailure = { title: 'Could not read the gateway configuration', lines: [raw], detail: null };
  assert.deepEqual(plain(cv.loadFailure(raw, { items: [{ ...item, granted: true }] })), plainFailure);
  assert.deepEqual(plain(cv.loadFailure(raw, null)), plainFailure);
});

test('T-105 the download is the admin file as the repository stores it, named after the deployed file', () => {
  const cv = load('config-view.js', 'configView');
  assert.equal(cv.downloadName('config/gateway-admin.azure-contoso.json'), 'gateway-admin.azure-contoso.json');
  assert.equal(cv.downloadName('C:\\deploy\\gateway-admin.json'), 'gateway-admin.json');
  assert.equal(cv.downloadName(''), 'gateway-admin.json');
  assert.equal(cv.adminFileText(contoso), `${JSON.stringify(contoso, null, 2)}\n`);
});

test('T-105 the onboarding settings use the gateway URL and the exact managed-settings contract', () => {
  const sv = load('settings-view.js', 'settingsView');
  assert.deepEqual(plain(sv.managedSettings('https://gw.example.com')), {
    forceLoginMethod: 'gateway',
    forceLoginGatewayUrl: 'https://gw.example.com',
    parentSettingsBehavior: 'merge',
  });
  assert.equal(sv.managedSettings('http://gw.example.com'), null);
  assert.equal(sv.managedSettings('https://gw.example.com/path'), null);
  assert.equal(sv.managedSettings('https://user:pass@gw.example.com'), null);
});

test('T-119 onboarding follows the topology: the public test gateway uses the developer profile, the private one managed login', () => {
  const sv = load('settings-view.js', 'settingsView');
  const test = plain(sv.onboarding('test', 'https://gw.example.com'));
  assert.equal(test.claudeCode, 'profile', '/login refuses a gateway on a public address, so forced login cannot work here');
  assert.equal(test.managedSettings, null, 'no managed-settings.json is offered where it would block every sign-in');
  assert.equal(test.profileCommand, 'powershell -NoProfile -ExecutionPolicy Bypass -File .\\Install-ClaudeGatewayProfile.ps1 -GatewayUrl https://gw.example.com -FastModel <model the role allows> -Model <model the role allows>',
    'the form every other onboarding page gives, which runs under the default execution policy');
  assert.match(test.reason, /private/);
  assert.equal(test.desktopBootstrapUrl, 'https://gw.example.com/user/bootstrap');
  const priv = plain(sv.onboarding('private', 'https://gw.example.com'));
  assert.equal(priv.claudeCode, 'managed');
  assert.deepEqual(priv.managedSettings, plain(sv.managedSettings('https://gw.example.com')));
  assert.equal(priv.profileCommand, null);
  assert.equal(plain(sv.onboarding('test', 'http://gw.example.com')).profileCommand, null, 'no command for a URL the profile refuses');
});

test('T-105 the Foundry brand and collapsible onboarding guide are present in the shell and Settings page', () => {
  const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
  const settings = fs.readFileSync(path.join(web, 'settings-page.js'), 'utf8');
  assert.match(html, /<title>Claude apps gateway - Foundry/);
  assert.match(html, /class="brand-name">Claude apps gateway - Foundry/);
  assert.match(html, /Claude apps gateway - Foundry<\/span>/);
  assert.match(app, /Claude apps gateway - Foundry/);
  assert.match(settings, /el\('details'/);
  assert.match(settings, /Download managed-settings\.json/);
  assert.match(settings, /bootstrapUrl/);
  assert.match(settings, /No separate onboarding\.json is required/);
});

// The shape of admin-ui/server/chargeback.mjs's report; 3026.43 cents is the live T-97 spend.
const chargeback = {
  period: 'monthly', groupBy: 'department', generatedAt: '2026-10-24T10:00:00.000Z', currency: 'USD', totalCents: 4026.43,
  groups: [
    { key: 'Engineering', label: 'Engineering', totalCents: 3026.43, users: 2, sharePct: 75.2 },
    { key: '(unresolved)', label: '(unresolved)', totalCents: 600, users: 1, sharePct: 14.9 },
    { key: 'Finance', label: 'Finance', totalCents: 400, users: 1, sharePct: 9.9 },
  ],
  rows: [
    { userId: 'sub-3', name: null, email: null, groupKey: '(unresolved)', roles: ['Gateway.Standard'], spendCents: 600, capCents: null, department: null, costCenter: null, resolved: false },
    { userId: 'sub-1', name: 'Dev One', email: 'dev.one@contoso.example', groupKey: 'Engineering', roles: ['Gateway.Premium'], spendCents: 3000, capCents: 3000, department: 'Engineering', costCenter: 'CC-100', resolved: true },
    { userId: 'sub-2', name: 'Dev Two', email: 'dev.two@contoso.example', groupKey: 'Engineering', roles: ['Gateway.Standard'], spendCents: 26.43, capCents: 50000, department: 'Engineering', costCenter: null, resolved: true },
    { userId: 'sub-4', name: 'Fin One', email: 'fin.one@contoso.example', groupKey: 'Finance', roles: ['Gateway.Standard'], spendCents: 400, capCents: null, department: 'Finance', costCenter: 'CC-200', resolved: true },
  ],
  notes: [], canTag: true,
};

test('T-105 the chargeback summary is the API\'s totals, with unresolved users as their own bucket, last', () => {
  const cb = load('chargeback-view.js', 'chargebackView');
  assert.equal(cb.formatUsd(302643), '$3,026.43');
  assert.equal(cb.formatUsd(3026.43), '$30.26');
  assert.equal(cb.formatUsd(10.454, 4), '$0.1045');
  assert.equal(cb.formatUsd(null), '—');
  const groups = plain(cb.groupsForDisplay(chargeback));
  assert.deepEqual(groups.map((g) => g.key), ['Engineering', 'Finance', '(unresolved)']);
  assert.deepEqual([groups[0].total, groups[0].share, groups[0].barPct], ['$30.26', '75.2%', 75.2]);
  assert.deepEqual([groups[2].label, groups[2].special], ['Unresolved users', 'unresolved']);
  assert.equal(cb.groupLabel('(unassigned)', 'costCenter'), 'No cost center');
  // groups counts named business units only: Engineering and Finance, not the unresolved bucket.
  assert.deepEqual(plain(cb.summary(chargeback)), { total: '$40.26', users: 4, groups: 2, unresolved: 1, unresolvedTotal: '$6.00' });
  const unassigned = { ...chargeback, groups: [...chargeback.groups, { key: '(unassigned)', label: '(unassigned)', totalCents: 0, users: 1, sharePct: 0 }] };
  assert.equal(cb.summary(unassigned).groups, 2);
});

test('T-105 chargeback rows: highest spend first, fractional cents to four places, unresolved rows flagged and kept', () => {
  const cb = load('chargeback-view.js', 'chargebackView');
  const rows = plain(cb.rowsForDisplay(chargeback));
  assert.deepEqual(rows.map((r) => r.name), ['Dev One', 'sub-3', 'Fin One', 'Dev Two']);
  assert.deepEqual([rows[0].spend, rows[0].cap, rows[0].capPct], ['$30.0000', '$30.00', 100]);
  assert.deepEqual([rows[3].spend, rows[3].cap], ['$0.2643', '$500.00']);
  assert.deepEqual([rows[2].cap, rows[2].capPct], ['Unlimited', null]);
  assert.deepEqual([rows[1].unresolved, rows[1].editable, rows[1].email], [true, false, '—']);
  assert.equal(rows[0].editable, true);
  assert.equal(plain(cb.rowsForDisplay({ ...chargeback, canTag: false })).some((r) => r.editable), false);
  assert.deepEqual(plain(cb.rowsForDisplay(chargeback, 'Finance')).map((r) => r.name), ['Fin One']);
});

test('T-105 a chargeback row shows each address once, and tags the user by UPN when the report has one', () => {
  const cb = load('chargeback-view.js', 'chargebackView');
  const rows = plain(cb.rowsForDisplay(chargeback));
  assert.deepEqual(rows.map((r) => r.detail), ['dev.one@contoso.example', 'No e-mail recorded', 'fin.one@contoso.example', 'dev.two@contoso.example']);
  const nameless = plain(cb.rowsForDisplay({ ...chargeback, rows: [{ ...chargeback.rows[1], name: null }] }))[0];
  assert.deepEqual([nameless.name, nameless.detail], ['dev.one@contoso.example', null]);
  assert.equal(rows[0].upn, 'dev.one@contoso.example');
  const withUpn = plain(cb.rowsForDisplay({ ...chargeback, rows: [{ ...chargeback.rows[1], upn: 'd1@example.com' }] }))[0];
  assert.equal(withUpn.upn, 'd1@example.com');
});

test('T-105 tagging sends only the changed attributes, an emptied one as null; without the grant the hint says where to set them', () => {
  const cb = load('chargeback-view.js', 'chargebackView');
  const devOne = chargeback.rows[1];
  assert.deepEqual(plain(cb.tagPatch(devOne, { department: 'Engineering', costCenter: ' CC-101 ' })), { costCenter: 'CC-101' });
  assert.deepEqual(plain(cb.tagPatch(devOne, { department: '', costCenter: 'CC-100' })), { department: null });
  assert.equal(cb.tagPatch(devOne, { department: 'Engineering', costCenter: 'CC-100' }), null);
  assert.match(cb.tagErrors({ department: 'x'.repeat(65), costCenter: '' }).department, /64/);
  assert.equal(cb.tagHint({ canTag: true }), null);
  assert.match(cb.tagHint({ canTag: false }), /Entra.*User\.ReadWrite\.All|User\.ReadWrite\.All.*Entra/);
  assert.equal(cb.csvHref('monthly', 'costCenter'), '/api/chargeback?format=csv&period=monthly&groupBy=costCenter');
});

test('T-107 business units: named units by name, unassigned users counted, rows sorted by unit then name, editable only with canTag', () => {
  const cb = load('chargeback-view.js', 'chargebackView');
  const data = {
    canTag: true, unassigned: 1, skipped: [{ principalId: 'g9', name: 'Platform team' }],
    units: [{ name: 'Finance', users: 1 }, { name: 'Engineering', users: 2 }],
    users: [
      { id: 'u3', upn: 'cy@contoso.example', name: 'Cy', roles: ['Gateway.Standard'], department: null, costCenter: null },
      { id: 'u2', upn: 'bo@contoso.example', name: 'Bo', roles: ['Gateway.Standard'], department: 'Finance', costCenter: null },
      { id: 'u4', upn: 'dee@contoso.example', name: 'Dee', roles: ['Gateway.Standard'], department: 'Engineering', costCenter: 'CC-1' },
      { id: 'u1', upn: 'ana@contoso.example', name: 'Ana', roles: ['Gateway.Premium', 'Gateway.Standard'], department: 'Engineering', costCenter: 'CC-100' },
    ],
  };
  const view = plain(cb.businessUnits(data));
  assert.deepEqual(view.units, [{ name: 'Engineering', usersText: '2 users' }, { name: 'Finance', usersText: '1 user' }]);
  assert.deepEqual(view.options, ['Engineering', 'Finance']);
  assert.equal(view.unassignedText, '1 user has no business unit');
  assert.match(view.skippedText, /Platform team/);
  assert.deepEqual(view.rows.map((r) => [r.name, r.department, r.roles, r.editable]), [
    ['Ana', 'Engineering', 'Gateway.Premium, Gateway.Standard', true],
    ['Dee', 'Engineering', 'Gateway.Standard', true],
    ['Bo', 'Finance', 'Gateway.Standard', true],
    ['Cy', '', 'Gateway.Standard', true],
  ]);
  assert.equal(view.rows[0].userId, 'u1');
  assert.equal(view.rows[0].upn, 'ana@contoso.example');
  assert.equal(plain(cb.businessUnits({ ...data, canTag: false })).rows.some((r) => r.editable), false);
  assert.deepEqual(plain(cb.businessUnits({})), { units: [], options: [], unassignedText: null, skippedText: null, rows: [] });
});

const rolesResponse = {
  roles: [
    { id: '1', value: 'Gateway.Standard', displayName: 'Standard', description: 'Sonnet', isEnabled: true, admitted: true, policy: { models: ['claude-sonnet-5'], desktop: false } },
    { id: '2', value: 'Gateway.Premium', displayName: 'Premium', description: 'All', isEnabled: true, admitted: true, policy: { models: ['claude-opus-5', 'claude-sonnet-5'], desktop: null } },
    { id: '3', value: 'Gateway.Trial', displayName: 'Trial', description: 'Trial', isEnabled: true, admitted: false, policy: null },
    { id: '4', value: 'Gateway.Old', displayName: 'Old', description: 'Retired', isEnabled: false, admitted: false, policy: null },
  ],
  canCreate: true,
};

test('T-105 a new role value: letters, digits, dot, underscore and hyphen, starting alphanumeric, unique in any case', () => {
  const rv = load('roles-view.js', 'rolesView');
  assert.equal(rv.valueError('Gateway.Trial2', rolesResponse.roles), null);
  assert.match(rv.valueError('', rolesResponse.roles), /Enter/);
  assert.match(rv.valueError('.Gateway', rolesResponse.roles), /start/);
  assert.match(rv.valueError('Gateway Trial', rolesResponse.roles), /letters/);
  assert.match(rv.valueError('gateway.standard', rolesResponse.roles), /exists/);
  assert.match(rv.valueError('x'.repeat(121), rolesResponse.roles), /120/);
  assert.deepEqual(plain(Object.keys(rv.formErrors({ value: 'Gateway.New', displayName: ' ', description: '' }, rolesResponse.roles))).sort(), ['description', 'displayName']);
});

test('T-105 the roles table shows admission, models and Claude Desktop, inheriting deployment.desktop when the policy has none', () => {
  const rv = load('roles-view.js', 'rolesView');
  const rows = plain(rv.roleRows(rolesResponse, { deployment: { desktop: true } }));
  assert.deepEqual(rows.map((r) => [r.value, r.admitted, r.models, r.desktop]), [
    ['Gateway.Standard', true, 'claude-sonnet-5', 'Not allowed'],
    ['Gateway.Premium', true, 'claude-opus-5, claude-sonnet-5', 'Allowed'],
    ['Gateway.Trial', false, '—', '—'],
    ['Gateway.Old', false, '—', '—'],
  ]);
  assert.equal(rows[3].enabled, false);
  assert.deepEqual(plain(rv.admittedValues(rolesResponse)), ['Gateway.Standard', 'Gateway.Premium']);
  assert.equal(rv.createBlocker(rolesResponse, {}), null);
  const caps = { signIn: { mode: 'required', isAdmin: true }, graph: { writeOwnedApps: false } };
  assert.match(rv.createBlocker({ ...rolesResponse, canCreate: false }, caps), /Application\.ReadWrite\.OwnedBy/);
});

test('T-105 the Developers and Budgets role choices are the admitted roles only, else the admin file\'s roles', () => {
  const rv = load('roles-view.js', 'rolesView');
  assert.deepEqual(plain(rv.choices(rolesResponse, contoso)), [
    { value: 'Gateway.Standard', label: 'Standard' },
    { value: 'Gateway.Premium', label: 'Premium' },
  ]);
  assert.deepEqual(plain(rv.choices(null, { roles: ['Gateway.Standard'] })), [{ value: 'Gateway.Standard', label: '' }]);
  assert.equal(rv.choices(null, null), null, 'neither source readable: the caller falls back to free text');
});

test('T-105 the signed-in admin shows by name, and with sign-in off the shell says access is limited by IP address', () => {
  const sv = load('settings-view.js', 'settingsView');
  const ada = plain(sv.identity({ signIn: 'required', user: { name: 'Ada Lovelace', upn: 'ada@contoso.example' }, isAdmin: true }));
  assert.deepEqual([ada.mode, ada.title, ada.subtitle, ada.initials, ada.badge], ['user', 'Ada Lovelace', 'ada@contoso.example', 'AL', 'Admin']);
  const bob = plain(sv.identity({ signIn: 'required', user: { name: '', upn: 'bob@contoso.example' }, isAdmin: false }));
  assert.deepEqual([bob.title, bob.initials, bob.badge], ['bob@contoso.example', 'B', 'No access']);
  assert.equal(sv.identity({ signIn: 'off', user: null, isAdmin: false }).text, 'Sign-in is off — access is limited by IP address');
});

test('T-105 the permissions checklist counts what is granted and keeps what each unlocks and how to grant it', () => {
  const sv = load('settings-view.js', 'settingsView');
  const items = [
    { key: 'signIn', label: 'Admin sign-in', granted: true, unlocks: 'Writes.', howToGrant: 'Assign AdminUi.Admin.' },
    { key: 'graph.writeUsers', label: 'User.ReadWrite.All', granted: false, unlocks: 'Tagging.', howToGrant: 'Run Deploy-AdminUi.ps1 -GrantUserWrite.' },
    { key: 'arm.writeGateway', label: 'Container Apps Contributor', granted: true, unlocks: 'Saving.', howToGrant: 'Deploy main.bicep.' },
  ];
  const list = plain(sv.checklist({ items, problems: ['Microsoft Graph token: timeout'] }));
  assert.deepEqual([list.granted, list.total], [2, 3]);
  assert.deepEqual([list.items[1].status, list.items[1].howToGrant], ['Missing', 'Run Deploy-AdminUi.ps1 -GrantUserWrite.']);
  assert.deepEqual(list.problems, ['Microsoft Graph token: timeout']);
});

test('T-105 an audit event reads as a change: created, changed or removed, for whom, from what amount to what', () => {
  const sv = loadSpendView();
  const created = plain(sv.auditChange({ created_at: '2026-10-23T18:04:05.123Z', actor: 'admin-key:admin-ui', before: null, after: { scope: { type: 'organization' }, amount: '50000', period: 'monthly' } }));
  assert.deepEqual(created, { when: '2026-10-23 18:04 UTC', actor: 'admin-ui (admin key)', action: 'Created', scope: 'Organization', period: 'monthly', before: '—', after: '$500.00' });
  const cap = { scope: { type: 'user', user_id: 'sub-1' }, amount: '50000', period: 'daily' };
  const changed = plain(sv.auditChange({ created_at: '2026-10-23T18:04:05Z', actor: 'oidc:abc', before: cap, after: { ...cap, amount: null } }));
  assert.deepEqual([changed.action, changed.scope, changed.before, changed.after, changed.actor], ['Changed', 'User sub-1', '$500.00', 'Unlimited', 'oidc:abc']);
  const group = { scope: { type: 'rbac_group', rbac_group_id: 'Gateway.Standard' }, amount: '100', period: 'weekly' };
  assert.deepEqual(plain(sv.auditChange({ created_at: '', actor: '', before: group, after: null })).action, 'Removed');
  assert.equal(sv.auditChange({ before: group, after: null }).scope, 'Role Gateway.Standard');
});

test('T-105 a user cap is named by who the gateway knows its subject as, and by the subject when it knows no one', () => {
  const sv = loadSpendView();
  const names = sv.userNames([
    { scope: { type: 'user', user_id: 'sub-1' }, actor: { name: 'Dev One', email_address: 'dev.one@contoso.example' } },
    { scope: { type: 'user', user_id: 'sub-2' }, actor: { email_address: 'dev.two@contoso.example' } },
    { scope: { type: 'user', user_id: 'sub-3' }, actor: null },
    { scope: { type: 'organization' }, actor: { name: 'Not a user' } },
  ]);
  const cap = (userId) => ({ scope: { type: 'user', user_id: userId }, amount: '5000', period: 'weekly' });
  assert.equal(sv.auditChange({ before: null, after: cap('sub-1') }, names).scope, 'User Dev One');
  assert.equal(sv.auditChange({ before: cap('sub-2'), after: null }, names).scope, 'User dev.two@contoso.example');
  assert.equal(sv.auditChange({ before: null, after: cap('sub-3') }, names).scope, 'User sub-3');
  assert.equal(sv.auditChange({ before: null, after: cap('sub-1') }).scope, 'User sub-1');
  assert.equal(sv.scopeText(cap('sub-1').scope, names), 'User Dev One');
});

test('T-105 the dashboard counts the caps by scope, without a misleading singular, and says when there are none', () => {
  const sv = loadSpendView();
  const caps = [
    { scope: { type: 'organization' }, period: 'monthly' }, { scope: null, period: 'daily' },
    { scope: { type: 'rbac_group', rbac_group_id: 'Gateway.Standard' } }, { scope: { type: 'rbac_group', rbac_group_id: 'Gateway.Premium' } },
    { scope: { type: 'user', user_id: 'sub-1' } },
  ];
  assert.equal(sv.capBreakdown(caps), 'Organization 2 · Role 2 · User 1');
  assert.equal(sv.capBreakdown(caps.slice(2, 3)), 'Role 1');
  assert.equal(sv.capBreakdown([]), 'None set, so spend is unlimited');
});

test('T-105 caps in the admin file compare with the live caps: set, different or missing, with the body that sets one again', () => {
  const sv = loadSpendView();
  const budgets = [
    { scope: { type: 'organization' }, amountUsd: 500, period: 'monthly' },
    { scope: { type: 'rbac_group', rbac_group_id: 'Gateway.Standard' }, amountUsd: 100, period: 'monthly' },
    { scope: { type: 'user', user_id: 'sub-1' }, amountUsd: null, period: 'daily' },
  ];
  const caps = [
    { id: 'spl_1', scope: { type: 'organization' }, amount: '50000', period: 'monthly' },
    { id: 'spl_2', scope: { type: 'rbac_group', rbac_group_id: 'Gateway.Standard' }, amount: '5000', period: 'monthly' },
    { id: 'spl_3', scope: { type: 'user', user_id: 'sub-1' }, amount: '100', period: 'monthly' },
  ];
  const rows = plain(sv.fileBudgets(budgets, caps));
  assert.deepEqual(rows.map((r) => r.status), ['set', 'differs', 'missing']);
  assert.deepEqual(rows.map((r) => [r.amount, r.live]), [['$500.00', '$500.00'], ['$100.00', '$50.00'], ['Unlimited', '—']]);
  assert.deepEqual(rows[1].body, { scope: { type: 'rbac_group', rbac_group_id: 'Gateway.Standard' }, amountCents: 10000, period: 'monthly' });
  assert.equal(rows[2].body.amountCents, null);
  assert.deepEqual(plain(sv.fileBudgets(undefined, caps)), []);
});

test('T-105 index.html routes every page, loads each helper before app.js, and loads nothing inline or from the internet', () => {
  const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
  for (const route of ['access', 'roles', 'chargeback', 'settings']) {
    assert.match(html, new RegExp(`<nav>[\\s\\S]*data-route="${route}"[\\s\\S]*</nav>`), `no nav link for ${route}`);
  }
  const app = html.indexOf('<script src="app.js">');
  for (const helper of ['config-view.js', 'chargeback-view.js', 'roles-view.js', 'settings-view.js']) {
    const at = html.indexOf(`<script src="${helper}">`);
    assert.ok(at >= 0 && at < app, `${helper} must load before app.js`);
  }
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/, 'no inline script');
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)="(?:https?:)?\/\//, 'nothing loaded from another origin');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline event handler');
});

// T-108 (ADR-0011): with sign-in on, a signed-in user without AdminUi.Admin sees one access-denied screen instead of the console.
test('T-108 the access-denied screen appears only for a signed-in non-admin, and names the account, the role and where to assign it', () => {
  const sv = load('settings-view.js', 'settingsView');
  const denied = plain(sv.accessDenied({ signIn: 'required', user: { name: 'Bob', upn: 'bob@contoso.example' }, roles: ['Gateway.Standard'], isAdmin: false }));
  assert.equal(denied.denied, true);
  assert.match(denied.title, /access/i);
  assert.ok(denied.body.some((line) => line.includes('bob@contoso.example')), 'names the signed-in account');
  assert.ok(denied.body.some((line) => line.includes('AdminUi.Admin')), 'names the missing role');
  assert.ok(denied.body.some((line) => /Enterprise applications/.test(line)), 'says where to assign it');
  assert.ok(denied.body.some((line) => line.includes('Gateway.Standard')), 'lists the roles admin-ui received');
  assert.ok(plain(sv.accessDenied({ signIn: 'required', user: { upn: 'x@c.example' }, roles: [], isAdmin: false })).body.some((l) => /no app roles/i.test(l)));
  assert.equal(sv.accessDenied({ signIn: 'required', user: { upn: 'a@c.example' }, roles: ['AdminUi.Admin'], isAdmin: true }).denied, false);
  assert.equal(sv.accessDenied({ signIn: 'off', user: null, roles: [], isAdmin: false }).denied, false, 'sign-in off: the IP allowlist decides');
  assert.equal(sv.accessDenied(null).denied, false, '/api/me unreadable: the pages report their own errors');
});

test('T-108 app.js checks access before routing, so a non-admin never loads a page', () => {
  const app = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
  assert.match(app, /settingsView\.accessDenied\(/);
});
