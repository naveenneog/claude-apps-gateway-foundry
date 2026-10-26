// T-91 (docs/TEST-PLAN.md): infra/azure-test/Install-ClaudeGateway.ps1 (ADR-0009) sequences its four sub-scripts as
// external processes, each pointed at a fake stand-in (tests/install-orchestrator/) that logs its own invocation, writes
// the state a real base stage would, and exits 1 when CGW_FAKE_FAIL_STEP names it. No az, ARM or Graph call happens.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'infra', 'azure-test', 'Install-ClaudeGateway.ps1');
const fixtures = path.join(repo, 'tests', 'install-orchestrator');
const fakeNode = path.join(fixtures, 'fake-node-stage.mjs');
const fakeAdminUi = path.join(fixtures, 'fake-adminui.ps1');
const ADMIN = path.join(fixtures, 'gateway-admin.fixture.json');
// Every stage runs from the repository root, so the files reach the stages as paths relative to it.
const adminRel = path.relative(repo, ADMIN);
const configRel = path.join(path.dirname(adminRel), 'gateway.fixture.yaml');
const CIDR = '203.0.113.0/26';
const ALL = ['config', 'base', 'entra', 'image', 'app', 'budgets', 'admin-ui'];
const skip = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status !== 0 && 'PowerShell 7 (pwsh) is not on PATH';

function workdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Runs the installer against the fakes. args override the named parameters below; null leaves one out, true is a switch.
function run(t, args = {}, { failStep, recorded } = {}) {
  const dir = workdir(t);
  const log = path.join(dir, 'calls.jsonl');
  const state = path.join(dir, 'state');
  fs.writeFileSync(log, '');
  fs.mkdirSync(state);
  if (recorded) fs.writeFileSync(path.join(state, `${args.ResourceGroup ?? 'rg-test'}.json`), JSON.stringify(recorded));
  const named = { ResourceGroup: 'rg-test', TesterCidr: CIDR, AdminFile: ADMIN, SignInAdmins: 'admin@contoso.example', FoundryResourceGroup: 'rg-foundry', FoundryAccount: 'ai-foundry', ConfigScript: fakeNode, DeployScript: fakeNode,
    BudgetsScript: fakeNode, AdminUiScript: fakeAdminUi, StateDir: state, ...args };
  const argv = Object.entries(named).flatMap(([k, v]) => (v === null ? [] : v === true ? [`-${k}`] : [`-${k}`, v]));
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, ...argv], {
    encoding: 'utf8', timeout: 90_000,
    env: { ...process.env, CGW_FAKE_LOG: log, CGW_FAKE_STATE_DIR: state, ...(failStep ? { CGW_FAKE_FAIL_STEP: failStep } : {}) },
  });
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const out = `${r.stdout}${r.stderr}`.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '');
  return { status: r.status, out, flat: out.replace(/\s+/g, ' '), calls };
}
const stepsRun = (r) => r.calls.map((c) => c.step);
const argsOf = (r, step) => r.calls.find((c) => c.step === step);
const deployArgs = (step, extra = []) => ['--tester-cidr', CIDR, '--step', step, '--resource-group', 'rg-test', '--app-display-name', 'claude-apps-gateway-test',
  '--foundry-resource-group', 'rg-foundry', '--foundry-account', 'ai-foundry', ...extra];
const valueAfter = (list, flag) => list[list.indexOf(flag) + 1];

