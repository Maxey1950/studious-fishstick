/**
 * Downloads the MakeCode Arcade target bundle, which carries the compiled API
 * metadata for every Arcade block, and caches it for the generator.
 *
 * Run this only to refresh the block library (`npm run arcade:refresh`). Normal
 * builds use the generated output committed under media/generated, so the build
 * needs no network access.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(root, '.arcade-cache');

const index = await (await fetch('https://arcade.makecode.com/')).text();
const targetUrl = /https:\/\/cdn\.makecode\.com\/blob\/[a-f0-9]+\/target\.js/.exec(index)?.[0];
if (!targetUrl) {
  throw new Error('could not find the target.js URL on arcade.makecode.com');
}
console.log('fetching', targetUrl);

const source = await (await fetch(targetUrl)).text();
const json = JSON.parse(source.slice(source.indexOf('{')));

await mkdir(CACHE, { recursive: true });
await writeFile(join(CACHE, 'target.json'), JSON.stringify(json));
console.log(`cached target bundle (${json.id} ${json.versions?.target ?? '?'}) from ${targetUrl}`);
