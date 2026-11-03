# ADR-0017: The gateway and the console are open to every address by default; an IP range is opt-in

- **Status:** Accepted
- **Date:** 2026-11-03
- **Packet:** P-47 · **Unknowns:** U-134 · **Amends:** ADR-0003 (ingress restriction)
- **Deciders:** owner (2026-11-03: "We don't want IP restriction"; "no ip restriction should be choosen by installer
  itself"; "allow all as default option with ip restriction opt in"), agent

## Context
ADR-0003 limits the test topology to one public range: the gateway's ingress rule `tester-egress`, the gateway's own
`access_control.allow_cidrs` read from `TESTER_CIDR`, and the console's `allowed-cidr` rule. `assertTesterCidr` refuses
anything wider than `/24` (infra/azure-test/lib/plan.mjs:43-54). Developers who connect from many networks cannot use a
range that narrow.

| Fact | Source |
|---|---|
| Container Apps with no `ipSecurityRestrictions` accept every address. | https://learn.microsoft.com/en-us/azure/container-apps/ip-restrictions |
| The gateway admits only signed-in users holding a gateway app role, enforces spend caps per user, and rate-limits sign-ins per address. | https://code.claude.com/docs/en/claude-apps-gateway-config ; ADR-0003 |
| The console admits only accounts with `AdminUi.Admin` when sign-in is on (the installer's default). | docs/adr/0011-admin-ui-is-admin-only-with-sign-in.md |

## Decision
Revised 2026-11-03 from an opt-in `-AllowAnyAddress` switch to open by default.

| Install | Gateway | Console |
|---|---|---|
| New install, no range given | No IP rule; deploy.mjs gets `--any-address`, which renders `TESTER_CIDR` as `0.0.0.0/0` | No IP rule (`allowAnyAddress`); sign-in with `AdminUi.Admin` required |
| `-TesterCidr <range>` | Ingress rule and allow list limited to the range (`/24` or narrower, as before) | Unchanged by `-TesterCidr` |
| `-AllowedCidr <range>` | Unchanged | Limited to the range |
| `-NoSignIn` | Unchanged | Requires `-AllowedCidr` or `-TesterCidr`; never open |
| A later run with no range option | Keeps the range in the state file (`testerCidr`; `0.0.0.0/0` means open) | Keeps `consoleAnyAddress` from the state file; an install from before this ADR, which recorded only a range, keeps that range |

`-GatewayAllowAnyAddress` and `-ConsoleAllowAnyAddress` reopen an app that an earlier run limited. Each is refused with
the matching range option, and `-ConsoleAllowAnyAddress` is refused with `-NoSignIn`; a refusal runs nothing. The
installer prints `gateway: open to every address` and `admin console: open to every address` when they apply.
`ingressRange` (infra/azure-test/lib/plan.mjs) keeps `assertTesterCidr`'s `/24` limit for a range, so `0.0.0.0/0` is
only reached through `--any-address`.

U-134 was resolved on 2026-11-03: gateway 2.1.308 in WSL booted with `allow_cidrs: ["0.0.0.0/0"]` and answered a request
from the WSL eth0 address (not loopback) with 401 (`auth.denied`, `missing_token`); with `["198.51.100.0/24"]` the same request got 403
(`access.denied`, `ip_not_allowlisted`).
## Consequences
+ Developers connect from any network; sign-in, roles, the admin-only console and spend caps still apply.
- The sign-in pages and the model endpoint can be reached and probed from the internet.

## How we'd know this was wrong
Sign-in probing or abuse shows up in the gateway's `auth.denied` events, or a security review asks for a network
boundary; then `-TesterCidr`/`-AllowedCidr` or the network-restricted topology (ADR-0005) is the answer.
