/**
 * Sharing the rest of the project, not just the blocks.
 *
 * A MakeCode project is more than its `.blocks` file: `pxt.json` lists the
 * extensions it depends on, `assets.json` holds every sprite, animation and
 * tilemap the image editors produce, and `main.ts` is the generated code. Until
 * now those were *preserved* — a collaborator's change could not destroy them —
 * but they were not *shared*, so adding an extension or painting a sprite only
 * happened for the person who did it, and everyone else got blocks referring to
 * assets they did not have.
 *
 * They are shared the same way the blocks are, and for the same reason: they
 * are written to real files beside the `.blocks` file, which is exactly what a
 * MakeCode project looks like on disk. Live Share replicates a folder of text
 * files without being asked, so nothing here talks to Live Share either.
 */

export type ProjectText = Record<string, string>;

/**
 * The files worth sharing.
 *
 * Deliberately a fixed list rather than everything the editor reports. The
 * editor's project also carries its own `.blocks` — which is the document, and
 * writing it as a sibling would give the same content two owners — and build
 * output that is regenerated anyway. Naming the three means a surprising entry
 * in a project cannot cause a file to appear in someone's folder.
 */
export const SHARED_FILES = ['pxt.json', 'assets.json', 'main.ts'] as const;

export function isShared(name: string): boolean {
  return (SHARED_FILES as readonly string[]).includes(name);
}

/** The shareable part of a project's files. */
export function sharedFiles(text: ProjectText): ProjectText {
  const files: ProjectText = {};
  for (const name of SHARED_FILES) {
    const content = text[name];
    if (typeof content === 'string') {
      files[name] = content;
    }
  }
  return files;
}

/**
 * Which files actually changed, with the one rule that matters.
 *
 * An empty file is never written, at all. The editor reports an empty or
 * placeholder project at several points while it starts up — a fresh project
 * carries a single space as its `main.ts` — and on a slow load that would
 * arrive looking exactly like a collaborator deleting every sprite in the game.
 * Nobody empties `assets.json` on purpose often enough to be worth the risk of
 * doing it to them by accident, and an empty file nobody had is only churn.
 */
export function changedFiles(previous: ProjectText, next: ProjectText): ProjectText {
  const changed: ProjectText = {};
  for (const [name, content] of Object.entries(next)) {
    if (!isShared(name)) {
      continue;
    }
    const before = previous[name];
    if (content === before || isEmpty(content)) {
      continue;
    }
    changed[name] = content;
  }
  return changed;
}

/** Blank, or the single-space placeholder a fresh project carries. */
export function isEmpty(content: string | undefined): boolean {
  return content === undefined || content.trim() === '';
}

/** Folds shared files into a project, leaving its blocks alone. */
export function withFiles<T extends { text: ProjectText }>(project: T, files: ProjectText): T {
  const text = { ...project.text };
  for (const [name, content] of Object.entries(files)) {
    if (isShared(name)) {
      text[name] = content;
    }
  }
  return { ...project, text };
}

/**
 * Keeps `pxt.json`'s file list honest.
 *
 * MakeCode only reads the files a project declares, so an `assets.json` that
 * arrives without being listed is ignored — the sprites are there on disk and
 * invisible in the editor, which is worse than not syncing it at all. Returns
 * the JSON unchanged if it cannot be parsed, since a broken config is not
 * something to make guesses about.
 */
export function withDeclaredFiles(config: string, names: string[]): string {
  let parsed: { files?: unknown };
  try {
    parsed = JSON.parse(config);
  } catch {
    return config;
  }
  if (!parsed || typeof parsed !== 'object') {
    return config;
  }

  const declared = Array.isArray(parsed.files) ? (parsed.files as unknown[]).map(String) : [];
  const missing = names.filter((name) => !declared.includes(name));
  if (!missing.length) {
    return config;
  }
  return JSON.stringify({ ...parsed, files: [...declared, ...missing] }, null, 4);
}
