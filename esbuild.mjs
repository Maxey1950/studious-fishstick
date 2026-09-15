import { context } from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Two bundles: the extension host half (browser-targeted, because vscode.dev
// runs extensions in a web worker with no Node API) and the webview half.
const shared = {
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

const ctxs = await Promise.all([
  context({
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/web/extension.js',
    platform: 'browser',
    target: 'es2022',
    external: ['vscode'],
  }),
  context({
    ...shared,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'media/blocksEditor.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
  }),
]);

if (watch) {
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all(ctxs.map((c) => c.rebuild()));
  await Promise.all(ctxs.map((c) => c.dispose()));
}
