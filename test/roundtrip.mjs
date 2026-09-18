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
  globalName: 'H',
  platform: 'browser',
  target: 'es2022',
});
const stubBundle = outputFiles[0].text;

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (error) => console.error('page error:', error.message));
await page.setContent('<div id="blockly" style="width:800px;height:600px"></div>');
// Blockly now comes bundled inside the harness, as it does in the webview.
await page.addScriptTag({ content: stubBundle });

const sampleDir = join(root, 'sample');
const samples = (await readdir(sampleDir)).filter((name) => name.endsWith('.blocks'));
assert.ok(samples.length > 0, 'expected at least one sample .blocks file');

let failures = 0;
/** Serialized output per sample, for the fidelity checks further down. */
const serializedBySample = new Map();

for (const name of samples) {
  const original = await readFile(join(sampleDir, name), 'utf8');
  const result = await page.evaluate((xml) => {
    // Register the Arcade library first, exactly as the editor does — otherwise
    // every Arcade block would fall back to a placeholder and this would be
    // testing the stub mechanism rather than the block library.
    H.registerArcadeBlocks();
    const dom = H.parseBlocksXml(xml);
    const stubbed = H.defineStubsFor(dom);
    const preserved = H.preserveUnknownFields(dom);
    const workspace = Blockly.inject('blockly', { renderer: 'pxt' });
    Blockly.Xml.clearWorkspaceAndLoadFromXml(dom, workspace);
    const out = H.serializeWorkspace(workspace);
    const blockCount = workspace.getAllBlocks(false).length;
    workspace.dispose();
    return { out, stubbed, preserved, blockCount };
  }, original);

  serializedBySample.set(name, result.out);

  const before = shape(original);
  const after = shape(result.out);

  try {
    assert.ok(result.blockCount > 0, 'workspace loaded no blocks');
    assert.deepEqual(after, before, 'serialized structure differs from the source file');
    // A sample named arcade-* must be covered by the generated Arcade library:
    // if any of its blocks fell back to a placeholder, the library has a hole.
    if (name.startsWith('arcade-')) {
      assert.deepEqual(
        result.stubbed,
        [],
        'Arcade blocks fell back to placeholders instead of real definitions'
      );
    }
    console.log(
      `PASS ${name} — ${result.blockCount} blocks` +
        (result.stubbed.length ? `, stubbed: ${result.stubbed.join(', ')}` : '') +
        (result.preserved.length ? `, preserved fields: ${result.preserved.join(', ')}` : '')
    );
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}: ${error.message}`);
    console.error('  expected:', JSON.stringify(before));
    console.error('  actual  :', JSON.stringify(after));
  }
}

// Details the structural comparison above deliberately ignores (it normalizes
// away ids, whitespace and attribute order) but which still must not be lost.
// These patterns come from a file saved by MakeCode Arcade itself.
const FIDELITY = {
  'arcade-real.blocks': [
    ['sprite kind field', /<field name="MEMBER">Player<\/field>/],
    ['user-defined kinds', /<variable type="KIND_SpriteKind"[^>]*>Enemy<\/variable>/],
    ['pixel-art image literal', /3 3 3 3 3 3 3/],
    ['block <data> payload', /<data>\{"commentRefs"/],
    ['expandable-block mutation', /_expanded="0"/],
    ['speed field editor value', /<field name="speed">100<\/field>/],
    ['variable id with punctuation', /EAxh@b_I_0=rzSxew0,2/],
  ],
};

for (const [sample, patterns] of Object.entries(FIDELITY)) {
  const serialized = serializedBySample.get(sample);
  if (!serialized) {
    failures++;
    console.error(`FAIL ${sample} was not round-tripped, so fidelity was not checked`);
    continue;
  }
  for (const [label, pattern] of patterns) {
    if (pattern.test(serialized)) {
      console.log(`PASS keeps ${label}`);
    } else {
      failures++;
      console.error(`FAIL lost ${label} from ${sample}`);
    }
  }
}

// The sprite image editor reads and writes MakeCode's `img` literal. Getting
// this wrong would corrupt artwork, so the shapes it must handle are pinned.
const imageCases = await page.evaluate(() => {
  const results = [];
  const sample = 'img`\n. . . .\n. 3 3 .\n. 3 f .\n. . . .\n`';

  const parsed = H.parseImageLiteral(sample);
  results.push(['parses size', parsed && parsed.width === 4 && parsed.height === 4]);
  results.push(['maps . to transparent', parsed && parsed.pixels[0] === 0]);
  results.push(['maps hex digits', parsed && parsed.pixels[5] === 3 && parsed.pixels[10] === 15]);

  // Round-tripping through the formatter must be stable: format(parse(x)) has to
  // parse back to the same pixels, or repeated edits would drift.
  const reparsed = H.parseImageLiteral(H.formatImageLiteral(parsed));
  results.push([
    'format round-trips',
    reparsed &&
      reparsed.width === parsed.width &&
      reparsed.height === parsed.height &&
      reparsed.pixels.every((value, i) => value === parsed.pixels[i]),
  ]);

  // MakeCode's own layout: an `img` tag, one token per pixel each followed by a
  // space, one row per line.
  const formatted = H.formatImageLiteral(H.createImage(2, 2));
  results.push(['emits MakeCode layout', formatted === 'img`\n. . \n. . \n`']);

  // Anything that is not an image literal must be left alone rather than coerced.
  results.push(['rejects non-image text', H.parseImageLiteral('hello') === undefined]);
  results.push(['rejects empty literal', H.parseImageLiteral('img``') === undefined]);

  // A ragged literal (short final row) should still parse rather than throw.
  const ragged = H.parseImageLiteral('img`\n1 2 3\n4 5\n`');
  results.push(['handles ragged rows', ragged && ragged.width === 3 && ragged.pixels[5] === 0]);

  return results;
});

for (const [label, ok] of imageCases) {
  if (ok) {
    console.log(`PASS image literal ${label}`);
  } else {
    failures++;
    console.error(`FAIL image literal ${label}`);
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
      H.parseBlocksXml(xml);
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
    return H.parseBlocksXml('   ').tagName.toLowerCase() === 'xml';
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
