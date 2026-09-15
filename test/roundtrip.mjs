/**
 * Round-trip test: loading a .blocks file into the editor's workspace and
 * serializing it back must preserve the file's block structure — including
 * block types the editor does not know, which is the normal case for MakeCode
 * files. Runs against real Blockly in real Chromium, because Blockly's XML path
 * depends on browser DOM behavior that a jsdom stand-in does not reproduce.
 */
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const { outputFiles } = await build({
  entryPoints: [join(root, 'test/harness.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'Stubs',
  platform: 'browser',
  target: 'es2022',
});
const stubBundle = outputFiles[0].text;
const blocklySource = await readFile(join(root, 'media/vendor/blockly/blockly.min.js'), 'utf8');

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (error) => console.error('page error:', error.message));
await page.setContent('<div id="blockly" style="width:800px;height:600px"></div>');
await page.addScriptTag({ content: blocklySource });
await page.addScriptTag({ content: stubBundle });

const sampleDir = join(root, 'sample');
const samples = (await readdir(sampleDir)).filter((name) => name.endsWith('.blocks'));
assert.ok(samples.length > 0, 'expected at least one sample .blocks file');

let failures = 0;

for (const name of samples) {
  const original = await readFile(join(sampleDir, name), 'utf8');
  const result = await page.evaluate((xml) => {
    const dom = Stubs.parseBlocksXml(xml);
    const stubbed = Stubs.defineStubsFor(dom);
    const workspace = Blockly.inject('blockly', { renderer: 'zelos' });
    Blockly.Xml.clearWorkspaceAndLoadFromXml(dom, workspace);
    const out = Stubs.serializeWorkspace(workspace);
    const blockCount = workspace.getAllBlocks(false).length;
    workspace.dispose();
    return { out, stubbed, blockCount };
  }, original);

  const before = shape(original);
  const after = shape(result.out);

  try {
    assert.ok(result.blockCount > 0, 'workspace loaded no blocks');
    assert.deepEqual(after, before, 'serialized structure differs from the source file');
    console.log(
      `PASS ${name} — ${result.blockCount} blocks` +
        (result.stubbed.length ? `, stubbed: ${result.stubbed.join(', ')}` : '')
    );
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}: ${error.message}`);
    console.error('  expected:', JSON.stringify(before));
    console.error('  actual  :', JSON.stringify(after));
  }
}

// A collaborator editing the file as text produces transiently malformed XML.
// Parsing must reject it, because a lenient parse yields an almost-empty
// workspace that would then be written back over their file.
const malformed = [
  ['unclosed tag', '<xml>\n<<<broken\n</xml>'],
  ['mismatched tags', '<xml><block type="a"></xm>'],
  ['truncated mid-attribute', '<xml><block type="a'],
  ['not XML at all', 'hello'],
  ['wrong root element', '<blocks><block type="a"/></blocks>'],
];

for (const [label, text] of malformed) {
  const rejected = await page.evaluate((xml) => {
    try {
      Stubs.parseBlocksXml(xml);
      return false;
    } catch {
      return true;
    }
  }, text);
  if (rejected) {
    console.log(`PASS rejects ${label}`);
  } else {
    failures++;
    console.error(`FAIL accepted malformed XML (${label}): ${text}`);
  }
}

// An empty file is a legitimate starting point, not a parse error.
const emptyOk = await page.evaluate(() => {
  try {
    return Stubs.parseBlocksXml('   ').tagName.toLowerCase() === 'xml';
  } catch {
    return false;
  }
});
if (emptyOk) {
  console.log('PASS accepts an empty file');
} else {
  failures++;
  console.error('FAIL rejected an empty file');
}

await browser.close();

if (failures > 0) {
  console.error(`\n${failures} sample(s) failed to round-trip.`);
  process.exit(1);
}
console.log(`\nAll ${samples.length} sample(s) round-tripped; malformed input rejected.`);

/**
 * Reduces XML to the structure that must survive a round trip: block/shadow
 * types, their nesting, and their field values. Ignores attribute ordering,
 * whitespace, coordinates and ids, which Blockly is free to rewrite.
 */
function shape(xml) {
  const nodes = [];
  const stack = [];

  // A tiny structural walk, to avoid pulling a DOM library into the test.
  const tokens = xml.match(/<[^>]+>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (!token.startsWith('<')) {
      const text = token.trim();
      if (text && stack.length && stack[stack.length - 1].startsWith('field:')) {
        nodes.push(`${'  '.repeat(stack.length)}${stack[stack.length - 1]}=${text}`);
      }
      continue;
    }
    if (token.startsWith('</')) {
      stack.pop();
      continue;
    }
    const tag = /^<\s*([a-zA-Z]+)/.exec(token)?.[1];
    if (!tag || tag === 'xml') {
      continue;
    }
    const attr = (key) => new RegExp(`${key}="([^"]*)"`).exec(token)?.[1];
    const label =
      tag === 'field' || tag === 'variable'
        ? `${tag}:${attr('name') ?? attr('type') ?? ''}`
        : tag === 'block' || tag === 'shadow'
          ? `${tag}:${attr('type') ?? ''}`
          : `${tag}:${attr('name') ?? ''}`;

    if (tag !== 'field' && tag !== 'variable') {
      nodes.push(`${'  '.repeat(stack.length)}${label}`);
    }
    if (!token.endsWith('/>')) {
      stack.push(label);
    }
  }
  return nodes;
}
