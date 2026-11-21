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
    template: { containers: [{ name: 'admin-ui', image: old, env: [
      { name: 'ADMIN_UI_SIGN_IN', value: 'required' },
      { name: 'GATEWAY_ADMIN_WRITE_KEY', value: null, secretRef: 'gateway-admin-write-key' },
    ] }], scale: { minReplicas: 1 } },
  },
};

const job = (name, container, image) => ({
  id: `/subscriptions/sub/resourceGroups/rg-test/providers/Microsoft.App/jobs/${name}`,
  location: 'eastus2', identity: { type: 'UserAssigned', userAssignedIdentities: { '/identity/admin-ui': {} } },
  properties: {
    provisioningState: 'Succeeded',
    configuration: { triggerType: 'Schedule', replicaTimeout: 300, replicaRetryLimit: 0,
      scheduleTriggerConfig: { cronExpression: '*/5 * * * *', parallelism: 1, replicaCompletionCount: 1 },
      secrets: [{ name: 'gateway-admin-file-json' }], registries: [{ server: 'registry.azurecr.io', identity: '/identity/admin-ui' }] },
    template: { containers: [{ name: container, image, command: ['node', 'server/pacer-job.mjs'], env: [
      { name: 'GATEWAY_URL', value: 'https://gateway.contoso.example' },
      { name: 'GATEWAY_ADMIN_FILE_JSON', value: null, secretRef: 'gateway-admin-file-json' },
    ] }] },
  },
});
const bothJobs = [job('job-spend-pacer', 'spend-pacer', old), job('job-signin-renewer', 'signin-renewer', old)];

function run({ plan = false, fault = '', group = 'rg-test', jobs = [] } = {}) {
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
        if ($env:UPDATE_FAULT -eq 'changed-env') { $result.properties.template.containers[0].env[0].value = 'off' }
        if ($env:UPDATE_FAULT -eq 'reordered') {
          $config = $result.properties.configuration
          $result.properties.configuration = [pscustomobject]@{ registries = $config.registries; secrets = $config.secrets; ingress = $config.ingress }
        }
        if ($env:UPDATE_FAULT -eq 'azure-defaults') {
          $container = $result.properties.template.containers[0]
          Add-Member -InputObject $container -NotePropertyName imageType -NotePropertyValue 'ContainerImage'
          Add-Member -InputObject $container -NotePropertyName resources -NotePropertyValue ([pscustomobject]@{ ephemeralStorage = '1Gi' })
          $container.env[1].value = ''
          Add-Member -InputObject $result.properties.template -NotePropertyName revisionSuffix -NotePropertyValue ''
          Add-Member -InputObject $result.properties.template.scale -NotePropertyName cooldownPeriod -NotePropertyValue 300
          Add-Member -InputObject $result.properties.template.scale -NotePropertyName pollingInterval -NotePropertyValue 30
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
    'containerapp job' {
      $jobs = @($env:UPDATE_JOBS | ConvertFrom-Json)
      $name = $a[[Array]::IndexOf($a, '-n') + 1]
      switch ($a[2]) {
        'list' { $result = @($jobs | ForEach-Object { $_.id.Split('/')[-1] }); return (ConvertTo-Json -InputObject $result -Compress) }
        'show' {
          $result = @($jobs | Where-Object { $_.id.Split('/')[-1] -eq $name })[0]
          if ($global:jobImages -and $global:jobImages.ContainsKey($name)) {
            $result.properties.template.containers[0].image = $global:jobImages[$name]
            if ($env:UPDATE_FAULT -eq 'job-changed' -and $name -eq 'job-spend-pacer') {
              $result.properties.configuration.scheduleTriggerConfig.cronExpression = '0 * * * *'
            }
            if ($env:UPDATE_FAULT -eq 'job-image' -and $name -eq 'job-spend-pacer') {
              $result.properties.template.containers[0].image = 'registry.azurecr.io/admin-ui:latest'
            }
            if ($env:UPDATE_FAULT -eq 'job-defaults') {
              $container = $result.properties.template.containers[0]
              Add-Member -InputObject $container -NotePropertyName imageType -NotePropertyValue 'ContainerImage'
              Add-Member -InputObject $container -NotePropertyName resources -NotePropertyValue ([pscustomobject]@{ ephemeralStorage = '1Gi' })
              $container.env[1].value = ''
            }
          }
        }
        'update' {
          if ($env:UPDATE_FAULT -eq 'job-update-fails') { $global:LASTEXITCODE = 1; return }
          if (-not $global:jobImages) { $global:jobImages = @{} }
          $global:jobImages[$name] = $a[[Array]::IndexOf($a, '--image') + 1]
        }
        default { throw "Unexpected az command: $($a -join ' ')" }
      }
    }
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
        UPDATE_CALLS: calls, UPDATE_FAULT: fault, UPDATE_GROUP: group, UPDATE_JOBS: JSON.stringify(jobs) },
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
  // T-183 reads the console's scheduled jobs; none exist in this fixture, so none may be changed.
  assert.ok(!r.calls.some((a) => a.includes('secret') || a.includes('deployment') || a.includes('role') ||
    (a.includes('job') && !['list', 'show'].includes(a[2]))));
});

