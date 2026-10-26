// T-125 (docs/TEST-PLAN.md): the admin console's Help page and the Settings page's client downloads (P-41).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = path.join(import.meta.dirname, '..');
const web = path.join(root, 'admin-ui', 'web');
const read = (f) => fs.readFileSync(path.join(web, f), 'utf8');

function load(file, name) {
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(read(file), context);
  return context[name];
}

// GitHub's heading anchors: lower case, punctuation other than hyphens and spaces removed, spaces as hyphens.
export const slug = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
export const anchorsOf = (markdown) => new Set(markdown.replace(/\r\n/g, '\n').replace(/```[\s\S]*?```/g, '').split('\n')
  .filter((l) => /^#{1,6}\s/.test(l)).map((l) => slug(l.replace(/^#+\s*/, ''))));

test('T-125 the navigation has a Help page, loaded before the router', () => {
  const html = read('index.html');
  assert.match(html, /<a href="#\/help" data-route="help">[\s\S]*?<span>Help<\/span>/);
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(scripts.includes('help-topics.js') && scripts.includes('help-page.js'), scripts.join(', '));
  assert.ok(scripts.indexOf('help-page.js') < scripts.indexOf('app.js'));
  assert.match(read('app.js'), /help:\s*helpPage/);
});

test('T-125 Help covers each administrator task, with the console\'s own labels and an existing article', () => {
  const topics = load('help-topics.js', 'helpTopics');
  const ids = topics.map((t) => t.id);
  for (const id of ['departments', 'groups', 'onboard-one', 'onboard-intune', 'desktop', 'models', 'caps', 'chargeback', 'admins']) {
    assert.ok(ids.includes(id), `no help topic ${id}; topics: ${ids.join(', ')}`);
  }
  const consoleText = fs.readdirSync(web).filter((f) => /\.(js|html)$/.test(f) && f !== 'help-topics.js').map(read).join('\n');
  for (const t of topics) {
    assert.ok(t.title && t.steps?.length, `${t.id} needs a title and steps`);
    for (const label of t.labels ?? []) assert.ok(consoleText.includes(label), `${t.id}: the console has no label "${label}"`);
    const [file, anchor] = t.doc.split('#');
    assert.ok(fs.existsSync(path.join(root, file)), `${t.id}: ${file} does not exist`);
    if (anchor) assert.ok(anchorsOf(fs.readFileSync(path.join(root, file), 'utf8')).has(anchor), `${t.id}: ${file} has no heading #${anchor}`);
  }
});

test('T-125 Settings offers the client kit and its single files for the chosen model', () => {
  const sv = load('settings-view.js', 'settingsView');
  const test1 = sv.clientKit('test', 'claude-sonnet-5');
  assert.equal(test1.zip, '/api/client-kit?model=claude-sonnet-5&fastModel=claude-sonnet-5');
  const testFiles = test1.files.map((f) => f.href);
  assert.ok(testFiles.includes('/api/client-kit?model=claude-sonnet-5&fastModel=claude-sonnet-5&file=desktop%2FClaudeDesktop-HKLM.reg'));
  assert.ok(testFiles.includes('/api/client-kit?model=claude-sonnet-5&fastModel=claude-sonnet-5&file=desktop%2FSet-ClaudeDesktopPolicy.ps1'));
  assert.ok(!testFiles.some((h) => h.includes('login%2F')), 'a public gateway must not offer the forced-login files');
  const priv = sv.clientKit('private', 'claude-opus-5').files.map((f) => f.href);
  assert.ok(priv.some((h) => h.endsWith('file=login%2Fmanaged-settings.json')));
  assert.ok(priv.some((h) => h.endsWith('file=login%2FClaudeCode-HKLM.reg')));
  assert.equal(sv.clientKit('test', ''), null);
  assert.equal(sv.clientKit('test', 'a b&c'), null);
});

test('T-125 Settings renders the client kit downloads', () => {
  const page = read('settings-page.js');
  assert.match(page, /settingsView\.clientKit\(/);
  assert.match(page, /Download client kit/);
});
