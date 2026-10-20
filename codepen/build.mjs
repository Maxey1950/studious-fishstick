/**
 * Builds the CodePen page: codepen/main.ts bundled and inlined into
 * codepen/page.html, as one file to paste into CodePen's HTML panel.
 */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const { outputFiles } = await build({
  entryPoints: [join(here, 'main.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
});

// The editor shims are <script> tags held in strings, and a literal
// "</script" anywhere in an inline script ends it early. "<\/script" means the
// same thing to JavaScript and nothing to the HTML parser.
const script = outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const page = (await readFile(join(here, 'page.html'), 'utf8')).replace('/*__SCRIPT__*/', () => script);

const out = join(here, 'dist', 'arcade-collab.html');
await mkdir(dirname(out), { recursive: true });
await writeFile(out, page);
console.log(`wrote ${out} (${Math.round(page.length / 1024)} KB)`);
