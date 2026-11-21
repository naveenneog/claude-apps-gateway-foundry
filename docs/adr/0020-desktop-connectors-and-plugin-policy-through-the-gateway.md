# ADR-0020: Claude Desktop connectors and plugin policy travel in the gateway's desktop block

- **Status:** Accepted
- **Date:** 2026-11-19
- **Packet:** P-35
- **Deciders:** owner requested a demo and a how-to for plugins, connectors and Claude.ai import and export

## Context

The owner asked how Claude Desktop's plugins, connectors and Claude.ai import and export are configured from this
deployment. Before this ADR, the admin file accepted nine per-role Desktop switches, among them plugin uploads, user-added
marketplaces, desktop extensions and `claudeAiImport.enabled`/`exportEnabled` (ADR-0019). Connectors (MCP servers)
and organization plugin marketplaces were left to device management.

| Fact | Source |
|---|---|
| A gateway policy's `desktop` block takes Claude Desktop keys as flat names; from Claude Code v2.1.232 this includes `managedMcpServers`, as an array. From v2.1.295 most keys of a newer Desktop release need no gateway upgrade. The gateway rejects at boot keys Desktop reads only from MDM, such as `bootstrapUrl`, and empty values. | https://code.claude.com/docs/en/claude-apps-gateway-config#claude-desktop-overlay, read 2026-11-19 |
| The gateway image this repository deploys runs Claude Code 2.1.311. | infra/azure-test/image/Dockerfile (`ARG CLAUDE_VERSION=2.1.311`) |
| Desktop documents `managedMcpServers` (remote `http`/`sse` with `url`, optional `oauth`, `toolPolicy`, `defaultState`, `toolTimeoutSec`; also `stdio`, built-in servers and `policy-only`), `allowedPluginMarketplaces` (`github`, `git` or `url` source, `installationPreference`), `allowedPluginMcpServers` and `deniedPluginMcpServers` (`{serverUrl}` patterns), `isLocalDevMcpEnabled`, `isDesktopExtensionSignatureRequired` and `claudeAiImport.allowedOrganizationUuids`. Each can be returned from a bootstrap server. | https://claude.com/docs/third-party/claude-desktop/configuration (managedMcpServers, allowedPluginMarketplaces, allowedPluginMcpServers, deniedPluginMcpServers, isLocalDevMcpEnabled, claudeAiImport), read 2026-11-19 |
| Desktop marks some fields "Consent required": a bootstrap-delivered value applies only after the user approves it. Among them are a connector's `headers`, `headersHelper`, `oauth.clientSecret`, a `stdio` entry's `command`, `args`, `env` and `envHelper`, and a marketplace's `credentialHelper`. `trustBootstrapDelivery`, settable only by MDM, skips the prompt. | Same page, field labels and `trustBootstrapDelivery`, read 2026-11-19 |
| Every value the renderer writes from the admin file must hold no `$`, because the gateway expands `${VAR}` in any string. A gateway.yaml value is served to every user that policy matches. | scripts/admin/new-gateway-config.mjs:18-25 |

## Options considered

1. **Leave connectors and plugin policy to Intune or Group Policy only.** No code. Every change needs a device-management
   push and does not follow the gateway role, so a role's connectors cannot differ from another role's.
2. **Pass any Desktop key the admin file holds through to gateway.yaml.** Covers everything. It would also carry
   connector headers, OAuth client secrets and local commands into a configuration served to every matched user,
   and the console could not show what an arbitrary key does.
3. **Accept a reviewed subset per role, rendered as JSON flow values, with the rest left to device management.**
   Remote connectors without secrets, organization marketplaces without credentials, plugin server allow and deny
   lists, two booleans and the import organization list.

## Decision

Option 3. Per role, `desktopSettings` also accepts:

- `managedMcpServers`: remote entries only, `transport` `http` or `sse`, with `name`, an `https://` `url`, and optionally
  `oauth: true` (dynamic client registration), `defaultState` `on` or `off`, `toolTimeoutSec` 5 to 3600 and `toolPolicy`
  (tool name or `*` pattern → `allow`, `ask` or `blocked`). No headers, header helpers, OAuth client secrets, `stdio`
  commands or built-in `server` entries.
