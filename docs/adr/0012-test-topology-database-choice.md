# ADR-0012: The test topology offers two databases, an in-app sidecar or a managed Flexible Server

- **Status:** Accepted
- **Date:** 2026-10-25
- **Packet:** P-38
- **Deciders:** owner ("make it deployment option either managed or mounted pgsql one with current design which is
  already built another is which gives persistent across multiple deployments")

## Context

The test topology (ADR-0003) and the Contoso deployment run PostgreSQL as a second container in the gateway app with
its data on an `EmptyDir` volume. A new revision starts with an empty database, so a configuration save, an image
update or a secret rotation resets spend totals, spend caps and the audit trail (U-92). The T-106 live run reset
$30.37 of month-to-date spend this way. The gateway reports only the current period's spend (U-89), so the chargeback
report for the month restarts with the database.

Verified this session:
- Azure Database for PostgreSQL Flexible Server keeps automatic backups for 7 to 35 days and restores to any point in
  that window; the recovery point objective is up to five minutes
  (https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-backup-restore, read 2026-10-25).
- Burstable B1ms compute is $0.02 an hour in East US 2 and backup storage beyond the provisioned size is $0.10 per GB
  a month (Azure Retail Prices API, 2026-10-25).
- Container Apps outbound addresses "might change over time" without a NAT gateway
  (https://learn.microsoft.com/en-us/azure/container-apps/networking, "Ports and IP addresses", read 2026-10-25).
- `newSecret()` produces lowercase hex, two character classes; the server's administrator password is commonly
  described as needing three of four, which no Learn page read today states verbatim (U-102, assumed).
- `Microsoft.DBforPostgreSQL` was not registered on the Contoso subscription (U-103).

## Options considered

1. **Sidecar on `EmptyDir` (current)** — no extra cost or resource; every revision empties the database.
2. **Managed Flexible Server, public access with a firewall** — data, caps and audit survive every revision, with
   point-in-time restore; about $15 a month for B1ms compute plus storage; the firewall must follow the app's outbound
   addresses, which can change.
3. **Managed Flexible Server, private access** — the private topology's design (ADR-0005); needs a virtual network,
   which the test topology's Consumption environment does not have and cannot add after creation.
4. **Sidecar on an Azure Files volume** — persists without a new service, but PostgreSQL on an SMB share runs into
   file-permission and locking problems; rejected without a proven configuration.

## Decision

Offer options 1 and 2 as a deployment choice: `deployment.database` in the admin file, `"sidecar"` (the default, and
what every existing admin file means) or `"managed"`. The admin file is the one source both the deploy script and
admin-ui render the gateway configuration from, so a console save cannot switch an app between the two.

With `"managed"`:
- the gateway connects to `${GATEWAY_PG_HOST}` with `sslmode=require` as the server's administrator `gateway`, and
  the container runs `claude gateway --config /etc/claude/gateway.yaml` directly, because the image's entrypoint waits
  for the sidecar on 127.0.0.1:5432 (U-104);
- `infra/azure-test/gateway-test.json` creates the server (PostgreSQL 16, Burstable B1ms, 32 GiB, 35-day backup
  retention) and the `gateway` database in `databaseLocation`, the app's region unless `--database-location` names
  another, and the app has no `postgres` container and no `pgdata` volume. The server name carries the region, and
  the deploy script keeps the region a server was created in (U-105);
- the database password is the app's `pg-password` secret, with an `A` appended when it has no capital letter;
- the server's firewall allows exactly the gateway app's current outbound addresses, rules named `aca-outbound-<address>`,
  set by `deploy.mjs` after every app deployment and by `scripts/admin/sync-database-firewall.mjs`.

An existing sidecar deployment moves with `scripts/admin/move-to-managed-database.mjs`, which saves the admin file with
`"managed"` and reshapes the app in one write through admin-ui's own configuration store. A configuration save from
the admin console that changes `deployment.database` is refused with 409, because only the move changes the app's
containers. The move refuses a gateway with no live admin file, and the deploy script finds an existing
`psql-claude-gw-*` server in the resource group and keeps its name and region.

A sidecar deployment renders the same `gateway.yaml` as before; its app gains `GATEWAY_PG_HOST=127.0.0.1`, which the
sidecar rendering does not read.

## Consequences

+ Spend, caps, the audit trail and stored sign-in state survive configuration saves, image updates and restarts.
+ Point-in-time restore over 35 days, and `pg_dump` for copies outside Azure.
+ admin-ui stops asking for the data-loss acknowledgement, because the app has no `EmptyDir` database.
− About $15 a month more per deployment, plus backup storage beyond 32 GiB.
− The server has a public endpoint, limited by firewall rules and a password; private access needs the private
  topology.
− An outbound address change refuses the gateway's database connections until the firewall is synced again (U-101).
− B1ms can be refused in the app's region (U-105). On Contoso the server is in Central US, the gateway in East US 2;
  three inference calls took 3.7 to 4.0 s, the same as with the sidecar.
− The move itself still loses the sidecar's data once: spend is not copied, and caps are set again with
  `bootstrap-budgets.mjs`.

## How we'd know this was wrong

- The gateway logs database connection failures after an outbound address change that `deploy.mjs` did not catch:
  the firewall sync then needs to run on a schedule, or the environment needs a virtual network and NAT gateway.
- Spend totals reset after a configuration save on a `"managed"` deployment: the store is not the managed server.
- B1ms CPU credits run out under load: the tier needs to change (P-36's sizing gives the connection counts).
