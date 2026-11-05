---
title: Troubleshoot the Claude apps gateway developer profile
description: Causes and fixes for the messages of the developer scripts and for Claude Code's apiKeyHelper failure when Claude Code reaches a Claude apps gateway through the developer profile on Windows.
author: naveenneog
ms.date: 09/28/2026
ms.topic: troubleshooting
---

# Troubleshoot the developer profile

Each script names what failed on stderr. The messages that a new sign-in fixes end with the command for it; a
failure a new sign-in does not fix, such as a gateway that does not answer or a lock another process holds, says what
does (scripts/developer/Get-ClaudeGatewayToken.ps1:45-48). The tables list the scripts' messages with the line that
prints each one.

## Claude Code reports that apiKeyHelper is failing

When the helper exits with an error, Claude Code reports `Your apiKeyHelper script is failing` within three attempts
([authentication](https://code.claude.com/docs/en/authentication), [errors](https://code.claude.com/docs/en/errors)).
In non-interactive mode, `claude -p`, Claude Code 2.1.272 also prints the helper's exit status and message on stderr,
such as `apiKeyHelper failed: exited 1: Get-ClaudeGatewayToken: No saved session for <gateway>. To sign in again, run: ...`
([connect to an LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect), U-53).
To see the helper's own message, run the profile's `apiKeyHelper` command in a new Windows PowerShell window with the
`env` values the launcher pins and the token output discarded:

```powershell
$pinned = Get-Content "$env:USERPROFILE\.claude-apps-gateway\gateway.settings.json" -Raw | ConvertFrom-Json
foreach ($p in $pinned.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value) }
cmd /d /c $pinned.apiKeyHelper 1>$null
```

Claude Code passes its settings `env` to the helper. These lines set, in that window only, the values `gateway.settings.json`
pins: the gateway as `ANTHROPIC_BASE_URL`, and the credentials and provider switches empty, which removes them
(scripts/developer/Install-ClaudeGatewayProfile.ps1:227-230). So a provider switch left in the shell does not hide the
helper's own failure. To reproduce a refusal caused by a project's settings, set the project's value after them.

| Message | Cause | Fix | Source |
|---|---|---|---|
| `No saved session for <gateway>.` | No sign-in on this Windows account, or a sign-out | Run the `Connect-ClaudeGateway.ps1` command the message names | scripts/developer/Get-ClaudeGatewayToken.ps1:92 |
| `The gateway refused the refresh token (<status> invalid_grant), so the saved session was deleted.` | The gateway ended the session, for example after your app role was removed | Sign in again; if the gateway refuses the sign-in, ask the operator about your role | scripts/developer/Get-ClaudeGatewayToken.ps1:125 |
| `ANTHROPIC_BASE_URL is <url>, not <gateway>, so the token is not printed: Claude Code would send it there.` | Claude Code was started without the profile's launcher, or with a `--settings` argument of your own, in a project whose `.claude/settings.json` or `.claude/settings.local.json` sets `ANTHROPIC_BASE_URL`. Project settings rank above the profile's `settings.json` and below the launcher's `--settings` file ([settings precedence](https://code.claude.com/docs/en/settings#settings-precedence)) | Start Claude Code with the profile's `claude-gateway.cmd`, without a `--settings` argument of your own | scripts/developer/Get-ClaudeGatewayToken.ps1:63 |
| `ANTHROPIC_BASE_URL is empty or not set, so Claude Code would send the token to https://api.anthropic.com, and it is not printed.` | As above, with a project value of `""`; or the helper was run by hand without the variable | Start Claude Code with the profile's `claude-gateway.cmd`; to run the helper by hand, set `$env:ANTHROPIC_BASE_URL` to the gateway first | scripts/developer/Get-ClaudeGatewayToken.ps1:58 |
| `<switch> is set, so Claude Code would send the token to that provider's endpoint, and it is not printed.` | A `CLAUDE_CODE_USE_*` provider switch, set by the shell or a project's settings, while Claude Code was started without the launcher or with a `--settings` argument of your own ([environment variables](https://code.claude.com/docs/en/env-vars)) | Start Claude Code with the profile's `claude-gateway.cmd`, or remove the switch | scripts/developer/Get-ClaudeGatewayToken.ps1:69 |
| `The saved session <file> cannot be read by this Windows user (<reason>). Signing in again replaces it.` | The file was copied from another account or machine, or damaged, with a reason such as `it holds no JSON object`; DPAPI decrypts it only for the account that wrote it | Sign in again | scripts/developer/ClaudeGateway.psm1:324 |
| `The session for <gateway> has expired and holds no refresh token.` | The gateway issued no refresh token | Sign in again | scripts/developer/Get-ClaudeGatewayToken.ps1:103 |
| `The session holds no refresh token and expires in <n> seconds.` | A warning; the token is still served | Sign in again before it expires | scripts/developer/Get-ClaudeGatewayToken.ps1:105 |
| `The refresh failed (<reason>); serving the current token, which expires in <n> seconds.` | A warning: the gateway did not answer the refresh, answered with an error other than `invalid_grant`, or answered HTTP 200 without an access token and a valid `expires_in`; the reason names which | None while it lasts; for a reason that names no HTTP status, see the connection messages below | scripts/developer/Get-ClaudeGatewayToken.ps1:131 |
| `The refresh failed (<reason>) and the saved token has expired. The session is kept: run the command again when the gateway answers.` | The gateway did not answer the refresh after the token expired, for example because of the network or a proxy | See the connection messages below, then run the command again. The session is kept, so the message names no sign-in: a new sign-in does not help while the gateway does not answer | scripts/developer/Get-ClaudeGatewayToken.ps1:134 |
| `The refresh failed (<status>) and the saved token has expired. The session is kept: run the command again, and ask the gateway operator to check the gateway's log when it repeats.` | After the token expired, the gateway answered the refresh with HTTP 429, a server error such as HTTP 503, a redirect, or HTTP 200 without an access token and a valid `expires_in` | Run the command again; when the message repeats, ask the operator to check the gateway's log. The session is kept, and a new sign-in is not the fix | scripts/developer/Get-ClaudeGatewayToken.ps1:141 |
| `The gateway refused the refresh token (<status>) and the saved token has expired. The session is kept.` | After the token expired, the gateway refused the refresh with an HTTP 4xx status other than 429 and without `invalid_grant`; an `invalid_grant` body with HTTP 200 or 429 is not a refusal and gets the operator message above; how the gateway refuses a refresh token it no longer accepts is not measured yet (docs/UNKNOWNS.md:59) | Sign in again with the command the message names; when the sign-in is refused too, ask the operator about your role | scripts/developer/Get-ClaudeGatewayToken.ps1:139 |
| `Waiting for the session lock <file>, which another process holds.` | Information: another run is refreshing | None | scripts/developer/ClaudeGateway.psm1:353 |
| `Another process has held <file> for <n> seconds.` | Another run did not finish its refresh within the lock timeout: 60 seconds, or `CLAUDE_GATEWAY_LOCK_TIMEOUT_SECONDS` | While the token has more than 30 seconds left it is served anyway. Otherwise the helper adds `Wait for the other Claude Code or helper process to finish, or close it, then run the command again.` and names no sign-in, which does not release the lock (scripts/developer/Get-ClaudeGatewayToken.ps1:82) | scripts/developer/ClaudeGateway.psm1:352 |
| `<reason> Serving the current token, which expires in <n> seconds.` | A warning: the lock stayed taken past its timeout, which the reason names, while the token had more than 30 seconds left | None while it lasts | scripts/developer/Get-ClaudeGatewayToken.ps1:85 |

## Sign-in messages

The sign-in uses the OAuth device authorization grant ([RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)).

| Message | Cause | Fix | Source |
|---|---|---|---|
| `Could not reach <url>: <reason> The scripts connect directly or through the Windows proxy settings (Internet Options); they do not read HTTPS_PROXY.` | No route to the gateway: a proxy that only `HTTPS_PROXY` names, or a wrong URL | Set the proxy in the Windows proxy settings, or correct the URL | scripts/developer/ClaudeGateway.psm1:167 |
| `Discovery at <url> returned HTTP <status>.` | By status. 403: the machine's address is outside the range the gateway's ingress accepts (config/gateway.azure-test.yaml:49-50). 404: nothing at the URL serves the metadata the script requests, `/.well-known/oauth-authorization-server` ([RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414), scripts/developer/ClaudeGateway.psm1:179), so the URL is not the gateway's. 500 to 599: the gateway or its ingress failed. 200: the answer is not JSON: a proxy's sign-in page, or a fault in the gateway or its ingress | 403: connect from an allowed network, or ask the operator to deploy with your range. 404: check the URL with the operator. 500 to 599: run the command again, and ask the operator to check the gateway's log when it repeats. 200: sign in to the proxy when it shows a sign-in page; otherwise ask the operator to check the gateway's log | scripts/developer/ClaudeGateway.psm1:181 |
| `Device authorization at <url> returned HTTP <status>.` | The gateway refused to start a sign-in | Ask the operator to check the gateway's log | scripts/developer/Connect-ClaudeGateway.ps1:45 |
| `The gateway's device authorization answer has no valid expires_in.` | The gateway's answer does not follow RFC 8628 | Ask the operator | scripts/developer/ClaudeGateway.psm1:205 |
| `Could not open a browser: <reason>` | No default browser, or a session without a desktop; the sign-in goes on | Open the verification URL the script printed in any browser | scripts/developer/Connect-ClaudeGateway.ps1:55 |
| `The sign-in was declined (access_denied)` | The code was declined in the browser, or the gateway refused the account | Run the command again and confirm the code; when the gateway refuses the account again, ask the operator whether it holds a gateway role ([grant developer access](how-to-admin-configure.md#grant-developer-access)) | scripts/developer/ClaudeGateway.psm1:219 |
| `The sign-in code expired before it was confirmed (expired_token).` | The gateway answered `expired_token`: the code was not confirmed in time; the test deployment gives 600 seconds | Run the command again and confirm the new code | scripts/developer/ClaudeGateway.psm1:221 |
| `The sign-in code expired before it was confirmed (expired_token).` | The script stopped polling: the `expires_in` of the gateway's device authorization answer passed without a token (scripts/developer/ClaudeGateway.psm1:206-208) | Run the command again and confirm the new code | scripts/developer/ClaudeGateway.psm1:224 |
| `The gateway ended the sign-in with HTTP <status> <code>.` | Another error from the gateway's token endpoint | Run the command again; ask the operator when it repeats | scripts/developer/ClaudeGateway.psm1:222 |
| `The gateway's token answer has no access_token or no valid expires_in, so the session was not saved.` | The gateway's answer does not follow the protocol | Ask the operator | scripts/developer/ClaudeGateway.psm1:213 |
| `The gateway signed you in as <account>, and this session cannot ask to confirm it.` | A non-interactive session cannot show the confirmation | Run the script in an interactive window, or add `-Force` after checking the account | scripts/developer/Connect-ClaudeGateway.ps1:65 |
| `Not saved: the account <account> was not confirmed.` | The account the gateway named was declined at the prompt | Run the command again and sign in with the account you intend | scripts/developer/Connect-ClaudeGateway.ps1:67 |
| `The gateway's <endpoint> '<url>' is not on the gateway origin <gateway>; stopping.` | The gateway's metadata points elsewhere, or the URL is not the gateway | Check the URL with the operator | scripts/developer/ClaudeGateway.psm1:136 |

## Sign-out messages

`Disconnect-ClaudeGateway.ps1` revokes as a best effort ([RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009)).

| Message | Cause | Fix | Source |
|---|---|---|---|
| `No saved session for <gateway>.` | Information: nothing to sign out of; the script exits 0 | None | scripts/developer/Disconnect-ClaudeGateway.ps1:29 |
| `the tokens could not be revoked (<reason>); the session is deleted anyway.` | The revocation request failed | None on the machine; the tokens stay valid at the gateway until they expire | scripts/developer/Disconnect-ClaudeGateway.ps1:45 |
| `<reason> It is deleted without revocation.` | The saved session could not be read, for example after a copy from another Windows account | None on the machine; its tokens stay valid at the gateway until they expire | scripts/developer/Disconnect-ClaudeGateway.ps1:35 |

## Installer and launcher messages

| Message | Cause | Fix | Source |
|---|---|---|---|
| `The profile <dir> is for <gateway>. To keep it, install <gateway> into its own profile with -ProfileDir "<dir>". To point this profile at <gateway> instead, add -ReplaceGateway.` | The profile directory already serves another gateway | Use the `-ProfileDir` the message names, or add `-ReplaceGateway` | scripts/developer/Install-ClaudeGatewayProfile.ps1:220 |
| `<file> does not hold a JSON object. Correct or remove it, then run this script again.` | The profile's `settings.json` is not valid JSON, or holds another JSON value such as an array | Correct or remove the file | scripts/developer/Install-ClaudeGatewayProfile.ps1:211 |
| `env in <file> is not a JSON object. Correct it, then run this script again.` | The `env` value in the profile's `settings.json` is a string, a number or an array | Correct the `env` value | scripts/developer/Install-ClaudeGatewayProfile.ps1:216 |
| `This profile has no gateway.settings.json. Run Install-ClaudeGatewayProfile.ps1 again.` | The launcher's pinned settings file was deleted, or an older installer wrote the profile | Run the installer again | scripts/developer/Install-ClaudeGatewayProfile.ps1:173 |
| `Claude Code was not found on PATH. Install it (https://code.claude.com/docs/en/setup), or pass -ClaudePath.` | No `claude.exe` or `claude.cmd` on `PATH` | Install Claude Code ([setup](https://code.claude.com/docs/en/setup)), or pass `-ClaudePath` | scripts/developer/Install-ClaudeGatewayProfile.ps1:99 |
| `ClaudePath '<path>' does not exist.` | `-ClaudePath` names no file | Pass the path of `claude.exe` or `claude.cmd` | scripts/developer/Install-ClaudeGatewayProfile.ps1:93 |
| `ClaudePath '<path>' is not a .exe or .cmd file.` | `-ClaudePath` names another kind of file | Pass the path of `claude.exe` or `claude.cmd` | scripts/developer/Install-ClaudeGatewayProfile.ps1:102 |
| `The model ID '<id>' has characters that model IDs do not use.` | `-FastModel` holds a space or another character outside letters, digits and `._:@/-` | Pass the model ID the operator names | scripts/developer/Install-ClaudeGatewayProfile.ps1:184 |
| `The profile directory must not be <dir>, the default Claude Code directory, which this script leaves alone.` | `-ProfileDir` names `%USERPROFILE%\.claude` | Omit `-ProfileDir`, or name another directory | scripts/developer/Install-ClaudeGatewayProfile.ps1:193 |
| `Windows PowerShell was not found at <path>.` | No `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, which runs the helper | Run the installer on Windows 10 or Windows 11 with Windows PowerShell 5.1 | scripts/developer/Install-ClaudeGatewayProfile.ps1:199 |
| `Claude Code is not at "<path>". Run Install-ClaudeGatewayProfile.ps1 again.` | Claude Code moved, for example after a reinstall | Run the installer again | scripts/developer/Install-ClaudeGatewayProfile.ps1:176 |
| `The path '<path>' contains % or a quote, which cmd would change.` | cmd expands `%NAME%` inside the launcher and the helper command | Install from a path without `%` | scripts/developer/Install-ClaudeGatewayProfile.ps1:88 |
| `The path '<path>' has characters outside ASCII that cmd cannot read from the launcher` | A Claude Code path outside `%LOCALAPPDATA%`, `%APPDATA%` and `%USERPROFILE%` has non-ASCII characters | Pass `-ClaudePath` with an ASCII path | scripts/developer/Install-ClaudeGatewayProfile.ps1:122 |
| `The gateway URL '<url>' has a host this script does not accept` | An internationalised host name | Give the name in its `xn--` form | scripts/developer/ClaudeGateway.psm1:126 |

## Gateway URL messages

Every developer script checks the gateway URL the same way before it sends a request
(scripts/developer/ClaudeGateway.psm1:111-128).

| Message | Cause | Fix | Source |
|---|---|---|---|
| `The gateway URL '<url>' is not an absolute URL.` | The URL has no scheme, such as `gateway.contoso.com` | Give the URL with `https://` | scripts/developer/ClaudeGateway.psm1:115 |
| `The gateway URL must use https; http is accepted only for a loopback address. Got '<url>'.` | `http://` for a host that is not loopback, or another scheme | Use the `https` URL the operator gave | scripts/developer/ClaudeGateway.psm1:117 |
| `The gateway URL must not contain a user name or password.` | The URL holds `user@` or `user:password@` | Give the URL without them | scripts/developer/ClaudeGateway.psm1:119 |
| `The gateway URL must be an origin, with no path, query or fragment. Got '<url>'.` | The URL has a path such as `/v1`, a query or a fragment | Give the scheme, host and port only | scripts/developer/ClaudeGateway.psm1:121 |

## Scripts do not start

Group Policy can set an execution policy that `-ExecutionPolicy Bypass` does not override; the `MachinePolicy` and
`UserPolicy` scopes take precedence over the process scope
([about_Execution_Policies](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies)).
`Get-ExecutionPolicy -List` shows the policy of each scope; a signed copy of the scripts, or an exception from the
policy owner, is then needed.

## Gateway and admin console

These messages come from Azure Container Apps or from the admin console, not from the developer scripts. Container
Apps ingress answers a caller outside its IP restrictions with HTTP 403 before the request reaches the app
([IP restrictions](https://learn.microsoft.com/en-us/azure/container-apps/ip-restrictions)); this repository's
deployments allow one range per app (docs/adr/0003-azure-test-deployment-with-restricted-ingress.md:1).

| Message | Cause | Fix |
|---|---|---|
| `RBAC: access denied` (HTTP 403, plain text) | The request came from an IP address outside the Container App's ingress IP restrictions, which exist only when the install was given `-TesterCidr` (gateway) or `-AllowedCidr` (console). It is not related to Azure role assignments or Entra app roles. | The install command with the block that holds the address, or with `-GatewayAllowAnyAddress` / `-ConsoleAllowAnyAddress` to accept every address again, and `-Steps app,admin-ui` ([limit or change the address range](tutorial-first-install.md#limit-or-change-the-address-range)). The gateway also checks the range itself (`access_control.allow_cidrs`, config/gateway.azure-test.yaml:50), so a portal change to its ingress is not enough. `203.0.113.0/26` in the documentation admits nobody. |
| Page **AdminUi.Admin is required** | The signed-in account is assigned to the `<app registration>-admin-ui-signin` enterprise application but does not hold its `AdminUi.Admin` app role, for example it has default access only, or its token does not carry the role (admin-ui/web/app.js:351, ADR-0011). | **Microsoft Entra admin center** > **Enterprise applications** > that application > **Users and groups** > **Add user/group**, role `AdminUi.Admin` ([assign users](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal)). The account signs out and in again so its token carries the role. |
| `AADSTS50105` during sign-in | The account has no assignment on the `<app registration>-admin-ui-signin` enterprise application, which requires one (`admin-ui/infra/Deploy-AdminUi.ps1`, line 184). Microsoft Entra ID stops the sign-in before admin-ui is reached ([AADSTS error codes](https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes)). | Assign the account the `AdminUi.Admin` role on that application, as in the previous row. |
| `AADSTS7000222` or `AADSTS700027` when a developer signs in to the gateway | The gateway's client secret or certificate has ended, or is not registered on the app registration. `job-signin-renewer` replaces it 30 days before its end (admin-ui/server/signin-renewer.mjs:23); a failed run, or a console without its Microsoft Graph grant, leaves it in place. | **Settings** > **Gateway sign-in credential** > **Renew now** in the console, or the install command with `-RotateClientSecret -Steps app` ([check the gateway's sign-in credential](tutorial-first-install.md#check-the-gateways-sign-in-credential)). The job's runs are under **Container Apps jobs** > `job-signin-renewer` > **Execution history**. |
| `preflight` prints a `FAIL` line | A read-only check before the install found a problem: the resource group, the Foundry account or its deployments, or the database regions (infra/azure-test/lib/preflight.mjs:59). Nothing was changed. | The line names the fix; [Install the Claude apps gateway, stage by stage](how-to-install-stage-by-stage.md#preflight) lists each check. |
| `id_token missing email claim` in the gateway log, and sign-in fails | The account has no `mail` attribute, so Entra puts no `email` claim in its token (docs/UNKNOWNS.md, U-81). | In the admin file, `"emailClaim": "preferred_username"` under `deployment`, then the install command with `-Steps entra,app` and `-EmailDomain` set to the sign-in names' domain. The `app` stage reads the admin file only until the admin console's first save, and the console does not edit `emailClaim` (docs/adr/0010-admin-ui-writes-gateway-config-roles-and-chargeback.md:117), so it is set before that save: the `entra` stage records the domain and `app` deploys it (infra/azure-test/deploy.mjs:218). |
| `ca-claude-gw holds secret ..., which gateway-test.json does not define, so the app step would delete them` | The gateway app holds settings added by hand, such as a cross-tenant Foundry credential (docs/UNKNOWNS.md, U-80); what the admin console saves is not among them (infra/azure-test/lib/plan.mjs:168-189). | Remove the named settings under **Containers** and **Secrets** of the Container App when they are no longer needed, then run the stage again. |
| `API Error: 400 model <id> is not in your role's availableModels allowlist` | Claude Code asked for a model the developer's role does not allow, often its own default when the profile has no `-Model` (docs/TEST-PLAN.md, T-88). | `/model` in Claude Code, or `--model <id>`, with a model of the role; or the profile installed again with `-Model <id>` ([script reference](reference-scripts.md)). |
| `AADSTS50011` on the admin console's sign-in | A `<app registration>-admin-ui-signin` registration left from an earlier install has the old console address as its redirect URI; the script sets it only when it creates the registration (`admin-ui/infra/Deploy-AdminUi.ps1`, lines 173-181). | Delete that registration under **App registrations**, then run the `admin-ui` stage again. |
| **Need admin approval** at the first sign-in to the gateway or the admin console | The tenant stops users from consenting to applications ([user consent settings](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent)). | An Application Administrator grants consent once: **Enterprise apps** > the application > **Permissions** > **Grant admin consent** ([grant tenant-wide admin consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent)). |
| `Sign-in is off. Changing the gateway configuration needs admin sign-in with the AdminUi.Admin role.` | The console was deployed without `-EnableSignIn`, so configuration, roles and user tags cannot be changed (admin-ui/web/config-view.js:216). | Run `Deploy-AdminUi.ps1` again with `-EnableSignIn -SignInAdmins <UPN>`. |
| `Authorization_RequestDenied` on the Developers or Roles page, or from `Deploy-AdminUi.ps1` | The admin console's managed identity has no Microsoft Graph application permissions, or the account running the script cannot grant them. | A Privileged Role Administrator or Global Administrator grants them: [install stage by stage, admin-ui](how-to-install-stage-by-stage.md#admin-ui). |
| Empty HTTP 403 on Set cap or Grant role, with authentication logs reporting CSRF substatus 60 and an empty Referer | Older console images send `Referrer-Policy: no-referrer`. The browser omits the header Azure Authentication expects even on a same-origin POST. This is separate from Azure RBAC or Graph grants (ADR-0019). | [Update only the console image](how-to-update-admin-console.md). The corrected image sends `same-origin`; Entra sign-in, AdminUi.Admin and cross-site write protection remain enabled. |
| Container Apps Contributor already exists, but Settings reports it missing | Older console images misread the published role's interior-wildcard read/write actions (ADR-0019). A permissions API failure can also cause this; its reason appears in the Permissions card. | [Update the console](how-to-update-admin-console.md), then Check again. Do not broaden the role's scope to clear an indicator. |
| **Apply and roll out** answers 403 `LinkedAuthorizationFailed` for `Microsoft.App/managedEnvironments/join/action` | Azure checks join on the gateway's Container Apps environment for every update of the gateway app; consoles installed before 2026-11-05 hold Container Apps Contributor on the app only (ADR-0019). | Assign **Container Apps Operator** on the environment to `id-admin-ui`: [Check the console](how-to-update-admin-console.md#check-the-console). It has no write access to the environment or any app. |
| **Apply and roll out** answers 403 `LinkedAuthorizationFailed` for `Microsoft.ManagedIdentity/userAssignedIdentities/assign/action` | Azure checks that `id-admin-ui` may reattach the gateway's `id-claude-gw` identity when it updates the gateway app (ADR-0019). | Assign **Managed Identity Operator** on `id-claude-gw` to `id-admin-ui`: [Check the console](how-to-update-admin-console.md#check-the-console). |
| `This gateway keeps its database on temporary storage (an EmptyDir volume), which a new revision starts empty.` | The gateway uses the in-app PostgreSQL sidecar, whose database is lost when a configuration change starts a new gateway revision (docs/adr/0012-test-topology-database-choice.md). | Confirm the reset in the dialog, then set the spend caps again with `bootstrap-budgets.mjs` ([script reference](reference-scripts.md#bootstrap-budgetsmjs)). To keep spend across saves, move to the managed database ([choose the database](how-to-install-stage-by-stage.md#choose-the-database)). |
| `/readyz` answers 503 on a gateway with the managed database, and the log shows connection timeouts to `*.postgres.database.azure.com` | The gateway app's outbound address changed and the database firewall still lists the old one (docs/UNKNOWNS.md, U-101). | `node scripts/admin/sync-database-firewall.mjs --resource-group <group>` ([script reference](reference-scripts.md#sync-database-firewallmjs)). |
| `SkuNotAvailable` when the managed database is created | The region does not currently provide Burstable B1ms to the subscription (docs/UNKNOWNS.md, U-105). | Run the install command again with `-DatabaseLocation` (or `deploy.mjs --database-location`) set to another region, or request access through Azure support ([resolve capacity errors](https://learn.microsoft.com/en-us/azure/postgresql/troubleshoot/how-to-resolve-capacity-errors)). |
| Log line `PostgreSQL did not accept connections on 127.0.0.1:5432 within 60 s` | The gateway container runs the image's entrypoint, which waits for the sidecar, but the app has no sidecar (docs/UNKNOWNS.md, U-104). | Run `move-to-managed-database.mjs` again; it sets the container to run the gateway directly ([script reference](reference-scripts.md#move-to-managed-databasemjs)). |

## Intune installs

The Intune apps write their own install logs on the device, because Intune keeps neither a script's output nor its
errors: `%ProgramFiles%\Anthropic\ClaudeCode\install-claude-code.log` and the developer's
`%LOCALAPPDATA%\ClaudeAppsGateway\install-profile.log` (scripts/admin/intune-package.mjs:32-33). Their messages and
fixes are in [When Intune reports Failed or Not detected](tutorial-first-install.md#when-intune-reports-failed-or-not-detected).

## Related content

- [Quickstart: connect Claude Code on Windows](quickstart-developer.md)
- [Script reference](reference-scripts.md)
