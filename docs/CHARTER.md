# claude-apps-gateway-foundry — Charter

> The prose half of the contract. The machine-checkable half is `.ironclad/charter.json`,
> enforced by `node .ironclad/gate.mjs`. When the two disagree, one of them is a bug.

## What this is

A planning and evaluation workspace for running Claude Code (CLI, VS Code extension, Claude Desktop)
against Claude models deployed in Microsoft Foundry through Anthropic's self-hosted
[Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway), and for comparing that
route with the Azure API Management (APIM) gateway already built in
[naveenneog/claude-code-foundry-gateway](https://github.com/naveenneog/claude-code-foundry-gateway), whose APIM
accelerator adds budgets, chargeback and workbooks.

## Goals

1. A Claude apps gateway instance serves inference from the existing Foundry Claude deployments, with
   Microsoft Entra ID sign-in and per-group model access, first on one machine, then privately on Azure.
2. Every behaviour the pilot depends on is covered by a test case in `docs/TEST-PLAN.md` that has a
   negative counterpart and a cited source for the expected result.
3. The same scenario set runs against the APIM route and the gateway route, and the measured results
   decide ADR-0002.
4. Every claim in the comparison cites a document URL or a `path:line` in the existing APIM code.

## Non-goals

- Replacing the APIM gateway before ADR-0002 is accepted. APIM stays the production route during the pilot.
- CI and other unattended workloads through the Claude apps gateway. The gateway has no service-token
  flow ([CI pipelines](https://code.claude.com/docs/en/claude-apps-gateway#ci-pipelines-and-remote-machines)).
- Non-Claude models. Claude Code does not support routing to non-Claude models through any gateway
  ([gateways](https://code.claude.com/docs/en/gateways#other-gateways)).
- A Helm chart or admin UI. Neither exists for the gateway
  ([availability](https://code.claude.com/docs/en/claude-apps-gateway#availability-and-limitations)).

## Constraints

- The gateway server runs on Linux only. On this machine `claude gateway` exits with
  "claude gateway is not supported on Windows" (Claude Code 2.1.272, probe run 2026-09-23).
- Claude Code signs in only to a gateway whose hostname resolves to private addresses, or to loopback
  over `http://` ([prerequisites](https://code.claude.com/docs/en/claude-apps-gateway#prerequisites)).
- The gateway needs PostgreSQL 14 or later and one OIDC issuer; Entra ID is the issuer here
  ([config](https://code.claude.com/docs/en/claude-apps-gateway-config#oidc)).
- No secrets in this repository. `gateway.yaml` references secrets through `${VAR}` or `${file:/path}`
  ([secret expansion](https://code.claude.com/docs/en/claude-apps-gateway-config#secret-expansion)).
- Changes to existing Azure resources run `az deployment group what-if` first; an ARM PUT resets
  omitted properties.
- Documentation uses plain factual statements with references.

## Quality bar

| Dimension | Bar |
|---|---|
| Tests | Test-first. Every packet has test cases in `docs/TEST-PLAN.md`; every check has a negative counterpart. |
| Evidence | Every comparison row, researched unknown, test case and sourced ARCHITECTURE row cites a URL or `path:line` (`tests/ledger.test.mjs`); `tests/mutate-ledger.ps1` shows each rule fails when broken. |
| Security | Secrets only in Key Vault or environment; the gateway stays unreachable from the internet; `access_control.allow_cidrs` set. |
| Docs | ADR for every significant decision; STATUS and CHANGELOG updated per packet. |

## Definition of done (a packet is done when all are true)

- [ ] Acceptance criteria in `docs/STATUS.md` are met, each with a test
- [ ] Tests pass; nothing skipped, `.only`'d, deleted or weakened
- [ ] Council verdicts recorded (Architect · Coder · QA · UX · Security)
- [ ] `node .ironclad/gate.mjs --stage packet` exits 0
- [ ] Unknowns for this packet closed (RESEARCHED / ASSUMED-with-detector / RESOLVED)
- [ ] ADR written if the decision was significant
- [ ] CHANGELOG and README updated where behaviour or usage changed
- [ ] Committed, with the hash recorded in `docs/STATUS.md`

## Stack

Markdown ledger and Node.js (`node:test`, no dependencies) for ledger checks. Later packets add
YAML (`gateway.yaml`), Bicep, and PowerShell 7 test scripts.

## Commands

```
test       node --test tests/*.test.mjs
gate       node .ironclad/gate.mjs --stage packet
```
