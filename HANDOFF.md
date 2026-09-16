# Handoff

Everything a new session needs to continue this project. Written at the end of
the session that built it; `README.md` documents the extension for users, this
documents the *work* — decisions, dead ends, and what is left.

**Branch:** `claude/fresh-start-gvxmdy` (all work pushed here; `main` holds only
an unrelated Azure workflow, left untouched).

---

## 1. What this is

A VS Code **web extension** that opens MakeCode Arcade `.blocks` files in a real
Arcade block canvas, runs in vscode.dev, and co-edits over **Live Share**.

Built in four commits:

| Commit | What landed |
| --- | --- |
| `fa2bf81` | The editor: web extension, custom text editor, Live Share collaboration model |
| `c8dcd1c` | Generator that turns Arcade's API metadata into Blockly definitions |
| `1647f3b` | Arcade blocks rendering in the editor; corrections from a real Arcade file |
| `cf3548f` | The sprite image painter |

Current library: **493 blocks, 69 dropdowns, 15 categories**, generated from
MakeCode Arcade target `4.1.25` / pxt `13.1.23`.

---

## 2. The two decisions everything else follows from

### Collaboration comes from the text document, not from Live Share

**Live Share has no API for syncing webviews or custom-editor state.** It
synchronizes *text documents*. So this is a `CustomTextEditorProvider`: the
`.blocks` file stays a real text document, every block change is written back
through a `WorkspaceEdit`, and Live Share replicates it like any other edit.

**The extension contains zero Live Share code.** Do not add any. If you ever
find yourself reaching for `CustomEditorProvider` (the non-text one) or an
internal document model, you are about to break collaboration entirely.

Three things keep it smooth, all in `src/webview/main.ts` and `src/textDiff.ts`:

- Writes are the **smallest single-range replacement** (`minimalReplacement`),
  not whole-file rewrites, so concurrent edits to different blocks merge under
  Live Share's OT instead of clobbering. Block ids are preserved for the same
  reason.
- Writes are **debounced** (default 200 ms), and UI-only Blockly events (scroll,
  zoom, selection) never produce a document revision — every revision is
  broadcast to every participant.
- A remote update arriving **mid-drag** is queued until the drag ends.

### Nothing may ever be dropped

Blockly silently discards fields and mutations a block does not declare. On save
that deletes part of someone's game. Three defenses, in `arcade/register.ts` and
`stubBlocks.ts`:

- Unknown `<field>` → added to the block as a text field before loading.
- Unknown `<mutation>` → stored verbatim, written back unchanged.
- Unknown block type → placeholder block shaped from how the file uses it.

**This is why the project survived my wrong guesses** (see §4). Keep these.

---

## 3. Layout

```
src/extension.ts                  activation, two commands
src/blocksEditorProvider.ts       CustomTextEditorProvider, webview HTML + CSP, write-back
src/textDiff.ts                   minimal single-range replacement
src/protocol.ts                   host <-> webview message types
src/webview/main.ts               Blockly injection, change handling, debounce, drag queue
src/webview/parse.ts              STRICT XML parsing (see §4)
src/webview/serialize.ts          workspace -> .blocks XML
src/webview/stubBlocks.ts         placeholders for unknown block types
src/webview/arcade/
  register.ts                     registers library; preserves unknown fields/mutations
  dropdowns.ts                    enum + sprite-kind dropdowns, extensible per document
  toolbox.ts                      Arcade toolbox merged with built-in categories
  coreBlocks.ts                   `on start` and pxt's loop/math/variable blocks
  theme.ts                        MakeCode palette as a Blockly theme
  palette.ts                      built-in category colours
  imageField.ts                   sprite image painter (field_arcade_image)
  imageLiteral.ts                 reads/writes MakeCode's img`...` literal
  imageRender.ts                  draws sprites for preview and painter
  colourField.ts                  palette swatch picker (field_arcade_colour)
src/generated/*.json              GENERATED - do not hand-edit, see §5
scripts/fetchArcade.mjs           downloads the Arcade target bundle
scripts/generateArcadeBlocks.mjs  turns its API metadata into block definitions
test/roundtrip.mjs                the test suite (real Blockly, real Chromium)
test/harness.ts                   re-exports shipping code so tests cannot drift
sample/arcade-real.blocks         GROUND TRUTH - a file saved by MakeCode Arcade
```

Commands: `npm run compile`, `npm test`, `npm run typecheck`,
`npm run arcade:refresh` (re-fetch + regenerate the block library).

---

## 4. Gotchas — the things that cost real time

Read this section before changing anything. Each was found the hard way.