test('T-168 build failure, changed configuration and an unhealthy rollout cannot report success', { skip }, () => {
  for (const [fault, reason] of [['build', /acr build failed/], ['changed-ingress', /settings changed unexpectedly/],
    ['changed-env', /settings changed unexpectedly/], ['unhealthy', /rollout failed/], ['registry', /registry does not match/]]) {
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

test('T-176 Azure-generated defaults and redacted secret values do not count as configuration changes', { skip }, () => {
  const r = run({ fault: 'azure-defaults' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Update complete/);
});

const jobUpdates = (r) => r.calls.filter((a) => a[0] === 'containerapp' && a[1] === 'job' && a[2] === 'update');
const jobRollback = (name, container, image) =>
  `az containerapp job update -g rg-test -n ${name} --container-name ${container} --image ${image}`;

test('T-183 the scheduled jobs move to the same digest only after the console is verified', { skip }, () => {
  const r = run({ jobs: bothJobs });
  assert.equal(r.status, 0, r.out);
  const updates = jobUpdates(r);
  assert.deepEqual(updates.map((a) => [a[a.indexOf('-n') + 1], a[a.indexOf('--container-name') + 1], a[a.indexOf('--image') + 1]]),
    [['job-spend-pacer', 'spend-pacer', next], ['job-signin-renewer', 'signin-renewer', next]]);
  for (const a of updates) {
    assert.equal(a[a.indexOf('-g') + 1], 'rg-test');
    assert.deepEqual(a.slice(-2), ['-o', 'none']);
  }
  const verified = r.calls.findIndex((a) => a[1] === 'revision');
  const firstJobUpdate = r.calls.findIndex((a) => a[1] === 'job' && a[2] === 'update');
  assert.ok(verified >= 0 && firstJobUpdate > verified, 'jobs change only after the console revision is Healthy');
  assert.ok(r.out.includes(jobRollback('job-spend-pacer', 'spend-pacer', old)), r.out);
  assert.ok(r.out.includes(jobRollback('job-signin-renewer', 'signin-renewer', old)), r.out);
  assert.ok(r.out.indexOf(jobRollback('job-spend-pacer', 'spend-pacer', old)) < r.out.indexOf('Update complete'));
  assert.match(r.out, /Update complete/);
  assert.match(r.out, /jobs updated: job-spend-pacer, job-signin-renewer/i);
});

test('T-183 Azure-generated job defaults and redacted secret values do not count as job changes', { skip }, () => {
  const r = run({ jobs: bothJobs, fault: 'job-defaults' });
  assert.equal(r.status, 0, r.out);
  assert.equal(jobUpdates(r).length, 2);
});

test('T-183 an absent job is skipped with a message, not an error', { skip }, () => {
  const r = run({ jobs: [bothJobs[0]] });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /job-signin-renewer.*not found.*skipped/i);
  assert.deepEqual(jobUpdates(r).map((a) => a[a.indexOf('-n') + 1]), ['job-spend-pacer']);
  assert.ok(!r.calls.some((a) => a[1] === 'job' && a.includes('job-signin-renewer')));
  assert.match(r.out, /jobs updated: job-spend-pacer\b/i);
});

test('T-183 a job running another registry\'s image, another image or another container is skipped and unchanged', { skip }, () => {
  for (const jobs of [
    [job('job-spend-pacer', 'spend-pacer', `other.azurecr.io/admin-ui@sha256:${'a'.repeat(64)}`)],
    [job('job-spend-pacer', 'spend-pacer', 'registry.azurecr.io/not-admin-ui:1')],
    [job('job-spend-pacer', 'something-else', old)],
  ]) {
    const r = run({ jobs });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /job-spend-pacer.*skipped/i);
    assert.equal(jobUpdates(r).length, 0, r.out);
    assert.match(r.out, /jobs updated: none/i);
  }
});

test('T-183 a job whose settings or image differ after its update fails with that job\'s rollback command', { skip }, () => {
  for (const [fault, reason] of [['job-changed', /job-spend-pacer settings changed unexpectedly/],
    ['job-image', /job-spend-pacer image differs/], ['job-update-fails', /containerapp job failed/]]) {
    const r = run({ jobs: bothJobs, fault });
    assert.notEqual(r.status, 0, `${fault}: ${r.out}`);
    assert.match(r.out, reason);
    assert.ok(r.out.includes(jobRollback('job-spend-pacer', 'spend-pacer', old)), r.out);
    assert.doesNotMatch(r.out, /Update complete/);
    assert.deepEqual(jobUpdates(r).map((a) => a[a.indexOf('-n') + 1]), ['job-spend-pacer'], 'the run stops at the first failed job');
  }
});

test('T-183 the plan lists the jobs and their previous images and runs no update', { skip }, () => {
  const r = run({ plan: true, jobs: [bothJobs[0]] });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Plan only/);
  assert.match(r.out, /job-spend-pacer/);
  assert.ok(r.out.includes(jobRollback('job-spend-pacer', 'spend-pacer', old)), r.out);
  assert.match(r.out, /job-signin-renewer.*not found.*skipped/i);
  assert.ok(!r.calls.some((a) => ['build', 'update', 'create', 'set', 'delete'].some((verb) => a.includes(verb))));
});

test('T-183 a console update that fails or is not verified leaves the jobs untouched', { skip }, () => {
  for (const fault of ['build', 'changed-ingress', 'unhealthy', 'registry']) {
    const r = run({ jobs: bothJobs, fault });
    assert.notEqual(r.status, 0, `${fault}: ${r.out}`);
    assert.equal(jobUpdates(r).length, 0, `${fault}: ${r.out}`);
  }
});

test('T-183 no role, secret, identity, Graph, gateway or deployment command is called', { skip }, () => {
  for (const options of [{ jobs: bothJobs }, { jobs: bothJobs, plan: true }, { jobs: bothJobs, fault: 'job-changed' }]) {
    const r = run(options);
    assert.ok(r.calls.length > 0);
    for (const a of r.calls) {
      const line = ` ${a.join(' ')} `;
      for (const forbidden of ['role', 'secret set', 'identity assign', 'ca-claude-gw', 'deployment', ' ad ']) {
        assert.ok(!line.includes(forbidden), `forbidden "${forbidden}" in: ${line}`);
      }
    }
  }
});
