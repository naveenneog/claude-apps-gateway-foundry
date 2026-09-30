param([string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path, [string]$Only = '')
# Mutation check for the deployment files and their tests (ADR-0003). Each mutation breaks one security
# or topology property the tests claim to guard. A mutation counts as caught only when every test in
# its suite still loads and at least one fails. Files are restored byte-for-byte after each run. Suites run
# with --test-force-exit and a 120-second test timeout, so a mutation that leaves a server open or a test
# waiting forever fails its suite instead of stopping the run.
# Run: pwsh -File tests/mutate-deploy.ps1 [-Only <regex over mutation names>]
# Exit 1 when an unmutated suite fails, or when any mutation survives, does not apply, or stops its
# suite from loading.
$ErrorActionPreference = 'Stop'
Set-Location $Repo

$suites = @{
  fast   = @('tests/deploy-artifacts.test.mjs', 'tests/deploy-orchestration.test.mjs', 'tests/deploy-plan.test.mjs', 'tests/deploy-spawn.test.mjs', 'tests/live-lib.test.mjs')
  verify = @('tests/verify-release.test.mjs')
  inference = @('tests/inference-lib.test.mjs', 'tests/inference-runner.test.mjs')
  private = @('tests/azure-private.test.mjs')
}
function Invoke-Suite([string]$Suite) {
  # --no-wasm-dynamic-tiering: a review of 95968fd saw Node 26.1 on Windows abort with "Assertion failed: !(handle->flags &
  # UV_HANDLE_CLOSING)" when --test-force-exit ended a test file just after an in-process fetch, in 4 of 4 runs of a
  # copy; the flag stopped it there. It did not reproduce on this machine in 6 runs, with or without the flag.
  $out = node --no-wasm-dynamic-tiering --test --test-force-exit --test-timeout=120000 --test-reporter=tap @($suites[$Suite]) 2>&1 | Out-String
  $count = { param($name) $m = [regex]::Match($out, "(?m)^# $name (\d+)\s*$"); if ($m.Success) { [int]$m.Groups[1].Value } else { -1 } }
  [pscustomobject]@{ Exit = $LASTEXITCODE; Tests = & $count 'tests'; Fail = & $count 'fail'; Skipped = & $count 'skipped' }
}

$baseline = @{}
foreach ($s in $suites.Keys) {
  $b = Invoke-Suite $s
  if ($b.Exit -ne 0 -or $b.Tests -lt 1 -or $b.Fail -ne 0 -or $b.Skipped -ne 0) {
    throw "The unmutated '$s' suite must pass with nothing skipped: exit $($b.Exit), $($b.Tests) tests, $($b.Fail) failed, $($b.Skipped) skipped."
  }
  $baseline[$s] = $b
}

function Test-Mutation([string]$File, [string]$Name, [scriptblock]$Mutate) {
  $suite = if ($File -like '*verify-release.sh') { 'verify' } elseif ($File -like 'tests/live/inference-*') { 'inference' } elseif ($File -like 'infra/azure-private/*') { 'private' } else { 'fast' }
  $full = Join-Path $Repo $File
  $bytes = [IO.File]::ReadAllBytes($full)
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  $mutated = & $Mutate $text
  if ($mutated -ceq $text) { return [pscustomobject]@{ target = $File; mutation = $Name; result = 'NOT APPLIED (the text must occur exactly once)' } }
  try {
    [IO.File]::WriteAllText($full, $mutated, [Text.UTF8Encoding]::new($false))
    $run = Invoke-Suite $suite
    $result = if ($run.Tests -ne $baseline[$suite].Tests) { "BROKEN ($($run.Tests) of $($baseline[$suite].Tests) tests ran)" }
              elseif ($run.Fail -ge 1) { 'caught' }
              else { 'SURVIVED' }
    [pscustomobject]@{ target = $File; mutation = $Name; result = $result }
  } finally {
    [IO.File]::WriteAllBytes($full, $bytes)
  }
}

$T = 'infra/azure-test/gateway-test.json'
$C = 'config/gateway.azure-test.yaml'
$M = 'infra/azure-test/entra-app.json'
$D = 'infra/azure-test/image/Dockerfile'
$E = 'infra/azure-test/image/gateway-entrypoint.sh'
$V = 'infra/azure-test/image/verify-release.sh'
$P = 'infra/azure-test/lib/plan.mjs'
$L = 'tests/live/lib.mjs'
$D2 = 'infra/azure-test/deploy.mjs'
$IR = 'tests/live/inference-runner.mjs'
$IC = 'tests/live/inference-checks.mjs'
$IL = 'tests/live/inference-lib.mjs'
$IS = 'tests/live/inference-suite.mjs'
$IH = 'tests/live/inference-http.mjs'
$AZ = 'infra/azure-private/lib/Az.psm1'; $SB = 'infra/azure-private/lib/Steps.Base.psm1'; $SA = 'infra/azure-private/lib/Steps.App.psm1'
$SD = 'infra/azure-private/lib/Steps.Dev.psm1'; $AD = 'infra/azure-private/lib/AppDefinition.psm1'; $DG = 'infra/azure-private/Deploy-Gateway.ps1'
# Literal replacements. Each entry is (file, name, exact text, replacement).
$lit = @(
  @($T, 'second replica', '"scale": { "minReplicas": 1, "maxReplicas": 1 }', '"scale": { "minReplicas": 1, "maxReplicas": 2 }'),
  @($T, 'plain HTTP allowed', '"allowInsecure": false,', '"allowInsecure": true,'),
  @($T, 'ingress open to all', '"ipAddressRange": "[parameters(''testerCidr'')]"', '"ipAddressRange": "0.0.0.0/0"'),
  @($T, 'tester range defaults open', '"testerCidr": { "type": "string", "metadata":', '"testerCidr": { "type": "string", "defaultValue": "0.0.0.0/0", "metadata":'),
  @($T, 'literal signing secret', '{ "name": "jwt-secret", "value": "[parameters(''gatewayJwtSecret'')]" }', '{ "name": "jwt-secret", "value": "hardcoded-signing-secret" }'),
  @($T, 'signing secret not secure', '"gatewayJwtSecret": { "type": "securestring", "defaultValue": "" }', '"gatewayJwtSecret": { "type": "string", "defaultValue": "" }'),
  @($T, 'Owner instead of Cognitive Services User', "'Microsoft.Authorization/roleDefinitions', 'a97b65f3-24c7-4388-baec-2e87135dc908')]", "'Microsoft.Authorization/roleDefinitions', '8e3af657-a8ff-443c-a75c-2fe8c4bcb635')]"),
  @($T, 'AcrPull assignment typed as a user', ('.principalId]",' + "`n" + '        "principalType": "ServicePrincipal"'), ('.principalId]",' + "`n" + '        "principalType": "User"')),
  @($T, 'Cognitive Services User assignment typed as a user', ('(''principalId'')]",' + "`n" + '                "principalType": "ServicePrincipal"'), ('(''principalId'')]",' + "`n" + '                "principalType": "User"')),
  @($T, 'registry admin user on', '"adminUserEnabled": false,', '"adminUserEnabled": true,'),
  @($T, 'PostgreSQL on every interface', '"listen_addresses=127.0.0.1"', '"listen_addresses=*"'),
  @($T, 'PGDATA off the volume', '"/var/lib/postgresql/data/pgdata"', '"/tmp/pgdata"'),
  @($T, 'config mounted into PostgreSQL', '"volumeMounts": [{ "volumeName": "pgdata", "mountPath": "/var/lib/postgresql/data" }]', '"volumeMounts": [{ "volumeName": "pgdata", "mountPath": "/var/lib/postgresql/data" }, { "volumeName": "gateway-config", "mountPath": "/etc/claude" }]'),
  @($T, '90-day log retention', '"retentionInDays": 30,', '"retentionInDays": 90,'),
  @($T, 'client secret as a plain value', '{ "name": "OIDC_CLIENT_SECRET", "secretRef": "oidc-client-secret" }', '{ "name": "OIDC_CLIENT_SECRET", "value": "[parameters(''oidcClientSecret'')]" }'),
  @($T, 'readiness on liveness path', '{ "type": "Readiness", "httpGet": { "path": "/readyz"', '{ "type": "Readiness", "httpGet": { "path": "/healthz"'),
  @($T, 'gateway calls another account', '{ "name": "FOUNDRY_RESOURCE", "value": "[parameters(''foundryAccountName'')]" }', '{ "name": "FOUNDRY_RESOURCE", "value": "ai-other-account" }'),
  @($C, 'literal client secret', 'client_secret: "${OIDC_CLIENT_SECRET}"', 'client_secret: "Xy7sQ~abcdefghijklmnopqrstuvwxyz0123456789"'),
  @($C, 'public trusted proxy', 'trusted_proxies: [10.0.0.0/8, 100.64.0.0/10, 172.16.0.0/12, 192.168.0.0/16]', 'trusted_proxies: [10.0.0.0/8, 100.64.0.0/10, 172.16.0.0/12, 192.168.0.0/16, 0.0.0.0/0]'),
  @($C, 'gateway allow list open', 'allow_cidrs: ["${TESTER_CIDR}"]', 'allow_cidrs: ["0.0.0.0/0"]'),
  @($C, 'groups claim instead of roles', 'groups_claim: roles', 'groups_claim: groups'),
  @($C, 'built-in models on', 'auto_include_builtin_models: false', 'auto_include_builtin_models: true'),
  @($C, 'undefined variable', 'public_url: "${GATEWAY_PUBLIC_URL}"', 'public_url: "${GATEWAY_URL_TYPO}"'),
  @($C, 'API key upstream', 'auth: { use_azure_ad: true }', 'auth: { api_key: "${FOUNDRY_API_KEY}" }'),
  @($C, 'third model', "    upstream_model: { foundry: claude-sonnet-5 }`n", "    upstream_model: { foundry: claude-sonnet-5 }`n  - id: claude-haiku-4-5`n    label: Claude Haiku 4.5`n    upstream_model: { foundry: claude-haiku-4-5 }`n"),
  @($M, 'multi-tenant app', '"signInAudience": "AzureADMyOrg",', '"signInAudience": "AzureADMultipleOrgs",'),
  @($M, 'implicit ID tokens on', '"enableIdTokenIssuance": false,', '"enableIdTokenIssuance": true,'),
  @($M, 'Directory.Read.All requested', '{ "id": "7427e0e9-2fba-42fe-b0c0-848c9e6a8182", "type": "Scope" }', '{ "id": "06da0dbc-49e2-44d2-8312-53f166ab848a", "type": "Scope" }'),
  @($M, 'role value drifts from config', '"value": "Gateway.Premium",', '"value": "Gateway.Admin",'),
  @($D, 'runs as root', 'USER 10001:10001', 'USER 0:0'),
  @($D, 'verification skipped', '    bash /usr/local/bin/verify-release.sh /release "${CLAUDE_VERSION}" linux-x64 "${CLAUDE_SHA256}" "${CLAUDE_KEY_FINGERPRINT}"; \', '    true; \'),
  @($D, 'base image unpinned', 'ARG BASE_IMAGE=mcr.microsoft.com/azurelinux/base/core:3.0@sha256:34a22db497ff34a0f35ca5fc54bd38711d04238a2c1b2f65d35dc9d45dd82584', 'ARG BASE_IMAGE=mcr.microsoft.com/azurelinux/base/core:3.0'),
  @($D, 'key fetched over HTTP', '-o key.asc https://downloads.claude.ai/keys/claude-code.asc', '-o key.asc http://downloads.claude.ai/keys/claude-code.asc'),
  @($D, 'version bumped without its checksum', 'ARG CLAUDE_VERSION=2.1.280', 'ARG CLAUDE_VERSION=2.1.281'),
  @($E, 'unbounded store wait', 'for _ in {1..60}; do', 'for _ in {1..600}; do'),
  @($E, 'entrypoint reads another config', 'exec /usr/local/bin/claude gateway --config /etc/claude/gateway.yaml', 'exec /usr/local/bin/claude gateway --config /etc/gateway.yaml'),
  @($P, 'tester range may be /0', 'export function assertTesterCidr(text, { minPrefix = 24 } = {}) {', 'export function assertTesterCidr(text, { minPrefix = 0 } = {}) {'),
  @($P, 'private ranges accepted', 'if (isPrivateOrReserved(formatIpv4(network))) {', 'if (false) {'),
  @($P, 'secret lifetime past tenant limit', 'if (!Number.isInteger(days) || days < 1 || days > 30)', 'if (!Number.isInteger(days) || days < 1 || days > 365)'),
  @($P, 'redaction off', "if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('[redacted]');", "if (false) out = out.split(secret).join('[redacted]');"),
  @('infra/azure-test/lib/secrets.mjs', 'secrets allowed on command lines', 'if (String(arg).includes(secret)) throw new Error(', 'if (false) throw new Error('),
  @('infra/azure-test/lib/spawn.mjs', 'relative PATH entries searched', ".filter((entry) => entry !== '' && path.isAbsolute(entry));", ".filter((entry) => entry !== '');"),
  @($V, 'signer fingerprint not checked', 'grep -Eq "^\[GNUPG:\] VALIDSIG [0-9A-F]{40} .* ${fingerprint}\$" "$GNUPGHOME/status" ||', 'true ||'),
  @($V, 'binary checksum not checked', '[ "$actual" = "$pinned" ] || fail "binary checksum $actual is not the pinned value"', 'true || fail "binary checksum $actual is not the pinned value"'),
  @($V, 'pin not compared with the manifest', '[ "${BASH_REMATCH[1]}" = "$pinned" ] || fail "manifest checksum for $platform is not the pinned value"', 'true || fail "manifest checksum for $platform is not the pinned value"'),
  @($T, 'rotation no longer rolls a revision', '{ "name": "OIDC_CREDENTIAL_ID", "value": "[parameters(''oidcCredentialId'')]" }', '{ "name": "OIDC_CREDENTIAL_ID", "value": "fixed" }'),
  @($P, 'probe address outside a /32', 'return formatIpv4(size > 2 ? start + 1 : start);', 'return formatIpv4(start + 1);'),
  @('tests/live/lib.mjs', 'role removed without a recorded assignment', "  if (!recorded) return { removed: false };`n", ''),
  @('tests/live/lib.mjs', 'runtime timestamp not stripped', "tryJson(text.replace(RUNTIME_STAMP, ''))", 'tryJson(text)'),
  @('tests/live/lib.mjs', 'intent alone restores access', "  if (pending.phase !== 'removed') return { restored: false, ambiguous: true };`n", ''),
  @($P, 'installed key removable', '  const keep = new Set([installed?.keyId, readyKeyId].filter(Boolean));', '  const keep = new Set([readyKeyId].filter(Boolean));'),
  @($P, 'serving key removable', '  const keep = new Set([installed?.keyId, readyKeyId].filter(Boolean));', '  const keep = new Set([installed?.keyId].filter(Boolean));'),
  @($P, 'installed secret trusted without its hint', '(!match || match.hint !== installed.hint)', '(!match)'),
  @($P, 'foreign secrets removable', 'c.displayName === ownName && !keep.has(c.keyId)', '!keep.has(c.keyId)'),
  @($P, 'foreign secrets superseded', '.filter((c) => c.displayName === ownName && c.keyId !== keyId)', '.filter((c) => c.keyId !== keyId)'),
  @($P, 'promotion ignores the serving key', 'after.readyRevision === revision && after.readyKeyId === keyId && after.installedKeyId === keyId', 'after.readyRevision === revision && after.installedKeyId === keyId'),
  @($P, 'only the latest Foundry account kept', 'return targets.some(same) ? [...targets] : [...targets, target];', 'return [target];'),
  @($P, 'legacy Foundry account dropped', ', ...(state.foundry ? [state.foundry] : [])]', ']'),
  @($P, 'recorded grant not checked', '  if (granted) ids.push(granted);', ''),
  @($P, 'deployment without preview', "  await validate();`n  report(await whatIf());", '  await validate();'),
  @($P, 'preview only still deploys', 'return previewOnly ? null : run();', 'return run();'),
  @($L, 'transport failure counts as a refusal', "if (typeof error?.status === 'number' && error.status >= 400 && error.status < 500 && error.status !== 408) journal(ifRefused);", 'journal(ifRefused);'),
  @($L, 'refusal keeps its record', "if (typeof error?.status === 'number' && error.status >= 400 && error.status < 500 && error.status !== 408) journal(ifRefused);", ''),
  @($L, 'timeout counts as a refusal', ' && error.status !== 408) journal(ifRefused);', ') journal(ifRefused);'),
  @($L, 'server error counts as a refusal', 'error.status >= 400 && error.status < 500', 'error.status >= 400'),
  @($L, 'app role restore not journalled', "phase: 'restoring' }, ifRefused: { ...record, phase: 'removed' } },`n      () => graph('POST'", "phase: 'removed' }, ifRefused: { ...record, phase: 'removed' } },`n      () => graph('POST'"),
  @($L, 'Foundry role restore not journalled', "phase: 'restoring' }, ifRefused: { ...record, phase: 'removed' } },`n      () => arm('PUT'", "phase: 'removed' }, ifRefused: { ...record, phase: 'removed' } },`n      () => arm('PUT'"),
  @($L, 'reconcile grants without journalling', "const restoring = { before: { ...pending, phase: 'restoring' }, ifRefused: pending };", 'const restoring = { before: pending, ifRefused: pending };'),
  @($L, 'app role restored, record kept', "    journal(null);`n    onRestored(restored.json.id);", '    onRestored(restored.json.id);'),
  @($L, 'Foundry role restored, record kept', "    journal(null);`n    onRestored();", '    onRestored();'),
  @($L, 'inference status not checked', 'if (![status].flat().includes(e.status)) fail.push', 'if (false) fail.push'),
  @($L, 'upstream field optional', 'if (!upstream) block.push(`no upstream field', 'if (!upstream) void (`no upstream field'),
  @($L, 'model field optional', "if (!named) block.push('no model field');", 'if (!named) void 0;'),
  @($L, 'subjectless inference passes', "if (subject === 'unknown') block.push('no sub or email field');", "if (subject === 'unknown') void 0;"),
  @($L, 'refresh of another request counts', 'const own = refreshes.filter((e) => e.request_id === good.requestId);', 'const own = refreshes;'),
  @($L, 'refresh subject not checked', "if (subject === 'unknown') block.push('the session.refresh event names no subject');", "if (subject === 'unknown') void 0;"),
  @($L, 'refresh negative ignored', "if (badEvents.some((e) => e.evt === 'session.refresh')) fail.push", 'if (false) fail.push'),
  @($L, 'any sign-in refusal counts', 'const admission = denials.filter(isRoleAdmissionDenial);', 'const admission = denials;'),
  @($L, 'refusal not tied to this sign-in', 'const own = admission.filter((e) => inRange(e.client_ip) && e.user_code === userCode);', 'const own = admission;'),
  @($L, 'missing user code accepted', '&& e.user_code === userCode);', '&& (e.user_code === undefined || e.user_code === userCode));'),
  @($L, 'restore command without its group', "'--resource-group', group, ", ''),
  @($L, 'restore command without the Foundry scope', "'--foundry-resource-group', scope[1], '--foundry-account', scope[2], ", ''),
  @($L, 'restore command without the email domain', "...(emailDomain ? ['--email-domain', emailDomain] : []), ", ''),
  @($L, 'relay records headers', "requestId: response.headers['x-request-id'] ?? null });", "requestId: response.headers['x-request-id'] ?? null, headers: req.headers });"),
  @($L, 'relay keeps the client Host', 'headers: { ...req.headers, host: target.host },', 'headers: { ...req.headers },'),
  @($L, 'relay listens on every interface', "server.listen(0, '127.0.0.1', resolve)", 'server.listen(0, resolve)'),
  @($L, 'cut stream left open', "      pipeline(response, res, (error) => {`n        if (error) entry.error = 'response not completed';`n      });", '      response.pipe(res);'),
  @($L, 'client disconnect leaves upstream running', "        upstream.destroy();`n      }`n      settle();", "      }`n      settle();"),
  @($L, 'relay close leaves idle connections', "      agent.destroy();`n", ''),
  @($L, 'relay uses the shared agent', 'port: target.port || undefined, agent,', 'port: target.port || undefined,'),
  @($L, 'refused run reads every event', "if (own.some((e) => e.evt === 'inference')) fail.push", "if (events.some((e) => e.evt === 'inference')) fail.push"),
  @($L, 'refused run needs no 401', "if (!captured.some((x) => x.status === 401 && x.path.startsWith('/v1/'))) fail.push", 'if (false) fail.push'),
  @($L, 'refused run needs no auth.denied', "if (!own.some((e) => e.evt === 'auth.denied')) fail.push", 'if (false) fail.push'),
  @($L, 'refusal message not checked', 'if (!/\b401\b|unauthori[sz]ed|authenticat/i.test(`${stdout}\n${stderr}`)) fail.push', 'if (false) fail.push'),
  @($L, 'capture read before the relay closes', "    result = await run(relay.url);`n  } finally {`n    await relay.close();`n  }`n  return { ...result, captured: [...relay.captured] };", "    result = { ...(await run(relay.url)), captured: [...relay.captured] };`n  } finally {`n    await relay.close();`n  }`n  return result;"),
  @($L, 'relay left open when the program throws', "  } finally {`n    await relay.close();`n  }`n  return { ...result", "  } catch (error) {`n    throw error;`n  }`n  await relay.close();`n  return { ...result"),
  @($L, 'close does not wait for requests', "      await Promise.all([...unsettled]);`n", ''),
  @($L, 'relay evidence from any request', 'return { block, own: events.filter((e) => ids.has(e.request_id)) };', 'return { block, own: events };'),
  @($L, 'empty capture accepted', "if (!captured.length) block.push('the client sent no request through the relay');", "if (false) block.push('the client sent no request through the relay');"),
  @($P, 'unknown serving key ignored', '  if (readyRevision && !readyKeyId) {', '  if (false) {'),
  @($P, 'missing outputs accepted', 'if (missing.length) throw new Error(', 'if (false) throw new Error('),
  @($P, 'restore record cleared for another grant', "`n  && typeof pending.assignmentId === 'string' && pending.assignmentId.toLowerCase() === out.foundryRoleAssignmentId.toLowerCase();", ';'),
  @($D2, 'target recorded after the deployment', "      io.save(ctx);`n      say(``running deployment", "      say(``running deployment"),
  @($D2, 'app outputs ignored', '  Object.assign(ctx.state, stateFromOutputs(out));', ''),
  @($D2, 'restore record kept after a re-deploy', 'if (restoredByDeployment(ctx.state.pendingRestore, out)) {', 'if (false) {'),
  @('infra/azure-test/lib/spawn.mjs', 'program timeout not enforced', 'const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs) : null;', 'const timer = null;'),  @($L, 'callback path not checked', ' && /^\/oauth\/callback(?:[?#]|$)/.test(e.path)', ''),
  @($L, 'admission reason not checked', "`n  && typeof e.reason === 'string' && /group|role/i.test(e.reason);", ';'),
  @($L, 'outstanding record replaced', 'if (current && !same) throw new Error(', 'if (false) throw new Error('),
  @($L, 'last character altered', 'const i = Math.floor(token.length / 2);', 'const i = token.length - 1;'),
  @('infra/azure-test/teardown.mjs', 'teardown looks for another identity', "const IDENTITY = 'id-claude-gw';", "const IDENTITY = 'id-other';"),
  # The inference suite (P-20, council round 3): every gateway answer audited, the APIM route not, temporary profiles removed.
  @($IC, 'latency samples the gateway unaudited', "measure(() => ctx.send('/v1/messages', body, { token }))", "measure(() => ctx.sendExternal('/v1/messages', body, { token, url: base }))"),
  @($IC, 'agentic run not audited', "    await ctx.auditCaptured('audit', r.captured);`n    const denied", '    const denied'),
  @($IC, 'tools-disallowed run not audited', "    await ctx.auditCaptured('tools disallowed audit', denied.captured);`n", ''),
  @($IC, 'profile run not audited', "    await ctx.auditCaptured('audit', r.captured);`n    // An origin", '    // An origin'),
  @($IR, 'answers not recorded', "        sent.push({ pathname, model: body?.model, status: r.status, requestId: r.requestId, withToken: Boolean(options.token) });`n", ''),
  @($IR, 'ctx.send can leave the gateway', '{ ...options, url: undefined }', 'options'),
  @($IR, 'captured answers not audited', "        await audit(ctx, label, answers.filter((a) => a.requestId), claims);`n      },", '      },'),
  @($IR, 'missing event does not block', 'if (!events) {', 'if (false) {'),
  @($IR, 'temporary profile not registered for removal', "    ctx.cleanups.push(() => fs.rmSync(work, { recursive: true, force: true }));`n    const profile", '    const profile'),
  @($IR, 'failed clean-up swallowed', 'record.notes.push(redactSecrets(`clean-up failed: ${error.message}`));', 'void error;'),
  @($IR, 'BLOCKED exits 0', "results.some((r) => r.result === 'BLOCKED') ? 2 : 0", '0'),
  @($IL, 'closed stream: a unit price counts as the cost', 'const cost = [e.cost_usd, e.cost].find', 'const cost = [e.cost_usd, e.cost, e.price_usd].find'),
  @($IL, 'closed stream: zero cost accepted', 'if (!(cost > 0)) f.fail.push', 'if (!(cost >= 0)) f.fail.push'),
  @($IL, 'closed stream: floor not checked', 'if (output < floor) f.fail.push', 'if (false) f.fail.push'),
  # The APIM route (T-64) is reached only when --apim-url names it.
  @($IS, 'APIM URL read from Claude Code settings', "apimUrl: opts['apim-url'] === undefined ? undefined : apimBaseUrl(opts['apim-url']) }", "apimUrl: opts['apim-url'] ?? JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE ?? '', '.claude', 'settings.json'), 'utf8')).env?.ANTHROPIC_FOUNDRY_BASE_URL }"),
  @($IS, 'APIM URL taken from the environment', "apimUrl: opts['apim-url'] === undefined ? undefined : apimBaseUrl(opts['apim-url']) }", 'apimUrl: process.env.ANTHROPIC_FOUNDRY_BASE_URL }'),
  @($IC, 'APIM half runs without a URL', 'if (!apimUrl) {', 'if (false) {'),
  # Council round 4: the closed stream gets the central audit and its own floor check; sendExternal refuses the
  # gateway; every check runs offline; the suite's token handling.
  @($IR, 'closed stream not recorded, so not audited', '        sent.push({ pathname, model: body?.model, status: r.status, requestId: r.requestId, withToken: Boolean(options.token) });', '        if (!options.cut) sent.push({ pathname, model: body?.model, status: r.status, requestId: r.requestId, withToken: Boolean(options.token) });'),
  @($IR, 'ctx.sendExternal reaches the gateway', "        if (!target || target.protocol !== 'https:' || target.origin === new URL(config.base).origin) {", "        if (!target || target.protocol !== 'https:') {"),
  @($IR, 'ctx.sendExternal sends over http', "        if (!target || target.protocol !== 'https:' || target.origin === new URL(config.base).origin) {", '        if (!target || target.origin === new URL(config.base).origin) {'),
  @($IC, 'closed stream: status not checked', '    if (cut.status !== 200) {', '    if (false) {'),
  @($IC, 'closed stream: event not looked up', "    const e = (cut.requestId ? await ctx.events([cut.requestId], (x) => x.evt === 'inference') : null)?.find((x) => x.evt === 'inference');", '    const e = undefined;'),
  @($IC, 'closed stream: findings not applied', "    ctx.apply('closed stream', closedStreamFindings(e, { receivedText: received, maxTokens: CLOSED_STREAM_MAX_TOKENS }));", '    void closedStreamFindings;'),
  @($IC, 'a check refers to a removed global', "  async thinking(ctx, token) {`n    const { models } = ctx.config;", "  async thinking(ctx, token) {`n    const models = MODELS;"),
  @($IC, 'agentic: the reading tools stay allowed', "['--disallowedTools', 'Read', 'Grep', 'Glob', 'Bash']", "['--disallowedTools', 'Read']"),
  @($IL, 'closed stream: cost fallback removed', 'const cost = [e.cost_usd, e.cost].find', 'const cost = [e.cost_usd].find'),
  @($IL, 'closed stream: usage fallback removed', 'const output = [e.output_tokens, e.usage?.output_tokens].find', 'const output = [e.output_tokens].find'),
  @($IL, 'closed stream: floor itself refused', 'if (output < floor) f.fail.push', 'if (output <= floor) f.fail.push'),
  @($IL, 'closed stream: max_tokens itself refused', 'if (output > maxTokens) f.fail.push', 'if (output >= maxTokens) f.fail.push'),
  @($IH, 'redirects followed', "redirect: 'manual'", "redirect: 'follow'"),
  @($IS, 'session token not registered for redaction', 'return { token: registerSecret(r.stdout.trim()) };', 'return { token: r.stdout.trim() };'),
  @($IS, 'APIM token not registered for redaction', 'apimToken: () => registerSecret(runAz(', 'apimToken: () => (runAz('),
  @($IS, 'helper asked without the gateway base URL', 'env: { ...process.env, ANTHROPIC_BASE_URL: base }', 'env: { ...process.env }'),
  @($IR, 'tenant not compared', 'if (account.tenantId !== state.tenantId) return', 'if (false) return'),
  @($IR, 'account read without the subscription', "runAz(['account', 'show', '--subscription', state.subscriptionId, '--output', 'json']", "runAz(['account', 'show', '--output', 'json']"),
  @($IS, 'log read without the subscription', "'--subscription', state.subscriptionId, '--container'", "'--container'"),
  @($IS, 'account not checked before the checks', 'if (accountProblem) {', 'if (false) {'),
  # Council round 5: --apim-url over https only and checked first, the APIM token's tenant, latency failures fail T-64.
  @($IR, 'APIM URL accepted over http', "  if (url.protocol !== 'https:') throw new Error(``--apim-url must use https", '  if (false) throw new Error(`--apim-url must use https'),
  @($IR, 'APIM URL keeps credentials', "  if (url.username || url.password) throw new Error('--apim-url must not contain", "  if (false) throw new Error('--apim-url must not contain"),
  @($IR, 'APIM URL keeps a query or fragment', "  if (url.search || url.hash) throw new Error('--apim-url must not have a query", "  if (false) throw new Error('--apim-url must not have a query"),
  @($IR, 'a refused APIM URL is repeated', "throw new Error('--apim-url is not an absolute URL')", 'throw new Error(`--apim-url ${value} is not an absolute URL`)'),
  @($IS, 'the suite skips the APIM URL check', "apimUrl: opts['apim-url'] === undefined ? undefined : apimBaseUrl(opts['apim-url'])", "apimUrl: opts['apim-url']"),
  @($IS, 'APIM token for the Azure CLI default tenant', " '--tenant', opts['apim-tenant'] ?? state.tenantId,", ''),
  @($IC, 'latency failures only noted', '      if (summary.failures) ctx.apply(route,', '      if (false) ctx.apply(route,'),
  @($IC, 'tools: the round trip does not use the tool result', "    const second = await call(answer(use.id, 'Sunny, 31 degrees Celsius'));", "    const second = await call(answer(use.id, 'Cloudy'));"),
  @($IC, 'tools: the unknown tool_use_id is not sent', "    ctx.apply('unknown tool_use_id', invalidRequestFindings(await call(answer('toolu_unknown', 'x'))));", ''),
  # The live run of 2026-09-28: a closed stream, adaptive thinking, thinking tokens within max_tokens, placeholder keys.
  @($IH, 'closed stream: the abort is thrown', '      if (!(cut && controller.signal.aborted)) throw error;', '      throw error;'),
  @($IH, 'closed stream: the stream is not closed', "data.delta.text) {`n            controller.abort();", "data.delta.text) {`n            void controller;"),
  @($IC, 'T-56: a max_tokens stop needs text', "{ stop: 'max_tokens', requireText: false }", "{ stop: 'max_tokens' }"),
  @($IC, 'no room for thinking in text requests', 'const TEXT_MAX_TOKENS = 1024;', 'const TEXT_MAX_TOKENS = 64;'),
  @($IC, 'T-60 asks for a manual budget', "thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } }", "thinking: { type: 'enabled', budget_tokens: 1024 } }"),
  @($IC, 'T-51: any answer without a session accepted', 'const answered = reached.filter((c) => c.status !== 401);', 'const answered = [];'),
  @($IL, 'T-60: a turn without thinking fails', "  if (thinking < 0) {`n    f.block.push(", "  if (thinking < 0) {`n    f.fail.push("),
  @($IL, 'T-56: text required for every stop', 'if (requireText && !textOf(json))', 'if (!textOf(json))'),
  # Council review of the live-run fixes (QA): the cut waits for text, the sender's contract and deadline, and no
  # evaluator passes on an empty answer.
  @($IH, 'the cut comes on any delta', "if (cut && data?.delta?.type === 'text_delta' && data.delta.text) {", 'if (cut) {'),
  @($IH, 'no deadline on a request', 'AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])', 'controller.signal'),
  @($IH, 'the token sent as x-api-key', 'authorization: `Bearer ${token}`', "'x-api-key': token"),
  @($IL, 'the floor checked with no text received', '  if (!received) return { ...f, block:', '  if (false) return { ...f, block:'),
  @($IL, 'T-56 accepts an empty answer', 'else if (!requireText && !textOf(json) && !thought) f.fail.push(', 'else if (false) f.fail.push('),
  @($IL, 'T-60 accepts thinking without text', "if (!blocks.some((b, i) => i > thinking && b.type === 'text' && b.text)) f.fail.push('no text block after the thinking');", "if (false) f.fail.push('no text block after the thinking');"),
  @($IL, 'T-60 accepts an empty summary', "if (summarized && blocks.some((b) => b.type === 'thinking' && !b.thinking))", 'if (false)'),
  @($IC, 'T-60 does not check the summary', 'thinkingFindings(r.json, { summarized: true })', 'thinkingFindings(r.json)'),
  @($IC, 'T-51 accepts an answer without a session', "if (refused.status === 0) ctx.apply('no session',", "if (false) ctx.apply('no session',"),
  @($IC, 'T-51 accepts a run with no apiKeyHelper report', "if (!report) ctx.apply('no session message'", "if (false) ctx.apply('no session message'"),
  # Council review of the live-run fixes (Coder): the manual budget goes to every model, and T-59 has room for thinking.
  @($IC, 'T-60 asks only the first model for the manual budget', 'invalidRequestFindings(await ctx.send(''/v1/messages'', ask(model, ''Hi''', 'invalidRequestFindings(await ctx.send(''/v1/messages'', ask(models[0], ''Hi'''),
  @($IC, 'T-59 without room for thinking', 'max_tokens: TEXT_MAX_TOKENS, tools: [tool], messages', 'max_tokens: 256, tools: [tool], messages'),
  # QA follow-up review of the live-run fixes: T-51 reads the helper's exit status and sign-in command from Claude Code's
  # report on stderr (U-53), and T-60 counts an empty text block for the order.
  @($IC, 'T-51 accepts any exit status of the helper', "if (report[1] !== '1')", 'if (false)'),
  @($IC, 'T-51 accepts a report without the sign-in command', 'if (!NO_SESSION_SIGN_IN.test(report[2]))', 'if (false)'),
  @($IC, 'T-51 reads the report from stdout too', "exec(refused.stderr ?? '')", 'exec(`${refused.stdout}${refused.stderr}`)'),
  @($IC, 'T-51 run keeps the real session', '{ helperGateway: NO_SESSION }', '{}'),
  @($IL, 'T-60 accepts a text block before the thinking', 'if (firstText >= 0 && firstText < thinking)', 'if (false)'),
  @($IL, 'T-60 orders by non-empty text only', "const firstText = types.indexOf('text');", "const firstText = types.findIndex((t, i) => t === 'text' && blocks[i].text);"),
  # QA second follow-up review: Claude Code exits by itself without a session.
  @($IC, 'T-51 accepts a run stopped at the time limit', "if (refused.timedOut) ctx.apply('no session'", "if (false) ctx.apply('no session'"),
  @($IC, 'T-51 accepts a run without an exit status', 'else if (!Number.isInteger(refused.status))', 'else if (false)'),
  # QA third follow-up review: every CLI run counts only when Claude Code ended by itself with status 0.
  @($IC, 'a CLI run stopped at the time limit counts', "(r.timedOut ? 'was stopped at the time limit' : r.status", "(false ? 'was stopped at the time limit' : r.status"),
  @($IC, 'T-51 positive run ignores how Claude Code ended', "const fault = cliFault(r);`n    if (fault || !/PONG/i.test(r.stdout))", "const fault = null;`n    if (fault || !/PONG/i.test(r.stdout))"),
  @($IC, 'T-65 read run ignores how Claude Code ended', "if (fault) ctx.apply('read'", "if (false) ctx.apply('read'"),
  @($IC, 'T-65 run with tools disallowed ignores how Claude Code ended', "if (deniedFault) ctx.apply('tools disallowed'", "if (false) ctx.apply('tools disallowed'"),
  @($IR, 'an install stopped at the time limit counts', 'if (installed.timedOut || installed.status !== 0) {', 'if (installed.status !== 0) {'),
  @($IS, 'a session token from a helper stopped at the time limit', 'if (r.timedOut || r.status !== 0 || !r.stdout.trim())', 'if (r.status !== 0 || !r.stdout.trim())'),
  # P-10 (T-74): the network-restricted deployment script (ADR-0005).
  @($AZ, 'the plan runs the changes', '    if ($script:Plan) {', '    if ($false) {'),
  @($AZ, 'an empty answer counts as a resource', 'if ($value -is [Management.Automation.PSCustomObject] -and -not @($value.PSObject.Properties).Count) { return $null }', ''),
  @($SB, 'environment subnet not delegated', "Extra = @('--delegations', 'Microsoft.App/environments')", 'Extra = @()'),
  @($SB, 'PostgreSQL subnet not delegated', "Extra = @('--delegations', 'Microsoft.DBforPostgreSQL/flexibleServers')", 'Extra = @()'),
  @($SB, 'Foundry left reachable from the internet', "'properties.publicNetworkAccess=Disabled'", "'properties.publicNetworkAccess=Enabled'"),
  @($SB, 'Foundry keys kept', "'properties.disableLocalAuth=true'", "'properties.disableLocalAuth=false'"),
  @($SB, 'private endpoint on another sub-resource', "'--group-id', 'account'", "'--group-id', 'blob'"),
  @($SB, 'a Foundry DNS zone left out', "openai = 'privatelink.openai.azure.com'; ", ''),
  @($SB, 'PostgreSQL with public access', "'--vnet', `$c.Vnet, '--subnet', 'snet-pg', '--private-dns-zone', `"`$(`$c.Postgres).private.postgres.database.azure.com`",", "'--public-access', 'All',"),
  @($SB, 'PostgreSQL password on the command line', "'--admin-password', (New-AzSecretArgument 'pg-password' `$c.Secrets.PgPassword)", "'--admin-password', `$c.Secrets.PgPassword"),
  @($SB, 'Claude deployment without the attestation', 'if (-not $c.ClaudeOrganizationName -and -not (Test-AzPlan)) { throw', 'if ($false) { throw'),
  @($SB, 'image build streams its log', "'--no-logs', `$c.ImageDir", '$c.ImageDir'),
  @($SB, 'a failed image build passes', "-and `$build.status -ne 'Succeeded'", '-and $false'),
  @($SA, 'environment with a public endpoint', "'--internal-only', 'true'", "'--internal-only', 'false'"),
  @($SA, 'app deployed with placeholder names', 'if ($missing) { throw "The app step needs', 'if ($false) { throw "The app step needs'),
  @($SA, 'a rotated secret never reaches the running app', 'if ($secretsChanged) {', 'if ($false) {'),
  @($SA, 'no wildcard record for a new environment', "        Invoke-AzChange @('network', 'private-dns', 'record-set', 'a', 'add-record', '-g', `$rg, '-z', `$c.DefaultDomain, '-n', '*', '-a', `$c.StaticIp) | Out-Null`n        return", '        return'),
  @($SD, 'developer VM with a public IP', "'--public-ip-address', '', '--nsg', '', ", ''),
  @($SD, 'Bastion on a paid SKU', "'--sku', 'Developer'", "'--sku', 'Basic'"),
  @($SD, 'VM password on the command line', "(New-AzSecretArgument 'vm-password' `$password)", '$password'),
  @($SD, 'a public address counts as private', '$a -eq 10 -or', '$true -or'),
  @($SD, 'Foundry answering from outside passes', '($FoundryStatus -eq 403)', '($FoundryStatus -ne 0)'),
  @($SD, 'PostgreSQL public access passes', "(`$PostgresAccess -eq 'Disabled')", '$true'),
  @($AD, 'grace period shorter than the drain window', 'terminationGracePeriodSeconds = 130', 'terminationGracePeriodSeconds = 30'),
  @($AD, 'readiness on the liveness endpoint', "(& `$probe 'Readiness' '/readyz' @{})", "(& `$probe 'Readiness' '/healthz' @{})"),
  @($AD, 'a configuration change deploys no revision', 'GATEWAY_CONFIG_SHA256 = [Convert]::ToHexString', 'GATEWAY_CONFIG_SHA256_UNUSED = [Convert]::ToHexString'),
  @($AD, 'JWT secret as a plain value', "@{ name = 'GATEWAY_JWT_SECRET'; secretRef = 'jwt-secret' },", "@{ name = 'GATEWAY_JWT_SECRET'; value = '__JWT__' },"),
  @($AD, 'no scale rule', "rules = @(@{ name = 'http-concurrency'; http = @{ metadata = @{ concurrentRequests = `"`$(`$c.ConcurrentRequests)`" } } })", 'rules = @()'),
  @($AD, 'the image entry point waits for a sidecar', "command = @('/usr/local/bin/claude')", "command = @('/bin/bash')"),
  @($DG, 'an unknown step accepted', 'if ($unknown.Count) { throw', 'if ($false) { throw'),
  @($DG, 'read-only steps change the subscription', 'if ($quiet -contains $s) { Set-AzPlan $true }', ''),
  @($DG, 'replicas outgrow the PostgreSQL connections', '[int]$MaxReplicas = 3,', '[int]$MaxReplicas = 10,')
)
# Regular-expression replacements, first match only. Each entry is (file, name, pattern, replacement).
$rx = @(
  , @($E, 'entrypoint gets a CR', '\n', "`r`n")
)
foreach ($m in $lit + $rx) {
  if ($m.Count -ne 4) { throw "Mutation entry '$($m[1])' has $($m.Count) elements; expected 4." }
}

$hashes = { Get-ChildItem -Recurse -File infra, config, tests | Get-FileHash | ForEach-Object { "$($_.Path)=$($_.Hash)" } }
$before = & $hashes
$rows = @()
if ($Only) { $lit = @($lit | Where-Object { $_[1] -match $Only }); $rx = @($rx | Where-Object { $_[1] -match $Only }) }
# A literal entry mutates the one site its text names: text that occurs twice or not at all is NOT APPLIED.
foreach ($m in $lit) { $f, $n, $a, $b = $m; $rows += Test-Mutation $f $n { param($t) $at = $t.IndexOf($a, [StringComparison]::Ordinal); if ($at -lt 0 -or $t.IndexOf($a, $at + 1, [StringComparison]::Ordinal) -ge 0) { $t } else { $t.Substring(0, $at) + $b + $t.Substring($at + $a.Length) } }.GetNewClosure() }
foreach ($m in $rx) { $f, $n, $a, $b = $m; $rows += Test-Mutation $f $n { param($t) ([regex]$a).Replace($t, $b, 1) }.GetNewClosure() }
$rows | Format-Table -AutoSize | Out-String -Width 220

$final = foreach ($s in $suites.Keys) { Invoke-Suite $s }
$restored = -not (Compare-Object $before (& $hashes))
$expected = $lit.Count + $rx.Count
$caught = @($rows | Where-Object result -eq 'caught').Count
"$caught of $expected mutations caught; unmutated suites after restore: exit $(($final | ForEach-Object Exit) -join ','); files byte-identical: $restored"
if ($rows.Count -ne $expected -or $caught -ne $expected -or ($final | Where-Object Exit -ne 0) -or -not $restored) { exit 1 }
