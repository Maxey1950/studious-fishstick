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
  entryPoints: [join(here, '../../src/shared/arcadeProtocol.ts')],
  bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022',
});
const dir = await mkdtemp(join(tmpdir(), 'arcade-protocol-'));
const modulePath = join(dir, 'arcadeProtocol.mjs');
await writeFile(modulePath, outputFiles[0].text);
const { handleEditorMessage, createProject, blocksOf, importProjectMessage,
  hasNoBlocks, withBlocks, ARCADE_EDITOR_URL } = await import(modulePath);

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
  // The editor addresses the host on the `pxthost` channel. Requiring
  // `pxteditor` here made the editor's request be ignored, and it hung on its
  // splash screen waiting for a reply that never came.
  const outcome = handleEditorMessage(
    { type: 'pxthost', action: 'workspacesync', id: 'req-1' }, project);
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
    { type: 'pxthost', action: 'workspacesave', project: edited }, project);
  assert.equal(outcome.kind, 'projectChanged');
  assert.equal(blocksOf(outcome.project), '<xml>edited</xml>');
});

check('a workspacesave without a project is ignored', () => {
  const outcome = handleEditorMessage(
    { type: 'pxthost', action: 'workspacesave' }, project);
  assert.equal(outcome.kind, 'ignore');
});

check('load notifications become status', () => {
  for (const action of ['workspaceloaded', 'editorcontentloaded']) {
    const outcome = handleEditorMessage({ type: 'pxthost', action }, project);
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
    // Our own outgoing command echoing back must not be treated as input.
    { type: 'pxteditor', action: 'importproject', project },
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
    handleEditorMessage({ type: 'pxthost', action: 'tutorialevent' }, project).kind,
    'ignore');
});

check('importproject is addressed to the editor', () => {
  const message = importProjectMessage(project);
  assert.equal(message.type, 'pxteditor', 'commands to the editor use pxteditor');
  assert.equal(message.action, 'importproject');
  assert.equal(blocksOf(message.project), '<xml>blocks</xml>');
});

check('applying blocks keeps the extension list and assets', () => {
  // pxt.json holds the project's extensions. Rebuilding a project from its
  // blocks would drop it, so adding an extension and then receiving someone
  // else's edit would silently remove the extension.
  const withExtension = {
    header: { name: 'demo' },
    text: {
      'main.blocks': '<xml>old</xml>',
      'main.ts': 'generated',
      'assets.json': '{"tiles":1}',
      'pxt.json': JSON.stringify({ name: 'demo', dependencies: { device: '*', jacdac: 'github:x/y' } }),
    },
  };

  const updated = withBlocks(withExtension, '<xml>new</xml>');
  assert.equal(blocksOf(updated), '<xml>new</xml>', 'blocks are replaced');
  assert.equal(updated.text['assets.json'], '{"tiles":1}', 'assets survive');
  assert.equal(updated.text['main.ts'], 'generated', 'generated source survives');
  assert.deepEqual(
    JSON.parse(updated.text['pxt.json']).dependencies,
    { device: '*', jacdac: 'github:x/y' },
    'extensions survive'
  );
  assert.equal(updated.header, withExtension.header, 'header is kept');
});

check('the editor is told its workspace is the host page', () => {
  // ws=browser makes the editor use its own IndexedDB: it ignores the project
  // we hand it, opens blank, and then saves that blank over the user's file.
  assert.ok(ARCADE_EDITOR_URL.includes('ws=iframe'), 'must request the iframe workspace');
  assert.ok(!ARCADE_EDITOR_URL.includes('ws=browser'), 'must never request browser storage');
  assert.ok(ARCADE_EDITOR_URL.includes('controller=1'), 'must run in controller mode');
});

check('an empty workspace is recognised, so it is never saved over a file', () => {
  assert.equal(hasNoBlocks('<xml xmlns="https://developers.google.com/blockly/xml"></xml>'), true);
  // The exact shape a failed load produces: variables, no blocks.
  assert.equal(hasNoBlocks(
    '<xml><variables><variable id="a">i</variable></variables></xml>'), true);
  assert.equal(hasNoBlocks('<xml><block type="pxt-on-start"></block></xml>'), false);
  assert.equal(hasNoBlocks('<xml>\n  <BLOCK type="x"/>\n</xml>'), false, 'case-insensitive');
});

if (failures > 0) { console.error(`\n${failures} protocol test(s) failed.`); process.exit(1); }
console.log('\nHandshake contract holds.');
