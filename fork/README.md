# Forking MakeCode Arcade to bundle it in the extension

The embedded editor works, but every change a collaborator makes reloads it,
because MakeCode's embed API accepts only `importproject` — a whole-project
replace. There is no way to apply a single change through that API.

Building the editor ourselves fixes that, for one reason: **the editor becomes
same-origin with the webview**. At that point its live Blockly workspace is
directly reachable, and a collaborator's change can be applied surgically
instead of by rebuilding everything.

Bundling it also removes the cross-origin embedder policy problem on vscode.dev
and makes the extension work with no network at all.

## What to do

1. Fork <https://github.com/microsoft/pxt-arcade>.
2. Copy `build-static-editor.yml` into `.github/workflows/` in the fork.
3. Actions → **Build static Arcade editor** → Run workflow.
4. Download the **arcade-static-editor** artifact when it finishes.

The build takes a while and the result is large — tens of megabytes.

## What you do *not* need to change

Nothing in MakeCode's source. `pxt staticpkg` builds the stock editor, and the
extension injects `host-bridge.js` into the built `index.html` afterwards. That
script runs inside the editor, same-origin, and adds the API we need.

Patching at load rather than forking the source means the fork stays a plain
mirror: re-running the workflow against upstream picks up MakeCode's updates
without re-applying any changes.

## Why `--route ./`

`staticpkg` writes URLs against the route it is given. The extension serves the
editor from a webview URI, which is not a domain root, so every generated URL
has to be relative. Without this the editor loads a blank page and asks for
paths like `/blb/...` that do not exist.

## Size

Expect 40–80 MB before trimming. A VS Code extension can carry that, but it is
worth removing what the blocks editor does not need — the Monaco text editor and
unused locales are the obvious candidates — before shipping it.
