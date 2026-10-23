# MakeCode's Blockly renderer

The files in this directory, except `contrast.ts` and this README, are taken
**verbatim** from Microsoft MakeCode (`pxtblocks/plugins/renderer/` in
<https://github.com/microsoft/pxt>), which is licensed **MIT**, Copyright (c)
Microsoft Corporation. See `LICENSE`.

They are a self-contained Blockly plugin: their only dependency is `blockly`
itself, which this extension already ships. Registering it gives blocks
MakeCode's exact geometry — it is the same `pxt` renderer a running Arcade
editor reports as `class="injectionDiv pxt-renderer"`.

Three local changes:

- `contrast.ts` supplies `contrastRatio`, which the upstream `pathObject.ts`
  calls as `pxt.contrastRatio` — a MakeCode editor helper that is not part of
  the plugin.
- `pathObject.ts` imports that helper (from `../contrast.ts`) instead of reading
  a `pxt` global.
- Each file carries a `@ts-nocheck` banner. These compile under pxt's looser
  settings and would not pass this project's `strict` checks; they are bundled
  by esbuild, which does not type-check, and left otherwise untouched.

To update, re-fetch the files from the same path upstream and re-apply those
three edits.