test('T-91 all seven stages run in the fixed order with their own arguments, whatever order they are asked in', { skip }, (t) => {
  const r = run(t, { Steps: 'admin-ui,budgets,base,app,entra,image,config' });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(stepsRun(r), ALL);
  assert.deepEqual(argsOf(r, 'config').argv, ['--topology', 'test', '--admin', adminRel, '--out', configRel]);
  for (const step of ['base', 'entra', 'image']) assert.deepEqual(argsOf(r, step).argv, deployArgs(step), step);
  assert.deepEqual(argsOf(r, 'app').argv, deployArgs('app', ['--config', configRel]), 'app deploys the rendering config wrote');
  assert.deepEqual(argsOf(r, 'budgets').argv, ['--admin', adminRel, '--resource-group', 'rg-test', '--gateway-app', 'ca-claude-gw']);
  assert.deepEqual(argsOf(r, 'admin-ui').args, ['-ResourceGroup', 'rg-test', '-EnvironmentName', 'cae-claude-gw', '-GatewayAppName', 'ca-claude-gw',
    '-AcrName', 'crfakeregistry1', '-AppRegistrationName', 'claude-apps-gateway-test', '-AdminFile', adminRel, '-AllowedCidr', CIDR, '-Topology', 'test'],
  'the registry is the one base recorded, admin-ui admits the tester range, and it renders for the test topology');
  assert.equal(argsOf(r, 'admin-ui').enableSignIn, true, 'the console is admin-only by default (ADR-0011)');
  assert.deepEqual(argsOf(r, 'admin-ui').signInAdmins, ['admin@contoso.example']);
  assert.match(r.out, /=== install complete ===/);
});

test('T-91 the optional deploy.mjs options, the app name and an explicit registry and range are forwarded when given', { skip }, (t) => {
  const r = run(t, { Steps: 'base,admin-ui', Location: 'eastus', FoundryResourceGroup: 'rg-foundry', FoundryAccount: 'ai-foundry',
    EmailDomain: 'contoso.example', AppRegistrationName: 'claude-gw-eval', AcrName: 'crexplicit', AllowedCidr: '198.51.100.0/24' });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(argsOf(r, 'base').argv, ['--tester-cidr', CIDR, '--step', 'base', '--resource-group', 'rg-test', '--app-display-name', 'claude-gw-eval',
    '--location', 'eastus', '--foundry-resource-group', 'rg-foundry', '--foundry-account', 'ai-foundry', '--email-domain', 'contoso.example']);
  const adminUi = argsOf(r, 'admin-ui').args;
  assert.equal(valueAfter(adminUi, '-AcrName'), 'crexplicit', 'an explicit -AcrName wins over the recorded one');
  assert.equal(valueAfter(adminUi, '-AppRegistrationName'), 'claude-gw-eval', 'entra and admin-ui name the same app');
  assert.equal(valueAfter(adminUi, '-AllowedCidr'), '198.51.100.0/24');
});

test('T-91 -Plan prints every stage and runs none; a registry base has not recorded yet shows as a placeholder', { skip }, (t) => {
  const r = run(t, { Plan: true });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.calls, [], 'nothing ran under -Plan');
  for (const step of ALL) assert.match(r.out, new RegExp(`== ${step} ==`), step);
  assert.match(r.flat, /-AcrName <acrName the base stage records>/);
  assert.match(r.out, /=== plan: 7 stage\(s\) would run ===/);
});

