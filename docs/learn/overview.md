---
title: Claude Code through the Claude apps gateway on Azure
description: How Claude Code on Windows reaches Claude models in Microsoft Foundry through a self-hosted Claude apps gateway on Azure Container Apps, and which scripts set up the gateway, the developer machines and the tests.
author: naveenneog
ms.date: 09/28/2026
ms.topic: overview
---

# Claude Code through the Claude apps gateway on Azure

The Claude apps gateway is a server that Anthropic ships inside Claude Code. It signs developers in through an
OpenID Connect identity provider, applies per-group model access and spend limits, and forwards Messages API requests
to an upstream such as Microsoft Foundry ([Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway)).
This repository runs one on Azure Container Apps in front of a Foundry account, with Microsoft Entra ID as the
identity provider (docs/adr/0003-azure-test-deployment-with-restricted-ingress.md:1).

## How a request flows

```text
Claude Code (developer machine)
  --> Claude apps gateway (Azure Container Apps, ingress limited to one address range)
        --> Microsoft Foundry (claude-opus-5, claude-sonnet-5), called with the gateway's managed identity
```

- The gateway admits a user whose Entra token carries one of its app roles, `Gateway.Standard` or `Gateway.Premium`
  (config/gateway.azure-test.yaml:22-23).
- It issues its own session token, valid for one hour (config/gateway.azure-test.yaml:27), and a refresh token.
- It writes an audit event for each request; an `inference` event names the user, the model and the upstream
  (tests/live/lib.mjs:177).

## Two ways to connect Claude Code

| Route | How Claude Code signs in | Needs | Per-group managed settings reach the client |
|---|---|---|---|
| `/login` with managed settings | Claude Code runs the device flow and keeps the session | A gateway name that resolves to private addresses, and the login keys in a managed settings source on each machine ([prerequisites](https://code.claude.com/docs/en/claude-apps-gateway#prerequisites)) | Yes |
| Developer profile with `apiKeyHelper` | `Connect-ClaudeGateway.ps1` runs the device flow once; `Get-ClaudeGatewayToken.ps1` gives Claude Code the token ([apiKeyHelper](https://code.claude.com/docs/en/settings-reference#apikeyhelper)) | Windows PowerShell 5.1 and Claude Code; no administrator rights | No; the gateway still enforces model access at `/v1/messages` |

The test deployment has a public Container Apps address, so its developers use the profile
(docs/adr/0004-operator-and-developer-tooling.md:15-17). The `/login` payloads are generated for a deployment with a
private address.

## The scripts

ADR-0004 records the design of the scripts and the council's changes to it
(docs/adr/0004-operator-and-developer-tooling.md:44-57).

| Who | Script | What it does |
|---|---|---|
| Operator | `infra/azure-test/deploy.mjs` | Deploys the gateway, its Entra app and its Foundry access to a resource group |
| Operator | `scripts/admin/new-gateway-config.mjs` | Renders the gateway configuration from the admin file: admitted roles, models, per-role model lists |
| Operator | `scripts/admin/set-developer.mjs` | Grants, lists and removes the gateway's app roles for users |
| Operator | `scripts/admin/new-client-policy.mjs` | Writes the `/login` payloads, and separately a developer folder with the Windows scripts |
| Developer | `scripts/developer/Install-ClaudeGatewayProfile.ps1` | Writes the Claude Code profile, then signs in |
| Developer | `scripts/developer/Connect-ClaudeGateway.ps1` | Signs in again; `Disconnect-ClaudeGateway.ps1` signs out |
| Tester | `tests/live/inference-suite.mjs` | Tests Messages API features and Claude Code through the gateway, and times both routes |

## What the developer profile protects

- The session, which holds the refresh token, is encrypted with DPAPI for the Windows user; DPAPI protects it from
  other users and other machines, not from programs that run as that user
  (docs/adr/0004-operator-and-developer-tooling.md:66-67).
- The launcher passes the profile's `gateway.settings.json` with `--settings`, which ranks above a repository's
  settings, and the helper prints the token only when `ANTHROPIC_BASE_URL` names the gateway and no provider switch is
  set. With the launcher, none of ten repository settings files tested sent the token to another host or replaced it
  (docs/adr/0004-operator-and-developer-tooling.md:129-146). A repository whose folder you trust can still run
  commands through hooks (docs/adr/0004-operator-and-developer-tooling.md:167-172).
- The token stays out of the PowerShell event log (docs/adr/0004-operator-and-developer-tooling.md:106-112).
- The profile leaves `%USERPROFILE%\.claude` unchanged, so another route configured there keeps working.

## Data sent and stored

| What | Where it goes or stays |
|---|---|
| Prompts, code and tool results | Claude Code sends them to the gateway, which forwards them to the Foundry deployment (config/gateway.azure-test.yaml:34-47) |
| Sign-in | The browser signs in to Microsoft Entra ID through the gateway's verification page; the script polls the gateway's token endpoint ([RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)) |
| Gateway tokens | `%LOCALAPPDATA%\ClaudeAppsGateway\sessions`, encrypted with DPAPI; the launcher and the helper keep them to the gateway (docs/adr/0004-operator-and-developer-tooling.md:129-146) |
| Audit events | The gateway's console log: request ID, user, model, upstream (tests/live/lib.mjs:177) |
| Claude Code's own requests | In `-p` runs through the profile, Claude Code 2.1.272 sent an MCP registry lookup and event logging to `api.anthropic.com`, neither with the gateway token (docs/UNKNOWNS.md:60). `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turns off such traffic ([environment variables](https://code.claude.com/docs/en/env-vars)) |

Anthropic's data use for Claude Code under commercial terms is in [data usage](https://code.claude.com/docs/en/data-usage).
## Related content

- [Tutorial: deploy on Azure in a network-restricted environment](tutorial-deploy-network-restricted.md)
- [Connect Claude Code, VS Code and Claude Desktop](how-to-connect-clients.md)
- [Plan capacity for 25,000 developers](concept-plan-for-scale.md)
- [Quickstart: connect Claude Code on Windows](quickstart-developer.md)
- [Configure models, roles and developer access](how-to-admin-configure.md)
- [Run the inference tests](how-to-test-inference.md)
- [Script reference](reference-scripts.md)
- [Troubleshoot the developer profile](troubleshoot.md)
- [Comparison with the APIM gateway accelerator](../GATEWAY-COMPARISON.md)
