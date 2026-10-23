/**
 * Comparing two `.blocks` documents by meaning rather than by spelling.
 *
 * The same blocks get written differently by different writers: MakeCode saves
 * one way, Blockly serializes another, attribute order and whitespace drift.
 * Treating those as a change is what makes a round trip look like an edit —
 * the file is rewritten, the rewrite comes back as someone's change, and the
 * editor is reloaded to apply a change that nobody made.
 */

/** True if both documents describe the same blocks. */
export function sameBlocks(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const left = canonicalXml(a);
  const right = canonicalXml(b);
  // Unparseable input is not silently called equal; that would drop a real edit.
  return left !== undefined && left === right;
}

/**
 * A comparable form of a whole document.
 *
 * Returns undefined for anything that will not parse, so an unreadable document
 * is never mistaken for a match.
 */
export function canonicalXml(xml: string): string | undefined {
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      return undefined;
    }
    return canonicalElement(doc.documentElement);
  } catch {
    return undefined;
  }
}

/**
 * Canonicalizes one element and its descendants.
 *
 * Attributes are sorted, whitespace-only text is dropped, and coordinates are
 * rounded — a block nudged by a fraction of a pixel during a render is not an
 * edit anybody made.
 */
function canonicalElement(element: Element): string {
  const attributes = Array.from(element.attributes)
    .map((attribute) => {
      const value =
        attribute.name === 'x' || attribute.name === 'y'
          ? String(Math.round(Number(attribute.value) || 0))
          : attribute.value;
      return `${attribute.name}=${value}`;
    })
    .sort()
    .join(' ');

  const children = Array.from(element.childNodes)
    .map((node) => {
      if (node.nodeType === 1) {
        return canonicalElement(node as Element);
      }
      if (node.nodeType === 3) {
        // Image literals are whitespace-significant inside, but their leading
        // and trailing newlines are not, so trim the ends and keep the middle.
        const text = (node.textContent ?? '').replace(/^\s+|\s+$/g, '');
        return text ? `#${text}` : '';
      }
      return '';
    })
    .filter(Boolean)
    .join('');

  return `<${element.tagName.toLowerCase()} ${attributes}>${children}`;
}
