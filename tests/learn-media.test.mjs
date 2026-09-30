// T-72 (docs/TEST-PLAN.md): the network-restricted deployment articles (P-29, ADR-0005). Every image an article shows
// exists with alt text and every file in docs/learn/media is shown; each step of the tutorial has the Azure portal,
// Azure CLI and Script tabs; every `az` command in a CLI tab is a command infra/azure-private runs; every -Step the
// articles name is a step of the script. The fixture tests at the end show that each detector reports what it guards.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEARN = path.join(root, 'docs', 'learn');
const TUTORIAL = 'docs/learn/tutorial-deploy-network-restricted.md';
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const articles = () => fs.readdirSync(LEARN).filter((f) => f.endsWith('.md')).map((f) => ({ rel: `docs/learn/${f}`, text: read(`docs/learn/${f}`) }));

// The images an article shows, with Learn's :::image::: syntax or Markdown's ![alt](src).
export function imagesOf(text) {
  const found = [];
  for (const m of text.matchAll(/:::image\s+([\s\S]*?):::/g)) {
    found.push({ source: /source="([^"]*)"/.exec(m[1])?.[1] ?? '', alt: /alt-text="([^"]*)"/.exec(m[1])?.[1] ?? '' });
  }
  for (const m of text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) found.push({ source: m[2], alt: m[1] });
  return found;
}

export function imageProblems(docs, mediaFiles, exists) {
  const problems = [];
  const shown = new Set();
  for (const { rel, text } of docs) {
    for (const { source, alt } of imagesOf(text)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), source));
      shown.add(target);
      if (!exists(target)) problems.push(`${rel}: image ${source} does not exist`);
      if (alt.trim().length < 20) problems.push(`${rel}: image ${source} has no alt text of 20 characters or more`);
    }
  }
  for (const file of mediaFiles) if (!shown.has(file)) problems.push(`${file} is not shown by any article`);
  return problems;
}

