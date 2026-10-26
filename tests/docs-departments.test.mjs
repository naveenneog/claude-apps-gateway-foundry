// T-126 (docs/TEST-PLAN.md): a new reader learns to create departments (business units) and to give a team a role
// through an Entra group (P-41), with pseudonymised screenshots and output.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.join(import.meta.dirname, '..');
const rel = 'docs/learn/how-to-organize-departments.md';
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');

test('T-126 the departments article covers the console, the Entra admin center, a CSV, groups and the check', () => {
  const text = read(rel);
  for (const h of ['## Create a department in the admin console', '## Set a department in the Microsoft Entra admin center',
    '## Set departments for many users from a CSV file', '## Give a whole team a role with an Entra group', '## Check the result']) {
    assert.ok(text.includes(`\n${h}\n`), `missing heading "${h}"`);
  }
  for (const s of ['Business units', 'Edit', 'Group by', 'Update-MgUser', 'P1 or P2', 'Nested',
    'https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal', 'User.ReadWrite.All']) {
    assert.ok(text.includes(s), `the article does not mention ${s}`);
  }
});

test('T-126 every screenshot exists, and every example address is a made-up one', () => {
  const text = read(rel);
  const images = [...text.matchAll(/!\[[^\]]+\]\(([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(images.length >= 2, 'expected screenshots');
  for (const img of images) assert.ok(fs.existsSync(path.join(root, 'docs', 'learn', img)), `${img} is missing`);
  for (const m of text.matchAll(/[\w.-]+@([\w-]+(?:\.[\w-]+)+)/g)) assert.match(m[1], /^contoso\.(com|example)$/, `${m[0]} is not a made-up address`);
});

test('T-126 the article is reachable from the table of contents, the console article, users-and-groups and the tutorial', () => {
  const name = path.posix.basename(rel);
  for (const f of ['docs/learn/toc.yml', 'docs/learn/how-to-use-admin-console.md', 'docs/learn/how-to-manage-users-and-groups.md', 'docs/learn/tutorial-first-install.md']) {
    assert.ok(read(f).includes(name), `${f} does not link ${name}`);
  }
});
