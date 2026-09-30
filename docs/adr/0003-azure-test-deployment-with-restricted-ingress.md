# ADR-0003: Test deployment on Azure Container Apps, ingress limited to the tester

- **Status:** Accepted
- **Date:** 2026-09-23
- **Packet:** P-2, P-3, P-4 (re-planned from the WSL2 plan); P-10 keeps the private design
- **Deciders:** project owner (request of 2026-09-23: run the gateway in an Azure container and test it)

## Context

- The gateway server runs on Linux only. This machine has no Linux runtime, and the session has no
  administrator rights, which installing WSL2 needs (U-4).
- The private design in P-10 needs a network path from the developer machine into a VNet (U-14). This
  machine has none today.
- Claude Code's `/login` accepts a gateway only on a private or loopback address
  ([prerequisites](https://code.claude.com/docs/en/claude-apps-gateway#prerequisites)). The keys that
  turn gateway sign-in on, `forceLoginMethod` and `forceLoginGatewayUrl`, are read only from the
  machine-wide managed settings file or the HKLM policy key
  ([managed settings](https://code.claude.com/docs/en/managed-settings)), and both need administrator
  rights to write.
- Measured in the tenant on 2026-09-23 (U-1): members may register apps; password credentials are
  limited to 30 days and must be system-generated; user consent covers `openid`, `profile`, `email`
  and `offline_access` for apps registered in the tenant.
- An app that requires user assignment accepts no user consent and needs tenant-wide admin consent
  (U-39). The tester holds no directory role.
- Container Apps HTTP ingress has a documented request timeout of 240 seconds (U-40).
- The tester's egress address changed between samples: 34 samples returned eight addresses from
  203.0.113.25 to 203.0.113.32 (U-33).
- The tester's own Claude Code settings select the APIM route (U-38).

## Options considered

1. **WSL2 on this machine** (the earlier P-3). Not available: no distribution is installed, and
   installing one needs administrator rights.
2. **Container Apps with external ingress limited to the tester's range.** `public_url` is the app's
   own HTTPS address. A script drives the device flow and the browser leg, and Claude Code uses the
   minted session token through `ANTHROPIC_AUTH_TOKEN`, which Claude Code sends as
   `Authorization: Bearer` ([connect](https://code.claude.com/docs/en/llm-gateway-connect#set-the-credential-variable)).
3. **Option 2 plus a loopback forwarder on the laptop**, with `public_url: http://localhost:8080`, so
   that a later administrator-run `/login` passes the loopback rule. It adds a component that rewrites
   the `Host` header, and `/login` still needs administrator rights on the laptop.
4. **Internal Container Apps environment** (the P-10 design). No path into the VNet from this machine.
5. **Azure Container Instances with a public IP.** No ingress allow list and no managed TLS.

## Decision

Option 2. It is the only option that runs the real gateway binary against the real Entra tenant and
Foundry account from this machine without administrator rights. Options 3 and 4 stay available for
P-11 and P-10.

| Property | Setting | Source |
|---|---|---|
| Runtime | Container Apps consumption environment in a new resource group `rg-claude-apps-gateway-test`, East US 2; single revision mode; one replica (minimum and maximum); no redeployment while a device-flow test runs | https://learn.microsoft.com/en-us/azure/container-apps/revisions |
| Image | Built by ACR Tasks. Claude Code 2.1.280 for `linux-x64`, checked by `verify-release.sh` against the GPG-signed `manifest.json` and a SHA-256 pinned in the Dockerfile; base image pinned by digest; runs as UID 10001 | https://code.claude.com/docs/en/claude-apps-gateway-deploy#container-image ; https://code.claude.com/docs/en/setup#binary-integrity-and-code-signing |
| Store | PostgreSQL 16 sidecar in the same replica, listening on 127.0.0.1 only, data on a replica-scoped `EmptyDir` volume, which survives a container restart but not a new replica | https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts |
| Network | Ingress allow list and the gateway's own `access_control.allow_cidrs`, both 203.0.113.0/26; `listen.trusted_proxies` set to the private ranges the ingress connects from (U-32) | https://learn.microsoft.com/en-us/azure/container-apps/ip-restrictions ; https://code.claude.com/docs/en/claude-apps-gateway-config#http-tuning |
| Sign-in | Entra app that does not require assignment (U-39); the tester holds `Gateway.Standard`; the gateway admits only ID tokens whose `roles` hold `Gateway.Standard` or `Gateway.Premium` (`groups_claim: roles`, `allowed_groups`) and whose email is in `allowed_email_domains` | https://code.claude.com/docs/en/claude-apps-gateway-config#oidc |
| Upstream | `provider: foundry` on `ai-contosohub530569751908`, `use_azure_ad: true` through a user-assigned identity with Cognitive Services User on that account only; the two models the account deploys, and no others | https://code.claude.com/docs/en/claude-apps-gateway-config#microsoft-foundry |
| Secrets | Client secret with a 7-day end date, JWT secret from 32 random bytes and database password, held only in the Container App's secret store; the deploy tool sends them in HTTPS request bodies and never on a command line, in a log or to disk; the config file is mounted only into the gateway container | https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets |
| Logs | Console logs to a Log Analytics workspace with 30-day retention and `immediatePurgeDataOn30Days` | https://learn.microsoft.com/en-us/azure/azure-monitor/logs/data-retention-configure |
| Cleanup | The deploy tool records non-secret identifiers of what it creates (resource group, app and service principal IDs, the cross-group role assignment) in a git-ignored state file; teardown deletes those items only when the resource group's `runId` tag matches the file | https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-template |

## Consequences

+ The real binary, IdP, managed identity and Foundry deployments are exercised end to end (P-2 to P-4).
+ One command deploys (`node infra/azure-test/deploy.mjs`) and one removes everything, including the
  Entra app and the role assignment on the Foundry account (`node infra/azure-test/teardown.mjs`).
− Not run in this topology, and not counted as passed by the token-based runs: `/login`, the TLS trust
  prompt (T-19), inference after a native sign-in (T-45), managed-settings delivery (T-12) and the
  client's own token refresh. They stay with P-11 and P-7.
− Any member of the tenant can complete the Entra sign-in to the app, because it does not require
  assignment. The gateway refuses a token without a gateway role with `auth.denied` (T-04 negative).
− The host name is in public DNS. Anyone inside 203.0.113.0/26 reaches the sign-in page.
− A replica restart clears device grants and rate-limit counters. Session tokens stay valid until
  `ttl_hours`, because they verify against the JWT secret
  ([outage behavior](https://code.claude.com/docs/en/claude-apps-gateway-deploy#outage-behavior)).
− A second replica, or an overlapping revision, has its own database and breaks the device-grant
  rendezvous, so the maximum replica count stays 1 and the app runs in single revision mode.
− A stream longer than the ingress request timeout is cut (U-40, T-46).
− Running cost: about 2.60 USD a day at the active rate for 1 vCPU and 2 GiB (U-13 list prices), plus
  about 0.17 USD a day for ACR Basic and the log ingestion.

## Redeploys, rotation and recovery

Added after council round 1 and revised after rounds 2 to 5 (Astra, 2026-09-23 and 2026-09-26). The live app, not the
state file, decides what a redeploy keeps: a run can stop between any two changes.

| Concern | Behaviour | Source |
|---|---|---|
| Secrets on redeploy | The app step reads the running app's JWT secret and database password with `listSecrets` and sends them back, so issued sessions stay valid across a redeploy | https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets |
| Which client secret is in use | A secret change starts no revision (U-42), so the key ID of the client secret goes into `OIDC_CREDENTIAL_ID`. The installed key is the `OIDC_CREDENTIAL_ID` in the app's template, deployed in the same request as the secret `listSecrets` returns, and it counts only when Graph's `hint` for that key equals the first three characters of that secret. The serving key is the `OIDC_CREDENTIAL_ID` of the latest ready revision; while that revision names no key, as one from before `OIDC_CREDENTIAL_ID` does, every key is kept until a revision that names one is ready (`keyPlan`) | https://learn.microsoft.com/en-us/graph/api/resources/passwordcredential ; https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets |
| Client secret rotation | The installed secret is reused while its key has more than a day left, or until `--rotate-client-secret`. A new secret starts a revision; once `promotionError` finds that revision ready and both it and the app's template holding the new key, the run's other secrets are removed and Graph is re-read until they are gone. The installed and the serving key are never removed; a key a crashed run installed is reused; while the installed secret matches no key, nothing is removed; secrets not named `gateway-test <runId>` are left alone. Run live on 2026-09-23: key `85c1900d` added, revision `ca-claude-gw--0000002` ready, then key `217f95bc` removed | https://learn.microsoft.com/en-us/graph/api/application-removepassword |
| Preview | Every ARM deployment runs validation, then what-if, then the deployment (`deployWithPreview`). The report lists the path of each property a `Modify` creates, changes or deletes, without values (`whatIfLines`). `--what-if` stops after the preview and writes no state. On revision `ca-claude-gw--0000002`, what-if listed `Modify` for three `reference()` values (`AZURE_CLIENT_ID`, `GATEWAY_PUBLIC_URL`, the registry server) and for the probe array, which the service returns in another order; the deployed values equal those the template produces | https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/deploy-what-if |
| Recorded tester range | `testerCidr` in the state file is written only after the app step's new revision is ready with both allow lists; the live checks default to it | https://learn.microsoft.com/en-us/azure/container-apps/ip-restrictions |
| Partial failure | Both steps deploy the whole template, the Foundry role assignment included. Before a deployment runs, `deployTemplate` adds the Foundry account it names to `foundryTargets` and saves the state; after it succeeds, the outputs, the grant ID included, go into the state (`stateFromOutputs`). Teardown finds the identity's role assignments by principal on every recorded account (`foundryAccountIds`), so a grant made by a deployment that failed before its outputs were saved is removed too. With `--no-wait` the state file stays until the resource group is gone | https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-rest |
| Checks that remove access | Before the T-04 and T-06 negatives remove the tester's app role or the gateway identity's Foundry role, the live checks write a restore record in phase `removing`, then `removed` after the delete, and `restoring` before every grant that undoes it, the next run's included; a completed restore clears it. A 4xx refusal changed nothing, so the record moves back (a refused delete clears it, a refused restore returns it to `removed`); a 408, a 5xx or a transport failure may have taken effect, so the record stays. The next run restores only a `removed` record; any other record is ambiguous and grants nothing, so an administrator's revocation after a restore whose response was lost stands (security review, round 3). A record is never replaced by another check's (`nextJournal`); the checks that remove access do not start while one is outstanding, and the run then ends with `ACCESS NOT RESTORED` and exit 1. The printed repair is `deploy.mjs --step entra` or `--step base` with the deployment's `--resource-group` and `--email-domain` and the Foundry scope of the assignment (`restoreCommand`); it re-creates the assignment by intent and clears the matching record, as does any deployment that re-creates the recorded Foundry grant (`restoredByDeployment`) | https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-approleassignedto |
| Evidence | Live checks read the audit events logged between two control requests whose `x-request-id` the log records, and match each request's events by that ID. An event without the field a check needs (upstream, model, `sub` or `email`, `request_id`) makes the check BLOCKED; a field with another value makes it FAIL. The CLI check runs Claude Code through a loopback relay that records the method, path, status and `x-request-id` of each response and nothing else (`startCaptureRelay`), and counts only the audit events of those requests (`relayEvidence`, `refusedCliFindings`); its refused run sets `CLAUDE_CODE_MAX_RETRIES=0` (U-46). The relay passes failures through: a response cut short upstream breaks the client's connection, a client that goes away cancels its upstream request, and closing the relay ends every connection on both sides, idle ones included; each such request is recorded with its error. `close()` returns once every request has its final record, and the CLI check reads the capture after it (`runThroughRelay`). The sign-in refusal counts only on `/oauth/callback`, with a group or role reason, carrying the flow's `user_code` (U-44) | https://code.claude.com/docs/en/claude-apps-gateway-deploy#logs ; https://code.claude.com/docs/en/env-vars |
## How we'd know this was wrong

- T-42 returns anything other than 403 from outside the range, or T-02 returns 403 from inside it: the
  allow lists or the `trusted_proxies` assumption (U-32) are wrong.
- T-06 passes without a matching `inference` event in the gateway log: the client reached Foundry by
  another route (U-38), and the result does not count.
- The tester's first sign-in stops at an Entra consent or admin-approval page: the consent finding
  (U-39) is incomplete, and P-2 records the error code.
- The gateway refuses a `public_url` on a public address, or the client refuses the session token from
  `ANTHROPIC_AUTH_TOKEN` (U-37): option 3 or 4 replaces option 2.
