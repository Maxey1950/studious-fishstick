# Blocks Editor (`.blocks`)

A **web extension** for VS Code that opens MakeCode Arcade `.blocks` files in a
real Arcade block canvas — and co-edits over **Live Share**.

Runs in [vscode.dev](https://vscode.dev) and github.dev, as well as desktop VS Code.

## How collaboration works

This is the part worth understanding before you extend the editor, because it
constrains the design.

**Live Share has no API for syncing webviews or custom editor state.** It
synchronizes *text documents*. A custom editor that keeps its own document model
(`CustomEditorProvider`) is invisible to Live Share — each participant would see
their own private, diverging canvas.

So this extension is a **`CustomTextEditorProvider`**. The `.blocks` file stays a
plain text document at all times:

```
 you drag a block
      ↓
 webview serializes the workspace to XML
      ↓
 extension host applies a WorkspaceEdit to the text document   ← Live Share syncs HERE
      ↓
 every participant's onDidChangeTextDocument fires
      ↓
 their webview reloads the canvas from the new XML
```

Collaboration therefore comes from the document, not from any Live Share API —
the extension contains no Live Share code at all. It works with Live Share, with
two windows on the same file, with undo/redo, and with a text editor open on the
same file in a split pane.

Three things make that smooth rather than janky:

- **Minimal edits.** Every save is diffed against the current document and
  applied as the smallest single-range replacement (`src/textDiff.ts`). Replacing
  the whole file on each change would make two people editing different blocks
  clobber each other under Live Share's operational transform; narrowing the edit
  lets those merges succeed.
- **Block ids are preserved** on serialization, for the same reason — stable ids
  keep diffs small.
- **Strict XML parsing.** Blockly's own `textToDom` falls back to lenient HTML
  parsing, so half-typed XML does not fail — it quietly yields an almost-empty
  workspace. Loading that would clear the canvas, and the next drag would write
  the empty workspace back over the file. Since a collaborator editing the file
  as text produces exactly those transient states, `src/webview/parse.ts` parses
  strictly and the canvas holds its last good state (with an explanatory banner)
  until the XML is valid again.
- **Debounced writes and drag-awareness.** Block changes are coalesced (default
  200 ms, see `blocksEditor.writeDebounceMs`), UI-only events (scroll, zoom,
  selection) never produce a document revision, and a remote update arriving
  mid-drag is queued until the drag ends instead of ripping the block out of
  your hand.

### Known limits

- Two people dragging **the same block** at the same time still conflict; last
  write wins. There is no block-level operational transform.
- There are no remote cursors or presence indicators on the canvas. Live Share's
  presence API reports text-document positions, which do not map onto a block
  canvas without extra work.
- Live Share must be installed by each participant **in desktop VS Code** to host
  a session. Browser participants can join a session in vscode.dev.

## MakeCode Arcade support

The editor ships Arcade's actual block library: **493 blocks and 69 dropdowns
across 15 categories**, generated from MakeCode Arcade's own compiled API
metadata, with Arcade's real colours, icons, groups, tooltips and reference
links. `sprite of kind`, `on game update`, `move with buttons`, `destroy with
effect`, tilemaps, music — they look and read the way they do in Arcade.

How it is built (`scripts/generateArcadeBlocks.mjs`):

- pxt has already parsed each block's layout into `attributes._def`, so the
  generator translates that structure instead of re-parsing TypeScript.
- The toolbox is limited to the packages a new Arcade project actually depends
  on, resolved from `blocksprj`'s dependency closure. Optional extensions
  (corgio, darts, radio, esp32…) stay *defined* — a project using them still
  loads — but are not offered, because Arcade does not offer them either until
  you add the extension.
- Categories carry MakeCode's own icon codepoints, drawn from a bundled
  Font Awesome 4 (see `media/fonts/LICENSE.md` for why not pxt's own font file).
- Built-in categories use MakeCode's palette verbatim from the target bundle:
  loops `#20BF6B`, logic `#45AAF2`, math `#A55EEA`, variables `#EC3B59`,
  text `#F5D547`, arrays `#FF8F08`, functions `#1446A0`.

Refresh the library against the current Arcade release with `npm run
arcade:refresh`; the generated output is committed so ordinary builds need no
network access.

### What is faithful, and what is not

Verified against a file saved by MakeCode Arcade itself (`sample/arcade-real.blocks`),
which round-trips byte-for-byte in structure — sprite kinds, pixel-art image
literals, `<data>` payloads, expandable-block `<mutation>`s and all:

- Sprite kinds are workspace variables (`<variable type="KIND_SpriteKind">`) and
  the dropdown reads its options from them, so the kinds a game defines for
  itself (`SpriteKind.Coin`) appear and survive saving.
- Blocks are drawn with the `zelos` renderer, closest to MakeCode's own.

Not reproduced:

- **Custom field editors.** MakeCode's image painter, tilemap editor, colour
  swatches and speed sliders are bespoke UI. Their values are shown as plain
  editable text or numbers — a sprite image reads as its `img\`...\`` literal
  rather than a grid of pixels. Nothing is lost; it is just not a painter.
- **The "+" expand toggle.** Blocks with optional arguments are drawn fully
  expanded. Omitting those inputs would drop values a file already stores for
  them, so they are always shown.
- **No simulator.** This edits games; it does not run them.

### Nothing gets dropped

Blockly silently discards fields and mutations a block does not declare, which
on save would delete part of someone's game. Two passes prevent that, and they
do not depend on this editor's guesses being right:

- Any `<field>` the definition does not declare is added to the block as a text
  field before loading, so it survives.
- Any `<mutation>` a block does not understand is stored verbatim and written
  back unchanged.
- Block types Arcade does not define at all still render, as placeholder blocks
  shaped from how the file uses them (`src/webview/stubBlocks.ts`).

`npm test` enforces this: it loads every sample into real Blockly in real
Chromium, asserts the serialized structure matches the source, and asserts that
Arcade files use no placeholders at all.

## Development

```bash
npm install
npm run compile      # vendors Blockly into media/, builds both bundles
npm test             # round-trip test against real Blockly in Chromium
npm run typecheck
```

To debug, press <kbd>F5</kbd> with the **Run Web Extension** launch configuration —
it starts an extension host in a web worker, the same host vscode.dev uses, so
Node-only API misuse fails here exactly as it would in the browser.

To try it in a browser-hosted VS Code build:

```bash
npx vscode-test-web --extensionDevelopmentPath=. ./sample
```

### Layout

| Path | Purpose |
| --- | --- |
| `src/extension.ts` | Activation; registers the editor and the two commands. |
| `src/blocksEditorProvider.ts` | The `CustomTextEditorProvider`: webview HTML/CSP, document ↔ webview sync, write-back. |
| `src/textDiff.ts` | Minimal single-range replacement, for conflict-friendly edits. |
| `src/protocol.ts` | Message types shared by both halves. |
| `src/webview/main.ts` | Blockly injection, change handling, debounce, drag queueing. |
| `src/webview/serialize.ts` | Workspace → `.blocks` XML. |
| `src/webview/stubBlocks.ts` | Placeholder definitions for unknown block types. |
| `src/webview/arcade/register.ts` | Registers the Arcade library; preserves unknown fields and mutations. |
| `src/webview/arcade/dropdowns.ts` | Enum and sprite-kind dropdowns, extensible per document. |
| `src/webview/arcade/toolbox.ts` | Arcade toolbox, merged with MakeCode's built-in categories. |
| `src/webview/arcade/coreBlocks.ts` | `on start` and pxt's loop/math/variable blocks. |
| `src/webview/arcade/theme.ts` | MakeCode's palette as a Blockly theme. |
| `scripts/fetchArcade.mjs` | Downloads the Arcade target bundle. |
| `scripts/generateArcadeBlocks.mjs` | Turns its API metadata into block definitions. |
| `scripts/vendor.mjs` | Copies Blockly out of `node_modules` into `media/vendor/`. |

Blockly is **vendored, not loaded from a CDN** — vscode.dev's webview content
security policy blocks remote scripts, and vendoring keeps the extension working
offline.

### Why the code avoids Node

vscode.dev runs extensions in a web worker. There is no `fs`, no `path`, no
`child_process`, and no `require` of Node builtins. The manifest declares
`"browser"` (not `"main"`), esbuild targets `platform: 'browser'`, and the
extension reads and writes exclusively through `vscode.workspace` APIs.

## Commands

| Command | Description |
| --- | --- |
| `Blocks: Open Active File as XML Text` | Switch the active `.blocks` file to the plain text editor. |
| `Blocks: Open Active File in Blocks Editor` | Switch back to the block canvas. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `blocksEditor.writeDebounceMs` | `200` | Delay after the last block change before writing to the file. Lower feels more live over Live Share, at the cost of more document revisions. |
| `blocksEditor.renderer` | `zelos` | Blockly renderer. `zelos` most closely resembles MakeCode. |

## License

MIT.

- **Blockly** is vendored under its own Apache-2.0 license, included at
  `media/vendor/blockly/LICENSE`.
- **Font Awesome 4.7** supplies the category icons, under SIL OFL 1.1 — see
  `media/fonts/LICENSE.md`.
- The generated block definitions are derived from **MakeCode Arcade**'s
  published target metadata (MIT, Copyright (c) Microsoft Corporation). This
  project is not affiliated with or endorsed by Microsoft.
