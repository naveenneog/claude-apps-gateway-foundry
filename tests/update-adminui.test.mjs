// T-168: image-only console updates, driven through the actual PowerShell entry point with a fake az function.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = path.join(import.meta.dirname, '..', 'admin-ui', 'infra', 'Update-AdminUi.ps1');
const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
const skip = pwsh.status !== 0 && 'PowerShell 7 is not installed';
const old = `registry.azurecr.io/admin-ui@sha256:${'a'.repeat(64)}`;
const next = `registry.azurecr.io/admin-ui@sha256:${'b'.repeat(64)}`;
const app = {
  id: '/subscriptions/sub/resourceGroups/rg-test/providers/Microsoft.App/containerApps/ca-admin-ui',
  location: 'eastus2', identity: { type: 'UserAssigned', userAssignedIdentities: { '/identity/admin-ui': {} } },
  properties: {
    latestRevisionName: 'old', latestReadyRevisionName: 'old', provisioningState: 'Succeeded',
    configuration: { ingress: { external: true, fqdn: 'console.contoso.example', ipSecurityRestrictions: [] },
      secrets: [{ name: 'gateway-admin-write-key' }], registries: [{ server: 'registry.azurecr.io' }] },
    template: { containers: [{ name: 'admin-ui', image: old, env: [{ name: 'ADMIN_UI_SIGN_IN', value: 'required' }] }], scale: { minReplicas: 1 } },
  },
};

function run({ plan = false, fault = '', group = 'rg-test' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-update-test-'));
  const calls = path.join(dir, 'calls.jsonl');
  const mock = `
$global:changed = $false
function global:az {
  $a = @($args)
  Add-Content -LiteralPath $env:UPDATE_CALLS -Value (ConvertTo-Json -InputObject $a -Compress)
  $global:LASTEXITCODE = 0
  $result = @{}
  switch ("$($a[0]) $($a[1])") {
    'account show' { $result = @{ id = 'sub'; tenantId = 'tenant' } }
    'containerapp show' {
      $result = $env:UPDATE_APP | ConvertFrom-Json
      if ($global:changed) {
        $result.properties.template.containers[0].image = $env:UPDATE_NEXT
        $result.properties.latestRevisionName = 'new'
        $result.properties.latestReadyRevisionName = 'new'
        if ($env:UPDATE_FAULT -eq 'changed-ingress') { $result.properties.configuration.ingress.external = $false }
        if ($env:UPDATE_FAULT -eq 'reordered') {
          $config = $result.properties.configuration
          $result.properties.configuration = [pscustomobject]@{ registries = $config.registries; secrets = $config.secrets; ingress = $config.ingress }
        }
        if ($env:UPDATE_FAULT -eq 'unhealthy') { $result.properties.provisioningState = 'Failed' }
      }
    }
    'containerapp auth' { $result = @{ properties = @{ platform = @{ enabled = $true }; identityProviders = @{ azureActiveDirectory = @{ enabled = $true } } } } }
    'acr show' { $result = @{ name = 'registry'; loginServer = $(if ($env:UPDATE_FAULT -eq 'registry') { 'different.azurecr.io' } else { 'registry.azurecr.io' }) } }
    'acr build' { if ($env:UPDATE_FAULT -eq 'build') { $global:LASTEXITCODE = 1; return } }
    'acr repository' { $result = @{ digest = $(if ($env:UPDATE_FAULT -eq 'same-image') { 'sha256:${'a'.repeat(64)}' } else { 'sha256:${'b'.repeat(64)}' }) } }
    'containerapp update' { $global:changed = $true }
    'containerapp revision' { $result = @{ properties = @{ healthState = 'Healthy' } } }
    default { throw "Unexpected az command: $($a -join ' ')" }
  }
  ConvertTo-Json -InputObject $result -Depth 30 -Compress
}
& $env:UPDATE_SCRIPT -ResourceGroup $env:UPDATE_GROUP ${plan ? '-Plan' : ''}
`;
  try {
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', mock], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, UPDATE_APP: JSON.stringify(app), UPDATE_NEXT: next, UPDATE_SCRIPT: script,
        UPDATE_CALLS: calls, UPDATE_FAULT: fault, UPDATE_GROUP: group },
    });
    const recorded = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/).map(JSON.parse) : [];
    return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: recorded };
  } finally {
    fs.rmSync(calls, { force: true });
    fs.rmdirSync(dir);
  }
}

test('T-168 the update plan reads the target but builds or changes nothing', { skip }, () => {
  const r = run({ plan: true });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /plan/i);
  assert.ok(r.calls.length > 0);
  assert.ok(!r.calls.some((a) => ['build', 'update', 'create', 'set', 'delete'].some((verb) => a.includes(verb))));
});

test('T-168 an update changes only the console image and retains a rollback reference', { skip }, () => {
  const r = run();
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.includes(old), 'the previous image is printed for rollback');
  const updates = r.calls.filter((a) => a[0] === 'containerapp' && a[1] === 'update');
  assert.equal(updates.length, 1);
  assert.equal(updates[0][updates[0].indexOf('--image') + 1], next);
  assert.ok(updates[0].includes('ca-admin-ui'));
  assert.ok(!r.calls.some((a) => a.includes('secret') || a.includes('deployment') || a.includes('role') || a.includes('job')));
});

test('T-168 build failure, changed configuration and an unhealthy rollout cannot report success', { skip }, () => {
  for (const [fault, reason] of [['build', /acr build failed/], ['changed-ingress', /settings changed unexpectedly/],
    ['unhealthy', /rollout failed/], ['registry', /registry does not match/]]) {
    const r = run({ fault });
    assert.notEqual(r.status, 0, `${fault}: ${r.out}`);
    assert.match(r.out, reason);
    assert.doesNotMatch(r.out, /Update complete/);
    if (fault === 'build') assert.ok(!r.calls.some((a) => a[1] === 'update'));
  }
});

test('T-168 unsafe native arguments stop before any Azure call', { skip }, () => {
  const r = run({ group: 'rg-test&bad' });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /ResourceGroup.*native-command-safe/);
  assert.equal(r.calls.length, 0);
});

test('T-168 the same image is verified without waiting for a nonexistent revision', { skip }, () => {
  const r = run({ fault: 'same-image' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Already up to date/);
  assert.ok(!r.calls.some((a) => a[1] === 'update'));
});

test('T-168 preservation compares settings structurally, not by JSON property order', { skip }, () => {
  const r = run({ fault: 'reordered' });
  assert.equal(r.status, 0, r.out);
});
