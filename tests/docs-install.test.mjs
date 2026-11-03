import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// T-162 (P-45 to P-48): the first-install documents show the options a first-time administrator chooses, and no step
// tells them to renew the gateway's sign-in credential by hand.
const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

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
