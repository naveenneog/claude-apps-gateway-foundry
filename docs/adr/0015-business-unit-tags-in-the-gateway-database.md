# ADR-0015: Business-unit tags live in the gateway database, not in Entra ID

- **Status:** Accepted
- **Date:** 2026-10-27
- **Packet:** P-44 · **Unknowns:** U-125 to U-128 · **Amends:** ADR-0010 (user tagging)
- **Deciders:** owner (2026-10-27: "just tag in our database all groups, that way it is safer for security and Entra
  ... it would avoid User.ReadWrite.All which is not recommended from Sec Ops team"; "not just departments all
  classifications we show in Chargebacks, except for the Entra groups to onboard like premium, standard"), agent

## Context
Chargeback groups spend by department, company, office, cost center, division or gateway role. ADR-0010 read the first
five from Entra ID user attributes and wrote department and cost center back to Entra with the Microsoft Graph
application permission `User.ReadWrite.All`, granted only with `Deploy-AdminUi.ps1 -GrantUserWrite`.

| Fact | Source |
|---|---|
| `User.ReadWrite.All` as an application permission lets the app read and update the full profile of every user in the tenant without a signed-in user. | [Microsoft Graph permissions reference, User.ReadWrite.All](https://learn.microsoft.com/en-us/graph/permissions-reference#userreadwriteall), checked 2026-10-27 |
| For a user synchronised from on-premises Active Directory, attributes such as `department` are managed on premises; Microsoft Graph refuses to update them in the cloud. | [Update user, Microsoft Graph](https://learn.microsoft.com/en-us/graph/api/user-update), checked 2026-10-27 |
| An Entra attribute is shared by every application in the tenant (address lists, HR feeds, Teams). | [user resource type](https://learn.microsoft.com/en-us/graph/api/resources/user) |
| The managed database option keeps a PostgreSQL Flexible Server, `psql-claude-gw-*`, that the gateway reaches with `GATEWAY_PG_HOST`, `GATEWAY_PG_USER` (default `gateway`) and the `pg-password` secret, from the Container Apps environment's outbound address, which the server firewall allows. | infra/azure-test/gateway-test.json:234-235, infra/azure-test/lib/database.mjs:38-56, infra/azure-private/lib/AppDefinition.psm1:11-22; Contoso server `psql-claude-gw-<suffix>-centralus`, PostgreSQL 16, `password_encryption` `scram-sha-256`, 2026-10-27 |
| admin-ui already holds Container Apps Contributor on the gateway app, which includes `listSecrets`; it reads the gateway's secrets to save its configuration and to run the spend pacer. | admin-ui/infra/main.bicep:111-113; admin-ui/server/gateway-config.mjs:104; admin-ui/server/pacer-job.mjs:33 |
| The repository has no package dependencies; Node.js has TLS, SCRAM's primitives (PBKDF2, HMAC, SHA-256) and sockets built in. | README.md; [PostgreSQL protocol, SASL authentication](https://www.postgresql.org/docs/16/sasl-authentication.html) |

## Options considered
1. **Keep Entra, with `User.ReadWrite.All`.** One source of truth, but a tenant-wide write permission that security
   teams refuse, and it fails for synchronised users.
2. **Entra read-only, tags as an override.** No write permission, but two places a value can come from, and the owner
   asked for one.
3. **Tags only, in the gateway's managed PostgreSQL** (chosen). No Graph write permission; every user can be tagged,
   synchronised or not; nothing outside chargeback changes. Needs a PostgreSQL client in admin-ui and the managed
   database option.
4. **Tags in a Container App secret or a storage account.** A secret is not a data store and has a size limit; a
   storage account is a new resource and a new role assignment.

## Decision
Option 3, because it removes the tenant-wide write permission and touches nothing outside chargeback.

- **Table.** `admin_console.user_tags(object_id uuid primary key, department, cost_center, company, office, division,
  updated_at, updated_by)`, each value 1 to 64 characters without control characters, or null. admin-ui creates the
  schema and table when it first needs them. The key is the user's Entra object ID, which outlives an email change;
  the table holds no name or address. `updated_by` is the signing-in administrator's object ID.
- **Credential.** admin-ui reads the host, user and password from the gateway app through Azure Resource Manager each
  time it connects (GET the app, POST `listSecrets`), with the role it already has. No secret is copied, no role is
  added. It connects with TLS and verifies the server certificate against Node's trust store and the host name;
  authentication is SCRAM-SHA-256 only, and every value is sent as a bound parameter.
- **Topologies.** Tags work when the gateway's `GATEWAY_PG_HOST` is not `127.0.0.1`, which means a managed or private
  server. On the in-app sidecar database admin-ui cannot reach the database; the Business units card says the managed
  database option is needed, and Chargeback groups by gateway role only.
- **Classifications.** Department, company, office, cost center and division come only from tags. Gateway role stays
  the user's gateway app roles from Entra (Premium, Standard, ...), which ADR-0010 assigns and which this ADR does not
  change. A user with no tag is `(unassigned)`.
- **Editing.** **Chargeback** > **Business units** edits the five values for each gateway user; **Import CSV** sets many
  users at once from a file whose columns are `user` (UPN, email or object ID), `department`, `costCenter`, `company`,
  `office` and `division`. admin-ui resolves each user with `User.Read.All`, which it already holds, and reports the
  lines it could not use.
- **Permission removed.** `Deploy-AdminUi.ps1` no longer has `-GrantUserWrite` and no longer grants `User.ReadWrite.All`;
  when the identity still holds it from an earlier install, the script prints the command that removes it.
  **Settings** > **Permissions** no longer lists it.

## Consequences
+ The console needs no Microsoft Graph write permission on users, and Entra ID is not changed by chargeback.
+ Synchronised users can be tagged, and a person can carry five independent classifications.
- Values that HR already keeps in Entra are not used; an administrator sets them in the console or imports a CSV file.
- admin-ui uses the gateway's database administrator credential. It could already read it through `listSecrets`;
  the new code uses it only for its own schema. A dedicated, narrower database role is a later hardening.
- The in-app sidecar database gets no tags.
- A PostgreSQL client of about 200 lines is maintained in this repository.

## How we'd know this was wrong
- admin-ui cannot reach the managed database from its environment, or the server certificate does not verify with
  Node's trust store (U-125, U-126).
- The gateway's own migrations touch the `admin_console` schema (U-127).
- Finance asks for Entra's values to be used automatically; Option 2 would then be reconsidered in a new ADR.
