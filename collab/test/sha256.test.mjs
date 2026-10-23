/**
 * The room password handshake hashes with codepen/sha256.ts, which has to agree
 * with real SHA-256 exactly — a slip at a block boundary would only show up as
 * "wrong password" for passwords of particular lengths.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const { outputFiles } = await build({
  entryPoints: [join(root, 'codepen/sha256.ts')],
  bundle: true,
  write: false,
  format: 'esm',
});
const { sha256 } = await import(`data:text/javascript,${encodeURIComponent(outputFiles[0].text)}`);

const cases = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(1000), 'pässwörd 🎮'];
for (const text of cases) {
  test(`sha256 of ${JSON.stringify(text.slice(0, 12))} (${text.length} chars) matches node`, () => {
    assert.equal(sha256(text), createHash('sha256').update(text).digest('hex'));
  });
}