- `allowedPluginMarketplaces`: `source` `github` (`repo`) or `git`/`url` (`https://` `url`), with optional `ref`,
  `path`, `expectedName`, `manifestSha256` and `installationPreference`. `auto_install` and `required` need a pin: a
  40-character commit SHA in `ref`, or `manifestSha256` for a `url` source. No `credentialKind` or `credentialHelper`.
- `allowedPluginMcpServers` and `deniedPluginMcpServers`: lists of `{ "serverUrl": "https://..." }` patterns.
- `isLocalDevMcpEnabled`, `isDesktopExtensionSignatureRequired`: booleans.
- `claudeAiImport.allowedOrganizationUuids`: a list of UUIDs. `automatic3pImport` stays unsupported (ADR-0019).

Every string in these values is checked like other admin values (no `$`, no control characters). The renderer writes each
structured value as one JSON flow value with its fields in a fixed order, which YAML 1.2 reads as the same data. The
console's Desktop capabilities card edits these values per role, and Review changes lists them.

The excluded fields are those Desktop marks as needing user consent when delivered by a bootstrap server, or that carry
a secret or a command. They remain device-management settings, documented in the how-to.

## Consequences

+ A role's connectors, marketplaces and plugin server limits change with Review changes and Apply and roll out, the
  same path as models, and are recorded in the configuration audit of each gateway revision.
+ Values that would put a secret or a command into gateway.yaml are refused before the gateway sees them.
− Connectors that need headers, a client secret or a local command, and private marketplaces, still need Intune or
  Group Policy. The how-to says so.
− A Desktop release can add or change fields. The validator accepts only the listed fields, so a new field needs a
  change here.

## How we'd know this was wrong

- The gateway refuses a rendered `desktop` block at boot, or `/user/bootstrap` does not return the values (U-144).
- Desktop asks users to approve a connector delivered with only the accepted fields, or ignores it (U-145).
- Customers mostly need connectors with headers or secrets, so the excluded set is the common case.

## Amendment — 2026-11-19: built-in connectors, Cowork egress and a catalog

The customer asked that "Plugins & Connectors need to be available, similar to Claude SaaS, and
`coworkEgressAllowedHosts` needs to include the most widely used domains".

