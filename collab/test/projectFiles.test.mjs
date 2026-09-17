/**
 * Tests for sharing the rest of the project.
 *
 * The risk being guarded against is not a missed sync but a destructive one:
 * the editor reports an empty project at several points while it starts up, and
 * writing that out would arrive at everyone else as every sprite in the game
 * being deleted.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const { outputFiles } = await build({
  entryPoints: [join(here, '../../src/shared/projectFiles.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
});
const dir = await mkdtemp(join(tmpdir(), 'files-'));
const file = join(dir, 'projectFiles.mjs');
await writeFile(file, outputFiles[0].text);
const { changedFiles, sharedFiles, withFiles, withDeclaredFiles, isShared } = await import(file);

test('only the three project files are shared', () => {
  assert.equal(isShared('pxt.json'), true);
  assert.equal(isShared('assets.json'), true);
  assert.equal(isShared('main.ts'), true);
  // The document itself has one owner; writing it as a sibling would give it two.
  assert.equal(isShared('main.blocks'), false);
  assert.equal(isShared('README.md'), false);
});

test('sharedFiles picks only what exists', () => {
  const picked = sharedFiles({ 'main.blocks': '<xml/>', 'pxt.json': '{}' });
  assert.deepEqual(picked, { 'pxt.json': '{}' });
});

test('unchanged files are not resent', () => {
  const known = { 'pxt.json': '{"a":1}', 'assets.json': '{}' };
  assert.deepEqual(changedFiles(known, { ...known }), {});
});

test('a real edit is sent', () => {
  const known = { 'assets.json': '{"sprites":[]}' };
  const next = { 'assets.json': '{"sprites":["hero"]}' };
  assert.deepEqual(changedFiles(known, next), next);
});

test('an empty file never replaces one with content', () => {
  // This is the whole point: a slow editor load reports an empty project, and
  // writing it out would delete everyone's sprites.
  const known = { 'assets.json': '{"sprites":["hero"]}' };
  assert.deepEqual(changedFiles(known, { 'assets.json': '' }), {});
  assert.deepEqual(changedFiles(known, { 'assets.json': '   \n' }), {});
});

test('a first write of a file that did not exist is allowed', () => {
  assert.deepEqual(changedFiles({}, { 'assets.json': '{}' }), { 'assets.json': '{}' });
  // But not an empty one, which says nothing and is worth no churn.
  assert.deepEqual(changedFiles({}, { 'assets.json': '' }), {});
});

test('files outside the shared set are ignored', () => {
  assert.deepEqual(changedFiles({}, { 'main.blocks': '<xml/>', 'secrets.env': 'x' }), {});
});

test('withFiles leaves the blocks alone', () => {
  const project = { header: {}, text: { 'main.blocks': '<xml/>', 'pxt.json': 'old' } };
  const merged = withFiles(project, { 'pxt.json': 'new', 'main.blocks': '<hacked/>' });
  assert.equal(merged.text['pxt.json'], 'new');
  assert.equal(merged.text['main.blocks'], '<xml/>', 'the document has one owner');
  assert.equal(project.text['pxt.json'], 'old', 'the original is not mutated');
});

test('assets.json is declared in pxt.json or the editor ignores it', () => {
  const config = JSON.stringify({ name: 'game', files: ['main.blocks', 'main.ts'] }, null, 4);
  const updated = withDeclaredFiles(config, ['assets.json']);
  assert.deepEqual(JSON.parse(updated).files, ['main.blocks', 'main.ts', 'assets.json']);
  // Already declared: left exactly as it was, byte for byte.
  assert.equal(withDeclaredFiles(updated, ['assets.json']), updated);
});

test('an unparseable pxt.json is returned untouched', () => {
  assert.equal(withDeclaredFiles('not json', ['assets.json']), 'not json');
  assert.equal(withDeclaredFiles('', ['assets.json']), '');
});
