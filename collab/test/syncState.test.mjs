/**
 * Tests for the collaboration sync rules. Pure logic, no network or editor, so
 * the awkward cases can be driven directly by moving a clock forward.
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const { outputFiles } = await build({
  entryPoints: [join(here, '../../src/shared/syncState.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
});
const dir = await mkdtemp(join(tmpdir(), 'syncstate-'));
const modulePath = join(dir, 'syncState.mjs');
await writeFile(modulePath, outputFiles[0].text);
const { SyncState } = await import(modulePath);

const OPTIONS = { sendDebounceMs: 700, applyAfterIdleMs: 2000 };
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

check('a local edit is broadcast once the user pauses', () => {
  const sync = new SyncState(OPTIONS);
  sync.onLocalChange('<xml>A</xml>', 1000);
  assert.deepEqual(sync.next(1100), { kind: 'wait', untilMs: 1700 });
  assert.deepEqual(sync.next(1700), { kind: 'broadcast', blocks: '<xml>A</xml>' });
  assert.equal(sync.next(1800), undefined, 'must not re-send the same content');
});

check('rapid edits collapse into one broadcast', () => {
  const sync = new SyncState(OPTIONS);
  sync.onLocalChange('<xml>A</xml>', 1000);
  sync.onLocalChange('<xml>B</xml>', 1200);
  sync.onLocalChange('<xml>C</xml>', 1400);
  assert.equal(sync.next(1500)?.kind, 'wait');
  assert.deepEqual(sync.next(2100), { kind: 'broadcast', blocks: '<xml>C</xml>' });
});

check('a remote change waits for the local user to go idle', () => {
  const sync = new SyncState(OPTIONS);
  sync.onLocalChange('<xml>mine</xml>', 1000);
  assert.deepEqual(sync.next(1700), { kind: 'broadcast', blocks: '<xml>mine</xml>' });
  sync.onRemoteChange('<xml>theirs</xml>', 1800);
  // Still inside the idle window: applying now would rebuild the editor under
  // the user's hands.
  assert.deepEqual(sync.next(1900), { kind: 'wait', untilMs: 3000 });
  assert.deepEqual(sync.next(3000), { kind: 'apply', blocks: '<xml>theirs</xml>' });
});

check('typing again cancels a waiting remote change', () => {
  const sync = new SyncState(OPTIONS);
  sync.onLocalChange('<xml>mine</xml>', 1000);
  sync.next(1700);
  sync.onRemoteChange('<xml>theirs</xml>', 1800);
  assert.equal(sync.hasPendingRemote(), true);
  sync.onLocalChange('<xml>mine2</xml>', 1900);
  assert.equal(sync.hasPendingRemote(), false, 'user kept working; their edit wins');
  assert.deepEqual(sync.next(2600), { kind: 'broadcast', blocks: '<xml>mine2</xml>' });
});

check('the editor echo of an applied change is not sent back', () => {
  const sync = new SyncState(OPTIONS);
  sync.onRemoteChange('<xml>theirs</xml>', 1000);
  assert.deepEqual(sync.next(3100), { kind: 'apply', blocks: '<xml>theirs</xml>' });
  // importproject makes the editor emit workspacesave with what we just applied.
  sync.onLocalChange('<xml>theirs</xml>', 3200);
  assert.equal(sync.next(5000), undefined, 'echo must not be broadcast');
});

check('an unsent local edit is sent before a remote one is applied', () => {
  const sync = new SyncState(OPTIONS);
  sync.onLocalChange('<xml>mine</xml>', 1000);
  sync.onRemoteChange('<xml>theirs</xml>', 1050);
  const first = sync.next(9000);
  assert.deepEqual(first, { kind: 'broadcast', blocks: '<xml>mine</xml>' },
    'local work must not be lost to an incoming change');
  assert.deepEqual(sync.next(9000), { kind: 'apply', blocks: '<xml>theirs</xml>' });
});

check('a remote change identical to ours is ignored', () => {
  const sync = new SyncState(OPTIONS);
  sync.onLocalChange('<xml>same</xml>', 1000);
  sync.next(1700);
  sync.onRemoteChange('<xml>same</xml>', 1800);
  assert.equal(sync.hasPendingRemote(), false);
  assert.equal(sync.next(9000), undefined);
});

check('nothing to do reports nothing', () => {
  const sync = new SyncState(OPTIONS);
  assert.equal(sync.next(1000), undefined);
});

if (failures > 0) {
  console.error(`\n${failures} sync rule(s) failed.`);
  process.exit(1);
}
console.log('\nAll sync rules hold.');
