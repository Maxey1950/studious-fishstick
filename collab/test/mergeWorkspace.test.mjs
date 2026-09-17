/**
 * Tests that applying a peer's blocks touches only the blocks that changed.
 *
 * This is the difference between collaboration and a slideshow: rebuilding the
 * whole canvas on every incoming change is what made the editor look like it
 * was reloading. The cases below are driven from the real Arcade sample, whose
 * top-level block carries no id at all — the case that makes id-matching alone
 * insufficient.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');

const { outputFiles } = await build({
  entryPoints: [join(root, 'src/webview/makecode/sameOrigin.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
});
const dir = await mkdtemp(join(tmpdir(), 'merge-'));
const module = join(dir, 'sameOrigin.mjs');
await writeFile(module, outputFiles[0].text);
const { mergeIntoWorkspace } = await import(module);

const { window } = new JSDOM('');
const parse = (xml) => {
  const doc = new window.DOMParser().parseFromString(xml, 'text/xml');
  return doc.documentElement;
};

/**
 * A Blockly and workspace stand-in that records what was disposed and built.
 *
 * Blocks are just the elements they came from, so `blockToDom` is the identity
 * — which is the honest model: a block serializes back to what created it.
 */
function harness(xml) {
  const disposed = [];
  const built = [];
  const blocks = Array.from(parse(xml).children)
    .filter((child) => child.tagName.toLowerCase() === 'block')
    .map((element, index) => ({
      id: element.getAttribute('id') ?? `generated-${index}`,
      element,
      dispose() {
        disposed.push(this);
        workspace.blocks = workspace.blocks.filter((block) => block !== this);
      },
    }));

  const workspace = {
    blocks,
    getTopBlocks: () => [...workspace.blocks],
  };

  const Blockly = {
    Xml: {
      blockToDom: (block) => block.element,
      domToBlock: (element) => {
        built.push(element);
        workspace.blocks.push({ id: element.getAttribute('id') ?? 'new', element });
      },
      domToVariables: () => {},
    },
  };

  return { Blockly, workspace, disposed, built };
}

const samples = {
  hello: await readFile(join(root, 'sample/hello.blocks'), 'utf8'),
  arcade: await readFile(join(root, 'sample/arcade-real.blocks'), 'utf8'),
};

for (const [name, xml] of Object.entries(samples)) {
  test(`${name}: identical blocks are left standing`, () => {
    const { Blockly, workspace, disposed, built } = harness(xml);
    assert.equal(mergeIntoWorkspace(Blockly, workspace, parse(xml)), true);
    assert.deepEqual(disposed, [], 'nothing should have been disposed');
    assert.deepEqual(built, [], 'nothing should have been rebuilt');
  });

  test(`${name}: reordered attributes and whitespace are not a change`, () => {
    const { Blockly, workspace, disposed, built } = harness(xml);
    // Blockly spells the same block differently from the file; the merge must
    // compare meaning, not text.
    const respelled = xml.replace(/<block type="([^"]+)" x="([^"]+)" y="([^"]+)"/g,
      '<block y="$3" x="$2" type="$1"');
    assert.equal(mergeIntoWorkspace(Blockly, workspace, parse(respelled)), true);
    assert.deepEqual(disposed, []);
    assert.deepEqual(built, []);
  });
}

test('hello: a changed block is the only one rebuilt', () => {
  const xml = `<xml xmlns="https://developers.google.com/blockly/xml">` +
    `<block type="a" id="one" x="0" y="0"><field name="N">1</field></block>` +
    `<block type="b" id="two" x="0" y="80"><field name="N">2</field></block>` +
    `</xml>`;
  const changed = xml.replace('>2<', '>3<');

  const { Blockly, workspace, disposed, built } = harness(xml);
  assert.equal(mergeIntoWorkspace(Blockly, workspace, parse(changed)), true);
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0].id, 'two');
  assert.equal(built.length, 1);
  assert.equal(built[0].getAttribute('id'), 'two');
});

test('a deleted block is removed and nothing else touched', () => {
  const xml = `<xml xmlns="https://developers.google.com/blockly/xml">` +
    `<block type="a" id="one" x="0" y="0"/>` +
    `<block type="b" id="two" x="0" y="80"/>` +
    `</xml>`;
  const without = `<xml xmlns="https://developers.google.com/blockly/xml">` +
    `<block type="a" id="one" x="0" y="0"/></xml>`;

  const { Blockly, workspace, disposed, built } = harness(xml);
  assert.equal(mergeIntoWorkspace(Blockly, workspace, parse(without)), true);
  assert.deepEqual(disposed.map((block) => block.id), ['two']);
  assert.deepEqual(built, []);
});

test('an id-less incoming block matches the canvas block it describes', () => {
  // How MakeCode actually saves: the canvas has ids, the file does not.
  const onCanvas = `<xml xmlns="https://developers.google.com/blockly/xml">` +
    `<block type="a" id="assigned-by-blockly" x="0" y="0"/></xml>`;
  const fromFile = `<xml xmlns="https://developers.google.com/blockly/xml">` +
    `<block type="a" x="0" y="0"/></xml>`;

  const { Blockly, workspace, disposed, built } = harness(onCanvas);
  assert.equal(mergeIntoWorkspace(Blockly, workspace, parse(fromFile)), true);
  assert.deepEqual(disposed, [], 'a missing id is not a different block');
  assert.deepEqual(built, []);
});

test('an added block is built without disturbing the others', () => {
  const before = `<xml xmlns="https://developers.google.com/blockly/xml">` +
    `<block type="a" id="one" x="0" y="0"/></xml>`;
  const after = `<xml xmlns="https://developers.google.com/blockly/xml">` +
    `<block type="a" id="one" x="0" y="0"/>` +
    `<block type="b" id="two" x="0" y="80"/></xml>`;

  const { Blockly, workspace, disposed, built } = harness(before);
  assert.equal(mergeIntoWorkspace(Blockly, workspace, parse(after)), true);
  assert.deepEqual(disposed, []);
  assert.deepEqual(built.map((element) => element.getAttribute('id')), ['two']);
});

test('an empty document against a full canvas refuses to merge', () => {
  const xml = `<xml xmlns="https://developers.google.com/blockly/xml">` +
    `<block type="a" id="one" x="0" y="0"/></xml>`;
  const { Blockly, workspace } = harness(xml);
  const empty = parse(`<xml xmlns="https://developers.google.com/blockly/xml"></xml>`);
  assert.equal(mergeIntoWorkspace(Blockly, workspace, empty), false);
});
