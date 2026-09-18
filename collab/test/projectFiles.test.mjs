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
const { changedFiles, sharedFiles, withFiles, withDeclaredFiles, withDeclaredStubs, isShared } =
  await import(file);

test('every project file is shared but the three that must not be', () => {
  assert.equal(isShared('pxt.json'), true);
  assert.equal(isShared('assets.json'), true);
  assert.equal(isShared('main.ts'), true);
  assert.equal(isShared('README.md'), true);
  assert.equal(isShared('anything.else'), true);
  // The document travels as the text document; the other two are volatile.
  assert.equal(isShared('main.blocks'), false);
  assert.equal(isShared('_history'), false);
  assert.equal(isShared('.simstate.json'), false);
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

test('the document is never shared, but other files are', () => {
  // main.blocks has one owner; a genuine project file rides along.
  assert.deepEqual(changedFiles({}, { 'main.blocks': '<xml/>', 'notes.txt': 'x' }), {
    'notes.txt': 'x',
  });
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

test('jres files carry the image data and are shared', () => {
  // The pixels live here, not in the .g.ts that references them. Sharing the
  // code but not the data was why a drawn image vanished on reload.
  assert.equal(isShared('images.g.jres'), true);
  assert.equal(isShared('tilemap.g.jres'), true);
  assert.equal(isShared('anything.jres'), true);
});

test('volatile files are never shared', () => {
  // pxt's private undo log and the simulator's scratch state belong to one
  // machine; the history especially would flood the folder.
  assert.equal(isShared('_history'), false);
  assert.equal(isShared('.simstate.json'), false);
  assert.equal(isShared('main.blocks'), false);
});

test('generated asset files are shared', () => {
  // They are declared in pxt.json, which makes them the compiler's business:
  // a project listing a file it does not have fails to build at all.
  assert.equal(isShared('images.g.ts'), true);
  assert.equal(isShared('tilemap.g.ts'), true);
});

test('a declared jres is stubbed as valid JSON, not empty', () => {
  // The bug: an empty string is not JSON, so the moment the editor parses a
  // .jres it throws "Unexpected end of JSON input", the image/tilemap project
  // fails to load, and nothing saves. A project with images always declares one.
  const project = {
    header: {},
    text: {
      'pxt.json': JSON.stringify({ files: ['main.blocks', 'main.ts', 'main.jres'] }),
    },
  };
  const stubbed = withDeclaredStubs(project);
  assert.equal(stubbed.text['main.jres'], '{}');
  assert.doesNotThrow(() => JSON.parse(stubbed.text['main.jres']));
  assert.equal(stubbed.text['main.ts'], '', 'a .ts stub stays empty');
});

test('every declared file exists, even if empty', () => {
  const project = {
    header: {},
    text: {
      'main.blocks': '<xml/>',
      'pxt.json': JSON.stringify({
        files: ['main.blocks', 'main.ts', 'images.g.ts', 'tilemap.g.ts'],
      }),
    },
  };
  const stubbed = withDeclaredStubs(project);
  assert.equal(stubbed.text['images.g.ts'], '');
  assert.equal(stubbed.text['tilemap.g.ts'], '');
  assert.equal(stubbed.text['main.ts'], '');
  assert.equal(stubbed.text['main.blocks'], '<xml/>', 'existing files are untouched');
});

test('a project with nothing missing is returned as it was', () => {
  const project = {
    header: {},
    text: { 'main.blocks': '<xml/>', 'pxt.json': JSON.stringify({ files: ['main.blocks'] }) },
  };
  assert.equal(withDeclaredStubs(project), project);
});

test('a project with no readable pxt.json is left alone', () => {
  const noConfig = { header: {}, text: { 'main.blocks': '<xml/>' } };
  assert.equal(withDeclaredStubs(noConfig), noConfig);
  const broken = { header: {}, text: { 'pxt.json': 'not json' } };
  assert.equal(withDeclaredStubs(broken), broken);
});

test('a stub never gets written back over a real file', () => {
  // The stubs exist for the compiler; writing them to disk would replace the
  // real generated code with nothing.
  const known = { 'images.g.ts': 'namespace myImages {}' };
  assert.deepEqual(changedFiles(known, { 'images.g.ts': '' }), {});
});