// The steps of the tutorial's "Deploy the gateway" section: each has the three tabs in order and ends its tab group.
export function tabProblems(text) {
  const section = text.split(/^## /m).find((s) => s.startsWith('Deploy the gateway'));
  if (!section) return ['no "Deploy the gateway" section'];
  const steps = section.split(/^### /m).slice(1);
  if (steps.length === 0) return ['the "Deploy the gateway" section has no steps'];
  const problems = [];
  for (const step of steps) {
    const name = step.slice(0, step.indexOf('\n')).trim();
    const tabs = [...step.matchAll(/^# \[[^\]]+\]\(#tab\/([\w-]+)\)\s*$/gm)].map((m) => m[1]);
    if (tabs.join(',') !== 'portal,cli,script') problems.push(`${name}: tabs are ${tabs.join(',') || 'missing'}, not portal,cli,script`);
    if (!/^---\s*$/m.test(step.slice(step.lastIndexOf('#tab/')))) problems.push(`${name}: the tab group does not end with ---`);
    // A portal tab names where each setting is: a navigation path such as **Virtual networks** > **Create**.
    const portal = step.split(/^# \[/m).find((t) => /^[^\]]+\]\(#tab\/portal\)/.test(t)) ?? '';
    if (!/\*\*[^*\n]+\*\* > /.test(portal)) problems.push(`${name}: the portal tab names no navigation path`);
  }
  return problems;
}

// The command words of each az invocation in infra/azure-private: the leading quoted words of an argument array, where a
// variable such as $verb stands for any word.
export function scriptCommands(sources) {
  const patterns = [];
  for (const text of sources) {
    for (const m of text.matchAll(/@\(\s*'([a-z][\w-]*)'((?:\s*,\s*(?:'[^']*'|\$[\w.]+))*)/g)) {
      const words = [m[1]];
      for (const t of m[2].matchAll(/'([^']*)'|(\$[\w.]+)/g)) {
        if (t[1] !== undefined && t[1].startsWith('-')) break;
        words.push(t[1] ?? '*');
      }
      patterns.push(words);
    }
  }
  return patterns;
}

// The az commands inside the CLI tabs of an article, as command words: the words after `az` up to the first option or value.
export function cliTabCommands(text) {
  const commands = [];
  for (const tab of text.split(/^# \[/m).slice(1).filter((t) => /^[^\]]+\]\(#tab\/cli\)/.test(t))) {
    const body = tab.split(/^---\s*$/m)[0];
    for (const block of body.matchAll(/```powershell\n([\s\S]*?)```/g)) {
      for (const line of block[1].split('\n')) {
        for (const m of line.matchAll(/(?:^|[\s(])az\s+((?:[a-z][\w-]*\s*)+)/g)) commands.push({ line: line.trim(), words: m[1].trim().split(/\s+/) });
      }
    }
  }
  return commands;
}

export function commandProblems(commands, patterns) {
  const matches = (words, p) => p.length === words.length && p.every((w, i) => w === '*' || w === words[i]);
  return commands.filter(({ words }) => !patterns.some((p) => matches(words, p))).map(({ words, line }) => `az ${words.join(' ')} is not a command infra/azure-private runs: ${line.slice(0, 90)}`);
}

// The -Step values the articles pass to Deploy-Gateway.ps1, against the script's step list.
export function stepProblems(docs, steps) {
  const problems = [];
  for (const { rel, text } of docs) {
    for (const m of text.matchAll(/Deploy-Gateway\.ps1[^\n`]*?-Step\s+([\w,]+)/g)) {
      for (const s of m[1].split(',')) if (s !== 'all' && !steps.includes(s)) problems.push(`${rel}: -Step ${s} is not a step of Deploy-Gateway.ps1`);
    }
  }
  return problems;
}

const scriptSources = () => ['infra/azure-private/Deploy-Gateway.ps1', ...fs.readdirSync(path.join(root, 'infra', 'azure-private', 'lib')).map((f) => `infra/azure-private/lib/${f}`)].map(read);
const scriptSteps = () => /\$order = ((?:'[a-z]+',?\s*)+)/.exec(read('infra/azure-private/Deploy-Gateway.ps1'))[1].match(/[a-z]+/g);
const mediaFiles = () => {
  const out = [];
  const walk = (rel) => { for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) { if (e.isDirectory()) walk(`${rel}/${e.name}`); else out.push(`${rel}/${e.name}`); } };
  walk('docs/learn/media');
  return out;
};

test('T-72 every image an article shows exists with alt text, and every media file is shown', () => {
  assert.deepEqual(imageProblems(articles(), mediaFiles(), (rel) => fs.existsSync(path.join(root, rel))), []);
  assert.ok(imagesOf(read(TUTORIAL)).length >= 10, 'the tutorial shows fewer than 10 images');
});

test('T-72 each step of the tutorial has the Azure portal, Azure CLI and Script tabs', () => {
  assert.deepEqual(tabProblems(read(TUTORIAL)), []);
  assert.ok(read(TUTORIAL).split(/^### Step /m).length - 1 >= 10, 'the tutorial has fewer than 10 steps');
});

test('T-72 every az command in a CLI tab is one that infra/azure-private runs, and every -Step is a step of the script', () => {
  const commands = cliTabCommands(read(TUTORIAL));
  assert.ok(commands.length >= 40, `expected at least 40 az commands in the CLI tabs, found ${commands.length}`);
  assert.deepEqual(commandProblems(commands, scriptCommands(scriptSources())), []);
  assert.deepEqual(stepProblems(articles(), scriptSteps()), []);
});

test('T-72 detectors: each defect in a fixture is reported', () => {
  const doc = (body) => [{ rel: 'docs/learn/x.md', text: body }];
  const exists = (rel) => rel === 'docs/learn/media/a.png';
  const alt = 'Screenshot of the subnets of the virtual network';
  assert.deepEqual(imageProblems(doc(`:::image type="content" source="media/a.png" alt-text="${alt}":::`), ['docs/learn/media/a.png'], exists), []);
  assert.deepEqual(imageProblems(doc(`:::image type="content" source="media/a.png" alt-text="${alt}: with a colon":::`), ['docs/learn/media/a.png'], exists), [], 'alt text may hold a colon');
  assert.match(imageProblems(doc(`:::image type="content" source="media/b.png" alt-text="${alt}":::`), [], exists)[0], /media\/b\.png does not exist/);
  assert.match(imageProblems(doc(':::image type="content" source="media/a.png" alt-text="":::'), ['docs/learn/media/a.png'], exists)[0], /no alt text/);
  assert.match(imageProblems(doc(`![${alt}](media/b.png)`), [], exists)[0], /does not exist/, 'a Markdown image is checked too');
  assert.deepEqual(imageProblems(doc('No images.'), ['docs/learn/media/a.png'], exists), ['docs/learn/media/a.png is not shown by any article']);

  const step = (tabs, end = '---', portalText = '**Virtual networks** > **Create**.') => `## Deploy the gateway\n\n### Step 1: X\n\n${tabs.map((t) => `# [T](#tab/${t})\n\n${t === 'portal' ? portalText : 'Text.'}\n`).join('\n')}\n${end}\n`;
  assert.deepEqual(tabProblems(step(['portal', 'cli', 'script'])), []);
  assert.deepEqual(tabProblems(step(['portal', 'cli', 'script'], '---', 'Create a virtual network.')), ['Step 1: X: the portal tab names no navigation path']);
  assert.match(tabProblems(step(['portal', 'script']))[0], /tabs are portal,script/);
  assert.match(tabProblems(step(['cli', 'portal', 'script']))[0], /not portal,cli,script/);
  assert.match(tabProblems(step(['portal', 'cli', 'script'], ''))[0], /does not end with ---/);
  assert.deepEqual(tabProblems('## Other\n'), ['no "Deploy the gateway" section']);

  const patterns = scriptCommands([
    "Invoke-AzChange @('network', 'vnet', 'create', '-g', $rg)",
    "Invoke-AzChange @('containerapp', $verb, '-g', $rg, '--yaml', $file)",
  ]);
  assert.deepEqual(patterns, [['network', 'vnet', 'create'], ['containerapp', '*']]);
  const cli = (line) => `# [Azure CLI](#tab/cli)\n\n\`\`\`powershell\n${line}\n\`\`\`\n\n---\n`;
  assert.deepEqual(commandProblems(cliTabCommands(cli('az network vnet create -g $rg -n x')), patterns), []);
  assert.deepEqual(commandProblems(cliTabCommands(cli('az containerapp create -g $rg --yaml a.yaml')), patterns), [], 'a variable in the script stands for any word');
  assert.match(commandProblems(cliTabCommands(cli('az network vnet delete -g $rg -n x')), patterns)[0], /az network vnet delete is not a command/);
  assert.match(commandProblems(cliTabCommands(cli('$id = (az network vnet list --query x)')), patterns)[0], /az network vnet list/, 'az inside an expression is checked');
  assert.deepEqual(cliTabCommands('# [Script](#tab/script)\n\n```powershell\naz network vnet delete\n```\n'), [], 'only CLI tabs are checked');

  assert.deepEqual(stepProblems(doc('pwsh -File infra/azure-private/Deploy-Gateway.ps1 -Step network,app'), ['network', 'app']), []);
  assert.deepEqual(stepProblems(doc('pwsh -File infra/azure-private/Deploy-Gateway.ps1 -Step network,bogus'), ['network']),
    ['docs/learn/x.md: -Step bogus is not a step of Deploy-Gateway.ps1']);
});
