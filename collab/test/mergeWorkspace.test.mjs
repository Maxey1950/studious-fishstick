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
const { mergeIntoWorkspace, baseIndexOf } = await import(module);

const { window } = new JSDOM('');
globalThis.DOMParser = window.DOMParser;
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
        const block = { id: element.getAttribute('id') ?? 'new', element };
        workspace.blocks.push(block);
        return block;
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
    assert.equal(mergeIntoWorkspace(Blockly, workspace, parse(xml)), undefined);
    assert.deepEqual(disposed, [], 'nothing should have been disposed');
    assert.deepEqual(built, [], 'nothing should have been rebuilt');
  });

  test(`${name}: reordered attributes and whitespace are not a change`, () => {
    const { Blockly, workspace, disposed, built } = harness(xml);
    // Blockly spells the same block differently from the file; the merge must
    // compare meaning, not text.
    const respelled = xml.replace(/<block type="([^"]+)" x="([^"]+)" y="([^"]+)"/g,
      '<block y="$3" x="$2" type="$1"');
    assert.equal(mergeIntoWorkspace(Blockly, workspace, parse(respelled)), undefined);
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
  assert.equal(mergeIntoWorkspace(Blockly, workspace, parse(changed)), undefined);
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
  assert.equal(mergeIntoWorkspace(Blockly, workspace, parse(without)), undefined);
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
  assert.equal(mergeIntoWorkspace(Blockly, workspace, parse(fromFile)), undefined);
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
  assert.equal(mergeIntoWorkspace(Blockly, workspace, parse(after)), undefined);
  assert.deepEqual(disposed, []);
  assert.deepEqual(built.map((element) => element.getAttribute('id')), ['two']);
});

test('an empty document against a full canvas refuses to merge', () => {
  const xml = `<xml xmlns="https://developers.google.com/blockly/xml">` +
    `<block type="a" id="one" x="0" y="0"/></xml>`;
  const { Blockly, workspace } = harness(xml);
  const empty = parse(`<xml xmlns="https://developers.google.com/blockly/xml"></xml>`);
  assert.match(mergeIntoWorkspace(Blockly, workspace, empty), /no blocks/);
});

test('a Blockly that cannot load variables still merges the blocks', () => {
  // Every real Arcade file opens with a <variables> block. If loading them
  // threw, the whole merge used to fail and the change fell back to
  // importproject — a full editor reload on exactly the common case.
  const xml = samples.arcade;
  const { Blockly, workspace, disposed, built } = harness(xml);
  Blockly.Xml.domToVariables = () => {
    throw new TypeError('domToVariables is not a function');
  };
  assert.equal(mergeIntoWorkspace(Blockly, workspace, parse(xml)), undefined);
  assert.deepEqual(disposed, []);
  assert.deepEqual(built, []);
});

// --- Two people editing at once -------------------------------------------
//
// The case that matters most and is hardest to see alone: a change composed
// before the other person's block existed cannot mention it, and reading that
// silence as a deletion is how collaborators destroy each other's work.

const XML = (...blocks) =>
  `<xml xmlns="https://developers.google.com/blockly/xml">${blocks.join('')}</xml>`;
const BLOCK = (type, id, y = 0) => `<block type="${type}" id="${id}" x="0" y="${y}"/>`;

test('a block added here survives a change that predates it', () => {
  const base = XML(BLOCK('shared', 'shared-1'));
  // We added ours; they added theirs, without ever having seen ours.
  const onCanvas = XML(BLOCK('shared', 'shared-1'), BLOCK('mine', 'mine-1', 80));
  const fromThem = XML(BLOCK('shared', 'shared-1'), BLOCK('theirs', 'theirs-1', 160));

  const { Blockly, workspace, disposed, built } = harness(onCanvas);
  assert.equal(
    mergeIntoWorkspace(Blockly, workspace, parse(fromThem), baseIndexOf(base)),
    undefined
  );

  assert.deepEqual(disposed, [], 'our block is not in their change, but it is not deleted');
  assert.deepEqual(built.map((e) => e.getAttribute('id')), ['theirs-1'], 'theirs arrives');
  assert.deepEqual(
    workspace.blocks.map((b) => b.id).sort(),
    ['mine-1', 'shared-1', 'theirs-1'],
    'both new blocks are on the canvas'
  );
});

