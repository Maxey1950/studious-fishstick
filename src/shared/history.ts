/**
 * A short memory of what the blocks used to be.
 *
 * Every serious bug this editor has had ended the same way — blocks that were
 * there a moment ago and are not there now. A merge reads a change wrong, a
 * collaborator's editor starts up empty, an echo arrives late. Each one is
 * fixed, and each one was invisible until someone noticed their work missing.
 *
 * So: keep the recent states, and let someone put one back. It is not a
 * substitute for the sync being right, but it turns the worst case from lost
 * work into an inconvenience — and it needs no server, no history file and no
 * cooperation from Live Share, because the states are just text.
 */

export interface Version {
  xml: string;
  /** When this state was first seen, for telling versions apart. */
  atMs: number;
  /** How many blocks it holds, which is what people actually recognize. */
  blocks: number;
}

/** How many states to keep. Enough to get back past a bad minute. */
export const HISTORY_LIMIT = 25;

/**
 * Adds a state to the history, newest first.
 *
 * Consecutive duplicates are not recorded: the same blocks arriving twice is
 * not a version worth offering, and a stream of them would push the state
 * somebody actually wants off the end.
 */
export function recordVersion(
  history: Version[],
  xml: string,
  atMs: number,
  limit = HISTORY_LIMIT
): Version[] {
  if (history[0]?.xml === xml) {
    return history;
  }
  const next = [{ xml, atMs, blocks: countBlocks(xml) }, ...history];
  return next.length > limit ? next.slice(0, limit) : next;
}

/**
 * How many blocks a document holds.
 *
 * Counted from the text rather than parsed. This runs on every recorded state,
 * the number only has to be good enough to tell versions apart in a list, and
 * "14 blocks" against "3 blocks" is exactly the difference someone is looking
 * for when they have just lost their work.
 */
export function countBlocks(xml: string): number {
  return (xml.match(/<block[\s>]/g) ?? []).length;
}

/** How a version reads in the list: when it was, and what was in it. */
export function describeVersion(version: Version, nowMs: number): string {
  const blocks = `${version.blocks} block${version.blocks === 1 ? '' : 's'}`;
  return `${describeAge(nowMs - version.atMs)} · ${blocks}`;
}

function describeAge(ageMs: number): string {
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  if (seconds < 10) {
    return 'just now';
  }
  if (seconds < 60) {
    return `${seconds} seconds ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}
