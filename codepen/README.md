# Arcade Collab

The real MakeCode Arcade editor in a plain web page, with no VS Code, plus live
collaboration and an optional level system.

## Use it

**W3Schools Tryit (tested working):** open any Tryit page, replace the code with
the contents of `loader.html`, and press Run. It downloads the latest
`dist/arcade-collab.html` from this repository, so there is nothing to re-paste
when the page is updated.

**Anywhere else:** paste all of `dist/arcade-collab.html` into a page that runs
it at its own web address. A sandboxed result frame will not work: MakeCode needs
storage and same-origin access, which a sandbox (or opening the file from disk)
takes away.

## Change it

Edit `main.ts` or `page.html`, then `npm run codepen` to rebuild
`dist/arcade-collab.html`, and commit that too. Everything that drives the editor
(the same-origin loader, the block-by-block merge, the sync rules) is shared
with the VS Code extension in `../src`.

- **Levels** (optional, switched on in Setup): `level1` … `levelN`, one loaded at
  a time. In the game, `console log "@next"` loads the next level, and
  `console log "@level level4"` a particular one.
- **Together:** "Just this computer" syncs tabs in one browser and needs nothing.
  "Online with friends" needs a WebSocket relay; `relay.mjs` is a minimal one.
- **Storage:** the browser's IndexedDB. Export / Open backup move a project in and
  out; Import folder takes a folder of `.blocks` files and their assets.