test('T-91 a failing stage stops every later one and names its documentation section and the retry', { skip }, (t) => {
  const r = run(t, {}, { failStep: 'image' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(stepsRun(r), ['config', 'base', 'entra', 'image'], 'app, budgets and admin-ui did not run');
  assert.match(r.flat, /stage 'image' failed \(exit 1\)/);
  assert.match(r.flat, /how-to-install-stage-by-stage\.md#image/);
  assert.match(r.flat, /-Steps naming 'image'/);
});

test('T-91 admin-ui, whose Graph grant needs a role many operators lack (U-75), runs last: its failure leaves every other stage done', { skip }, (t) => {
  const r = run(t, {}, { failStep: 'admin-ui' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(stepsRun(r), ALL);
  assert.match(r.flat, /stage 'admin-ui' failed/);
});

test('T-91 asking for app renders the admin file first, so a stale rendering is never deployed', { skip }, (t) => {
  const r = run(t, { Steps: 'app' });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(stepsRun(r), ['config', 'app']);
});

test('T-91 an unknown step is refused before any stage runs', { skip }, (t) => {
  const r = run(t, { Steps: 'base,bogus' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.calls, []);
  assert.match(r.flat, /unknown step\(s\) bogus/);
});

test('T-91 -TesterCidr is required only for the deploy.mjs stages, and admin-ui needs a range to admit', { skip }, (t) => {
  const ok = run(t, { TesterCidr: null, Steps: 'budgets,admin-ui', AllowedCidr: '198.51.100.0/24', AcrName: 'crx' });
  assert.equal(ok.status, 0, ok.out);
  for (const [args, message] of [[{ TesterCidr: null, Steps: 'base' }, /-TesterCidr is required/],
    [{ TesterCidr: null, Steps: 'admin-ui', AcrName: 'crx' }, /-AllowedCidr or -TesterCidr is required/]]) {
    const r = run(t, args);
    assert.notEqual(r.status, 0);
    assert.deepEqual(r.calls, []);
    assert.match(r.flat, message);
  }
});

test('P-39 without -TesterCidr, a later run uses the range the state file records, for the gateway and the console', { skip }, (t) => {
  const r = run(t, { TesterCidr: null, Steps: 'app,admin-ui', AcrName: 'crx' }, { recorded: { testerCidr: '198.51.100.0/26' } });
  assert.equal(r.status, 0, r.out);
  assert.equal(valueAfter(argsOf(r, 'app').argv, '--tester-cidr'), '198.51.100.0/26');
  assert.equal(valueAfter(argsOf(r, 'admin-ui').args, '-AllowedCidr'), '198.51.100.0/26');
  assert.match(r.flat, /recorded range 198\.51\.100\.0\/26/);
  const explicit = run(t, { Steps: 'app' }, { recorded: { testerCidr: '198.51.100.0/26' } });
  assert.equal(valueAfter(argsOf(explicit, 'app').argv, '--tester-cidr'), CIDR, 'an explicit -TesterCidr wins');
});

test('T-91 admin-ui, and budgets when the file declares any, need deployment.adminApi; without it nothing runs', { skip }, (t) => {
  const dir = workdir(t);
  const write = (name, admin) => { const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(admin)); return file; };
  const noApi = write('gateway-admin.noapi.json', { roles: ['Gateway.Standard'], budgets: [{ scope: { type: 'organization' }, amountUsd: 1, period: 'monthly' }] });
  for (const step of ['admin-ui', 'budgets']) {
    const r = run(t, { AdminFile: noApi, Steps: step, AcrName: 'crx' });
    assert.notEqual(r.status, 0, step);
    assert.deepEqual(r.calls, [], step);
    assert.match(r.flat, /need the gateway's admin API: set deployment\.adminApi to true/, step);
  }
  const r = run(t, { AdminFile: write('gateway-admin.nobudgets.json', { roles: ['Gateway.Standard'] }), Steps: 'budgets' });
  assert.equal(r.status, 0, 'a file that declares no budgets sends nothing to the admin API');
  assert.deepEqual(stepsRun(r), ['budgets']);
});

test('T-91 a value holding a character cmd.exe interprets is refused before any stage runs', { skip }, (t) => {
  for (const [name, value] of [['AppRegistrationName', 'app&calc'], ['ResourceGroup', 'rg|x'], ['EmailDomain', 'a^b.example'],
    ['Location', 'east<us'], ['AllowedCidr', '198.51.100.0/24%']]) {
    const r = run(t, { [name]: value, Steps: 'base,admin-ui', AcrName: 'crx' });
    assert.notEqual(r.status, 0, name);
    assert.deepEqual(r.calls, [], name);
    assert.match(r.flat, new RegExp(`-${name} holds a character cmd\\.exe interprets`), name);
  }
});

test('T-91 -AdminFile is required and must exist', { skip }, (t) => {
  for (const args of [{ AdminFile: null }, { AdminFile: path.join(fixtures, 'gateway-admin.absent.json') }]) {
    const r = run(t, args);
    assert.notEqual(r.status, 0);
    assert.deepEqual(r.calls, []);
  }
  assert.match(run(t, { AdminFile: path.join(fixtures, 'gateway-admin.absent.json') }).flat, /does not exist; nothing was run/);
});

// The failure message names docs/learn/how-to-install-stage-by-stage.md#<stage>, so every stage needs that section.
test('T-92 every stage the installer runs has the guide section its failure message points to', () => {
  const order = /^\$ORDER = @\(([^)]*)\)$/m.exec(fs.readFileSync(script, 'utf8'))[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.deepEqual(order, ALL);
  const guide = fs.readFileSync(path.join(repo, 'docs', 'learn', 'how-to-install-stage-by-stage.md'), 'utf8');
  const sections = [...guide.matchAll(/^## (.+?)\s*$/gm)].map((m) => m[1]);
  for (const stage of order) assert.ok(sections.includes(stage), `the guide has no "## ${stage}" section for the anchor #${stage}`);
});

// T-117 (P-39): a first install gives an admin-only console and can place the managed database.
test('T-117 admin-ui needs -SignInAdmins unless -NoSignIn is given, and -NoSignIn turns sign-in off', { skip }, (t) => {
  const missing = run(t, { SignInAdmins: null, Steps: 'admin-ui', AcrName: 'crx' });
  assert.notEqual(missing.status, 0);
  assert.deepEqual(missing.calls, []);
  assert.match(missing.flat, /-SignInAdmins/);
  const off = run(t, { SignInAdmins: null, NoSignIn: true, Steps: 'admin-ui', AcrName: 'crx' });
  assert.equal(off.status, 0, off.out);
  assert.equal(argsOf(off, 'admin-ui').enableSignIn, false);
  const two = run(t, { SignInAdmins: 'a@contoso.example,b@contoso.example', Steps: 'admin-ui', AcrName: 'crx' });
  assert.equal(two.status, 0, two.out);
  assert.deepEqual(argsOf(two, 'admin-ui').signInAdmins, ['a@contoso.example,b@contoso.example'], 'passed as one comma list, which Deploy-AdminUi.ps1 splits');
  const bad = run(t, { SignInAdmins: 'a@x&calc', Steps: 'admin-ui', AcrName: 'crx' });
  assert.notEqual(bad.status, 0);
  assert.deepEqual(bad.calls, []);
});

test('T-117 -DatabaseLocation reaches the app stage only', { skip }, (t) => {
  const r = run(t, { Steps: 'base,app', DatabaseLocation: 'centralus' });
  assert.equal(r.status, 0, r.out);
  assert.equal(valueAfter(argsOf(r, 'app').argv, '--database-location'), 'centralus');
  assert.ok(!argsOf(r, 'base').argv.includes('--database-location'));
  const bad = run(t, { Steps: 'app', DatabaseLocation: 'Central US' });
  assert.notEqual(bad.status, 0);
  assert.deepEqual(bad.calls, []);
});

test('P-39 -ClientSecretDays reaches the app stage only, and 31 runs nothing', { skip }, (t) => {
  const r = run(t, { Steps: 'base,app', ClientSecretDays: '30' });
  assert.equal(r.status, 0, r.out);
  assert.equal(valueAfter(argsOf(r, 'app').argv, '--client-secret-days'), '30');
  assert.ok(!argsOf(r, 'base').argv.includes('--client-secret-days'));
  const bad = run(t, { Steps: 'app', ClientSecretDays: '31' });
  assert.notEqual(bad.status, 0);
  assert.deepEqual(bad.calls, []);
});

test('P-39 -RotateClientSecret reaches the app stage only', { skip }, (t) => {
  const r = run(t, { Steps: 'base,app', RotateClientSecret: true });
  assert.equal(r.status, 0, r.out);
  assert.ok(argsOf(r, 'app').argv.includes('--rotate-client-secret'));
  assert.ok(!argsOf(r, 'base').argv.includes('--rotate-client-secret'));
  assert.ok(!argsOf(run(t, { Steps: 'app' }), 'app').argv.includes('--rotate-client-secret'), 'not without the switch');
});

test('T-117 base and app need the Foundry account named, so nothing falls back to another deployment\'s account', { skip }, (t) => {
  for (const step of ['base', 'app']) {
    const r = run(t, { FoundryResourceGroup: null, FoundryAccount: null, Steps: step });
    assert.notEqual(r.status, 0, step);
    assert.deepEqual(r.calls, [], step);
    assert.match(r.flat, /-FoundryResourceGroup and -FoundryAccount/, step);
  }
  const ok = run(t, { FoundryResourceGroup: null, FoundryAccount: null, Steps: 'budgets' });
  assert.equal(ok.status, 0, 'budgets does not use the Foundry account');
});