1. **Blockly's `textToDom` parses leniently as HTML.** Malformed XML does not
   fail — it silently yields an almost-empty `<xml>`. Loading that clears the
   canvas, and the next drag writes the empty workspace over the user's file.
   A collaborator typing in the text view produces exactly those states
   constantly. `src/webview/parse.ts` parses strictly with `DOMParser` and
   `application/xml`; **never** route loading back through Blockly's parser.

2. **Blockly 13's `workspaceToDom` emits `<variables>` only when a block
   references the variable.** Unused declarations — which MakeCode files carry —
   were being silently deleted on save. `serialize.ts` replaces whatever Blockly
   produced with the workspace's complete list.

3. **`BlockDrag extends UiBase`, so `event.isUiEvent` is true for it.** An early
   `if (event.isUiEvent) return` made all drag tracking dead code. Check
   `BLOCK_DRAG` *before* the UI-event guard.

4. **Sprite kinds are variables, not enum members.** A real Arcade file stores
   them as `<variable type="KIND_SpriteKind">Player</variable>`, and the shadow
   holds the **bare** name in a field called **`MEMBER`**. The metadata's
   `kindMemberName` names the *TypeScript parameter* and does not appear in the
   XML at all — I guessed from it and was wrong. Kinds are user-extensible
   (`SpriteKind.Coin`), so `dropdowns.ts` sources options from the document's own
   variables; a static dropdown rejects unknown values and loses data.

5. **Saved files use the Blockly XML namespace**, not the `xhtml` one that
   appears in MakeCode's `blocksprj` project template. Trust saved files.

6. **`paramFieldEditor` marks a field editor; `ref: true` does not.** A `ref`
   param is a variable passed by reference (`$sprite=variables_get(mySprite)`)
   and keeps its value socket. Conflating them turned `move ... with buttons`
   into three text fields.

7. **pxt-core's icon fonts are shipped corrupt in its npm package** — all three
   formats fail Chromium's sanitiser ("OTS parsing error"). Font Awesome 4.7 has
   the same codepoints and works; that is what is bundled.

8. **Blockly preloads its sounds with `fetch`**, governed by `connect-src`, not
   `media-src`. The CSP needs both.

9. **Palette index 0 and index 15 are both `#000000`.** Only 15 is ink; 0 is
   transparent. Draw 0 as a checkerboard or sprites look solid black.

10. **Blockly is typed as `any`** (`src/webview/blockly.d.ts`) because it loads
    as a UMD global. TypeScript rejects `override` modifiers on members of an
    `any` base class — omit them when subclassing `Blockly.Field`.

---

## 5. Generated code

`src/generated/*.json` comes from `scripts/generateArcadeBlocks.mjs`, which reads
a cached Arcade target bundle (`.arcade-cache/target.json`, gitignored, ~8.7 MB).

Key insight: **pxt has already parsed every block's layout** into
`attributes._def` (labels, params, shadow ids). Translate that structure. Do not
re-parse the TypeScript `//%` annotations — that path was started and abandoned.

The toolbox is limited to the dependency closure of `blocksprj` (9 packages, via
`device`). Optional extensions (corgio, darts, radio, esp32…) stay **defined** so
projects using them load, but are not offered, because Arcade does not offer them
until you add the extension.

Output is committed so ordinary builds need no network.

---

## 6. Verification

`npm test` runs against **real Blockly in real Chromium** (Playwright). It:

- round-trips every `sample/*.blocks` and asserts the structure is unchanged;
- asserts Arcade files use **zero placeholders** (a placeholder means the library
  has a hole);
- asserts fidelity details the structural comparison normalizes away: the
  pixel-art literal, the `<data>` payload, the `_expanded="0"` mutation, and
  punctuation-heavy variable ids;
- covers the image-literal parser and formatter;
- asserts malformed XML is rejected and an empty file is accepted.

Beyond that, these were verified by driving **browser-hosted VS Code** with
Playwright (`npx vscode-test-web --browserType=none --port=PORT
--quality=stable --extensionDevelopmentPath=. ./sample`, then open
`http://localhost:PORT/?folder=vscode-test-web%3A%2F%2Fmount%2F`):

