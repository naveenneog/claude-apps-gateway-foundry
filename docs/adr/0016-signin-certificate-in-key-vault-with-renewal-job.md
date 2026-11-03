# ADR-0016: The gateway signs in to Entra with a certificate, renewed by a job

- **Status:** Accepted
- **Date:** 2026-11-03
- **Packet:** P-45 · **Unknowns:** U-130 to U-134
- **Deciders:** owner (2026-11-03: "build, test and validate the Certificate way, so no client secret path is needed ...
  if client secret is the way, extend that to 365 days, use existing key vault to rotate"), agent

## Context
The gateway signs in to Microsoft Entra with a client secret that the `app` stage creates for at most 30 days
(ADR-0003, `-ClientSecretDays`). When it ends, new sign-ins fail with `AADSTS7000222` until someone runs the `app` stage
again (docs/learn/tutorial-first-install.md, "Keep the gateway's sign-in secret current").

| Fact | Source |
|---|---|
| The gateway authenticates to the IdP with a certificate when `token_endpoint_auth_method: private_key_jwt` and a `client_assertion` block hold the PEM private key and one PEM certificate; it reads them once at boot; it needs Claude Code 2.1.284 or later. Rotation order: upload the new certificate to the IdP, replace the files, restart, then remove the old one. | https://code.claude.com/docs/en/claude-apps-gateway-config#certificate-client-authentication, checked 2026-11-03 |
| The image pins Claude Code 2.1.280; the stable channel is 2.1.311. | infra/azure-test/image/Dockerfile:8; `https://downloads.claude.ai/claude-code-releases/stable`, 2026-11-03 |
| A Key Vault certificate has an addressable secret holding the private key and certificate as PEM when the policy says so; Key Vault renews self-signed certificates automatically by the policy's lifetime action. | https://learn.microsoft.com/en-us/azure/key-vault/certificates/about-certificates ; https://learn.microsoft.com/en-us/azure/key-vault/certificates/overview-renew-certificate |
| A Container App secret can reference a Key Vault secret through a user-assigned identity with Key Vault Secrets User; a reference without a version is refreshed within 30 minutes and restarts revisions that use it in an environment variable; a versioned reference does not change. | https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets#reference-secret-from-key-vault |
| `PATCH /applications/{id}` sets `keyCredentials` with the application permission `Application.ReadWrite.OwnedBy` for an owned app, and replaces the whole collection. | https://learn.microsoft.com/en-us/graph/api/application-update ; https://learn.microsoft.com/en-us/graph/api/application-addkey |
| admin-ui's identity owns the gateway's app registration and holds `Application.ReadWrite.OwnedBy` and Container Apps Contributor on the gateway app. | admin-ui/infra/Deploy-AdminUi.ps1:103-108; admin-ui/infra/main.bicep:111-113 |

## Options considered
1. **Longer client secrets only.** Fewer renewals, but a person still renews, and many tenants cap secret lifetimes.
2. **A certificate in the customer's existing Key Vault, renewed by Key Vault, rolled out by a job** (chosen).
3. **Federated credential from the managed identity.** Removes stored credentials altogether, but the gateway's
   `client_assertion` takes PEM files only; it does not request a managed-identity assertion. Not available.

## Decision
Option 2, with the client secret kept as an explicit fallback.

- **Choice in the admin file.** `deployment.signInCredential` is `"certificate"` or `"secret"` (absent means `"secret"`,
  so existing installs render as before). The renderer writes `token_endpoint_auth_method: private_key_jwt` and
  `client_assertion` with `${file:/tmp/idp/key.pem}` and `${file:/tmp/idp/cert.pem}` for a certificate; the console
  renders from the same file, so its saves keep the choice.
- **Certificate.** The installer's new `-KeyVaultName` names the customer's vault. The `app` stage creates the
  certificate `claude-gateway-signin` there if it is absent: self-signed, RSA 2048, exportable, PEM content type,
  12 months, auto-renew 30 days before expiry. It grants the gateway identity Key Vault Secrets User on that
  certificate's secret only, and admin-ui's identity Key Vault Reader on the vault (public certificate data only, U-132).
- **Gateway.** The app secret `oidc-certificate` references the certificate's secret **by version** through the gateway
  identity, and is the environment variable `GATEWAY_IDP_PEM`. The image's entrypoint writes its private key and its
  first certificate to `/tmp/idp/key.pem` and `/tmp/idp/cert.pem` (mode 0600) and refuses to start when either is
  missing. The image moves to Claude Code 2.1.311.
- **Registration.** The `app` stage sets the app registration's `keyCredentials` to the public certificates of every
  unexpired version in Key Vault, then deploys.
- **Renewal job.** `job-signin-renewer`, deployed with admin-ui like `job-spend-pacer`, runs daily with admin-ui's identity:
  when the vault's latest version is not the one the gateway pins, it sets `keyCredentials` to all unexpired versions,
  waits for Entra to list it, repoints `oidc-certificate` to the new version (a new revision), waits for the revision to
  be ready, and records the result. Expired versions are dropped from `keyCredentials` on later runs. Any failure leaves
  the gateway on the version it runs and exits non-zero.
- **Secret fallback.** With `"secret"`, `-ClientSecretDays` takes 1 to 365 (Entra or the tenant policy can refuse a long
  one; the stage then says so). With `-KeyVaultName`, the secret is stored there as `claude-gateway-signin-secret` and
  referenced by version; the renewal job adds a new secret 30 days before the end, stores it as a new version, repoints
  the gateway, waits for it, and removes the old one.
- **Console.** Settings shows the credential type, its end date and the last renewal.

## Consequences
+ No person renews the sign-in credential; the private key never leaves Key Vault except into the gateway container.
+ Rotation follows the gateway's documented order, so sign-in does not fail during it.
- The installer needs a Key Vault the installing account may create certificates in and assign roles on.
- The gateway image changes release (2.1.280 to 2.1.311); the T-48 sign-in and inference checks are repeated on it.
- The private topology (infra/azure-private) keeps its client secret; extending it is a roadmap entry.

## How we'd know this was wrong
- The gateway refuses the Key Vault PEM after the entrypoint split, or Entra refuses the assertion (U-130).
- Key Vault Reader does not return the public certificate to admin-ui's identity (U-132).
- A tenant policy refuses certificate credentials on applications (U-133).

## Amendment (2026-11-03): no Key Vault in the path; the installer and a job make the certificate

**Status of the original decision:** superseded for the store and the renewal mechanism; the rest stands.

### What changed the decision
| Fact | Source |
|---|---|
| In the Contoso tenant, the tenant-root policy assignment `MCAPSGovDeployPolicies` (definition `KeyVault_PublicNetwork_Modify`, effect `modify`) sets every new or updated vault's public network access to `Disabled`. `az keyvault update --public-network-access Enabled` returned `Disabled`; data-plane calls from the installing machine answered `403 ForbiddenByConnection`. | Activity log of `kvclgwp457897`, 2026-11-03 (U-137) |
| Container Apps documents Key Vault references through a managed identity, and firewall rules for a UDR environment, but not a path to a vault whose public network access is disabled from an environment with no virtual network. The test topology has no virtual network. Assumed, not tested: such a reference does not resolve (U-137). The same page advises a Key Vault reference over a directly stored value for production. | https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets#reference-secret-from-key-vault, read 2026-11-03 |
| Entra accepted a certificate made with Node.js `crypto` alone (RSA 2048, SHA-256, self-signed, `x5t`/`x5t#S256` assertion headers): the token endpoint answered 200. Gateway 2.1.311 booted with it through the image entrypoint and logged `client authentication private_key_jwt` with the same thumbprint. | U-130, 2026-11-03 |

### Decision
- The `app` stage makes the certificate (infra/azure-test/lib/x509.mjs:27): RSA 2048, valid `-CredentialValidityMonths` (1 to 24, default 12). It registers it on the app registration with `PATCH /applications/{id}` `keyCredentials`, holding the running one next to it until the new revision is ready, then only the new one, and removes the client secrets the installer made. Certificates on the app registration that the installer did not make stop the stage, because `PATCH` replaces the whole set.
- The key and certificate are the Container Apps secret `oidc-certificate`, read as `GATEWAY_IDP_PEM`. The image's entrypoint writes them to `/tmp/idp` (mode 0600) and starts the gateway from a copy of the configuration whose `client_secret` line is replaced by `private_key_jwt` (infra/azure-test/image/gateway-entrypoint.sh:17). The rendered configuration is the same in both modes, so the installer and the console never render different `oidc` blocks.
- `job-signin-renewer` (admin-ui image and identity, daily at 03:17 UTC) and the console's **Renew now** run the same renewal (admin-ui/server/signin-renewer.mjs:23): a certificate or client secret that ends within 30 days is replaced in the gateway's rotation order. The console's Settings page shows the credential, its end date and the last Renew now.
- Fallback: a certificate that cannot be made or registered falls back to a client secret of `-ClientSecretDays` (1 to 365, default 365), unless `-SignInCredential certificate` was given. An install that already signs in with a secret keeps it until `-SignInCredential certificate` is given.
- `-KeyVaultName` and `-CreateKeyVault` are not built. A Key Vault store is a roadmap entry for the network-restricted topology, where a private endpoint is possible.

### Consequences
+ No person renews the sign-in credential, and no client secret exists in a certificate install.
- The private key is held as a Container Apps secret, not in a Key Vault, which Microsoft advises against for production. Anyone with `listSecrets` on the gateway app (Owner, Contributor, Container Apps Contributor or Operator) can read it, as they can read the existing JWT secret and admin keys.
- The image must be 2.1.311 or later for a certificate; the `app` stage refuses an older image and names the `image` stage.
