param([string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path, [int]$Parallel = 4, [string]$Only = '', [switch]$DryRun, [string]$Shard = '', [switch]$List)
# Mutation check for the developer scripts (ADR-0004, T-48 to T-50). Each mutation breaks one property the
# developer tests claim to guard. The tree is never changed: every mutant is a copy of scripts/developer in a
# temporary directory, and the tests read it through DEVELOPER_SCRIPTS_DIR. A mutation counts as caught only when
# the mutant parses, the suite runs its full baseline test count, and at least one test does not pass: a failed test or a
# cancelled one, which is how node:test reports a timeout. -Only runs the mutations whose names match a regular expression;
# -DryRun only checks that each mutation's text occurs exactly once. -Shard k/n runs every n-th mutation from the k-th,
# so shards 1/n to n/n run each mutation once between them (the GitHub workflow, P-26); -List prints the selected
# mutations and runs nothing.
# Run: pwsh -File tests/mutate-developer.ps1
# Exit 1 when the unmutated suite fails or skips a test, or when any mutation survives, does not apply exactly
# once, or breaks parsing.
$ErrorActionPreference = 'Stop'
$suite = @('tests/developer-connect.test.mjs', 'tests/developer-helper.test.mjs', 'tests/developer-profile.test.mjs')
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$source = Join-Path $Repo 'scripts/developer'
$work = Join-Path ([IO.Path]::GetTempPath()) "cgw-mutate-$PID"

$M = 'ClaudeGateway.psm1'; $C = 'Connect-ClaudeGateway.ps1'; $D = 'Disconnect-ClaudeGateway.ps1'; $G = 'Get-ClaudeGatewayToken.ps1'; $I = 'Install-ClaudeGatewayProfile.ps1'
# (file, name, exact text, replacement). {NL} stands for a line break in the LF-normalised scripts.
$mutations = @(
  @($M, 'http accepted for a remote host', '-not ($uri.Scheme -eq ''http'' -and $uri.IsLoopback)', '-not ($uri.Scheme -eq ''http'')'),
  @($M, 'credentials in the URL accepted', 'if ($uri.UserInfo) {', 'if ($false) {'),
  @($M, 'path, query and fragment accepted', 'if ($uri.AbsolutePath -ne ''/'' -or $uri.Query -or $uri.Fragment) {', 'if ($false) {'),
  @($M, 'any host characters accepted', '-notmatch ''^https?://([A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]+)?$''', '-notmatch ''^https?://'''),
  @($M, 'IPv6 origin not canonical', 'if ($Uri.HostNameType -eq [UriHostNameType]::IPv6) {', 'if ($false) {'),
  @($M, 'endpoints on another origin accepted', ' -or (Get-UriOrigin -Uri $uri) -ne $Origin', ''),
  @($M, 'revocation endpoint origin not checked', 'if ($revocation) { Assert-GatewayOrigin -Url $revocation -Origin $Origin -Name ''revocation_endpoint'' }', ''),
  @($M, 'redirects followed', '$handler.AllowAutoRedirect = $false', '$handler.AllowAutoRedirect = $true'),
  @($M, 'proxy settings not named', ' The scripts connect directly or through the Windows proxy settings (Internet Options); they do not read HTTPS_PROXY.', ''),
  @($M, 'slow_down ignored', '$interval += 5', '$interval += 0'),
  @($M, 'authorization_pending ends the sign-in', 'if ($code -eq ''authorization_pending'') { continue }', ''),
  @($M, 'device answer without expires_in accepted', 'if (-not (Test-PositiveNumber $lifetime)) { throw', 'if ($false) { throw'),
  @($M, 'token answer not validated', 'if (Test-GatewayTokenAnswer $r.Json) { return $r.Json }', 'return $r.Json'),
  @($M, 'a refresh answer without refresh_token drops the saved one', 'if (-not $refresh) { $refresh = Get-JsonValue $Previous ''refreshToken'' }', ''),
  @($M, 'expiry ignores expires_in', '+ [int64][Math]::Floor([double](Get-JsonValue $TokenResponse ''expires_in''))', '+ 3600'),
  @($M, 'session protected for the machine', '::Protect($bytes, (Get-GatewayEntropy -Origin $Origin), [Security.Cryptography.DataProtectionScope]::CurrentUser)', '::Protect($bytes, (Get-GatewayEntropy -Origin $Origin), [Security.Cryptography.DataProtectionScope]::LocalMachine)'),
  @($M, 'session stored in the clear', '$blob = [Security.Cryptography.ProtectedData]::Protect($bytes, (Get-GatewayEntropy -Origin $Origin), [Security.Cryptography.DataProtectionScope]::CurrentUser)', '$blob = $bytes'),
  @($M, 'entropy changed', '"claude-apps-gateway/v1 $Origin"', '"claude-apps-gateway $Origin"'),
  @($M, 'replace not retried', 'if ([DateTime]::UtcNow -ge $deadline) { Remove-Item -LiteralPath $temp', 'if ($true) { Remove-Item -LiteralPath $temp'),
  @($M, 'lock shared', '[IO.FileShare]::None)', '[IO.FileShare]::ReadWrite)'),
  @($M, 'lock timeout variable ignored', 'if ([int]::TryParse([string]$env:CLAUDE_GATEWAY_LOCK_TIMEOUT_SECONDS, [ref]$configured) -and $configured -gt 0) { $TimeoutSeconds = $configured }', ''),
  @($C, 'named account saved without confirmation', 'if ($email -and -not $Force) {', 'if ($false) {'),
  @($C, 'verification URL origin not checked', 'Assert-GatewayOrigin -Url $verification -Origin $origin -Name ''verification URL''', ''),
  @($C, 'verification URL not shown', '[Console]::Out.WriteLine("To sign in, open $verification and confirm the code $(Get-JsonValue $device.Json ''user_code'').")', ''),
  @($C, 'verification URL not opened', 'try { Start-Process -FilePath $verification }', 'try { }'),
  @($C, 'save not under the lock', '    $lock = Enter-GatewayLock -Origin $origin{NL}    try {{NL}        Save-GatewaySession', '    $lock = New-Object IO.MemoryStream{NL}    try {{NL}        Save-GatewaySession'),
  @($C, 'failure without the command to start again', 'if ($retry) { $message = "$message $retry" }', ''),
  @($D, 'no revocation', '                if ($revocation) {', '                if ($false) {'),
  @($D, 'session kept after sign-out', '        Remove-GatewaySession -Origin $origin{NL}    } finally {', '    } finally {'),
  @($G, 'refresh threshold lowered', '$refreshBelowSeconds = 300', '$refreshBelowSeconds = 200'),
  @($G, 'expired token served after a failed refresh', '                if ($left -gt $servableAboveSeconds) {', '                if ($true) {'),
  @($G, 'invalid_grant keeps the session', '-eq ''invalid_grant'') {{NL}                Remove-GatewaySession -Origin $origin', '-eq ''invalid_grant'') {'),
  @($G, 'session not read again under the lock', 'if ($null -ne $lock) { try { $session = Read-GatewaySession -Origin $origin } catch { $recovery = $signIn; throw } }', ''),
  @($G, 'held lock ends the run', '            if ($left -le $servableAboveSeconds) {{NL}                $recovery = ''Wait for', '            if ($true) {{NL}                $recovery = ''Wait for'),
  # Council rounds 4 and 5 (UX, Architect): only a failure a new sign-in fixes names it; the others say what does.
  @($G, 'a held lock advises a new sign-in', '                $recovery = ''Wait for the other Claude Code or helper process to finish, or close it, then run the command again.''', '                $recovery = $signIn'),
  @($G, 'a refresh the gateway did not answer advises a new sign-in', '                } elseif ($null -eq $answer) {{NL}                    throw "The refresh failed', '                } elseif ($null -eq $answer) {{NL}                    $recovery = $signIn; throw "The refresh failed'),
  @($G, 'a refresh the gateway answered badly is told to wait for an answer', '                } elseif ($null -eq $answer) {', '                } elseif ($true) {'),
  @($G, 'a 200 without a usable token reported as a bare status', "                if (`$null -ne `$answer -and `$answer.Status -eq 200) { `$status = 'HTTP 200 without an access token and a valid expires_in' }{NL}", ''),
  @($G, 'a save failure advises a new sign-in', '    try { $session = Read-GatewaySession -Origin $origin } catch { $recovery = $signIn; throw }', '    $recovery = $signIn{NL}    try { $session = Read-GatewaySession -Origin $origin } catch { $recovery = $signIn; throw }'),
  @($G, 'an unreadable session without the sign-in command', '    try { $session = Read-GatewaySession -Origin $origin } catch { $recovery = $signIn; throw }', '    $session = Read-GatewaySession -Origin $origin'),
  @($G, 'no session without the sign-in command', 'if ($null -eq $session) { $recovery = $signIn; throw "No saved session', 'if ($null -eq $session) { throw "No saved session'),
  @($G, 'invalid_grant without the sign-in command', '                Remove-GatewaySession -Origin $origin{NL}                $recovery = $signIn{NL}                throw "The gateway refused', '                Remove-GatewaySession -Origin $origin{NL}                throw "The gateway refused'),
  @($G, 'an expired session without a refresh token lacks the sign-in command', '                Remove-GatewaySession -Origin $origin{NL}                $recovery = $signIn{NL}                throw "The session for', '                Remove-GatewaySession -Origin $origin{NL}                throw "The session for'),
  @($G, 'a refusal other than invalid_grant without the sign-in command', '                    $recovery = $signIn{NL}                    throw "The gateway refused the refresh token ($status) and', '                    throw "The gateway refused the refresh token ($status) and'),
  @($G, 'a 4xx refusal sent to the operator', '                } elseif ($refused) {', '                } elseif ($false) {'),
  @($G, 'a 429 treated as a refusal', '$answer.Status -lt 500 -and $answer.Status -ne 429{NL}', '$answer.Status -lt 500{NL}'),
  @($G, 'invalid_grant accepted with any status', '} elseif ($refused -and (Get-JsonValue $answer.Json ''error'') -eq ''invalid_grant'') {', '} elseif ($null -ne $answer -and (Get-JsonValue $answer.Json ''error'') -eq ''invalid_grant'') {'),
  @($G, 'refresh answer not validated', '$answer.Status -eq 200 -and (Test-GatewayTokenAnswer $answer.Json)', '$answer.Status -eq 200'),
  @($G, 'expired session without refresh token kept', '{NL}                Remove-GatewaySession -Origin $origin{NL}                $recovery = $signIn{NL}                throw "The session for $origin has expired', '{NL}                $recovery = $signIn{NL}                throw "The session for $origin has expired'),
  @($G, 'diagnostics on stdout', '{ [Console]::Error.WriteLine("Get-ClaudeGatewayToken: $Message") }', '{ [Console]::Out.WriteLine("Get-ClaudeGatewayToken: $Message") }'),
  @($G, 'token followed by a line break', '[Console]::Out.Write($token)', '[Console]::Out.WriteLine($token)'),
  @($I, 'apiKeyHelper runs a bare powershell.exe', '"`"$powershell`" -NoProfile', '"powershell.exe -NoProfile'),
  @($I, 'launcher runs a bare claude.exe', '$run = "`"$path`" $pinned %*"', '$run = "claude $pinned %*"'),
  @($I, 'launcher runs a bare claude.cmd', '{ $run = "call `"$path`" $pinned %*" }', '{ $run = "claude $pinned %*" }'),
  @($I, 'npm claude.cmd run without call', 'if ($Claude.EndsWith(''.cmd'', [StringComparison]::OrdinalIgnoreCase)) { $run = "call `"$path`" $pinned %*" }', ''),
  @($I, 'native claude.exe behind the shim ignored', 'if (Test-Path -LiteralPath $native -PathType Leaf) { return $native }', ''),
  @($I, 'launcher path not relative to a variable', 'if ($Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $Path = "%$name%\" + $Path.Substring($prefix.Length); break }', ''),
  @($I, 'launcher keeps ANTHROPIC_ variables', 'set ANTHROPIC_ 2^>nul', 'set ANTHROPIC_NOTHING 2^>nul'),
  @($I, 'launcher keeps CLAUDE_CODE_USE_ variables', 'set CLAUDE_CODE_USE_ 2^>nul', 'set CLAUDE_CODE_USE_NOTHING 2^>nul'),
  @($I, 'launcher does not set CLAUDE_CONFIG_DIR', 'do set "CLAUDE_CONFIG_DIR=%%~fd"', 'do set "CLAUDE_CONFIG_UNUSED=%%~fd"'),
  @($I, 'printed PowerShell command without the call operator', '[Console]::Out.WriteLine("  & `"$launcher`"")', '[Console]::Out.WriteLine("  `"$launcher`"")'),
  @($I, 'default Claude Code directory accepted', 'if ($ProfileDir -eq $defaultConfig) {', 'if ($false) {'),
  @($I, 'relative profile directory from the process directory', '[IO.Path]::GetFullPath($PSCmdlet.GetUnresolvedProviderPathFromPSPath($ProfileDir))', '[IO.Path]::GetFullPath($ProfileDir)'),
  @($I, 'short profile path compared as given', '$ProfileDir = [IO.Path]::GetFullPath($PSCmdlet.GetUnresolvedProviderPathFromPSPath($ProfileDir)).TrimEnd(''\'')', '$ProfileDir = $PSCmdlet.GetUnresolvedProviderPathFromPSPath($ProfileDir).TrimEnd(''\'')'),
  @($I, 'another gateway replaces the profile silently', 'if ($previous -and $previous -ne $origin -and -not $ReplaceGateway) {', 'if ($false) {'),
  @($I, 'cmd-unsafe paths accepted', 'if ($Path.Contains(''%'') -or $Path.Contains(''"'')) {', 'if ($false) {'),
  @($I, 'runtime not versioned', '        $version = -join (', '        $version = ''current''; $unused = -join ('),
  @($I, 'shell credentials not emptied', 'foreach ($name in @(''ANTHROPIC_AUTH_TOKEN'', ''ANTHROPIC_API_KEY'') + $providerSwitches)', 'foreach ($name in $providerSwitches)'),
  @($I, 'fast mode check left on', '$pinnedEnv[''CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK''] = ''1''', ''),
  @($M, 'token answers parsed with ConvertFrom-Json', 'Json = (ConvertFrom-GatewayJson -Holder @{ Text = $text })', 'Json = ($text | ConvertFrom-Json)'),
  @($M, 'form pairs built with New-Object', '$pairs.Add([System.Collections.Generic.KeyValuePair[string, string]]::new($key, [string]$Form[$key]))', '$pairs.Add((New-Object ''System.Collections.Generic.KeyValuePair[string,string]'' -ArgumentList $key, ([string]$Form[$key])))'),
  @($M, 'session read with ConvertFrom-Json', '$session = ConvertFrom-GatewayJson -Holder @{ Text = [Text.Encoding]::UTF8.GetString($bytes) }', '$session = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json'),
  @($G, 'token printed for another base URL', 'if ($target -ne $allowed) {', 'if ($false) {'),
  @($G, 'expected base URL ignored', 'if ($ExpectedBaseUrl) { $allowed = ConvertTo-GatewayOrigin -Url $ExpectedBaseUrl }', ''),
  @($C, 'raw verification URL opened', '    $verification = ([Uri]$verification).AbsoluteUri', ''),
  @($I, 'helper TTL not set', '$pinnedEnv[''CLAUDE_CODE_API_KEY_HELPER_TTL_MS''] = ''240000''', ''),
  @($I, 'provider switches not emptied', '@(''ANTHROPIC_AUTH_TOKEN'', ''ANTHROPIC_API_KEY'') + $providerSwitches)', '@(''ANTHROPIC_AUTH_TOKEN'', ''ANTHROPIC_API_KEY''))'),
  @($I, 'existing settings replaced', '$settings = ConvertFrom-GatewayJson -Holder $holder', '$settings = [Collections.Generic.Dictionary[string, object]]::new()'),
  @($I, 'settings written with a byte order mark', '$utf8 = New-Object Text.UTF8Encoding -ArgumentList $false', '$utf8 = New-Object Text.UTF8Encoding -ArgumentList $true'),
  @($I, 'fast model ignored', 'if ($FastModel) { $envBlock[''ANTHROPIC_DEFAULT_HAIKU_MODEL''] = $FastModel }', ''),
  @($I, 'runtime not copied', 'foreach ($file in $runtime) { Copy-Item', 'foreach ($file in @()) { Copy-Item'),
  @($I, 'launcher without the pinned settings', '$pinned = ''--settings "%CLAUDE_CONFIG_DIR%\gateway.settings.json"''', '$pinned = '''''),
  @($I, 'pinned settings after the arguments', '$run = "`"$path`" $pinned %*"', '$run = "`"$path`" %* $pinned"'),
  @($I, 'pinned settings file not written', '[IO.File]::WriteAllText((Join-Path $ProfileDir ''gateway.settings.json''), (ConvertTo-GatewayJson -Value $pinned -Indented), $utf8)', ''),
  @($I, 'pinned settings without env', '$pinned = [ordered]@{ apiKeyHelper = $apiKeyHelper; env = $pinnedEnv }', '$pinned = [ordered]@{ apiKeyHelper = $apiKeyHelper }'),
  @($I, 'launcher starts without the pinned settings file', '''if not exist "%CLAUDE_CONFIG_DIR%\gateway.settings.json" goto nosettings''', '''rem no check'''),
  @($I, 'two provider switches not emptied', ', ''CLAUDE_CODE_USE_ANTHROPIC_AWS'', ''CLAUDE_CODE_USE_MANTLE'')', ')'),
  @($I, 'settings text passed to a logged cmdlet', '$envBlock = Get-JsonValue $settings ''env''', 'Write-Verbose (ConvertTo-GatewayJson -Value $settings); $envBlock = Get-JsonValue $settings ''env'''),
  @($I, 'settings that are not a JSON object accepted', 'if ($null -eq $settings) { throw "$settingsPath does not hold a JSON object.', 'if ($false) { throw "$settingsPath does not hold a JSON object.'),
  @($I, 'env that is not a JSON object accepted', 'if ($envBlock -isnot [Collections.IDictionary]) { throw', 'if ($false) { throw'),
  @($M, 'settings written on one line', 'if ($Indented) { return ConvertTo-Json -InputObject $Value -Depth 100 }', ''),
  @($M, 'PowerShell 7 nested objects not converted', 'if ($token -is [Newtonsoft.Json.Linq.JObject]) {', 'if ($false) {'),
  @($M, 'PowerShell 7 parses date-like strings', '$reader.DateParseHandling = [Newtonsoft.Json.DateParseHandling]::None', ''),
  @($G, 'unset base URL passes', 'if (-not $env:ANTHROPIC_BASE_URL) {', 'if ($false) {'),
  @($G, 'provider switch ignored', 'if ([Environment]::GetEnvironmentVariable($switch)) {', 'if ($false) {'),
  @($G, 'Mantle switch not checked', ', ''CLAUDE_CODE_USE_MANTLE'')) {', ')) {')
)
# Runs the suite against a scripts directory; returns the exit code and the TAP totals.
$invokeSuite = {
  param([string]$Node, [string]$Repo, [string[]]$Suite, [string]$ScriptsDir)
  $psi = [Diagnostics.ProcessStartInfo]::new($Node)
  foreach ($a in @('--test', '--test-force-exit', '--test-timeout=150000', '--test-reporter=tap') + $Suite) { $psi.ArgumentList.Add($a) }
  $psi.WorkingDirectory = $Repo
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.Environment['DEVELOPER_SCRIPTS_DIR'] = $ScriptsDir
  $p = [Diagnostics.Process]::Start($psi)
  $stderr = $p.StandardError.ReadToEndAsync()
  $out = $p.StandardOutput.ReadToEnd()
  $p.WaitForExit()
  [void]$stderr.Result
  $count = { param($name) $m = [regex]::Match($out, "(?m)^# $name (\d+)\s*$"); if ($m.Success) { [int]$m.Groups[1].Value } else { -1 } }
  $failed = @([regex]::Matches($out, '(?m)^\s*not ok \d+ - (.+?)\s*$') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
  # Every reported test, so a run that reports fewer than the baseline can name the ones it lost.
  $names = @([regex]::Matches($out, '(?m)^\s*(?:not )?ok \d+ - (.+?)\s*(?:# .*)?$') | ForEach-Object { $_.Groups[1].Value })
  [pscustomobject]@{ Exit = $p.ExitCode; Tests = & $count 'tests'; Pass = & $count 'pass'; Fail = & $count 'fail'; Cancelled = & $count 'cancelled'; Skipped = & $count 'skipped'; Failed = $failed; Names = $names }
}
# ForEach-Object -Parallel does not take a script block through $using:, so the runner travels as text.
$suiteText = $invokeSuite.ToString()

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
  [pscustomobject]@{ Index = $i; File = $mutations[$i][0]; Name = $mutations[$i][1]; Find = $mutations[$i][2].Replace('{NL}', "`n"); Replace = $mutations[$i][3].Replace('{NL}', "`n") }
})
if ($List) {
  $indexed | ForEach-Object { Write-Output "$($_.Index) $($_.File): $($_.Name)" }
  exit 0
}

