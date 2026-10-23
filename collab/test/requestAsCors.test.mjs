/**
 * Tests for marking the editor's assets as CORS requests.
 *
 * On vscode.dev the webview sets Cross-Origin-Embedder-Policy: require-corp,
 * which the re-hosted editor inherits, and under it MakeCode's CDN assets are
 * refused — the bundle defining `pxt` included, so the editor never starts.
 * Being fetched as CORS is the way through, and the CDN allows it.
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
  entryPoints: [join(here, '../../src/webview/makecode/sameOrigin.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
});
const dir = await mkdtemp(join(tmpdir(), 'cors-'));
const file = join(dir, 'sameOrigin.mjs');
await writeFile(file, outputFiles[0].text);
const { requestAsCors } = await import(file);

test('a cross-origin script is marked', () => {
  const html = '<script src="https://cdn.makecode.com/blob/abc/pxtapp.js"></script>';
  const out = requestAsCors(html);
  assert.match(out, /crossorigin="anonymous"/);
  assert.match(out, /src="https:\/\/cdn\.makecode\.com\/blob\/abc\/pxtapp\.js"/);
});

test('a cross-origin stylesheet is marked', () => {
  const html = '<link rel="stylesheet" href="https://cdn.makecode.com/blob/abc/semantic.css">';
  assert.match(requestAsCors(html), /<link crossorigin="anonymous" rel="stylesheet"/);
});

test('an inline script is left alone', () => {
  // There is nothing to fetch, and the editor's config lives in one of these.
  const html = '<script>var pxtConfig = {"simUrl":"https://trg.example/sim"};</script>';
  assert.equal(requestAsCors(html), html);
});

test('a tag that already says how it is fetched is left alone', () => {
  const html = '<script crossorigin="use-credentials" src="https://cdn.makecode.com/a.js"></script>';
  assert.equal(requestAsCors(html), html);
});

test('a relative source is left alone', () => {
  // Same-origin by definition once the <base> resolves it, so the policy does
  // not apply and marking it would only change how it is sent.
  const html = '<script src="/---worker.js"></script>';
  assert.equal(requestAsCors(html), html);
});

test('every script in a realistic head is marked exactly once', () => {
  const html = [
    '<head>',
    '<link rel="stylesheet" href="https://cdn.makecode.com/blob/a/semantic.css">',
    '<script src="https://cdn.makecode.com/blob/b/pxtweb.js"></script>',
    '<script>var x = 1;</script>',
    '<script src="https://cdn.makecode.com/blob/c/pxtapp.js"></script>',
    '<script src="https://cdn.makecode.com/blob/d/target.js"></script>',
    '<script src="https://cdn.makecode.com/blob/e/main.js"></script>',
    '</head>',
  ].join('\n');

  const out = requestAsCors(html);
  assert.equal((out.match(/crossorigin="anonymous"/g) ?? []).length, 5);
  assert.equal(requestAsCors(out), out, 'marking twice changes nothing');
  // The URLs must survive untouched, or nothing loads at all.
  for (const name of ['semantic.css', 'pxtweb.js', 'pxtapp.js', 'target.js', 'main.js']) {
    assert.ok(out.includes(`/${name}"`), `${name} kept its URL`);
  }
});
