# ADR-0005: Network-restricted deployment on Azure: an internal Container Apps environment, deployed by an Azure CLI script

- **Status:** Proposed
- **Date:** 2026-09-29
- **Packet:** P-10 (with P-11, P-14, P-27, P-28 and P-29)
- **Deciders:** owner, Architect seat

## Context

The owner asked for step-by-step documentation of a network-restricted deployment: the gateway on Azure with Claude
models in Microsoft Foundry, and developers who sign in from Claude Code, the VS Code extension and Claude Desktop,
for a rollout to 25,000 developers. The documentation shows each step three ways: the Azure portal with its navigation
path and a screenshot, the Azure CLI, and a script.

Facts this decision rests on:

- `/login` accepts only a gateway whose host name resolves to private addresses, and connects directly, not through
  a proxy ([prerequisites](https://code.claude.com/docs/en/claude-apps-gateway#prerequisites)). The test deployment of
  ADR-0003 has a public address, so the interactive sign-in cannot run against it.
- The login keys `forceLoginMethod` and `forceLoginGatewayUrl` are read only from an admin source, the HKLM registry
  or `C:\Program Files\ClaudeCode\managed-settings.json` on Windows, never from the user-writable HKCU value
  ([managed settings](https://code.claude.com/docs/en/managed-settings#keys-read-from-every-admin-source)). The
  workstation has no administrator rights (U-4), so the sign-in is tested on a VM in the gateway's VNet.
- A Container Apps environment with its own virtual network and an internal virtual IP has no public endpoint; its
  workload-profiles subnet is at least /27 and delegated to `Microsoft.App/environments`; the platform's private DNS
  pattern is a zone named after the environment's default domain with a `*` record for the static IP
  ([custom virtual networks](https://learn.microsoft.com/en-us/azure/container-apps/vnet-custom), checked 2026-09-29).
- A stream of 403.5 seconds passed the Container Apps HTTP ingress and ended with `message_stop` (U-40), so the
  documented 240-second request timeout does not end an active stream.
- A Foundry account exposes three endpoint families, each with its own private DNS zone, through one private endpoint
  with group ID `account` ([private endpoint DNS](https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns#commercial)).
- In this subscription, East US 2 has 40 units of `claude-opus-5` Global Standard quota, all held by the shared
  Foundry account, 40 units of its Data Zone Standard quota free, and 60 of 80 `claude-sonnet-5` Global Standard units
  free (`az cognitiveservices usage list -l eastus2`, 2026-09-29).
- `.ironclad/charter.json` caps a file at 400 lines, and the charter requires a preview before a change to an existing
  Azure resource, because an ARM PUT resets omitted properties.

## Options considered

1. **Container Apps, internal environment** — no public endpoint; the platform terminates TLS; scale rules count
   concurrent HTTP requests; the same service as ADR-0003, so the image, probes and secrets carry over. Costs: a
   delegated subnet, and a DNS zone the corporate network must resolve.
2. **AKS private cluster with an internal load balancer** — full control of timeouts and certificates; costs a
   cluster to operate and patch, which the documentation would have to teach as well.
3. **App Service with a private endpoint** — its front end ends a request after 230 seconds, which cuts long streams.
4. **Container Apps with public ingress limited by IP (ADR-0003)** — rejected for this purpose: `/login` refuses a
   public address, and `gatewayInternalNetworks` admits a public block only when the developer's machine is inside it,
   which cloud egress addresses are not.

For the deployment tool: **an Azure CLI script** (PowerShell 7 with `az`), whose commands are the ones the
documentation's CLI tab shows, against **a Bicep template**, which has `what-if` but would put a second, different
description of each step next to the CLI tab.

## Decision

Option 1, deployed by `infra/azure-private/Deploy-Gateway.ps1`, a PowerShell 7 script that runs one `az` command per
documented action. It creates what is missing and leaves what exists: a resource it finds is not changed, except the
Container App, which `az containerapp update` changes with PATCH semantics, so no ARM PUT resets a property. `-Plan`
reads the subscription and prints each command it would run, without changing anything, as the preview the charter
requires. The script and its helpers stay under 400 lines per file.

The deployment:

| Part | Test deployment | Production guidance in the documentation |
|---|---|---|
| Network | VNet `10.40.0.0/16`: `/23` for the environment, `/24` for private endpoints, `/27` for PostgreSQL, `/27` for the developer VM | Peered to the hub; corporate DNS forwards the gateway's zone to an Azure DNS Private Resolver |
| Gateway | Internal workload-profiles environment, Consumption profile, 2 to 10 replicas, HTTP scale rule | Zone-redundant environment; replica count from P-28 |
| TLS | The environment's default domain and its platform certificate (U-56) | A custom domain with a certificate from the organization's CA and a published fingerprint, because every certificate change shows each developer the trust prompt again |
| Store | PostgreSQL 16 Flexible Server, private access, Burstable B1ms | General Purpose with zone-redundant high availability, sized in P-28 |
| Models | A dedicated Foundry account: private endpoint, public network access and local authentication off; `claude-sonnet-5` Global Standard and `claude-opus-5` Data Zone Standard | Quota per model and region from P-28 (U-59) |
| Image | Azure Container Registry Basic, pulled with the gateway's managed identity; Claude Code 2.1.284, checked against the signed manifest | Premium with a private endpoint; the image built elsewhere and imported |
| Identity | A user-assigned identity with AcrPull and Cognitive Services User; an Entra app with app roles | The same, with app roles assigned to groups (U-24) |
| Developers | A Windows 11 VM in the VNet, reached through Azure Bastion Developer, with a NAT gateway for its outbound traffic | The corporate network over ExpressRoute or VPN |

The gateway's client-address handling changes from ADR-0003: `listen.trusted_proxies` names only the addresses the
Container Apps ingress connects from. Developers' own addresses are private, so trusting every private range would
let a developer set `X-Forwarded-For` and share another address's sign-in limit.

**Amendment, 2026-09-29 (measured).** The decision first named the environment's infrastructure subnet as the
ingress's addresses. `/login` from the test VM then got 403: the gateway logged `access.denied`, reason
`ip_not_allowlisted`, client IP 100.100.0.168. In a workload profile environment the ingress connects from the ranges
the environment reserves, `100.100.0.0/17`, `100.100.128.0/19`, `100.100.160.0/19` and `100.100.192.0/19`, which no
subnet of the VNet may overlap ([custom virtual networks](https://learn.microsoft.com/en-us/azure/container-apps/custom-virtual-networks)),
and puts the client's address rightmost in `X-Forwarded-For`
([ingress headers](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview#http)).
`trusted_proxies` names those four ranges. No developer or app holds such an address, since the platform reserves
them, so a developer still cannot choose the address the gateway sees.

## Consequences

+ The interactive sign-in of Claude Code, the VS Code extension and Claude Desktop runs as developers will run it.
+ Each documented CLI command is one the script runs, and a test checks that the documentation's commands exist in
  the script (T-72).
− The test needs a person to sign in on the developer VM through Bastion; the rest runs unattended.
− A second deployment runs next to ADR-0003's; each has its own teardown.
− The platform certificate of the default domain changes on the platform's schedule, not the operator's (U-56).

## How we'd know this was wrong

- `/login` from the developer VM refuses the gateway, or Claude Code cannot verify the default domain's certificate.
- The gateway cannot reach Foundry through the private endpoint (U-57).
- A stream longer than the measured 403.5 seconds is cut by the ingress under load (T-46 in P-28).
- The script's re-run changes a resource it should have left alone, which the `-Plan` output would show.