test('a block they really deleted is still deleted', () => {
  // Present when the two sides last agreed, absent from what they sent: gone.
  const base = XML(BLOCK('shared', 'shared-1'), BLOCK('doomed', 'doomed-1', 80));
  const onCanvas = base;
  const fromThem = XML(BLOCK('shared', 'shared-1'));

  const { Blockly, workspace, disposed } = harness(onCanvas);
  assert.equal(
    mergeIntoWorkspace(Blockly, workspace, parse(fromThem), baseIndexOf(base)),
    undefined
  );
  assert.deepEqual(disposed.map((b) => b.id), ['doomed-1']);
});

test('without a base, the incoming change is still taken as authoritative', () => {
  // The old behaviour, kept for the paths where nothing is known to be agreed.
  const onCanvas = XML(BLOCK('shared', 'shared-1'), BLOCK('mine', 'mine-1', 80));
  const fromThem = XML(BLOCK('shared', 'shared-1'));

  const { Blockly, workspace, disposed } = harness(onCanvas);
  assert.equal(mergeIntoWorkspace(Blockly, workspace, parse(fromThem)), undefined);
  assert.deepEqual(disposed.map((b) => b.id), ['mine-1']);
});

test('an unreadable base never deletes anything it cannot vouch for', () => {
  assert.equal(baseIndexOf('<xml><block'), undefined);
  assert.equal(baseIndexOf(''), undefined);
});

test('an id-less base still recognizes its blocks by content', () => {
  // How MakeCode actually saves: no ids in the file, ids on the canvas.
  const base = `<xml xmlns="https://developers.google.com/blockly/xml">` +
    `<block type="shared" x="0" y="0"/></xml>`;
  const onCanvas = XML(BLOCK('shared', 'assigned-by-blockly'), BLOCK('mine', 'mine-1', 80));
  const fromThem = `<xml xmlns="https://developers.google.com/blockly/xml">` +
    `<block type="shared" x="0" y="0"/><block type="theirs" x="0" y="160"/></xml>`;

  const { Blockly, workspace, disposed } = harness(onCanvas);
  assert.equal(
    mergeIntoWorkspace(Blockly, workspace, parse(fromThem), baseIndexOf(base)),
    undefined
  );
  assert.deepEqual(disposed, [], 'ours is new, theirs is unchanged, nothing is lost');
});

test('the merge reports which blocks it changed', () => {
  // What the highlight needs: the blocks a collaborator's change actually
  // altered, so they can be pointed out rather than appearing silently.
  const before = XML(BLOCK('kept', 'kept-1'), BLOCK('edited', 'edited-1', 80));
  const after = XML(
    BLOCK('kept', 'kept-1'),
    `<block type="edited" id="edited-1" x="0" y="240"/>`,
    BLOCK('added', 'added-1', 320)
  );

  const { Blockly, workspace } = harness(before);
  const touched = [];
  assert.equal(
    mergeIntoWorkspace(Blockly, workspace, parse(after), baseIndexOf(before), touched),
    undefined
  );
  assert.deepEqual(touched.sort(), ['added-1', 'edited-1'], 'moved and added, not the untouched one');
});

test('nothing is reported when nothing changed', () => {
  const xml = XML(BLOCK('a', 'a-1'));
  const { Blockly, workspace } = harness(xml);
  const touched = [];
  mergeIntoWorkspace(Blockly, workspace, parse(xml), baseIndexOf(xml), touched);
  assert.deepEqual(touched, []);
});
