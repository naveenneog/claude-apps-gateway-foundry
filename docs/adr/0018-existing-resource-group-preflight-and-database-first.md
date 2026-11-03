# ADR-0018: Existing resource groups, a read-only preflight, and the database created first

- **Status:** Accepted
- **Date:** 2026-11-03
- **Packets:** P-46, P-48 · **Unknowns:** U-135, U-136
- **Deciders:** owner (2026-11-03: "user should be able to give existing resource group as an option"; "in the plan
  stage check if the region selected would allow postgres managed deployment, i don't want it to fail in later stage"),
  agent

## Context
The `base` stage refuses a resource group it did not create, because teardown deletes the whole group
(infra/azure-test/deploy.mjs:142-145; infra/azure-test/teardown.mjs:41-43). A customer's install failed twice in the
`app` stage, about 15 minutes in: once on `SkuNotAvailable` for PostgreSQL in East US 2, once on a transient `503`.

| Fact | Source |
|---|---|
| `az postgres flexible-server list-skus` shows what a region offers, not what a subscription may create; a subscription can still get `SkuNotAvailable`. | https://learn.microsoft.com/en-us/answers/questions/6035964 ; https://learn.microsoft.com/en-us/azure/postgresql/troubleshoot/how-to-resolve-capacity-errors |
| The location capabilities answer for a subscription carries `restricted`, `status` and `reason` at the region, edition and SKU levels. | `az postgres flexible-server list-skus` JSON, 2026-11-03 (U-135) |
| ARM validation passed for the deployment that then failed on `SkuNotAvailable`. | Customer install output, 2026-11-03 |

## Decision
- **Existing group.** `-UseExistingResourceGroup` lets `base` use a group without this tool's tags. The state file
  records `existingGroup: true`. Before deploying, the stage lists the group and refuses when a resource has a name the
  template creates but lacks this run's `runId` tag. Teardown never deletes such a group: it deletes the resources that
  carry this run's tag, the Foundry role assignment, the Entra apps and the Key Vault role assignments it made.
- **Preflight.** A new first stage, `preflight`, runs also under `-Plan` and changes nothing. It checks: the signed-in
  subscription; the resource group (exists or not, existing-group mode, name clashes); the Foundry account and that each
  admin-file deployment exists there; for each database region, the subscription's PostgreSQL capabilities for
  PostgreSQL 16 and Standard_B1ms, including `restricted` and `reason`; the Key Vault (exists, permission model, public
  access, the installing account's rights to create certificates and assign roles). It prints one line per check and
  stops the install on a failure.
- **Database first.** With the managed database, `base` creates the PostgreSQL server before anything else, from a small
  template, with a temporary password that the `app` stage replaces. `-DatabaseLocation` takes a comma-separated list;
  the stage tries each region in order and moves on only on `SkuNotAvailable`, a restricted location or a quota refusal,
  and records the region that worked. Any other error stops the stage.

## Consequences
+ A refused region fails, or falls back, in the first minutes, before the registry, apps or console exist.
+ Customers can keep the gateway with their Foundry account and Key Vault in one group.
- Preflight cannot prove capacity (U-135); creating the database first is what makes the failure early.
- A failed attempt can leave an empty server name reserved for a short time in that region; the name includes the region,
  so the next region does not collide.

## How we'd know this was wrong
Preflight passes and the database step still fails on a cause the fallback list does not cover, or the `app` stage's
password replacement does not reach the server created by `base` (U-136).

## Notes from the build (2026-11-03)
- The Key Vault checks of the preflight were not built: ADR-0016's amendment keeps the sign-in certificate in the gateway
  app, so the install needs no vault (U-137).
- A region whose capabilities answer `restricted: Enabled` refused a direct create with `400 ParameterOutOfRange`
  (`Version should be in: []`), not `SkuNotAvailable`; the fallback treats both as a region refusal (U-135).
- The `app` stage's deployment set the password of the server `base` created: the gateway connected and `budgets`
  wrote through it (U-136, T-161).
- Any run that includes `base` or `app` also runs `preflight` first; under `-Plan` a `FAIL` is reported and the rest
  of the plan is still printed, with exit code 1.
