---
title: Give Claude Desktop connectors, plugins, Claude.ai import and Cowork network access
description: Deliver Claude Desktop connectors (MCP servers), organization plugin marketplaces, Claude.ai import and export, and Cowork's allowed network hosts per gateway role, from the admin console of the Claude apps gateway on Microsoft Foundry.
author: naveenneog
ms.date: 11/20/2026
ms.topic: how-to
---

# Give Claude Desktop connectors, plugins, Claude.ai import and Cowork network access

Claude Desktop reads its managed settings from the gateway when a user signs in. Each gateway role carries its own
`desktop` block, so one role can have a different set of connectors, plugin marketplaces and network hosts from
another ([gateway Desktop overlay](https://code.claude.com/docs/en/claude-apps-gateway-config#claude-desktop-overlay)).
The admin console edits these settings under **Access & models** > **Desktop capabilities**. Which settings the
console accepts, and why the others stay with device management, is recorded in
docs/adr/0020-desktop-connectors-and-plugin-policy-through-the-gateway.md:1.

| Claude.ai feature | Gateway setting per role | Console section |
|---|---|---|
| Connectors such as Atlassian, Notion or Figma | `managedMcpServers` | Connectors (MCP servers) |
| Microsoft 365 and GitHub connectors | `managedMcpServers` entries with `server: microsoft365` or `server: github` | Built-in Microsoft 365 or GitHub |
| Organization plugins | `allowedPluginMarketplaces` | Organization plugin marketplaces |
| User-added plugins and marketplaces | `userPluginUploadsEnabled`, `userPluginMarketplacesEnabled` | Switches at the top of the card |
| Limits on servers that plugins start | `allowedPluginMcpServers`, `deniedPluginMcpServers` | Plugin servers and import sources |
| Import of a Claude.ai export, export to another device | `claudeAiImport.enabled`, `claudeAiImport.exportEnabled`, `claudeAiImport.allowedOrganizationUuids` | Switches, and Plugin servers and import sources |
| Cowork's network access | `coworkEgressAllowedHosts` | Cowork network access |

Field definitions: [Claude Desktop configuration reference](https://claude.com/docs/third-party/claude-desktop/configuration).

## Prerequisites

| Item | Requirement | Source |
|---|---|---|
| Gateway | Claude Code 2.1.232 or later for `managedMcpServers` in the `desktop` block; this repository's image runs 2.1.311 | [gateway Desktop overlay](https://code.claude.com/docs/en/claude-apps-gateway-config#claude-desktop-overlay); infra/azure-test/image/Dockerfile |
| Claude Desktop | 1.2581.0 or later for managed connectors, 1.10628.0 for Claude.ai import, 1.37937.0 for the user plugin switches | [Desktop configuration reference](https://claude.com/docs/third-party/claude-desktop/configuration) |
| Role | Claude Desktop turned on for the role in **Access & models** > **Role access** | [Enable import, plugins and extensions](how-to-admin-configure.md#enable-import-plugins-and-extensions) |
| Console | AdminUi.Admin and the write permissions in **Settings** > **Permissions** | [Use the admin console](how-to-use-admin-console.md) |

## Add connectors

Desktop adds each listed connector for every user of the role. Users sign in to the service the first time they use
it and can turn a connector off. A connector with `oauth: true` signs in through the service's dynamic client
registration, with the callback `http://127.0.0.1:53280/callback` on the user's machine. Desktop does not follow
redirects for MCP URLs ([managedMcpServers](https://claude.com/docs/third-party/claude-desktop/configuration)).

1. In **Desktop capabilities**, open the role.
2. Under **Connectors (MCP servers)** > **From the catalog**, choose a connector and select **Add**, or select
   **Add all catalog connectors**.
3. For a server that is not in the catalog, fill **Another remote server**: a name, an `https://` URL, the transport
   (Streamable HTTP or SSE) and the sign-in (none, OAuth with automatic registration, or OAuth with your client ID). Connectors start on; `defaultState` is refused because this gateway image (Claude Code 2.1.311) rejects it at boot, and new sub-keys need 2.1.321 (docs/UNKNOWNS.md:162).
4. Select **Review changes**, check the `managedMcpServers` line, and select **Apply and roll out**.

The catalog in `admin-ui/web/desktop-catalog.js` holds the connectors below. On 2026-11-19 each URL answered without a
redirect, and each OAuth server published dynamic client registration; a test fails if an entry stops passing the
admin file's validation (docs/TEST-PLAN.md T-173).

| Connector | URL | Sign-in | Covers | Vendor documentation |
|---|---|---|---|---|
| Atlassian | `https://mcp.atlassian.com/v2/mcp` | OAuth | Jira, Confluence | [support.atlassian.com](https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/) |
| Notion | `https://mcp.notion.com/mcp` | OAuth | Pages and databases | [developers.notion.com](https://developers.notion.com/guides/mcp/overview) |
| Linear | `https://mcp.linear.app/mcp` | OAuth | Issues and projects | [linear.app](https://linear.app/docs/mcp) |
| monday.com | `https://mcp.monday.com/mcp` | OAuth | Boards and items | [developer.monday.com](https://developer.monday.com/api-reference/docs/mondaycom-mcp) |
| Figma | `https://mcp.figma.com/mcp` | OAuth | Design files | [developers.figma.com](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/) |
| Canva | `https://mcp.canva.com/mcp` | OAuth | Designs | [canva.com](https://www.canva.com/help/mcp-agent-setup/) |
| Sentry | `https://mcp.sentry.dev/mcp` | OAuth | Errors and issues | [mcp.sentry.dev](https://mcp.sentry.dev) |
| Stripe | `https://mcp.stripe.com` | OAuth | Payments data | [docs.stripe.com](https://docs.stripe.com/mcp) |
| Intercom | `https://mcp.intercom.com/mcp` | OAuth | Conversations (US region) | [developers.intercom.com](https://developers.intercom.com/docs/guides/mcp) |
| Webflow | `https://mcp.webflow.com/mcp` | OAuth | Sites and CMS | [developers.webflow.com](https://developers.webflow.com/mcp/reference/how-it-works) |
| Vercel | `https://mcp.vercel.com` | OAuth | Projects and deployments | [vercel.com](https://vercel.com/docs/agent-resources/vercel-mcp) |
| Cloudflare | `https://mcp.cloudflare.com/mcp` | OAuth | Cloudflare API | [developers.cloudflare.com](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/) |
| Zapier | `https://mcp.zapier.com/api/mcp/mcp` | OAuth | Actions across apps | [docs.zapier.com](https://docs.zapier.com/mcp/home) |
| Microsoft Learn | `https://learn.microsoft.com/api/mcp` | None | Microsoft documentation | [learn.microsoft.com](https://learn.microsoft.com/en-us/training/support/mcp-developer-reference) |

Asana, Box and HubSpot publish no dynamic client registration endpoint, so they need an OAuth client ID and secret.
A client secret in gateway.yaml would be served to every user of the role, so the console refuses it; deliver these
connectors with device management (docs/adr/0020-desktop-connectors-and-plugin-policy-through-the-gateway.md:1).

### Microsoft 365 and GitHub

These connectors are built into Desktop. Under **Built-in Microsoft 365 or GitHub**:

- **Microsoft 365** needs the directory (tenant) ID and the application (client) ID of an app registration in your
  Microsoft Entra tenant. US Government clouds need your own app registration and `azureCloud`.
- **GitHub** needs the client ID of a GitHub OAuth app with device flow enabled, or of a GitHub App. `host` names a
  GitHub Enterprise Server; blank means github.com.

The console writes `name`, `server`, `tenantId` and `clientId`. The admin file also accepts `azureCloud` and `scope`
for Microsoft 365, and `host`, `scope`, `toolsets` and `readOnly` for GitHub; `continuousAccessEvaluation` is not
accepted ([built-in servers](https://claude.com/docs/third-party/claude-desktop/configuration)).

### Microsoft 365 local-mode registration and proof

The local connector runs on the user's device and calls Microsoft Graph directly. Unlike the remote connector,
it needs no Anthropic tenant allowlisting. Its dedicated Entra app registration has **Accounts in this organizational
directory only**, a **Mobile and desktop applications** redirect of `http://localhost`, and **Allow public client
flows** enabled. It has delegated Graph scopes, not application-wide mailbox or file permissions. The remote
connector's client registration is separate and is not reused
([local connector setup](https://claude.com/docs/third-party/claude-desktop/connectors-m365#local-connector)).
On Windows, brokered sign-in also uses
`ms-appx-web://Microsoft.AAD.BrokerPlugin/<application-client-id>` on the same public-client registration
([broker registration](https://claude.com/docs/third-party/claude-desktop/entra-broker#register-the-entra-id-application)).

For a small read-only pilot, the registration and the connector's `scope` can both contain `User.Read Mail.Read`.
The built-in connector also requests `User.Read` and `offline_access`. This tests the user's profile and mailbox
without enabling send, edit or delete tools. A wider production read set is listed in the same guide.

After the user selects **Connect**, `get_me` proves authenticated access to that user's Graph profile, and
`get_granted_scopes` identifies the delegated access actually granted. `outlook_email_search` is a separate mailbox
test: a successful profile call does not prove that an unlicensed account has an Exchange mailbox.

The device needs HTTPS egress to `login.microsoftonline.com` and `graph.microsoft.com`. File reads also need the
tenant's SharePoint and OneDrive hosts, and the download host Microsoft returns for that file. These are client
network requirements, not `coworkEgressAllowedHosts` entries
([local-mode egress](https://claude.com/docs/third-party/claude-desktop/connectors-m365#allow-the-required-network-hosts-for-local-mode)).

### Salesforce hosted MCP

Salesforce's read-only hosted server is
`https://api.salesforce.com/platform/mcp/v1/platform/sobject-reads`. Sandbox and scratch-org URLs include
`/v1/sandbox/`. An External Client App in the authorized Salesforce org supplies its Consumer Key, a public OAuth
client ID, and the `mcp_api` and `refresh_token` scopes. A public-client setup needs no client secret
([Salesforce client setup](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/create-external-client-app.html),
[server URLs](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/server-urls.md)).

For **Claude Desktop on third-party inference**, its default callback is `http://127.0.0.1:53280/callback`.
Salesforce's general Claude guide instead describes the SaaS callback `https://claude.ai/api/mcp/auth_callback`;
that hosted callback is not the managed Desktop 3P flow
([Desktop MCP sign-in](https://claude.com/docs/third-party/claude-desktop/mcp-sign-in#choose-the-oauth-setting)).

Salesforce publishes protected-resource and authorization-server metadata but no dynamic client registration
endpoint in that metadata. The connector therefore needs **Bring your own client**, not automatic registration.
In **Desktop capabilities** > **Another remote server**, set **Sign-in** to **OAuth with your client ID (no secret)**,
**OAuth client ID** to the External Client App's Consumer Key and **OAuth scopes** to `mcp_api refresh_token`. The
console refuses a client secret, a secret helper and the `hosted` mode, because gateway.yaml is served to every user
of the role (docs/adr/0020-desktop-connectors-and-plugin-policy-through-the-gateway.md:1). The admin file holds:

```json
{
  "name": "Salesforce (read only)",
  "transport": "http",
  "url": "https://api.salesforce.com/platform/mcp/v1/platform/sobject-reads",
  "oauth": { "mode": "byo", "clientId": "<Salesforce External Client App Consumer Key>", "scope": "mcp_api refresh_token" },
  "toolPolicy": { "*": "ask" }
}
```
The device's network allowlist includes `api.salesforce.com`, `login.salesforce.com` for production or
`test.salesforce.com` for sandbox sign-in, and the org's My Domain host when applicable. A 401 from the public MCP
endpoint proves reachability and an authentication requirement, not successful Salesforce access.

## When Desktop applies a change

Desktop reads the gateway's settings when it starts and about every ten minutes. On Desktop 6.28899.6.0, `userPluginMarketplacesEnabled` and `userPluginUploadsEnabled` took effect at once; changes to `managedMcpServers`, `allowedPluginMarketplaces`, `isDesktopExtensionEnabled` and `skillCreationEnabled` took effect after Desktop restarted, which it asks the user to do (docs/UNKNOWNS.md:163).

From a marketplace, Desktop installs only the plugins whose source is inside the marketplace repository. On 2026-11-21 that was 55 of the 317 in `anthropics/claude-plugins-official`, 22 of 123 in `anthropics/knowledge-work-plugins` and all 19 in `anthropics/financial-services` (docs/UNKNOWNS.md:163).

The Cowork network list does not apply to Claude Code shell commands on Windows, where Claude Code has no sandbox (docs/UNKNOWNS.md:163).
## Make plugins available

1. Under **Organization plugin marketplaces**, select **Add Anthropic marketplaces** to list
   `anthropics/claude-plugins-official`, `anthropics/knowledge-work-plugins` and `anthropics/financial-services`. Each
   repository holds `.claude-plugin/marketplace.json` (checked with `gh api` on 2026-11-19).
2. To add your own marketplace, choose **GitHub repository**, **Git URL** or **marketplace.json URL**, enter its
   location and, optionally, a branch, tag or commit.
3. To let users add their own plugins or marketplaces, set **Allow plugin uploads** or **Allow user-added plugin
   marketplaces** to **Enabled**. When off, Desktop hides marketplaces your organization did not add.
4. To limit the MCP servers that plugins may start, enter one `https://` pattern per line in **Allowed plugin MCP
   servers** or **Blocked plugin MCP servers**. A blocked pattern applies even when an allowed pattern matches.

Marketplaces appear in Desktop's Directory on the Organization tab. `installationPreference` `auto_install` or
`required` in the admin file needs a pinned 40-character commit in `ref`, or `manifestSha256` for a URL source
([allowedPluginMarketplaces](https://claude.com/docs/third-party/claude-desktop/configuration)). The switches do not
limit Claude Code in a terminal, which reads its own managed settings.

## Import and export Claude.ai conversations

| Step | Who | Where |
|---|---|---|
| Set **Allow Claude.ai import** (`claudeAiImport.enabled`) to **Enabled** for the role, and **Allow session export** (`claudeAiImport.exportEnabled`) to allow a zip to move to another device | Administrator | Desktop capabilities |
| Optional: limit imports to your Claude.ai organizations in **Claude.ai organizations users may import from**, one UUID per line. Users then import by sign-in only. | Administrator | Plugin servers and import sources |
| On a Team or Enterprise plan, an owner turns on **Allow members to export their own data** | Claude.ai owner | Claude.ai organization settings |
| Export the chats from **Settings** > **Privacy** > **Export data**; a download link arrives by e-mail | User | claude.ai or Claude Desktop signed in to Claude.ai |
| Import the export in **Settings** > **Import & export** | User | Claude Desktop signed in through the gateway |

Sources: [export your Claude data](https://support.claude.com/en/articles/9450526-how-can-i-export-my-claude-data),
[claudeAiImport](https://claude.com/docs/third-party/claude-desktop/configuration), and
[move from Claude Enterprise to Claude Desktop on a cloud provider](https://support.claude.com/en/articles/18426225-move-from-claude-enterprise-to-claude-desktop-on-a-cloud-provider).

The import brings over the user's own chats and projects and Cowork and Code sessions already on the computer. It does
not bring file contents, other users' content or cloud sessions, and it can be run again without duplicates. Imported
tasks, plugins and skills arrive turned off. An export zip can contain passwords or API keys from local MCP server
commands. `automatic3pImport` is not set by the console (ADR-0019).

## Allow Cowork network access

Under **Cowork network access**, enter one host per line: `github.com`, `*.github.com` or `*`. **Add common domains**
adds about 55 hosts for package registries (PyPI, npm, crates.io, Maven, NuGet, Go), source hosts (GitHub, GitLab,
Bitbucket), container registries (Docker Hub, Microsoft Container Registry), Microsoft and Azure endpoints and
documentation sites. **Allow all hosts (\*)** replaces the list with `*`. **Clear** removes the setting.

| Behavior | Source |
|---|---|
| A list in the role's `desktop` block replaces the one the gateway derives from `sandbox.network.allowedDomains` | [gateway Desktop overlay](https://code.claude.com/docs/en/claude-apps-gateway-config#claude-desktop-overlay) |
| `*.example.com` matches subdomains only; list `example.com` as well for the apex host | Same |
| A list other than `*` keeps Claude Code's sandbox on; `*` without `allowedWorkspaceFolders` leaves the Code tab's Bash sandbox off | Same |
| The list does not govern web search, model requests or MCP connectors | Same |

The console refuses a URL with a scheme or path, and the gateway admin file accepts at most 500 entries
(scripts/admin/desktop-settings.mjs:113-115).

## Settings that stay with device management

The console refuses these values because Desktop asks each user to approve them when a bootstrap server delivers them,
or because they hold a secret or a command that gateway.yaml would serve to every user of the role
(docs/adr/0020-desktop-connectors-and-plugin-policy-through-the-gateway.md:1):

- connector `headers`, `headersHelper` and OAuth client secrets;
- local `stdio` connectors (`command`, `args`, `env`);
- private marketplaces with `credentialHelper` or `credentialKind`;
- the web search built-in connector, which needs an API key;
- `trustBootstrapDelivery`, which skips the per-user approval for bootstrap-delivered connectors and is read only from
  device management.

Deliver them with Intune or Group Policy, as in [Connect Claude Code, VS Code and Claude Desktop](how-to-connect-clients.md).
Whether Desktop asks users to approve a connector that has only the accepted fields is recorded as an assumption,
U-145 in docs/UNKNOWNS.md:156, with manual check T-175.

## Admin file example

The console writes the same values to the role's `desktopSettings` in the admin file:

```json
{
  "role": "Gateway.Premium",
  "models": ["claude-sonnet-5"],
  "desktop": true,
  "desktopSettings": {
    "userPluginUploadsEnabled": true,
    "userPluginMarketplacesEnabled": true,
    "claudeAiImport": { "enabled": true, "exportEnabled": true },
    "managedMcpServers": [
      { "name": "Atlassian", "transport": "http", "url": "https://mcp.atlassian.com/v2/mcp", "oauth": true },
      { "name": "Microsoft Learn", "transport": "http", "url": "https://learn.microsoft.com/api/mcp" },
      { "name": "Microsoft 365", "server": "microsoft365", "tenantId": "<tenant-guid>", "clientId": "<app-guid>" }
    ],
    "allowedPluginMarketplaces": [{ "source": "github", "repo": "anthropics/claude-plugins-official" }],
    "coworkEgressAllowedHosts": ["pypi.org", "files.pythonhosted.org", "github.com", "*.github.com"]
  }
}
```

The renderer writes each list as one JSON value in the policy's `desktop` block of gateway.yaml, which YAML 1.2 reads
as the same data; values containing `$` are refused because the gateway expands `${VAR}`
(scripts/admin/desktop-settings.mjs:199).

## What live verification establishes

The checks follow the [Microsoft 365 local connector guide](https://claude.com/docs/third-party/claude-desktop/connectors-m365#local-connector)
and the [managed MCP sign-in guide](https://claude.com/docs/third-party/claude-desktop/mcp-sign-in).

| Check | What a passing result establishes |
|---|---|
| A healthy gateway revision and `/user/bootstrap` returning the connector settings | The deployment accepts and serves the configuration |
| The connector appearing in Desktop, with no dropped-entry error | Desktop applies the configuration |
| A client-side HTTPS request reaching the expected host and protocol endpoint | Network reachability; an expected 401 or 403 still does not prove authentication |
| MCP initialization and a tool list | The actual server starts and exposes its tools; this can succeed before sign-in |
| Microsoft 365 `get_me` with a successful tool result for the intended user | Authenticated Graph profile access, not mailbox or file access |
| A successful read-only Salesforce tool result from the intended org | Authenticated Salesforce connector access |

An OAuth prompt, a pending consent request, an error tool response, or a missing Salesforce External Client App is
an incomplete live test. Gateway inference health is also checked separately, so successful connector delivery
does not conceal a failing Foundry credential.

### Recorded live test, 2026-11-20

The Contoso test deployment was repaired without deleting its resources. Its authenticated admin save, managed
database, gateway connector bootstrap and unchanged Foundry inference route were verified. The M365 public client
uses only delegated `User.Read Mail.Read`.

An isolated protocol test of the installed Desktop's M365 server passed initialization and its 11-tool list, but
its `get_me` call remained in interactive sign-in.
Salesforce endpoint and OAuth metadata checks passed, but no org and External Client App Consumer Key were available
for an authenticated call. Neither vendor connector is recorded as authenticated. Tenant-specific SharePoint,
OneDrive and Salesforce My Domain endpoint access also remains unverified.

The [live test record](../TEST-PLAN.md#results-p-35-live-connectors-2026-11-20) separates these outcomes.

## Related content

- [Configure models, roles and developer access](how-to-admin-configure.md)
- [Use the admin console](how-to-use-admin-console.md)
- [Connect Claude Code, VS Code and Claude Desktop](how-to-connect-clients.md)
- [Claude Desktop configuration reference](https://claude.com/docs/third-party/claude-desktop/configuration)
- [Claude apps gateway configuration](https://code.claude.com/docs/en/claude-apps-gateway-config)
