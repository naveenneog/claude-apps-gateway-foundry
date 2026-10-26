// T-117 (P-39): admin-ui/infra/Deploy-AdminUi.ps1 checks its sign-in administrators before any Azure call, so an
// admin-only console cannot be deployed with nobody able to sign in to it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'admin-ui', 'infra', 'Deploy-AdminUi.ps1');
const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '(Get-Process -Id $PID).Path'], { encoding: 'utf8' }).stdout?.trim();
const skip = !pwsh && 'PowerShell 7 (pwsh) is not on PATH';
// PATH holds only node's folder, so az cannot be found: the script must stop on its own check before calling az.
const run = (args) => {
  const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', script, '-ResourceGroup', 'rg-x', '-AcrName', 'crx', '-AppRegistrationName', 'app-x', ...args],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: path.dirname(process.execPath) } });
  return { status: r.status, out: `${r.stdout}${r.stderr}`.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+/g, ' ') };
};

test('T-117 -EnableSignIn without -SignInAdmins is refused before any az call', { skip }, () => {
  const r = run(['-EnableSignIn']);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /-SignInAdmins/);
  assert.doesNotMatch(r.out, /az(\.cmd)?'? is not recognized|CommandNotFoundException/);
});

test('T-117 a comma list of administrators is split, and each must be a plain UPN', { skip }, () => {
  const ok = run(['-EnableSignIn', '-SignInAdmins', 'a@contoso.example,b@contoso.example', '-Plan']);
  assert.match(ok.out, /administrators: a@contoso\.example, b@contoso\.example/);
  const bad = run(['-EnableSignIn', '-SignInAdmins', 'a@contoso.example,not-an-upn']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.out, /not-an-upn/);
});

// P-39: az ad app list --display-name matches by prefix, so the gateway's registration and the console's
// <name>-admin-ui-signin registration both match the gateway's name; the deploy picks the exact name or stops.
const lookup = (apps, name) => spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command',
  `Import-Module '${path.join(repo, 'admin-ui', 'infra', 'AppLookup.psm1')}'; Select-AppIdByName -Apps (ConvertFrom-Json -InputObject $env:CGW_APPS) -Name $env:CGW_NAME`],
{ encoding: 'utf8', timeout: 60_000, env: { ...process.env, CGW_APPS: JSON.stringify(apps), CGW_NAME: name } });

test('P-39 the app registration is chosen by its exact name, not the first prefix match', { skip }, () => {
  const apps = [{ displayName: 'claude-gw-eval-admin-ui-signin', appId: 'signin-id' }, { displayName: 'claude-gw-eval', appId: 'gateway-id' }];
  assert.equal(lookup(apps, 'claude-gw-eval').stdout.trim(), 'gateway-id');
  assert.equal(lookup(apps, 'claude-gw-eval-admin-ui-signin').stdout.trim(), 'signin-id');
  assert.equal(lookup([], 'claude-gw-eval').stdout.trim(), '', 'none yet');
  assert.equal(lookup([apps[0]], 'claude-gw-eval').stdout.trim(), '', 'a prefix match alone is not the app');
  const two = lookup([apps[1], { displayName: 'claude-gw-eval', appId: 'other-id' }], 'claude-gw-eval');
  assert.notEqual(two.status, 0);
  assert.match(two.stderr + two.stdout, /2 app registrations are named claude-gw-eval/);
});

test('P-39 Deploy-AdminUi.ps1 looks app registrations up only through Select-AppIdByName', () => {
  const text = fs.readFileSync(script, 'utf8');
  assert.doesNotMatch(text, /ad app list --display-name [^\n]*'\[0\]/, 'no first-of-a-prefix-match lookup');
  assert.equal((text.match(/Select-AppIdByName/g) ?? []).length, 2);
});
