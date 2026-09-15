// Copies the Blockly runtime out of node_modules and into media/vendor so the
// webview can load it with a webview URI. Bundling it (rather than pulling from
// a CDN) keeps the extension working under vscode.dev's content security policy
// and in offline/air-gapped setups.
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'blockly');
const dest = join(root, 'media', 'vendor', 'blockly');

try {
  await stat(src);
} catch {
  console.error('blockly is not installed. Run `npm install` first.');
  process.exit(1);
}

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });

await cp(join(src, 'blockly.min.js'), join(dest, 'blockly.min.js'));
await cp(join(src, 'media'), join(dest, 'media'), { recursive: true });
await cp(join(src, 'LICENSE'), join(dest, 'LICENSE'));

console.log('vendored blockly ->', dest);
