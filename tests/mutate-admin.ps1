param([string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path, [int]$Parallel = 6, [string]$Only = '', [string]$Shard = '', [switch]$List)
# Mutation check for the admin scripts (ADR-0004, T-52 to T-54). Each mutation breaks one property the admin tests
# claim to guard. The tree is never changed: every mutant runs in a temporary copy of the files the admin tests use.
# A mutation counts as caught only when the mutant passes `node --check`, the suite runs its full baseline test count,
# and at least one test does not pass (failed, or cancelled as node:test reports a timeout). -Only runs the
# mutations whose names match a regular expression. -Shard k/n runs every n-th mutation from the k-th, so shards 1/n to
# n/n run each mutation once between them (the GitHub workflow, P-26); -List prints the selected mutations and runs nothing.
# Run: pwsh -File tests/mutate-admin.ps1
# Exit 1 when the unmutated suite fails or skips a test, or when any mutation survives, does not apply exactly once,
# or breaks the syntax.
$ErrorActionPreference = 'Stop'
$suite = @('tests/admin-config.test.mjs', 'tests/admin-developer.test.mjs', 'tests/admin-policy.test.mjs', 'tests/private-config.test.mjs')
$copied = @('scripts/admin', 'scripts/developer', 'infra/azure-test/lib', 'infra/azure-test/entra-app.json',
  'config/gateway-admin.azure-test.json', 'config/gateway.azure-test.yaml', 'config/gateway-admin.azure-private.json', 'config/gateway.azure-private.yaml',
  'tests/developer', 'tests/message-rules.mjs') + $suite
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$work = Join-Path ([IO.Path]::GetTempPath()) "cgw-mutate-admin-$PID"

$N = 'scripts/admin/new-gateway-config.mjs'; $S = 'scripts/admin/set-developer.mjs'; $P = 'scripts/admin/new-client-policy.mjs'
# (file, name, exact text, replacement)
$mutations = @(
  @($N, 'unknown keys accepted', "if (!['`$comment', 'roles', 'models', 'policies', 'deployment'].includes(key)) errors.push(", 'if (false) errors.push('),
  @($N, 'role outside the manifest accepted', 'else if (!knownRoles.includes(role)) errors.push(', 'else if (false) errors.push('),
  @($N, 'model without a deployment accepted', "for (const key of ['id', 'deployment']) {", "for (const key of ['id']) {"),
  @($N, 'label with control characters accepted', '!/^[^\x00-\x1f\x7f$]{1,100}$/.test(model.label)', 'false'),
  @($N, 'duplicate model accepted', 'if (ids.has(model.id)) errors.push(', 'if (false) errors.push('),
  @($N, 'policy model outside models accepted', 'for (const id of allowed) if (!ids.has(id)) errors.push(', 'for (const id of allowed) if (false) errors.push('),
  @($N, 'policy role outside roles accepted', 'if (!roles.includes(policy.role)) errors.push(', 'if (false) errors.push('),
  @($N, 'admitted role without a policy accepted', 'for (const role of roles) if (!covered.has(role)) errors.push(', 'for (const role of roles) if (false) errors.push('),
  @($N, 'YAML booleans written bare', ' && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(value)', ''),
  @($N, 'numbers written bare', 'const bare = /^[A-Za-z][A-Za-z0-9 ._()/-]*$/', 'const bare = /^[A-Za-z0-9][A-Za-z0-9 ._()/-]*$/'),
  @($N, 'policies rendered in reverse', '...admin.policies.flatMap(', '...[...admin.policies].reverse().flatMap('),
  @($N, '--check ignored', 'if (values.check) {', 'if (false) {'),
  @($N, 'written despite problems', 'if (errors.length) throw new Error(', 'if (false) throw new Error('),
  @($S, 'listing not paged', "next = page['@odata.nextLink'] ?? null;", 'next = null;'),
  @($S, 'assignments of another app used', 'return all.filter((a) => a.resourceId === servicePrincipalId);', 'return all;'),
  @($S, 'UPN not encoded', '`/users/${encodeURIComponent(upn)}?', '`/users/${upn}?'),
  @($S, 'grant repeated', 'if (mine.length) return { changed: false, message: `${who} already holds ${role}` };', ''),
  @($S, 'unknown role accepted', 'if (!found) throw new Error(', 'if (false) throw new Error('),
  @($S, 'remove takes every role of the user', '.filter((a) => a.principalId === user.json.id && a.appRoleId === appRole.id)', '.filter((a) => a.principalId === user.json.id)'),
  @($P, 'http accepted', "if (url.protocol !== 'https:') throw", 'if (false) throw'),
  @($P, 'credentials accepted', 'if (url.username || url.password) throw', 'if (false) throw'),
  @($P, 'path, query and fragment accepted', "if (url.pathname !== '/' || url.search || url.hash) throw", 'if (false) throw'),
  @($P, 'public address accepted', 'if (!PRIVATE.some((range) => cidrContains(range, host))) throw', 'if (false) throw'),
  @($P, 'IPv6 literal accepted', "if (host.startsWith('[')) throw", 'if (false) throw'),
  @($P, 'host characters not checked', '} else if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {', '} else if (false) {'),
  @($P, 'quotes not escaped in the .reg value', ".replace(/`"/g, '\\`"')", ''),
  @($P, '.reg without a byte order mark', 'Buffer.from([0xff, 0xfe]), ', ''),
  @($P, 'profile UUIDs random', "crypto.createHash('sha256').update(seed).digest('hex')", "crypto.randomBytes(32).toString('hex')"),
  @($P, 'non-empty directory overwritten', 'if (fs.existsSync(out) && fs.readdirSync(out).length && !values.force) throw', 'if (false) throw'),
  @($P, 'parentSettingsBehavior dropped', ", parentSettingsBehavior: 'merge' })", ' })'),
  @($P, 'developer bundle without the module', '.filter((f) => /\.(ps1|psm1)$/.test(f))', '.filter((f) => /\.ps1$/.test(f))'),
  @($P, 'mobileconfig identifiers ignore the policy ID', 'com.anthropic.claudecode.gateway.profile.${xml(policyId)}', 'com.anthropic.claudecode.gateway.profile'),
  @($P, 'policy ID not validated', 'if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/.test(policyId)) throw', 'if (false) throw'),
  @($N, 'label may hold a $', '\x7f$]{1,100}', '\x7f]{1,100}'),
  @($N, 'renderer accepts a $', "if (value.includes('`$')) throw new Error(", 'if (false) throw new Error('),
  @($N, 'null model entry not reported', "if (model === null || typeof model !== 'object' || Array.isArray(model)) { errors.push(", 'if (false) { errors.push('),
  @($N, 'null policy entry not reported', "if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) { errors.push(", 'if (false) { errors.push('),
  @($S, 'role the gateway does not admit granted', 'if (!admittedRoles.includes(role)) {', 'if (false) {'),
  @($S, 'grant without admitted roles allowed', 'if (!Array.isArray(admittedRoles)) throw new Error(', 'if (false) throw new Error('),
  @($S, 'CLI ignores --admin', 'const adminFile = path.resolve(values.admin);', 'const adminFile = DEFAULT_ADMIN;'),
  @($S, 'admin file not validated before Graph', 'if (errors.length) throw new Error(`${shownPath(adminFile)} has', 'if (false) throw new Error(`${shownPath(adminFile)} has'),
  @($N, 'header names a fixed admin file', 'Generated from ${adminFile} by the admin script new-gateway-config.mjs (ADR-0004)', 'Generated from config/gateway-admin.azure-test.json by the admin script new-gateway-config.mjs (ADR-0004)'),
  @($N, 'private: header names a fixed admin file', 'Generated from ${adminFile} by the admin script new-gateway-config.mjs --topology private', 'Generated from config/gateway-admin.azure-private.json by the admin script new-gateway-config.mjs --topology private'),
  @($P, 'START-HERE launcher without the call operator', '''   & "$env:USERPROFILE\\.claude-apps-gateway\\claude-gateway.cmd"'',', '''   "$env:USERPROFILE\\.claude-apps-gateway\\claude-gateway.cmd"'','),
  @($P, 'START-HERE signs in again through the installed runtime', 'run(''Connect-ClaudeGateway.ps1''),', '''   powershell -File "%LOCALAPPDATA%\\ClaudeAppsGateway\\bin\\Connect-ClaudeGateway.ps1"'','),
  @($P, 'START-HERE without the sign-out', 'run(''Disconnect-ClaudeGateway.ps1''),', ''),
  @($P, 'START-HERE without the alternatives statement', '. A machine takes one of the two.', '.'),
  @($P, 'START-HERE without the network prerequisite', 'A network from which the gateway answers.', 'A browser.'),
  @($P, 'START-HERE quotes a message no script prints', '"The sign-in was declined (access_denied)"', '"The sign-in was refused (access_denied)"'),
  @($P, 'START-HERE quotes a status the script interpolates', '"Discovery at <url> returned HTTP <status>."', '"Discovery at <url> returned HTTP 403."'),
  @('tests/message-rules.mjs', 'START-HERE checked only up to the first placeholder', 'message.split(/<[^>]*>/).map((s) => s.trim()).filter(Boolean)', 'message.split(/<[^>]*>/).slice(0, 1).map((s) => s.trim()).filter(Boolean)'),
  # Council round 5: START-HERE quotes only what a script prints, covers HTTP 200, and diagnoses a failing apiKeyHelper.
  @('tests/message-rules.mjs', 'START-HERE counts a message kept in a comment', '    if (/^\s*#/.test(line)) return;', ''),
  @($P, 'START-HERE without the HTTP 200 case', 'With 200, the answer was not JSON', 'With 299, the answer was not JSON'),
  @($P, 'START-HERE sends every apiKeyHelper failure to a new sign-in', '''- Claude Code reports that apiKeyHelper is failing: in a new Windows PowerShell window, run the helper', '''- Claude Code reports that apiKeyHelper is failing: sign in again, or in a new Windows PowerShell window, run the helper'),
  @($P, 'START-HERE diagnostic sets only the base URL', '    ''   foreach ($p in $pinned.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value) }'',', '    ''   $env:ANTHROPIC_BASE_URL = $pinned.env.ANTHROPIC_BASE_URL'','),
  @($P, 'START-HERE sends a declined code to the operator', '''- "The sign-in was declined (access_denied)": if you declined the code, run step 2 again and confirm it. When the'',', '''- "The sign-in was declined (access_denied)": ask the operator for a gateway role. When the'','),
  @($N, 'C0 range narrowed in the header path', '/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(adminFile)', '/[\x00-\x1e\x7f-\x9f\u2028\u2029]/.test(adminFile)'),
  @($N, 'NEL accepted in the header path', '/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(adminFile)', '/[\x00-\x1f\x7f]/.test(adminFile)'),
  @($N, 'line separators accepted in the header path', '/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(adminFile)', '/[\x00-\x1f\x7f-\x9f]/.test(adminFile)'),
  @($P, 'START-HERE install command without the fast model', '`-GatewayUrl ${origin}${fast}`', '`-GatewayUrl ${origin}`'),
  # P-10 (T-73): the network-restricted topology of new-gateway-config.mjs.
  @($N, 'private: every private range trusted', '''  trusted_proxies: [100.100.0.0/17, 100.100.128.0/19, 100.100.160.0/19, 100.100.192.0/19]'',', '''  trusted_proxies: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16]'','),
  @($N, 'the Default model left outside availableModels', '''        enforceAvailableModels: true'',', ''),
  @($N, 'private: store without TLS', ':5432/gateway?sslmode=require"', ':5432/gateway"'),
  @($N, 'private: host bits accepted', 'return address % size === 0 ? null :', 'return true ? null :'),
  @($N, 'private: limits not checked', 'if (value !== undefined && !(Number.isInteger(value) && value >= 1 && value <= max)) errors.push(', 'if (false) errors.push('),
  @($N, 'private: an empty allow list accepted', 'if (!Array.isArray(cidrs) || !cidrs.length) errors.push(', 'if (!Array.isArray(cidrs)) errors.push('),
  @($N, 'private: Claude Desktop without policies accepted', 'if (deployment.desktop === true && !Array.isArray(policies)) errors.push(', 'if (false) errors.push('),
  @($N, 'private: every policy opted in to Claude Desktop', 'const desktop = topology === ''private'' && deployment.desktop === true;', 'const desktop = topology === ''private'';'),
  @($N, 'private: the admin file''s allow list ignored', '`  allow_cidrs: [${d.developerCidrs.join('', '')}]`,', '''  allow_cidrs: [10.0.0.0/8]'','),
  @($N, 'private: topology without its deployment block accepted', 'if (topology === ''private'' && !deployment) throw', 'if (false) throw')
)

# The selection: -Only by name, then -Shard k/n by position in the list above.
$shardIndex = 0; $shardCount = 1
if ($Shard) {
  if ($Shard -notmatch '^(\d+)/(\d+)$' -or [int]$Matches[1] -lt 1 -or [int]$Matches[1] -gt [int]$Matches[2]) {
    throw "-Shard must be k/n with k from 1 to n, such as 2/4; found '$Shard'."
  }
  $shardIndex = [int]$Matches[1] - 1; $shardCount = [int]$Matches[2]
}
$indexed = @(for ($i = 0; $i -lt $mutations.Count; $i++) {
  if ($Only -and $mutations[$i][1] -notmatch $Only) { continue }
  if (($i % $shardCount) -ne $shardIndex) { continue }
  [pscustomobject]@{ Index = $i; File = $mutations[$i][0]; Name = $mutations[$i][1]; Find = $mutations[$i][2]; Replace = $mutations[$i][3] }
})
if ($List) {
  $indexed | ForEach-Object { Write-Output "$($_.Index) $($_.File): $($_.Name)" }
  exit 0
}
if ($Shard) { Write-Host "shard $Shard`: $($indexed.Count) of $($mutations.Count) mutations" }

$invokeSuite = {
  param([string]$Node, [string]$Dir, [string[]]$Suite)
  $psi = [Diagnostics.ProcessStartInfo]::new($Node)
  foreach ($a in @('--test', '--test-force-exit', '--test-timeout=60000', '--test-reporter=tap') + $Suite) { $psi.ArgumentList.Add($a) }
  $psi.WorkingDirectory = $Dir
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $p = [Diagnostics.Process]::Start($psi)
  $stderr = $p.StandardError.ReadToEndAsync()
  $out = $p.StandardOutput.ReadToEnd()
  $p.WaitForExit()
  [void]$stderr.Result
  $count = { param($name) $m = [regex]::Match($out, "(?m)^# $name (\d+)\s*$"); if ($m.Success) { [int]$m.Groups[1].Value } else { -1 } }
  [pscustomobject]@{ Exit = $p.ExitCode; Tests = & $count 'tests'; Pass = & $count 'pass'; Fail = & $count 'fail'; Cancelled = & $count 'cancelled'; Skipped = & $count 'skipped' }
}
$suiteText = $invokeSuite.ToString()
$copyTree = {
  param([string]$Repo, [string[]]$Paths, [string]$Dir)
  foreach ($rel in $Paths) {
    $to = Join-Path $Dir $rel
    New-Item -ItemType Directory -Force -Path (Split-Path $to -Parent) | Out-Null
    Copy-Item -LiteralPath (Join-Path $Repo $rel) -Destination $to -Recurse
  }
}
$copyText = $copyTree.ToString()

New-Item -ItemType Directory -Path $work | Out-Null
try {
  $baseDir = Join-Path $work 'baseline'
  & $copyTree $Repo $copied $baseDir
  $baseline = & $invokeSuite $node $baseDir $suite
  if ($baseline.Exit -ne 0 -or $baseline.Tests -lt 1 -or $baseline.Pass -ne $baseline.Tests -or $baseline.Skipped -ne 0) {
    throw "The unmutated suite must pass with nothing skipped: exit $($baseline.Exit), $($baseline.Tests) tests, $($baseline.Pass) passed, $($baseline.Skipped) skipped."
  }
  Write-Host "baseline: $($baseline.Tests) tests pass"
  $results = $indexed | ForEach-Object -ThrottleLimit $Parallel -Parallel {
    $m = $_
    $dir = Join-Path $using:work "m$($m.Index)"
    & ([scriptblock]::Create($using:copyText)) $using:Repo $using:copied $dir
    $file = Join-Path $dir $m.File
    $text = [IO.File]::ReadAllText($file)
    $at = $text.IndexOf($m.Find, [StringComparison]::Ordinal)
    $result = if ($at -lt 0 -or $text.IndexOf($m.Find, $at + 1, [StringComparison]::Ordinal) -ge 0) { 'NOT APPLIED (text must occur exactly once)' } else {
      [IO.File]::WriteAllText($file, $text.Substring(0, $at) + $m.Replace + $text.Substring($at + $m.Find.Length), [Text.UTF8Encoding]::new($false))
      & $using:node --check $file 2>$null
      if ($LASTEXITCODE -ne 0) { 'BROKEN (node --check fails)' } else {
        $run = & ([scriptblock]::Create($using:suiteText)) $using:node $dir $using:suite
        if ($run.Tests -ne ($using:baseline).Tests) { "BROKEN ($($run.Tests) of $(($using:baseline).Tests) tests ran)" }
        elseif ($run.Pass -lt $run.Tests) { "caught ($($run.Fail) failed, $($run.Cancelled) cancelled)" } else { 'SURVIVED' }
      }
    }
    [pscustomobject]@{ target = $m.File; mutation = $m.Name; result = $result }
  }
  $results | Sort-Object target, mutation | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
  $bad = @($results | Where-Object { $_.result -notlike 'caught*' })
  Write-Host "$($results.Count - $bad.Count) of $($results.Count) mutations caught"
  if ($bad.Count) { exit 1 }
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
