/**
 * Tests for the short memory of what the blocks used to be.
 *
 * This exists because of how this editor's bugs have gone: blocks that were
 * there a moment ago and are not now. The list has to hold the state somebody
 * wants back, and has to be readable enough that they can recognize it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const { outputFiles } = await build({
  entryPoints: [join(root, 'src/shared/history.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
});
const dir = await mkdtemp(join(tmpdir(), 'history-'));
const file = join(dir, 'history.mjs');
await writeFile(file, outputFiles[0].text);
const { recordVersion, countBlocks, describeVersion } = await import(file);

test('states are kept newest first', () => {
  let history = [];
  history = recordVersion(history, '<xml>one</xml>', 1000);
  history = recordVersion(history, '<xml>two</xml>', 2000);
  assert.deepEqual(history.map((v) => v.xml), ['<xml>two</xml>', '<xml>one</xml>']);
});

test('the same state twice in a row is recorded once', () => {
  // A stream of duplicates would push the state somebody wants off the end.
  let history = recordVersion([], '<xml>same</xml>', 1000);
  history = recordVersion(history, '<xml>same</xml>', 1100);
  history = recordVersion(history, '<xml>same</xml>', 1200);
  assert.equal(history.length, 1);
});

test('a state that returns after a change is recorded again', () => {
  let history = recordVersion([], '<xml>a</xml>', 1000);
  history = recordVersion(history, '<xml>b</xml>', 2000);
  history = recordVersion(history, '<xml>a</xml>', 3000);
  assert.deepEqual(history.map((v) => v.xml), ['<xml>a</xml>', '<xml>b</xml>', '<xml>a</xml>']);
});

test('the oldest states fall off the end', () => {
  let history = [];
  for (let i = 0; i < 40; i++) {
    history = recordVersion(history, `<xml>${i}</xml>`, i * 1000, 25);
  }
  assert.equal(history.length, 25);
  assert.equal(history[0].xml, '<xml>39</xml>');
  assert.equal(history[24].xml, '<xml>15</xml>');
});

test('blocks are counted from a real Arcade file', async () => {
  const arcade = await readFile(join(root, 'sample/arcade-real.blocks'), 'utf8');
  const counted = countBlocks(arcade);
  // Whatever the exact number, it has to be the blocks and not the shadows or
  // the variables, or the list reads as nonsense.
  assert.ok(counted > 0, 'found some blocks');
  assert.equal(counted, (arcade.match(/<block[\s>]/g) ?? []).length);
  assert.equal(countBlocks('<xml></xml>'), 0);
});

test('a self-closing block still counts', () => {
  assert.equal(countBlocks('<xml><block type="a"/><block type="b"/></xml>'), 2);
});

test('a version reads as a time and a size', () => {
  const now = 1_000_000;
  const version = { xml: '<xml><block/></xml>', atMs: now - 120_000, blocks: 1 };
  assert.equal(describeVersion(version, now), '2 minutes ago · 1 block');

  assert.equal(
    describeVersion({ xml: '', atMs: now - 2000, blocks: 14 }, now),
    'just now · 14 blocks'
  );
});
