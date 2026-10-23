/**
 * Computes the smallest single-range replacement that turns `oldText` into
 * `newText`, by trimming the common prefix and suffix.
 *
 * This matters for collaboration: replacing the whole document on every block
 * change would make two people editing different parts of the same file clobber
 * each other under Live Share's operational transform. Narrowing the edit to
 * the bytes that actually moved lets concurrent edits to different blocks merge
 * cleanly.
 *
 * Returns `undefined` when the two texts are identical.
 */
export function minimalReplacement(
  oldText: string,
  newText: string
): { start: number; end: number; replacement: string } | undefined {
  if (oldText === newText) {
    return undefined;
  }

  const max = Math.min(oldText.length, newText.length);

  let prefix = 0;
  while (prefix < max && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) ===
      newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix++;
  }

  // Never split a surrogate pair — doing so would write lone surrogates into
  // the document and corrupt any astral-plane characters in block field text.
  if (prefix > 0 && isHighSurrogate(oldText.charCodeAt(prefix - 1))) {
    prefix--;
  }
  if (suffix > 0 && isLowSurrogate(oldText.charCodeAt(oldText.length - suffix))) {
    suffix--;
  }

  return {
    start: prefix,
    end: oldText.length - suffix,
    replacement: newText.slice(prefix, newText.length - suffix),
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