- a real mouse drag moves a block and the document updates;
- editing the XML in a split text editor live-updates the canvas (the direction
  a Live Share peer's edit arrives from);
- the canvas holds its last good state while the XML is transiently invalid;
- painting a pixel puts the painted row into the document.

Note `@vscode/test-web` must be ≥ 0.0.81; older versions 404 against current
VS Code builds.

---

## 7. What is NOT done

In rough order of value:

1. **Tilemap and tileset editors** — the biggest remaining gap. Larger than the
   sprite painter: tilemaps reference a tileset and store a denser payload.
   Metadata signals are `paramFieldEditor: "tilemap"` / `"tileset"`.
2. **Melody / sound-effect editors** (`melody`, `musiceditor`, `note`,
   `soundeffect`) and **grid pickers** (`gridpicker`, 27 uses — the most common
   editor kind after the ones done).
3. **No simulator.** Running games would mean the pxt compiler; a large project,
   and the user explicitly chose the "real Arcade blocks" scope over it.
4. **The `+` expand toggle.** Blocks with optional args are always drawn
   expanded, because collapsing risks dropping stored values.
5. **Cosmetic:** the `on start` wrapper does not stretch its top bar across wide
   contents the way MakeCode's does — a `zelos` renderer difference.
6. **Collaboration limits:** two people dragging *the same* block still conflict
   (last write wins); there are no remote cursors on the canvas.

### Open: embedding the real MakeCode Arcade editor

The user wants **the genuine Arcade editor**, not a recreation, still editing the
`.blocks` file so Live Share works. Researched 2026-09-16 — the protocol exists
and supports it.

The embed URL is the site **root with query parameters** —
`https://arcade.makecode.com/?controller=1&ws=browser`. There is no
`/index.html`; that path 404s.

**Framing is permitted.** The response carries no `X-Frame-Options`, no
`Content-Security-Policy` with `frame-ancestors`, and no `<meta>` CSP, so
MakeCode does not block being embedded in an iframe. That was the largest
structural risk and it is cleared.

MakeCode's **controller embedding** (`?controller=1&ws=browser`) speaks a
postMessage protocol, typed in `pxt-core/localtypings/pxteditor.d.ts`:

- `workspacesync` — editor asks the host for its projects; host replies with
  `{ type: "pxthost", id, success: true, projects: [project] }`.
- `workspacesave` — **editor pushes `{ project }` to the host on every change.**
  This is the piece that makes the design work: no polling needed.
- `importproject` — host pushes a project into the editor.
- Also available: `switchblocks`, `renderblocks`, `proxytosim`,
  `workspacediagnostics`, and a simulator channel.

Architecture would be: iframe the editor, answer `workspacesync` with the
document's `.blocks`, and on `workspacesave` write `project.text['main.blocks']`
back through the same `WorkspaceEdit` path the Blockly build already uses — so
Live Share replication is unchanged.

**Still unverified:** whether the controller *handshake* completes (the headers
only prove the page may be framed). This could not be tested in the build
sandbox: outbound HTTPS
goes through a proxy whose CA Chromium does not trust, `certutil` is not
installable, and disabling TLS verification is prohibited. `curl` reaches
MakeCode; a browser in that sandbox cannot.

`npm run probe:embed` serves `probe/embed-probe.html` on http://localhost:4173.
Open it on a normal network and move a block: it reports whether the editor
loads, requests sync, renders the blocks, and pushes `workspacesave`. If the
last one fires, the design is confirmed. It must be served over http — MakeCode
checks the embedding origin, so `file://` will not handshake.

**Costs to weigh before building it** (these cut against the collaboration goal):

1. **No patch API — `importproject` replaces the whole project.** A remote edit
   arriving forces a full editor rebuild: scroll, selection and undo history are
   lost. The Blockly build reloads only the workspace and restores scroll, so
   simultaneous editing is *better* there, not worse.
2. **Bigger diffs, more conflicts.** MakeCode re-serializes the whole project;
   the Blockly build preserves block ids and ordering so a one-block change is a
   one-line diff. Large diffs collide far more often under Live Share's OT.
3. **A project is four files** (`main.blocks`, `main.ts`, `pxt.json`,
   `assets.json`). Modern Arcade keeps tilemaps and the image library in
   `assets.json`; a lone `.blocks` document has nowhere to put them. Decide
   between sidecar files, a container format, or accepting the loss.
4. **Network-only and heavy** — no offline use, slower open.

Suggested shape if pursued: keep both engines behind a setting
(`blocksEditor.engine: "blockly" | "makecode"`), so the offline, fine-grained
Blockly path stays the default and the embedded editor is opt-in for fidelity.
The provider, `textDiff.ts` and the write-back path are engine-agnostic already.

### Hosting constraints (the real blocker)

The target user is a student on a school-managed device running **Securly**,
which filters the device everywhere, not just on the school network. Confirmed
blocked: **GitHub, GitHub Pages, Cloudflare `workers.dev`, Google Apps Script
(`script.google.com`), and claude.ai** (so a Claude Artifact cannot host it
either). Confirmed allowed: **arcade.makecode.com** — it is used in class.

**What makecode.com can and cannot do as a backend** (probed 2026-09-16):

| Operation | Result |
| --- | --- |
| `POST /api/scripts` (create a share, anonymous) | works — returns `{id, shortid}` |
| `GET /api/<shortid>/text` | works — returns the file map |
| `POST /api/<shortid>` (update in place) | **403** |
| `GET /api/scripts`, `?q=`, `/api/search`, `/api/list` | **404 — no such api** |

So MakeCode is a free, allowed, **append-only blob store addressable only by an
id you already hold**. Shares are immutable and undiscoverable: ids are
server-assigned and random, so they cannot be derived from a room name.

The consequence worth remembering: **the project payload can live on MakeCode
for free**, so the only external dependency is a single mutable value — roughly
12 bytes naming the current share id. Any host that can store and serve one
string suffices; it does not need to hold the project. A chain does not work
either (links can only point backwards, and finding the head is the problem).

If a host is ever allowed, that is the whole integration: write the project to
MakeCode, write the returned id to the mutable cell, and have peers poll the
cell. Prefer plain HTTPS polling over WebSockets or WebRTC — school filters
commonly block both.

### Conclusion: not deployable to the target device

After testing every available route, **real-time collaboration cannot be
delivered to the user's school-managed device.** Do not re-run this search.

Blocked on the device (Securly, filters at home too): GitHub, GitHub Pages,
`workers.dev`, `script.google.com`, claude.ai, `netlify.app`, `vercel.app`.
Allowed: `arcade.makecode.com`. Note the pattern — `netlify.com` is allowed
while `netlify.app` is blocked: the filter permits companies' marketing sites
and blocks the domains where anyone can host anything. That rule predicts
`pages.dev`, `glitch.me`, `repl.co` and `cdpn.io` too, so host-hunting is not
worth more effort.

The two hosting-free fallbacks are also gone:

- **Bookmarklet** (code in the bookmark, injected into the allowed MakeCode
  page): `javascript:` URLs are disabled by device policy.
- **Browser extension**: cannot be installed on a managed Chromebook.
- **Google Sites** (an Embed block would have supplied both hosting and a
  permitted domain): `sites.google.com` is blocked too.
- **MakeCode extensions** do not help either — they are TypeScript libraries
  compiled into the *game*, with no access to the editor or to edit-time
  network calls.

No allowlist request is possible. A web app must be served from some domain,
and every candidate is blocked, so the work stops here for that device.

**What still has value:**

- The VS Code extension (commits `fa2bf81`..`cf3548f`) works on any unfiltered
  machine and was the original request.
- `collab/src/` (the MakeCode controller handshake and the sync rules, both
  tested) and `collab/netlify/functions/room.mts` are complete and
  host-agnostic. If a host ever becomes available, finishing the app is the
  page shell plus a polling transport — a few hours, not a redesign.

What the user can do on the school device today, with allowed domains only:
MakeCode's own Share button for turn-taking collaboration on one project.

### Considered and rejected: switching to pxt-blockly

Asked whether to rebuild on Microsoft's Blockly fork (`pxt-blockly`) instead of
upstream Blockly. **Do not.** Researched 2026-09-16:

- `pxt-blockly` was last published **July 2022** (v4.0.15) and is abandoned.
- `pxt-core@13.2.4` depends on **`blockly: 13.1.1`** — MakeCode migrated to
  upstream Blockly. This project uses `blockly@^13.3.0`, so it is *already* on
  the same engine MakeCode runs.

The worthwhile version of that idea is to adopt what pxt layers *on top* of
Blockly, which lives in `pxt-core/pxtblocks/` (158 modules: a renderer plugin,
colorpicker, functions/flyout/comment plugins). Note the npm package ships
**only `.d.ts` files — zero JavaScript**; the implementation is compiled into the
monolithic `built/web/main.js`. Porting therefore means working from the
`microsoft/pxt` GitHub source, which is MIT (attribution required).

Concretely, in value order:

1. `@blockly/field-grid-dropdown` (an off-the-shelf plugin pxt-core itself
   depends on) supplies the `gridpicker` editor — 27 uses, the most common
   field editor still unimplemented. Cheapest, highest coverage.
2. Port pxt's renderer plugin for true MakeCode block geometry; this also fixes
   the `on start` wrapper cosmetic noted above.
3. Port the colorpicker to replace `colourField.ts`.

pxt-core also uses `@blockly/plugin-workspace-search`, if block search is ever
wanted. None of these touch the sync model.

Also untouched: `.github/workflows/azure-webapps-node.yml` on `main` is an
unrelated Azure Node deploy workflow that will fail against this repo. The user
was asked and did not say to remove it.

---

## 8. Working agreement that served this project well

- **Get ground truth before guessing.** One real Arcade file corrected two
  conventions that metadata alone had led me to get wrong. If you need another,
  ask for a `main.blocks`, or a **Share** link (`arcade.makecode.com/_AbCd...`,
  fetchable at `https://arcade.makecode.com/api/<id>/text`). Never ask for
  account credentials — they are not needed.
- **Make correctness independent of guesses.** The tolerance passes in §2 are why
  being wrong was recoverable rather than destructive.
- **Verify in the real host**, not just unit tests. Every significant claim above
  was checked by driving actual VS Code in a browser.