| Fact | Source |
|---|---|
| `managedMcpServers` accepts built-in entries `server: microsoft365` (`tenantId`, `clientId` of the customer's Entra app registration, optional `azureCloud`, `scope`) and `server: github` (`clientId`, optional `host`, `scope`, `toolsets`, `readOnly`). Neither field is marked "Consent required". | https://claude.com/docs/third-party/claude-desktop/configuration (managedMcpServers, built-in servers), read 2026-11-19 |
| `coworkEgressAllowedHosts` set in a policy's `desktop` block replaces the list the gateway derives from `sandbox.network.allowedDomains`. Entries are a host, `*.host` (subdomains only) or `*`. A list other than `*` keeps Claude Code's sandbox on; `*` without `allowedWorkspaceFolders` leaves the Code tab's Bash sandbox off. The list does not govern web search, model requests or MCP servers. | https://code.claude.com/docs/en/claude-apps-gateway-config#claude-desktop-overlay, read 2026-11-19 |
| Desktop does not follow redirects for MCP URLs. On 2026-11-19 the catalog's 14 remote URLs answered without a redirect; 13 publish OAuth metadata with dynamic client registration; Microsoft Learn answers without sign-in. Asana, Box and HubSpot publish no registration endpoint, so they need a client ID and secret, which this ADR excludes. | Live probes of each URL and its `/.well-known/oauth-authorization-server`, 2026-11-19; each catalog entry's `source` in admin-ui/web/desktop-catalog.js |
| `anthropics/claude-plugins-official`, `anthropics/knowledge-work-plugins` and `anthropics/financial-services` each hold `.claude-plugin/marketplace.json`. | `gh api repos/<repo>/contents/.claude-plugin/marketplace.json`, 2026-11-19 |

Decision:

- `managedMcpServers` also accepts the two built-in servers with only the fields above. Other built-ins (for example web
  search, which needs an API key) stay with device management.
- `coworkEgressAllowedHosts` is accepted per role: at most 500 entries, each a host name, `*.host` or `*`, with an optional
  port.
- `admin-ui/web/desktop-catalog.js` lists the probed connectors, the Anthropic marketplaces and about 55 common
  developer hosts (package registries, source hosts, documentation). The console adds them on request; nothing is
  applied until Review changes and Apply and roll out. Each catalog entry must pass the same validation (T-173).

Consequences: an administrator can give a role the connectors and marketplaces users see on Claude.ai in a few clicks.
The catalog is a snapshot; a vendor that moves its MCP URL breaks that connector until the catalog is updated. Users
still sign in to each connector's service themselves.

## Amendment — 2026-11-20: authenticated vendor proof

The owner authorized a Contoso live deployment test, prioritizing Salesforce and Microsoft 365. Existing resources
are repaired before considering replacement, and the Foundry route and stored database are preserved.

The proof has four distinct stages: configuration served by the gateway, configuration applied by Desktop,
client-side network reachability, and an authenticated read-only tool response. A public HTTP or OAuth-discovery
response does not establish vendor authentication or data access.

Microsoft 365 uses delegated user access through a dedicated client registration; application-wide mail or file
permissions are not added for this test. Salesforce's provider-owned client registration requirements remain on the
device-management/local-configuration surface when they are outside the gateway validator's accepted subset.
Connector credentials are not placed in gateway.yaml, source, screenshots or evidence logs.

## Amendment 2 — 2026-11-21: public OAuth client ("Bring your own client") for Salesforce

The owner asked to fix and prove the Salesforce connector. Salesforce's hosted MCP server publishes no dynamic client
registration endpoint (U-146), so `oauth: true` cannot sign in to it.

| Fact | Source |
|---|---|
| A remote `managedMcpServers` entry's `oauth` may be an object in mode `byo` ("Bring your own client") with `clientId`, and optionally `scope` and `appendOfflineAccess`; `mode` can be left out. `clientSecret` is needed "only if the provider requires one"; `oauth.clientSecretHelper` is marked "Consent required". | https://claude.com/docs/third-party/claude-desktop/configuration (managedMcpServers, oauth), read 2026-11-21 |
| A Salesforce External Client App can be a public client with PKCE and no secret, scopes `mcp_api` and `refresh_token`. | https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/create-external-client-app.html |

Decision: `oauth` also accepts `{ mode?: "byo", clientId, scope?, appendOfflineAccess? }`. `clientId` is required and
holds only letters, digits and `. _ : -`; `scope` follows the other string rules. `clientSecret`, `clientSecretHelper`,
`authorizationServer`, tenant and broker fields, and the `hosted` and `dcr` object forms stay refused: a secret in
gateway.yaml would reach every user of the role. The console's **Another remote server** form gains **OAuth with your
client ID (no secret)** with Client ID and Scopes fields (T-180). A client ID is an identifier, not a credential.

Consequence: Salesforce, and other servers that issue public clients, can be delivered per role from the console. A
provider that requires a client secret still needs device management.

Correction, same date (U-151, T-181): the first live T-180 rollout on Contoso failed to activate. The gateway (Claude
Code 2.1.311) logged `managed.policies[0].desktop invalid: managedMcpServers[2].defaultState ignored: not a recognized
sub-key`. The gateway documentation states that most new sub-keys inside a known key need v2.1.321 or later
(https://code.claude.com/docs/en/claude-apps-gateway-config, "Keys the gateway doesn't know", read 2026-11-21).
`defaultState`, accepted since the original decision, is therefore refused with that reason, and the console's
**Starts** choice is removed, until the gateway image moves to 2.1.321 or later. Connectors start on, Desktop's default.
