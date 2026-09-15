# Blocks Editor (`.blocks`)

A **web extension** for VS Code that opens `.blocks` files (Blockly / MakeCode XML)
in a visual block canvas — and co-edits over **Live Share**.

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

## MakeCode files

MakeCode `.blocks` files reference block types defined by the MakeCode target
(`device_forever`, `basic_show_leds`, …) that stock Blockly does not know.

Rather than failing to load — or worse, loading partially and then writing the
damage back to disk — unknown types get a **generated placeholder block** whose
shape is inferred from how the file uses it: its fields, value inputs, statement
inputs, and whether it reports a value (`src/webview/stubBlocks.ts`). Any
`<mutation>` element is stored verbatim and re-emitted.

The result is that a MakeCode file **round-trips unchanged** even though this
editor does not ship MakeCode's block library. That claim is enforced by
`npm test`, which loads each file in `sample/` into real Blockly in real
Chromium and asserts the serialized structure matches the source.

This extension does not attempt to *be* MakeCode. It will not render MakeCode's
block artwork or offer its toolbox.

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

MIT. Blockly is vendored under its own Apache-2.0 license, included at
`media/vendor/blockly/LICENSE`.
