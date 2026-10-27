// T-126 (docs/TEST-PLAN.md): a new reader learns to create departments (business units) and to give a team a role
// through an Entra group (P-41), with pseudonymised screenshots and output.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.join(import.meta.dirname, '..');
const rel = 'docs/learn/how-to-organize-departments.md';
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');

test('T-126 T-147 the departments article covers the console, a CSV import, groups and the check, and keeps Entra unchanged', () => {
  const text = read(rel);
  for (const h of ['## Create a department in the admin console', '## Import tags for many users from a CSV file',
    '## Give a whole team a role with an Entra group', '## Check the result']) {
    assert.ok(text.includes(`\n${h}\n`), `missing heading "${h}"`);
  }
  for (const s of ['Business units', 'Edit', 'Import CSV', 'Group by', 'P1 or P2', 'Nested', 'admin_console.user_tags',
    'Department', 'Cost center', 'Company', 'Office', 'Division', 'managed database',
    'https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal']) {
    assert.ok(text.includes(s), `the article does not mention ${s}`);
  }
  assert.match(text, /Entra ID is not changed/);
  assert.doesNotMatch(text, /## Set a department in the Microsoft Entra admin center|Update-MgUser|Connect-MgGraph|GrantUserWrite/, 'no step writes Entra users');
});

test('T-147 no Learn article or console README tells the reader to grant User.ReadWrite.All', () => {
  const dir = path.join(root, 'docs', 'learn');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => `docs/learn/${f}`).concat(['admin-ui/README.md', 'README.md']);
  for (const f of files) {
    const text = read(f);
    assert.doesNotMatch(text, /GrantUserWrite/, `${f} names the removed -GrantUserWrite`);
    for (const line of text.split('\n').filter((l) => l.includes('User.ReadWrite.All'))) {
      assert.match(line, /not (grant|need|use|ask)\w*|no longer|never|removes?|instead of|refus/i, `${f}: "${line.slice(0, 120)}" reads as an instruction to grant it`);
    }
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
