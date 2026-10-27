# claude-apps-gateway-foundry

This repository deploys and operates Anthropic's self-hosted
[Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway) on Azure. The gateway is a server that
signs developers in with Microsoft Entra ID and forwards Claude Code's requests to Claude models in Microsoft
Foundry, so no model key reaches a developer machine. It includes an admin console, titled
**Claude apps gateway - Foundry**, for spend caps, developer access, models and chargeback ([admin-ui](admin-ui)).
The starting point for each kind of reader is
[docs/learn/overview.md, Where to start](docs/learn/overview.md#where-to-start); terms are defined in the
[glossary](docs/learn/glossary.md). The rest of the repository holds the plan, test plan and decision records,
including the comparison with the Azure API Management (APIM) gateway.

## Start here

| Goal | Read | Time |
|---|---|---|
| Install the gateway on Azure for the first time, then onboard developers by hand or with Microsoft Intune | [Tutorial: install the gateway and onboard developers](docs/learn/tutorial-first-install.md) | One sitting; the install itself took about eight minutes on 2026-10-21 (docs/TEST-PLAN.md, T-91) |
| Use Claude Code on a Windows machine through a gateway someone else installed | [Quickstart: connect Claude Code on Windows](docs/learn/quickstart-developer.md) | A few minutes |
| Run a gateway that is already installed: models, access, budgets, chargeback | [Use the admin console](docs/learn/how-to-use-admin-console.md) | — |
| Install a gateway with no public address, reached over VPN or ExpressRoute | [Tutorial: deploy in a network-restricted environment](docs/learn/tutorial-deploy-network-restricted.md) | Longer: it builds the network too |
| Group developers into departments or cost centers for chargeback, or give a whole team access with an Entra group | [Group developers into departments and teams](docs/learn/how-to-organize-departments.md) | — |
| Choose what Claude Desktop shows each role (Chat, Cowork, Code) | [Claude Desktop: Chat, Cowork and Code](docs/learn/how-to-admin-configure.md#claude-desktop-chat-cowork-and-code) | — |
| Slow spend down before a monthly cap is reached | [Pace the last part of a monthly cap with a soft limit](docs/learn/how-to-admin-configure.md#pace-the-last-part-of-a-monthly-cap-with-a-soft-limit) | — |
| Look up a term | [Glossary](docs/learn/glossary.md) | — |

The first tutorial needs Owner on an Azure subscription, a Microsoft Foundry account with Claude models deployed, and
PowerShell 7, Node.js 22, the Azure CLI and Git on the machine that runs it; its "Before you begin" section lists each
role and why. Developer machines run Windows, and the gateway accepts connections from one public address range. Claude Desktop through this gateway was tested on
2026-10-26 (docs/UNKNOWNS.md, U-106). Not yet tested: an Intune assignment in a real tenant (docs/UNKNOWNS.md, U-107).

## Start the deployment

These are the tutorial's commands in order, for a reader who has met its
[Before you begin](docs/learn/tutorial-first-install.md#before-you-begin) list. The tutorial explains each value and
what each command prints. In PowerShell 7, from a folder that holds no other copy of the repository:

```powershell
git clone https://github.com/naveenneog/claude-apps-gateway-foundry.git
Set-Location claude-apps-gateway-foundry
az login
az account set --subscription "<subscription name or ID>"
az extension add --name containerapp --upgrade

$rg = 'rg-claude-gw-eval'
$foundryRg = '<resource group of your Foundry account>'
$foundry = '<name of your Foundry account>'
$admins = az account show --query user.name -o tsv
$ip = Invoke-RestMethod https://api.ipify.org
$cidr = "$ip/32"

az cognitiveservices account deployment list -g $foundryRg -n $foundry --query "[].{deployment:name,model:properties.model.name}" -o table
Copy-Item config/gateway-admin.example.json config/gateway-admin.azure-eval.json
notepad config/gateway-admin.azure-eval.json
node scripts/admin/new-gateway-config.mjs --topology test --admin config/gateway-admin.azure-eval.json --out config/gateway.azure-eval.yaml

pwsh -File infra/azure-test/Install-ClaudeGateway.ps1 -ResourceGroup $rg -AdminFile config/gateway-admin.azure-eval.json -TesterCidr $cidr -FoundryResourceGroup $foundryRg -FoundryAccount $foundry -AppRegistrationName claude-apps-gateway-eval -SignInAdmins $admins -ClientSecretDays 30 -DatabaseLocation centralus -Plan
pwsh -File infra/azure-test/Install-ClaudeGateway.ps1 -ResourceGroup $rg -AdminFile config/gateway-admin.azure-eval.json -TesterCidr $cidr -FoundryResourceGroup $foundryRg -FoundryAccount $foundry -AppRegistrationName claude-apps-gateway-eval -SignInAdmins $admins -ClientSecretDays 30 -DatabaseLocation centralus
```

| Step | What it does | Tutorial section |
|---|---|---|
| `git clone` to `az extension add` | Gets the files and signs in to the subscription the install goes into | [Get the files and sign in to Azure](docs/learn/tutorial-first-install.md#get-the-files-and-sign-in-to-azure) |
| `$rg` to `$cidr` | Names the new resource group, the Foundry account, the console's administrators and the address range that may connect; `"$ip/32"` admits this machine only | [Set the values every command uses](docs/learn/tutorial-first-install.md#set-the-values-every-command-uses) |
| `deployment list` | Lists the Claude deployment names the admin file needs | [Find your Claude deployments in Foundry](docs/learn/tutorial-first-install.md#find-your-claude-deployments-in-foundry) |
| `Copy-Item` to `new-gateway-config.mjs` | Copies the example admin file, opens it to set the deployment names, and checks it | [Write the admin file](docs/learn/tutorial-first-install.md#write-the-admin-file) |
| `Install-ClaudeGateway.ps1 ... -Plan` | Prints every command the install would run and changes nothing | [Preview the install](docs/learn/tutorial-first-install.md#preview-the-install) |
| `Install-ClaudeGateway.ps1` | Installs the gateway, its database and the admin console, and prints their addresses | [Run the install](docs/learn/tutorial-first-install.md#run-the-install) |

After the install: [open the admin console](docs/learn/tutorial-first-install.md#open-the-admin-console),
[give developers access](docs/learn/tutorial-first-install.md#give-developers-access) and
[onboard developers](docs/learn/tutorial-first-install.md#onboard-developers). A stage that stops is named with its fix
in the table under [Run the install](docs/learn/tutorial-first-install.md#run-the-install).
The tutorial and the pages it links are all a first install needs. The sections below describe how the repository is
built and tested, using its record identifiers: ADR-n decisions, P-n work packets, T-n tests and U-n unknowns
([glossary](docs/learn/glossary.md#repository-records)).

## About this repository

[docs/learn/tutorial-deploy-network-restricted.md](docs/learn/tutorial-deploy-network-restricted.md) deploys the
gateway on Azure in a network-restricted environment, step by step in the Azure portal, the Azure CLI and a script
(ADR-0005). Like Anthropic's [AWS example](https://code.claude.com/docs/en/claude-apps-gateway-on-aws), it is a
working example for customer-managed infrastructure, not a supported production deployment. Admin, developer and
test scripts (ADR-0004) are documented in Microsoft Learn format in [docs/learn/overview.md](docs/learn/overview.md).
[docs/STATUS.md](docs/STATUS.md) names the packet in progress.

Addresses in 203.0.113.0/24, the [RFC 5737](https://www.rfc-editor.org/rfc/rfc5737) documentation range, stand for
the tester's public egress range: 203.0.113.0/26 in the commands below is a documentation range that admits nobody,
and a deployment uses the range its administrator connects from. `<environment>` stands for the generated environment name of the public test
deployment (ADR-0003). The network-restricted example deployment keeps its generated names, such as
`politebush-4e216865`, because its screenshots show them; its environment has no public address (ADR-0006).

## Contents

| File | Content |
|---|---|
| [docs/adr/0002-pilot-claude-apps-gateway-alongside-apim.md](docs/adr/0002-pilot-claude-apps-gateway-alongside-apim.md) | Options A1, A2, B, C and D; cited comparison against APIM; proposed decision, pilot design decisions and P-16 gates |
| [docs/GATEWAY-COMPARISON.md](docs/GATEWAY-COMPARISON.md) | APIM gateway accelerator (route A, at `ea31a5f`) against the Claude apps gateway (route B): comparison, advantages and disadvantages, requirements each route meets, measured results, where the sources differ |
| [docs/adr/0003-azure-test-deployment-with-restricted-ingress.md](docs/adr/0003-azure-test-deployment-with-restricted-ingress.md) | M1 test topology: Container Apps, PostgreSQL sidecar, allow lists on the tester's range, admission by app role, what stays untested |
| [docs/learn/](docs/learn/overview.md) | Microsoft Learn articles: overview, developer quickstart, network-restricted deployment tutorial, client connection how-to, capacity plan for 25,000 developers, load test and sizing how-to, admin how-to, admin console how-to, stage-by-stage install how-to, users, groups and budgets how-to, inference tests how-to, script reference, glossary, troubleshooting, `toc.yml` |
| [docs/export/](docs/export) | PDF and Word copies of the network-restricted deployment tutorial, the client connection how-to and the capacity plan, for readers without the repository |
| [infra/azure-private/](infra/azure-private) | Network-restricted deployment (ADR-0005): `Deploy-Gateway.ps1` and its step modules, telemetry included (ADR-0007) |
| [docs/adr/0004-operator-and-developer-tooling.md](docs/adr/0004-operator-and-developer-tooling.md) | Admin and developer tooling: the `apiKeyHelper` developer profile, DPAPI session, admin scripts, and the council's amendments |
| [scripts/developer/](scripts/developer) | Windows PowerShell 5.1 scripts: `Install-ClaudeGatewayProfile.ps1`, `Connect-ClaudeGateway.ps1`, `Get-ClaudeGatewayToken.ps1`, `Disconnect-ClaudeGateway.ps1` |
| [scripts/admin/](scripts/admin) | Node.js scripts: `new-gateway-config.mjs`, `set-developer.mjs`, `new-client-policy.mjs`, `bootstrap-budgets.mjs` |
| [admin-ui/](admin-ui) | Web UI for gateway configuration, app roles, spend limits, chargeback and client onboarding (ADR-0010): framework-free `node:http` backend, vanilla JS frontend, Bicep deployment into the gateway's own environment |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Routes A, A2, B, C and D; draft `gateway.yaml`; client managed settings; controls on route C's APIM API |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones and work packets P-0 onwards with acceptance criteria |
| [docs/TEST-PLAN.md](docs/TEST-PLAN.md) | Test cases T-01 onwards with negative checks, parity scenarios PS-1–PS-11, and results |
| [docs/UNKNOWNS.md](docs/UNKNOWNS.md) | Known unknowns, their state and evidence |
| [docs/STATUS.md](docs/STATUS.md) | Active packet and handover notes |
| [docs/CHARTER.md](docs/CHARTER.md) | Goals, non-goals, constraints, definition of done |
| [infra/azure-test/](infra/azure-test) | Test deployment on Azure Container Apps (ADR-0003): `Install-ClaudeGateway.ps1`, the stage-based installer (ADR-0009), `deploy.mjs`, `teardown.mjs`, ARM template `gateway-test.json`, Entra app manifest, image files (`Dockerfile`, `verify-release.sh`, entrypoint) |
| [config/gateway.azure-test.yaml](config/gateway.azure-test.yaml) | Gateway config for the test deployment; every secret and environment value is a `${VAR}` reference |
| [config/otel-collector.azure-private.json](config/otel-collector.azure-private.json) | OpenTelemetry Collector config of the network-restricted deployment: one metrics pipeline from the gateway's loopback to Application Insights (ADR-0007) |
| [tests/live/](tests/live) | Live checks against the deployed gateway, and `inference-suite.mjs` (T-51, T-55 to T-65); results in `docs/TEST-PLAN.md` |
| [scripts/publish/](scripts/publish) | `check-public.mjs`, the check a tree passes before it is published, and `allow.json`, the values it accepts with a reason each (ADR-0006) |

## Checks

The checks require Node.js 22 or later and no packages. `tests/verify-release.test.mjs` also needs bash
with `gpg` and `sha256sum`, which Git for Windows provides; without them its cases are skipped. The developer
script tests need Windows PowerShell 5.1 and skip elsewhere, unless `CGW_REQUIRE_WINDOWS=1` turns the skip into a
failure, as in the `windows-latest` CI job.

```powershell
node --test tests/*.test.mjs                 # ledger, deployment files, admin and developer scripts, inference harness, Learn articles
pwsh -File tests/mutate-developer.ps1        # mutations of the developer scripts, each in a temporary copy
pwsh -File tests/mutate-admin.ps1            # mutations of the admin scripts, each in a temporary copy
pwsh -File tests/mutate-ledger.ps1           # mutations of the ledger rules, the Learn checks and the docs; exit 1 unless every one is caught
pwsh -File tests/mutate-deploy.ps1           # mutations of the deployment files, their guards and the inference harness
node .ironclad/gate.mjs --stage packet       # Ironclad definition of done
```

The test deployment (ADR-0003) needs Azure CLI signed in with Owner on the subscription. The installer commands, with
the values each needs, are in [docs/learn/tutorial-first-install.md](docs/learn/tutorial-first-install.md); the commands
below are the underlying scripts, and `203.0.113.0/26` in them is a documentation range that admits nobody, replaced by
the range the administrator connects from:

```powershell
pwsh -File infra/azure-test/Install-ClaudeGateway.ps1 -ResourceGroup rg-claude-gw-eval -AdminFile config/gateway-admin.azure-eval.json -TesterCidr 203.0.113.0/26 -FoundryResourceGroup <rg> -FoundryAccount <account> -SignInAdmins <upn> -Plan   # every stage, in order
node infra/azure-test/deploy.mjs --tester-cidr 203.0.113.0/26 --resource-group rg-claude-gw-eval --foundry-resource-group <rg> --foundry-account <account> --what-if    # preview: validation and what-if, writes nothing
node infra/azure-test/deploy.mjs --tester-cidr 203.0.113.0/26 --resource-group rg-claude-gw-eval --foundry-resource-group <rg> --foundry-account <account>              # deploy or update; each ARM deployment runs what-if first
node infra/azure-test/deploy.mjs --tester-cidr 203.0.113.0/26 --resource-group rg-claude-gw-eval --foundry-resource-group <rg> --foundry-account <account> --step app --config config/gateway.azure-eval.yaml --rotate-client-secret   # new client secret; the old key goes once the new revision is ready
node tests/live/gateway-live.mjs --check entra,surface,outside,boot,build   # checks without a browser
node tests/live/gateway-live.mjs --check signin,inference,cli,refresh,stream,longstream,upstream,denied
node infra/azure-test/teardown.mjs --dry-run                                # then without --dry-run
```

`tests/ledger.test.mjs` fails when a comparison row, researched unknown, test case, or an
`docs/ARCHITECTURE.md` row with an Evidence or Source column has no URL or `path:line` (ARCHITECTURE
rows may instead cite a backticked command with a date; a URL inside a backticked command is not a
citation); when a roadmap packet has no Given/when/then line; when a P-, T-, PS- or U- reference in
any ledger file or decision record names an item that does not exist; when a pipe row belongs to no
table, for example after a blank line inside a table; when the active packet in `docs/STATUS.md` is missing from the
roadmap; when a packet is marked done while a case assigned to it has no current PASS, meaning the
latest result by heading date, with evidence, and with evidence after "Negative:" when the case defines a
negative; or when the roadmap drops the ordering that ADR-0002 depends on (P-13 after P-12, P-10 after
P-8, P-16 after P-15 and P-17). Each rule has synthetic negative tests that break one condition at a
time.

`tests/mutate-ledger.ps1` first requires the unmodified suite to pass, then breaks each rule, and a
sample of documented facts, one at a time. A mutation counts as caught only when all tests still load
and at least one fails. The script exits 1 when any mutation survives, does not apply, stops the suite
from loading, or when `node` is missing. Each file is restored byte-for-byte after its run.

## Related repositories

- [naveenneog/claude-code-foundry-gateway](https://github.com/naveenneog/claude-code-foundry-gateway): the APIM
  gateway (Bicep, policy XML) used as the baseline, and its accelerator with budgets, chargeback and workbooks.
- [naveenneog/claude-desktop-foundry](https://github.com/naveenneog/claude-desktop-foundry): Claude Desktop policies
  for Foundry, cited by ADR-0002.

## Publication

The public repository `naveenneog/claude-apps-gateway-foundry` holds copies of the working repository's committed
revisions, without their history, as one commit per publication; the working repository is private (ADR-0006).
`scripts/publish/publish-public.mjs` publishes a revision after `scripts/publish/check-public.mjs` checks it with a deny
file kept outside the repository, and `scripts/publish/verify-public.mjs` checks the public repository afterwards.
Without `--deny-file`, the checker runs its pattern checks only, for user profile paths, public IPv4 addresses,
Container Apps host names and e-mail addresses; the test suite runs it that way over the tracked files.

## License

[MIT](LICENSE).
