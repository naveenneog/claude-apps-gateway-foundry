import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// T-162 (P-45 to P-48): the first-install documents show the options a first-time administrator chooses, and no step
// tells them to renew the gateway's sign-in credential by hand.
const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const prose = (text) => text.replace(/\r\n/g, '\n').replace(/\n>\s?/g, ' ').replace(/\s+/g, ' ');

test('T-162 README and the tutorial show the existing-group, region-list, open-by-default and certificate behaviour', () => {
  for (const rel of ['README.md', 'docs/learn/tutorial-first-install.md']) {
    const text = read(rel);
    assert.match(text, /-UseExistingResourceGroup/, `${rel}: existing group`);
    assert.match(text, /-DatabaseLocation \$regions/, `${rel}: the region list`);
    assert.match(text, /\$regions = '[a-z0-9]+(,[a-z0-9]+)+'/, `${rel}: a region list example`);
    assert.match(text, /any network/, `${rel}: open by default`);
    assert.match(text, /certificate/, `${rel}: certificate sign-in`);
    for (const command of text.match(/^pwsh -File infra\/azure-test\/Install-ClaudeGateway\.ps1 .+$/gm) ?? []) {
      assert.doesNotMatch(command, /-ClientSecretDays 30/, `${rel}: a 30-day secret is no longer the install's default`);
      assert.doesNotMatch(command, /-TesterCidr \$cidr/, `${rel}: no address range is needed for a first install`);
    }
  }
});

