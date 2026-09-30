---
title: Connect Claude Code, the VS Code extension and Claude Desktop to the Claude apps gateway
description: Deploy Windows client policies with Intune or Group Policy and connect Claude Code, its VS Code extension and Claude Desktop through the gateway's interactive sign-in.
author: naveenneog
ms.date: 09/29/2026
ms.topic: how-to
---

# Connect Claude Code, VS Code and Claude Desktop to the gateway

This article configures Windows machines for the network-restricted Azure deployment, with Microsoft Entra ID sign-in
and Microsoft Foundry upstreams. Production uses a custom domain with the organization's certificate
(docs/adr/0005-network-restricted-deployment.md:65-74); the example URL is `https://claude-gateway.corp.contoso.com`.
A custom domain replaces the default host name in four places: a private DNS record, a certificate bound to the
Container App ([custom domains and certificates](https://learn.microsoft.com/en-us/azure/container-apps/custom-domains-certificates)),
`GATEWAY_PUBLIC_URL`, which is the gateway's `listen.public_url`, and the Entra redirect URI `<origin>/oauth/callback`.
`Deploy-Gateway.ps1` sets the last two from the default host name (infra/azure-private/lib/AppDefinition.psm1:16;
infra/azure-private/lib/Steps.App.psm1:44). Until that change, the client values use
`https://ca-claude-gw.<environment default domain>`.

| Client | Machine setting | Sign-in | Minimum version | Source |
|---|---|---|---|---|
| Claude Code CLI | `forceLoginMethod`, `forceLoginGatewayUrl`, `parentSettingsBehavior` in Claude Code managed settings | `/login`, then gateway device-code approval in a browser | Claude Code 2.1.195 | [Prerequisites](https://code.claude.com/docs/en/claude-apps-gateway#prerequisites), [login keys](https://code.claude.com/docs/en/claude-apps-gateway#set-the-gateway-url) |
| Claude Code extension for VS Code | The same machine-level Claude Code settings | Panel sign-in and browser authorization; gateway-specific screens are not documented | VS Code 1.94.0; no extension-specific gateway minimum is documented | [Extension prerequisites](https://code.claude.com/docs/en/vs-code#prerequisites), [first use](https://code.claude.com/docs/en/vs-code#get-started), [policy surfaces](https://code.claude.com/docs/en/managed-settings#where-and-when-a-policy-applies) |
| Claude Desktop | `bootstrapUrl` under `HKLM\SOFTWARE\Policies\Claude`; keep the Claude Code merge opt-in too | Its own gateway device-code sign-in; not the CLI session | Desktop 1.10628.0 for `bootstrapUrl`; gateway 2.1.203 | [Bootstrap keys](https://claude.com/docs/third-party/claude-desktop/configuration#bootstrap), [Desktop connection](https://code.claude.com/docs/en/claude-apps-gateway#connect-claude-desktop) |

## Prerequisites

- Complete [Deploy the network-restricted gateway](tutorial-deploy-network-restricted.md); use its HTTPS hostname and a trusted certificate ([TLS requirements](https://code.claude.com/docs/en/claude-apps-gateway#prerequisites)).
- Connect the machine and sign-in browser to the corporate network or VPN, with private-zone DNS forwarding ([DNS Private Resolver](https://learn.microsoft.com/en-us/azure/dns/dns-private-resolver-overview#inbound-endpoints)).
- Install the listed clients; check the standalone CLI with `claude --version`. The extension bundles its own CLI ([VS Code prerequisites](https://code.claude.com/docs/en/vs-code#prerequisites)).
- A `CLAUDE_CODE_USE_*` provider variable, such as `CLAUDE_CODE_USE_FOUNDRY`, selects that provider directly, without the gateway sign-in ([set the gateway URL](https://code.claude.com/docs/en/claude-apps-gateway#set-the-gateway-url)).
- Have Node.js 22 or later for the generator (docs/learn/reference-scripts.md:13), and administrator rights or device management for HKLM ([delivery mechanisms](https://code.claude.com/docs/en/managed-settings#choose-a-delivery-mechanism)).
- Assign a user, or groups for the 25,000-developer rollout, to `Gateway.Standard` or `Gateway.Premium` on the gateway's
  enterprise application (config/gateway.azure-private.yaml:22-23). This deployment names its app registration
  `claude-apps-gateway-private-<suffix>` (infra/azure-private/Deploy-Gateway.ps1:84).
  In the Microsoft Entra admin center, open **Enterprise applications**, select that gateway application, then
  **Users and groups > Add user/group**. Select the user or group, choose **Select a role**, select the gateway role,
  and select **Assign**. Group-based assignment requires **Microsoft Entra ID P1 or P2**; nested group memberships
  do not grant access through the assignment ([assign users, groups and roles](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal)).

## Network requirements for developer machines

The deployment constructs `https://ca-claude-gw.<environment default domain>` and links a private DNS zone with a
wildcard A record pointing to the environment's static IP (infra/azure-private/lib/Steps.App.psm1:23-31).
Forward that zone from corporate DNS to an Azure DNS Private Resolver inbound endpoint; give a custom hostname private resolution too
([inbound endpoints](https://learn.microsoft.com/en-us/azure/dns/dns-private-resolver-overview#inbound-endpoints)).

From a developer machine, check resolution and connectivity:

```powershell
Resolve-DnsName claude-gateway.corp.contoso.com
Test-NetConnection claude-gateway.corp.contoso.com -Port 443
```

Every address must be RFC 1918, CGNAT `100.64.0.0/10`, link-local, IPv6 ULA `fc00::/7`, or loopback; a public A or AAAA answer fails `/login` ([private-network requirement](https://code.claude.com/docs/en/claude-apps-gateway#prerequisites)).

| Destination | Port | Used for | Source |
|---|---|---|---|
| Gateway hostname, resolving to its private IP | TCP 443 | CLI and browser sign-in, Desktop bootstrap and model requests | [Gateway prerequisites](https://code.claude.com/docs/en/claude-apps-gateway#prerequisites) |
| `login.microsoftonline.com` and the documented authentication hosts, including `*.msauth.net` and `*.aadcdn.msftauth.net` | TCP 443 | Entra browser sign-in and its page resources; use the full authentication list for your environment | [Microsoft authentication endpoints](https://learn.microsoft.com/en-us/azure/azure-portal/azure-portal-safelist-urls#azure-portal-authentication) |
| `claude.ai` | TCP 443 | Downloading the native CLI installation script, if using Anthropic's installer | [Install Claude Code](https://code.claude.com/docs/en/setup#install-claude-code) |
| `downloads.claude.ai` | TCP 443 | CLI native binaries and updates; Desktop session components, model catalog and update binaries | [CLI network access](https://code.claude.com/docs/en/network-config#network-access-requirements), [Desktop egress](https://claude.com/docs/third-party/claude-desktop/telemetry#required-egress-paths) |
| `claude.ai`, `api.anthropic.com`; alternatively `releases.claude.com` with `updateViaUpdatesHost` | TCP 443 | Desktop update feeds when auto-updates are enabled | [Desktop egress](https://claude.com/docs/third-party/claude-desktop/telemetry#required-egress-paths) |

Export Desktop's **Egress** list for all enabled telemetry, services and connectors; this table is not a complete feature allowlist ([Desktop egress](https://claude.com/docs/third-party/claude-desktop/telemetry#required-egress-paths)).
The offline installer bundles session components, but its catalog still uses `downloads.claude.ai` unless disabled or mirrored ([MDM egress](https://claude.com/docs/third-party/claude-desktop/mdm#3-allow-required-network-egress)).

Add the gateway hostname to `NO_PROXY`, retaining other entries: HTTPS-proxied CLI requests skip certificate pinning ([pinning](https://code.claude.com/docs/en/claude-apps-gateway#connect-developers)).
Desktop's app follows its own OS or managed proxy configuration, not the CLI shell variable ([Desktop proxy](https://claude.com/docs/third-party/claude-desktop/network-proxy#default-behavior)).

## Generate the policy files

From the repository root, use an empty output directory with the generator in [Generate client payloads](how-to-admin-configure.md):

```powershell
node scripts\admin\new-client-policy.mjs --gateway-url https://claude-gateway.corp.contoso.com --fast-model claude-sonnet-5 --out .\client-policy
```

Options and outputs: scripts/admin/new-client-policy.mjs:155-179. [Windows policy locations](https://code.claude.com/docs/en/managed-settings#where-each-mechanism-stores-the-policy) define the destinations below.

| Output | Purpose |
|---|---|
| `login\managed-settings.json` | File-based policy; install as `C:\Program Files\ClaudeCode\managed-settings.json` |
| `login\ClaudeCode-HKLM.reg` | The same JSON as the `Settings` string value under `HKLM\SOFTWARE\Policies\ClaudeCode` |
| `login\ClaudeCode.mobileconfig` | macOS configuration profile; not used on Windows |
| `developer\` | Alternative `apiKeyHelper` profile and instructions; do not deploy alongside forced gateway login |

The login payload contains these three keys (scripts/admin/new-client-policy.mjs:46):

```json
{
  "forceLoginMethod": "gateway",
  "forceLoginGatewayUrl": "https://claude-gateway.corp.contoso.com",
  "parentSettingsBehavior": "merge"
}
```

The login keys require an administrator-managed source on the machine, not user/project settings, HKCU or the gateway's `managed.policies[].cli`
([client-side settings](https://code.claude.com/docs/en/claude-apps-gateway-config#client-side-managed-settings)).
`--fast-model` affects only the alternative developer folder's install command (scripts/admin/new-client-policy.mjs:97-98).

The generator does not write Desktop's policy. Add this separate `REG_SZ` value ([Desktop value types](https://claude.com/docs/third-party/claude-desktop/configuration#value-types)):

```cmd
reg add "HKLM\SOFTWARE\Policies\Claude" /v bootstrapUrl /t REG_SZ /d "https://claude-gateway.corp.contoso.com/user/bootstrap" /f
```

Equivalent `.reg` content:

```reg
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Claude]
"bootstrapUrl"="https://claude-gateway.corp.contoso.com/user/bootstrap"
```

The VM setup downloads `claude.exe`, checks its release SHA-256, writes both HKLM policies and installs VS Code (infra/azure-private/lib/Steps.Dev.psm1:17-29).

## Deliver the policy with Intune or Group Policy

Registry policy replaces the managed settings file by default. Keep all three keys and other required controls in one complete JSON value ([source precedence](https://code.claude.com/docs/en/claude-apps-gateway-config#client-side-managed-settings)).

**Intune**

1. Use a PowerShell platform script to write both HKLM values, or a system-context Win32 app to import the `.reg` and set Desktop's value
   ([Intune Management Extension](https://learn.microsoft.com/en-us/intune/intune-service/apps/intune-management-extension), [Win32 install context](https://learn.microsoft.com/en-us/intune/app-management/deployment/add-win32#step-2-program)).
   The packaged installer can run `reg import .\client-policy\login\ClaudeCode-HKLM.reg`, followed by the Desktop command above.
2. For a platform script, open **Devices > Scripts and remediations > Platform scripts > Add > Windows 10 and later**.
   Set **Run this script using the logged on credentials** to **No** (system context) and **Run script in 64-bit PowerShell host** to **Yes**
   ([script policy settings](https://learn.microsoft.com/en-us/intune/device-management/tools/run-powershell-scripts-windows#create-a-script-policy-and-assign-it)).
3. Assign to a pilot device group; review **Device status** before expanding
   ([monitor run status](https://learn.microsoft.com/en-us/intune/device-management/tools/run-powershell-scripts-windows#monitor-run-status)).

**Group Policy**

1. Edit the device GPO in Group Policy Management. Open **Computer Configuration > Preferences > Windows Settings > Registry**.
2. Add **Registry Item** entries: action **Update**, hive **HKEY_LOCAL_MACHINE**, type **REG_SZ**.
   Set `SOFTWARE\Policies\ClaudeCode` / `Settings` to the complete JSON; set `SOFTWARE\Policies\Claude` / `bootstrapUrl` to `https://claude-gateway.corp.contoso.com/user/bootstrap`
   ([configure a Registry item](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2008-r2-and-2008/cc753092%28v=ws.11%29)).

For 25,000 developers, stage assignments with sign-in instructions. NAT/VPN users share per-address sign-in limits
([large rollouts](https://code.claude.com/docs/en/claude-apps-gateway-deploy#large-rollouts)).
The sample sets 1,000 starts and 100 submissions per address per 600 seconds, not fleet-wide capacity (config/gateway.azure-private.yaml:71-73).

## Sign in from Claude Code

1. Open PowerShell and run `claude`.
2. Enter `/login`; the **Cloud gateway** screen has the URL filled in. Press **Enter** ([login screen](https://code.claude.com/docs/en/claude-apps-gateway#set-the-gateway-url)).
3. Compare the first-connect fingerprint with the administrator's published value: the first 16 lowercase hex
   characters of the leaf certificate's SHA-256, without colons. Accept only a match ([pinning](https://code.claude.com/docs/en/claude-apps-gateway#connect-developers)).
4. Open the verification link and confirm the code on the gateway's page. Sign in to Entra with the assigned work account;
   the browser returns to `/oauth/callback` ([device flow](https://code.claude.com/docs/en/claude-apps-gateway#ci-pipelines-and-remote-machines), [callback](https://code.claude.com/docs/en/claude-apps-gateway-deploy#identity-provider-setup)).
5. Run `/status`; **Setting sources** shows gateway policy as remote managed settings. Use `/model` for allowed models
   ([policy check](https://code.claude.com/docs/en/managed-settings#check-that-a-policy-is-in-force), [models](https://code.claude.com/docs/en/claude-apps-gateway#whats-enforced-on-developers)).

On the test machine of the [tutorial](tutorial-deploy-network-restricted.md), Claude Code 2.1.284 showed these screens
on 2026-09-29 (docs/TEST-PLAN.md:280-281). After **Enter** on the Cloud gateway screen, it asks to trust the gateway
and shows the start of the certificate's SHA-256 fingerprint:

:::image type="content" source="media/clients/login-trust-gateway.png" alt-text="Screenshot of Claude Code asking Trust gateway ca-claude-gw on the environment's default domain, with the certificate fingerprint 2fbc49857fa6e209 and the choices Yes, trust this gateway and No, go back.":::

After the trust, it opens the browser, shows the code and the gateway's verification address, and waits:

:::image type="content" source="media/clients/login-device-code.png" alt-text="Screenshot of Claude Code's Cloud gateway sign-in screen with a one-time code, the address of the gateway's device page, and Waiting for sign-in to complete in your browser.":::

The gateway's device page takes the code, then sends the browser to Microsoft Entra ID for the sign-in; a mistyped
code is refused on the page:

:::image type="content" source="media/clients/gateway-device-page.png" alt-text="Screenshot of the gateway's device page in Microsoft Edge on the test machine: Enter the code from your device, a code field and a Continue button.":::

Administrators can publish the fingerprint from the served leaf certificate file with OpenSSL in PowerShell:

```powershell
$fingerprint = ((openssl x509 -noout -fingerprint -sha256 -in .\cert.pem) -split '=', 2)[1].Replace(':', '').ToLowerInvariant()
$fingerprint
$fingerprint.Substring(0, 16)
```

This formats Anthropic's [OpenSSL command](https://code.claude.com/docs/en/claude-apps-gateway#connect-developers) for PowerShell.
The verify step also prints `sha256` (infra/azure-private/lib/Steps.Dev.psm1:94).
The CLI pins the leaf per hostname; every rotation prompts every developer again. Publish the replacement fingerprint.

Over SSH, run `/login` remotely and open the link on a laptop that can reach the gateway ([remote machines](https://code.claude.com/docs/en/claude-apps-gateway#ci-pipelines-and-remote-machines)).
Client 2.1.275 added optional email confirmation, but this gateway returns no email field, so no such confirmation appears
([connection behavior](https://code.claude.com/docs/en/claude-apps-gateway#connect-developers)).

## Sign in from the VS Code extension

1. Deploy the same machine policy; the extension's bundled CLI reads managed sources
   ([runtime](https://code.claude.com/docs/en/vs-code#prerequisites), [policy surfaces](https://code.claude.com/docs/en/managed-settings#where-and-when-a-policy-applies)).
2. Open **Extensions** with **Ctrl+Shift+X**, install **Claude Code**, then open its Spark-icon panel
   ([install](https://code.claude.com/docs/en/vs-code#install-the-extension), [open panel](https://code.claude.com/docs/en/vs-code#get-started)).
3. On first use, select **Sign in** and complete browser authorization ([first use](https://code.claude.com/docs/en/vs-code#get-started)).

The guide does not specify gateway-only screens, panel behavior for `forceLoginMethod`, or CLI credential reuse.
`disableLoginPrompt` skips prompts for direct third-party provider setups; leave its default `false` here
([extension settings](https://code.claude.com/docs/en/vs-code#extension-settings)).
The integrated terminal's `claude` command needs the standalone CLI, separate from the panel
([extension prerequisites](https://code.claude.com/docs/en/vs-code#prerequisites)).

## Connect Claude Desktop

1. Both roles opt in with `desktop: {}` (config/gateway.azure-private.yaml:55-65); without it, `/user/bootstrap` returns 404 ([Desktop overlay](https://code.claude.com/docs/en/claude-apps-gateway-config#claude-desktop-overlay)).
2. Deploy `bootstrapUrl` directly under `HKLM\SOFTWARE\Policies\Claude`. Since Desktop 1.19367.0, HKLM policy excludes
   HKCU policy entirely; keep configuration in one hive
   ([registry precedence](https://claude.com/docs/third-party/claude-desktop/mdm#4-deploy-the-configuration)).
3. Quit and reopen Desktop; configuration is read at launch ([how keys are read](https://claude.com/docs/third-party/claude-desktop/configuration#how-keys-are-read)).
4. Complete Desktop's browser sign-in. With only `bootstrapUrl`, and no `bootstrapOidc` or header credentials,
   Desktop uses device-code mode against the bootstrap server's origin
   ([bootstrap authentication](https://claude.com/docs/third-party/claude-desktop/bootstrap#bootstrap-server-as-authorization-server-device-code)).
5. Cowork and Code send model requests through the gateway; CLI and Desktop sign-ins are separate. Enable Chat with
   `chatTabEnabled: true` in Desktop policy or the `desktop` overlay (gateway 2.1.227+ for the overlay)
   ([Desktop tabs](https://code.claude.com/docs/en/claude-apps-gateway#connect-claude-desktop)).

Retain `parentSettingsBehavior: "merge"` in the selected Claude Code managed source on Desktop-only machines:
it lets a gateway egress allowlist reach embedded sessions. This repository sets model lists, not an egress allowlist (config/gateway.azure-private.yaml:54-65;
[Desktop policy delivery](https://code.claude.com/docs/en/claude-apps-gateway#deliver-policy-to-claude-desktop-sessions)).
The MDM-only `trustBootstrapDelivery` (Desktop 1.26832.0+) skips consent for bootstrap-delivered sign-in targets, endpoints, helper scripts and connectors, not sign-in
([bootstrap controls](https://claude.com/docs/third-party/claude-desktop/configuration#bootstrap)).

## What the gateway enforces after sign-in

- **Models:** Standard gets Sonnet 5; Premium adds Opus 5 (config/gateway.azure-private.yaml:55-65).
  The picker follows `availableModels`; other model requests return 400 ([model enforcement](https://code.claude.com/docs/en/claude-apps-gateway#whats-enforced-on-developers)).
- **CLI policy:** locked settings cannot be overridden locally; policy loads at startup and refreshes hourly, with some changes deferred.
  A signed-in CLI exits at startup after about 10 seconds if the gateway is unreachable ([policy and startup](https://code.claude.com/docs/en/claude-apps-gateway#whats-enforced-on-developers)).
- **Credentials:** clear conflicting API credentials; forced gateway sign-in does not use a leftover API key or claude.ai login
  ([credential errors](https://code.claude.com/docs/en/errors#administrator-policy-requires-a-cloud-gateway-sign-in)).
- **Lifetime:** IdP deprovisioning ends the session within `ttl_hours` when refresh fails; here it is one hour (config/gateway.azure-private.yaml:27; [deprovisioning](https://code.claude.com/docs/en/claude-apps-gateway#whats-enforced-on-developers)).
- **Sign-out:** `/logout` deletes the local credential. Client 2.1.275 supports revocation, but this server advertises no endpoint: logout is local only ([sign-out](https://code.claude.com/docs/en/claude-apps-gateway#whats-enforced-on-developers)).
- **CI:** no unattended service-token flow exists ([CI limitations](https://code.claude.com/docs/en/claude-apps-gateway#ci-pipelines-and-remote-machines)).

## Troubleshoot

| Symptom | Cause | Fix | Reference |
|---|---|---|---|
| `Gateway hosts must be on your organization's private network; <host> resolves to the public (or unrecognized) address <ip>` | At least one DNS answer is public | Correct corporate DNS forwarding and A/AAAA records; use the private route | [Private-address refusal](https://code.claude.com/docs/en/claude-apps-gateway-deploy#troubleshooting) |
| No gateway option in `/login` | Missing login keys, or keys in user settings/HKCU | Deploy all three keys in the selected machine-managed source, then start Claude Code again | [Set the gateway URL](https://code.claude.com/docs/en/claude-apps-gateway#set-the-gateway-url) |
| `The gateway is limiting sign-in attempts right now` | Per-address sign-in limit reached; this wording requires client 2.1.274+ | Retry after the window; operators check `trusted_proxies` before sizing sign-in limits for shared addresses | [Large rollouts](https://code.claude.com/docs/en/claude-apps-gateway-deploy#large-rollouts) |
| Desktop cannot fetch `/user/bootstrap` (404), or is not configured | Missing matching `desktop` policy, wrong `bootstrapUrl`, or unread policy | Check the matching policy's `desktop: {}`, the HKLM value and gateway URL; quit and reopen Desktop | [Desktop overlay](https://code.claude.com/docs/en/claude-apps-gateway-config#claude-desktop-overlay), [registry delivery](https://claude.com/docs/third-party/claude-desktop/mdm#4-deploy-the-configuration) |
| Fingerprint prompt after a certificate change | Leaf certificate no longer matches the pin | Compare the new published fingerprint; for repeated unexpected changes, check ingress certificates and TLS interception | [Certificate pinning](https://code.claude.com/docs/en/claude-apps-gateway#connect-developers) |
| `Administrator policy requires a Cloud gateway sign-in` | API environment variables, an `apiKeyHelper`, or a saved Console API key conflict with policy | Clear those credentials; use `claude auth logout` for a saved key, then start `claude` and run `/login` | [Error reference](https://code.claude.com/docs/en/errors#administrator-policy-requires-a-cloud-gateway-sign-in) |
| Proxy refusal, or certificate pin checks skipped | An HTTPS proxy is on the CLI's gateway route | Add `claude-gateway.corp.contoso.com` to `NO_PROXY` and relaunch; retain other bypass entries | [Proxy and pinning](https://code.claude.com/docs/en/claude-apps-gateway#connect-developers) |
| Gateway rejects requests from a corporate subnet | The source is outside `access_control.allow_cidrs` | Have the operator configure the admitted developer networks; the sample admits `10.40.0.0/16` | config/gateway.azure-private.yaml:68 |

## Related content

- [Overview](overview.md)
- [Configure models, roles and developer access](how-to-admin-configure.md)
- [Developer profile quickstart](quickstart-developer.md)
- [Troubleshoot the developer profile](troubleshoot.md)
- [Deploy the network-restricted gateway](tutorial-deploy-network-restricted.md)
- [Plan capacity for 25,000 developers](concept-plan-for-scale.md)