if ($DryRun) {
  $stale = @(foreach ($m in $mutations) {
    $text = [IO.File]::ReadAllText((Join-Path $source $m[0])).Replace("`r`n", "`n")
    $find = $m[2].Replace('{NL}', "`n")
    $at = $text.IndexOf($find, [StringComparison]::Ordinal)
    if ($at -lt 0 -or $text.IndexOf($find, $at + 1, [StringComparison]::Ordinal) -ge 0) { "$($m[0]): $($m[1])" }
  })
  $stale | ForEach-Object { Write-Host "NOT APPLIED: $_" }
  Write-Host "$($mutations.Count - $stale.Count) of $($mutations.Count) mutations apply exactly once"
  exit [int][bool]$stale.Count
}
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $baseDir = Join-Path $work 'baseline'
  Copy-Item -LiteralPath $source -Destination $baseDir -Recurse
  $baseline = & $invokeSuite $node $Repo $suite $baseDir
  if ($baseline.Exit -ne 0 -or $baseline.Tests -lt 1 -or $baseline.Pass -ne $baseline.Tests -or $baseline.Skipped -ne 0) {
    throw "The unmutated suite must pass with nothing skipped: exit $($baseline.Exit), $($baseline.Tests) tests, $($baseline.Fail) failed, $($baseline.Skipped) skipped."
  }
  Write-Host "baseline: $($baseline.Tests) tests pass"
  if ($Shard) { Write-Host "shard $Shard`: $($indexed.Count) of $($mutations.Count) mutations" }

  $results = $indexed | ForEach-Object -ThrottleLimit $Parallel -Parallel {
    $m = $_
    $dir = Join-Path $using:work "m$($m.Index)"
    Copy-Item -LiteralPath $using:source -Destination $dir -Recurse
    $file = Join-Path $dir $m.File
    $text = [IO.File]::ReadAllText($file)
    $at = $text.IndexOf($m.Find, [StringComparison]::Ordinal)
    $result = if ($at -lt 0 -or $text.IndexOf($m.Find, $at + 1, [StringComparison]::Ordinal) -ge 0) { 'NOT APPLIED (text must occur exactly once)' } else {
      $mutated = $text.Substring(0, $at) + $m.Replace + $text.Substring($at + $m.Find.Length)
      [IO.File]::WriteAllText($file, $mutated, [Text.UTF8Encoding]::new($false))
      $errors = $null
      [void][Management.Automation.Language.Parser]::ParseInput($mutated, [ref]$null, [ref]$errors)
      if ($errors.Count) { 'BROKEN (does not parse)' } else {
        $run = & ([scriptblock]::Create($using:suiteText)) $using:node $using:Repo $using:suite $dir
        if ($run.Tests -ne ($using:baseline).Tests) {
          $lost = @(($using:baseline).Names | Where-Object { $run.Names -notcontains $_ } | Select-Object -First 3 | ForEach-Object { $_.Substring(0, [Math]::Min(60, $_.Length)) })
          "BROKEN ($($run.Tests) of $(($using:baseline).Tests) tests ran, $($run.Fail) failed, $($run.Cancelled) cancelled; not reported: $($lost -join '; '))"
        } elseif ($run.Pass -lt $run.Tests) { "caught ($($run.Fail) failed, $($run.Cancelled) cancelled): " + (($run.Failed | Select-Object -First 2 | ForEach-Object { $_.Substring(0, [Math]::Min(70, $_.Length)) }) -join '; ') } else { 'SURVIVED' }
      }
    }
    [pscustomobject]@{ target = $m.File; mutation = $m.Name; result = $result }
  }
  $results | Sort-Object target, mutation | Format-Table -AutoSize | Out-String -Width 360 | Write-Host
  $bad = @($results | Where-Object { $_.result -notlike 'caught*' })
  Write-Host "$($results.Count - $bad.Count) of $($results.Count) mutations caught"
  if ($bad.Count) { exit 1 }
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