test('T-162 the tutorial explains the credential renewal and the preflight, and the troubleshooting table covers their stops', () => {
  const tutorial = read('docs/learn/tutorial-first-install.md');
  assert.match(tutorial, /^## Check the gateway's sign-in credential$/m);
  assert.doesNotMatch(tutorial, /every three\s+weeks/, 'no manual renewal schedule');
  assert.match(tutorial, /job-signin-renewer/);
  assert.match(tutorial, /Renew now/);
  assert.match(tutorial, /preflight: PASS/);
  for (const stop of ['FAIL  database: no region', 'the resource group exists and was not created by this tool', 'falling back to a client secret', 'not made by the installer']) {
    assert.ok(tutorial.includes(stop), `the tutorial's stops table covers "${stop}"`);
  }
  const troubleshoot = read('docs/learn/troubleshoot.md');
  assert.match(troubleshoot, /AADSTS700027/);
  assert.match(troubleshoot, /`preflight` prints a `FAIL` line/);
});

for (const rel of ['README.md', 'docs/learn/tutorial-first-install.md']) {
  test(`T-162 ${rel} identifies the new-install certificate store`, () => {
    const text = prose(read(rel));
    assert.ok(/new (?:test-topology )?install[\s\S]{0,220}Container Apps\s+secret `oidc-certificate`/i.test(text),
      `${rel}: a new install stores its certificate as a Container Apps secret`);
    assert.ok(/not\s+in\s+(?:Azure\s+)?Key\s+Vault/i.test(text), `${rel}: the credential is not in Key Vault`);
  });
}

test('T-162 the tutorial states the credential fallback, exceptions and secret-store access', () => {
  const text = read('docs/learn/tutorial-first-install.md').replace(/\r\n/g, '\n');
  const section = prose(text.split("## Check the gateway's sign-in credential")[1]?.split('## Update the gateway')[0] ?? '');
  assert.ok(/(?:may|can)\s+fall back to a client secret[\s\S]{0,160}`oidc-client-secret`/i.test(section),
    'the client secret is a possible fallback and names its Container Apps secret');
  assert.ok(/`-SignInCredential certificate`[\s\S]{0,100}stop/i.test(section),
    'explicit certificate mode stops instead of falling back');
  assert.ok(/some errors[\s\S]{0,80}stop/i.test(section), 'some errors stop even in the default mode');
  assert.ok(/existing install[\s\S]{0,100}client secret[\s\S]{0,80}keeps/i.test(section),
    'an existing secret-mode install keeps its mode');
  assert.ok(/`-KeyVaultName` and `-CreateKeyVault` are not implemented/i.test(section),
    'the installer does not offer Key Vault options');
  assert.ok(/Microsoft\.App\/containerApps\/listSecrets\/action/.test(section),
    'the relevant permission to read Container Apps secrets is named');
  assert.ok(section.includes('https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets'),
    'the storage guidance cites Microsoft');
  assert.ok(section.includes('docs/adr/0016-signin-certificate-in-key-vault-with-renewal-job.md'),
    'the storage guidance cites the amended decision');
});

for (const rel of ['README.md', 'docs/learn/tutorial-first-install.md', 'docs/learn/quickstart-developer.md']) {
  test(`T-162 ${rel} distinguishes the VS Code terminal from the extension panel`, () => {
    const text = prose(read(rel));
    assert.ok(/VS Code(?:'s)? integrated (?:PowerShell )?terminal/i.test(text), `${rel}: the terminal runs the launcher`);
    assert.ok(/VS Code extension(?:'s)? (?:side )?panel[^.!?]{0,180}(?:not (?:yet )?(?:been )?verified|unverified)/i.test(text),
      `${rel}: extension-panel session reuse remains unverified`);
  });
}

test('T-162 the tutorial explains the Windows profile and saved sign-in', () => {
  const text = read('docs/learn/tutorial-first-install.md').replace(/\r\n/g, '\n');
  const section = prose(text.split('### One machine')[1]?.split('### Many machines with Intune')[0] ?? '');
  assert.ok(/profile is in `%USERPROFILE%\\\.claude-apps-gateway`/i.test(section), 'the default profile path is stated');
  assert.ok(/saved sign-in session is encrypted for that Windows user[\s\S]{0,100}`%LOCALAPPDATA%\\ClaudeAppsGateway\\sessions`/i.test(section),
    'the saved session location and Windows-user encryption are stated');
  assert.ok(/refreshes its token automatically[\s\S]{0,100}does not require another browser sign-in each time/i.test(section),
    'the launcher does not need a browser sign-in every time');
});

test('T-162 the onboarding commands use replaceable examples rather than bare placeholders', () => {
  const text = read('docs/learn/tutorial-first-install.md').replace(/\r\n/g, '\n');
  const section = text.split('## Onboard developers')[1]?.split('### Many machines with Intune')[0] ?? '';
  const commands = [...section.matchAll(/```powershell\n([\s\S]*?)```/g)].map((match) => match[1]);
  assert.ok(commands.length >= 3, 'the administrator and developer commands are present');
  assert.ok(commands.every((command) => !/<[^>\n]+>/.test(command)), 'the commands have no bare angle-bracket placeholders');
  assert.ok(/`https:\/\/gateway\.contoso\.example` is an example/i.test(section), 'the example gateway URL is explained');
  assert.ok(/`C:\\path\\to\\developer` is an example/i.test(section), 'the example developer folder is explained');
});

test('T-162 the tutorial separates the certificate pilot from proven client and model paths', () => {
  const text = read('docs/learn/tutorial-first-install.md').replace(/\r\n/g, '\n');
  const section = prose(text.split('## Onboard developers')[1]?.split('\n## ')[0] ?? '');
  assert.ok(/browser sign-in[\s\S]{0,180}stand-in Foundry deployment[\s\S]{0,180}Claude inference[^.!?]{0,100}not been verified/i.test(section),
    'the certificate test verified sign-in, not real Claude inference');
  assert.ok(/Claude Desktop[\s\S]{0,150}earlier public gateway[\s\S]{0,100}not on (?:the|this) certificate test gateway/i.test(section),
    'Desktop was tested on a different gateway');
  assert.ok(/Intune[\s\S]{0,200}not (?:yet )?(?:been )?(?:assigned|verified)[\s\S]{0,60}Intune tenant/i.test(section),
    'Intune tenant assignment is not verified');
});
