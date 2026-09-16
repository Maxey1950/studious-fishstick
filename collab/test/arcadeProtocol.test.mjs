/**
 * Drives the MakeCode controller handshake against a fake editor, so the
 * message contract is pinned without a browser or a network.
 *
 * The real editor cannot be reached from the build sandbox (its HTTPS proxy's
 * CA is not trusted by Chromium), so this covers the half that is ours: what we
 * reply, what we treat as a change, and what we ignore.
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const { outputFiles } = await build({
  entryPoints: [join(here, '../src/arcadeProtocol.ts')],
  bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022',
});
const dir = await mkdtemp(join(tmpdir(), 'arcade-protocol-'));
const modulePath = join(dir, 'arcadeProtocol.mjs');
await writeFile(modulePath, outputFiles[0].text);
const { handleEditorMessage, createProject, blocksOf, importProjectMessage } =
  await import(modulePath);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
};

const project = createProject('demo', '<xml>blocks</xml>');

check('a valid project is built around the blocks', () => {
  assert.equal(blocksOf(project), '<xml>blocks</xml>');
  assert.equal(project.header.target, 'arcade');
  assert.equal(project.header.editor, 'blocksprj');
  // pxt.json must parse, or the editor rejects the import.
  const config = JSON.parse(project.text['pxt.json']);
  assert.deepEqual(config.dependencies, { device: '*' });
  assert.ok(config.files.includes('main.blocks'));
});

check('workspacesync is answered with the project', () => {
  const outcome = handleEditorMessage(
    { type: 'pxteditor', action: 'workspacesync', id: 'req-1' }, project);
  assert.equal(outcome.kind, 'reply');
  assert.equal(outcome.message.type, 'pxthost');
  assert.equal(outcome.message.id, 'req-1', 'the reply must echo the request id');
  assert.equal(outcome.message.success, true);
  assert.equal(outcome.message.projects.length, 1);
  assert.equal(blocksOf(outcome.message.projects[0]), '<xml>blocks</xml>');
});

check('workspacesave is reported as a change', () => {
  const edited = createProject('demo', '<xml>edited</xml>');
  const outcome = handleEditorMessage(
    { type: 'pxteditor', action: 'workspacesave', project: edited }, project);
  assert.equal(outcome.kind, 'projectChanged');
  assert.equal(blocksOf(outcome.project), '<xml>edited</xml>');
});

check('a workspacesave without a project is ignored', () => {
  const outcome = handleEditorMessage(
    { type: 'pxteditor', action: 'workspacesave' }, project);
  assert.equal(outcome.kind, 'ignore');
});

check('load notifications become status', () => {
  for (const action of ['workspaceloaded', 'editorcontentloaded']) {
    const outcome = handleEditorMessage({ type: 'pxteditor', action }, project);
    assert.equal(outcome.kind, 'status', action);
    assert.equal(outcome.status, 'ready');
  }
});

check('messages from anything but the editor are ignored', () => {
  // The page shares a window with whatever else is on it; only pxteditor
  // messages may be acted on.
  for (const message of [
    { type: 'pxtsim', action: 'workspacesave', project },
    { action: 'workspacesave', project },
    { type: 'evil', action: 'workspacesync' },
    null,
    'workspacesave',
    42,
  ]) {
    assert.equal(handleEditorMessage(message, project).kind, 'ignore',
      `should ignore ${JSON.stringify(message)}`);
  }
});

check('unknown actions are ignored rather than mishandled', () => {
  assert.equal(
    handleEditorMessage({ type: 'pxteditor', action: 'tutorialevent' }, project).kind,
    'ignore');
});

check('importproject carries the project', () => {
  const message = importProjectMessage(project);
  assert.equal(message.type, 'pxthost');
  assert.equal(message.action, 'importproject');
  assert.equal(blocksOf(message.project), '<xml>blocks</xml>');
});

if (failures > 0) { console.error(`\n${failures} protocol test(s) failed.`); process.exit(1); }
console.log('\nHandshake contract holds.');
