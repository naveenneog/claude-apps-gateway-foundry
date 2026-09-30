---
title: "Quickstart: Connect Claude Code on Windows to a Claude apps gateway"
description: Install a separate Claude Code profile on Windows that signs in to a Claude apps gateway once and sends Claude Code's requests through it, without administrator rights and without changing your own Claude Code settings.
author: naveenneog
ms.date: 09/28/2026
ms.topic: quickstart
---

# Quickstart: Connect Claude Code on Windows to a Claude apps gateway

This quickstart installs a Claude Code profile that signs in to a Claude apps gateway once, then reaches Claude
models through it. Claude Code runs the profile's credential helper through its `apiKeyHelper` setting
([settings reference](https://code.claude.com/docs/en/settings-reference#apikeyhelper)). Your own settings in
`%USERPROFILE%\.claude` stay as they are.

## Prerequisites

- Windows 10 or Windows 11 with Windows PowerShell 5.1 (`powershell.exe`), which runs the credential helper, and
  .NET Framework 4.7 or later, which uses the operating system's TLS versions
  ([TLS best practices with .NET Framework](https://learn.microsoft.com/en-us/dotnet/framework/network-programming/tls)).
- Claude Code 2.1.272 or later on `PATH` ([set up Claude Code](https://code.claude.com/docs/en/setup)). `claude --version`
  prints the version, and `claude update` installs the newest
  ([update manually](https://code.claude.com/docs/en/setup#update-manually)); the installer does not check the version
  (P-25 in docs/ROADMAP.md). The settings
  precedence the launcher relies on, and the rule that only the last `--settings` argument applies, were measured with
  2.1.272 (docs/UNKNOWNS.md:61), which the CI job installs (.github/workflows/ironclad.yml:58). Claude Code runs the helper
  again when the token it holds has expired from 2.1.246
  ([apiKeyHelper](https://code.claude.com/docs/en/settings-reference#apikeyhelper)).
- The gateway URL, for example `https://gateway.contoso.com`, from the gateway operator.
- A network from which the gateway accepts connections. The test deployment's ingress and the gateway accept only
  the address range the operator deployed with (config/gateway.azure-test.yaml:49-50); from other addresses discovery
  returns HTTP 403.
- An account that holds one of the gateway's app roles; the operator grants it
  ([Configure models, roles and developer access](how-to-admin-configure.md#grant-developer-access)).
- The name of a model the gateway serves for Claude Code's background tasks, when it serves no Haiku model; for the
  test deployment, `claude-sonnet-5`.
- The developer scripts: the `developer` folder the operator hands out, or `scripts\developer` in this repository.

## Install the profile and sign in

The installer writes the profile, then signs in with the OAuth device authorization grant
([RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)): the browser confirms a code, and the script polls the
gateway until the code is confirmed.

1. Open Windows PowerShell in the folder that holds `Install-ClaudeGatewayProfile.ps1`.
1. Run the installer with the gateway URL and the background model:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-ClaudeGatewayProfile.ps1 -GatewayUrl https://gateway.contoso.com -FastModel claude-sonnet-5
   ```

   The installer prints the launcher command, then shows a sign-in code and opens the gateway's verification page in
   the browser:

   ```output
   Profile for https://gateway.contoso.com written to C:\Users\dev\.claude-apps-gateway.
   Start Claude Code through the gateway from PowerShell with:
     & "C:\Users\dev\.claude-apps-gateway\claude-gateway.cmd"
   or from cmd with:
     "C:\Users\dev\.claude-apps-gateway\claude-gateway.cmd"
   To sign in, open https://gateway.contoso.com/device?user_code=WDJB-MJHT and confirm the code WDJB-MJHT.
   ```

1. In the browser, confirm the code and sign in with your work account.
1. When the gateway names the account that signed in, the script asks you to confirm it. Answer **Y** to save the
   session:

   ```output
   Signed in to https://gateway.contoso.com as dev@contoso.com. Get-ClaudeGatewayToken.ps1 now serves tokens for this gateway.
   ```

> [!NOTE]
> The session is saved in `%LOCALAPPDATA%\ClaudeAppsGateway\sessions`, encrypted with DPAPI for your Windows user. On
> the test deployment a gateway token lasts one hour; the helper refreshes it when fewer than five minutes remain, so
> the browser sign-in is needed again only when the gateway refuses the refresh token.

## Start Claude Code

The launcher clears the shell's `ANTHROPIC_*` and `CLAUDE_CODE_USE_*` variables, which would outrank `apiKeyHelper`
or select another provider ([authentication](https://code.claude.com/docs/en/authentication)), and starts Claude Code
with `CLAUDE_CONFIG_DIR` set to the profile. It also passes the profile's `gateway.settings.json` with `--settings`.
That level ranks above a repository's `.claude/settings.json` and `.claude/settings.local.json`
([settings precedence](https://code.claude.com/docs/en/settings#settings-precedence)), so their `env` cannot send the
token to another host. Claude Code uses only the last `--settings` argument, so a `--settings` argument added to the
launcher replaces that file; settings of your own go in the profile's `settings.json` instead. Without the launcher,
Claude Code reads only the profile's `settings.json`, which a repository's settings outrank, and in the measured cases
a repository's settings then sent the token to another host (docs/UNKNOWNS.md:61).

1. Start an interactive session:

   ```powershell
   & "$env:USERPROFILE\.claude-apps-gateway\claude-gateway.cmd"
   ```

1. Or send one prompt without the interactive interface:

   ```powershell
   & "$env:USERPROFILE\.claude-apps-gateway\claude-gateway.cmd" -p "Reply with the single word PONG"
   ```

   ```output
   PONG
   ```

## Clean up resources

1. Sign out. The script sends both tokens to the gateway's revocation endpoint when the gateway advertises one, as a
   best effort, then deletes the saved session:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Disconnect-ClaudeGateway.ps1 -GatewayUrl https://gateway.contoso.com
   ```

1. Delete the profile:

   ```powershell
   Remove-Item -Recurse -Force "$env:USERPROFILE\.claude-apps-gateway"
   ```

1. When no profile for another gateway remains, delete the runtime and the session store as well. The folder holds
   the sessions of every gateway on this Windows account:

   ```powershell
   Remove-Item -Recurse -Force "$env:LOCALAPPDATA\ClaudeAppsGateway"
   ```

## Next steps

- [Troubleshoot the developer profile](troubleshoot.md)
- [Script reference](reference-scripts.md)
- [How the gateway route works](overview.md)