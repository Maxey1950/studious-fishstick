/**
 * Tests that two spellings of the same blocks are recognized as the same.
 *
 * This is what stops the import loop: MakeCode does not reproduce XML byte for
 * byte, so without it the editor's own save reads as somebody's edit and gets
 * applied by reloading the editor, which saves again.
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
  entryPoints: [join(root, 'src/shared/sameBlocks.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
});
const dir = await mkdtemp(join(tmpdir(), 'same-'));
const file = join(dir, 'sameBlocks.mjs');
await writeFile(file, outputFiles[0].text);

const { window } = new JSDOM('');
globalThis.DOMParser = window.DOMParser;
const { sameBlocks } = await import(file);

const arcade = await readFile(join(root, 'sample/arcade-real.blocks'), 'utf8');
const hello = await readFile(join(root, 'sample/hello.blocks'), 'utf8');

test('a document equals itself', () => {
  assert.equal(sameBlocks(arcade, arcade), true);
  assert.equal(sameBlocks(hello, hello), true);
});

test('attribute order is not a change', () => {
  const respelled = hello.replace(/<block type="([^"]+)" id="([^"]+)" x="([^"]+)"/,
    '<block x="$3" id="$2" type="$1"');
  assert.notEqual(respelled, hello);
  assert.equal(sameBlocks(hello, respelled), true);
});

test('indentation between elements is not a change', () => {
  const pretty = hello.replace(/></g, '>\n  <');
  assert.equal(sameBlocks(hello, pretty), true);
});

test('a fraction of a pixel is not a change', () => {
  const nudged = arcade.replace('x="0" y="0"', 'x="0.4" y="-0.2"');
  assert.notEqual(nudged, arcade);
  assert.equal(sameBlocks(arcade, nudged), true);
});

test('an edited field is a change', () => {
  const edited = arcade.replace('>Player<', '>Enemy<');
  assert.notEqual(edited, arcade);
  assert.equal(sameBlocks(arcade, edited), false);
});

test('a removed block is a change', () => {
  const stripped = arcade.replace(/<block type="game_control_sprite"[\s\S]*?<\/block>/, '');
  assert.notEqual(stripped, arcade);
  assert.equal(sameBlocks(arcade, stripped), false);
});

test('an image literal is compared row for row', () => {
  // Image literals are whitespace-significant: a newline inside one is an extra
  // row of pixels, which is a real edit and must not be shrugged off. Only the
  // whitespace at the very ends of a text node is noise.
  const extraRow = arcade.replace('img`\n', 'img`\n\n');
  assert.notEqual(extraRow, arcade);
  assert.equal(sameBlocks(arcade, extraRow), false);

  const repainted = arcade.replace('. . . . .', '1 . . . .');
  assert.notEqual(repainted, arcade);
  assert.equal(sameBlocks(arcade, repainted), false);

  // Padding around the field's contents is not part of the picture.
  const padded = arcade.replace('<field name="img">img`', '<field name="img">  img`');
  assert.notEqual(padded, arcade);
  assert.equal(sameBlocks(arcade, padded), true);
});

test('unparseable input is never called equal', () => {
  assert.equal(sameBlocks('<xml><block', '<xml><block'), true, 'identical text short-circuits');
  assert.equal(sameBlocks('<xml><block', hello), false);
});
