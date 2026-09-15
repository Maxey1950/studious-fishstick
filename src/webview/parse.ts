const EMPTY_WORKSPACE = '<xml xmlns="https://developers.google.com/blockly/xml"></xml>';

/**
 * Strictly parses `.blocks` XML, throwing on anything malformed.
 *
 * Deliberately not `Blockly.utils.xml.textToDom`: that falls back to lenient
 * HTML parsing, so a half-typed file does not fail — it silently yields an
 * almost-empty `<xml>` element. Loading that would wipe every block off the
 * canvas, and the next drag would then serialize the empty workspace over the
 * user's file. Since a collaborator editing the file as text produces exactly
 * such transient states, this has to be caught rather than tolerated.
 */
export function parseBlocksXml(xml: string): Element {
  const text = xml.trim() === '' ? EMPTY_WORKSPACE : xml;
  const doc = new DOMParser().parseFromString(text, 'application/xml');

  // Browsers report malformed XML as a <parsererror> node rather than throwing.
  const failure = doc.getElementsByTagName('parsererror')[0];
  if (failure) {
    throw new Error(summarizeParserError(failure.textContent ?? ''));
  }

  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'xml') {
    throw new Error(`expected a root <xml> element, found <${root?.tagName ?? 'nothing'}>`);
  }
  return root;
}

/**
 * Picks the useful sentence out of a browser's <parsererror> text, which wraps
 * one informative clause in boilerplate — and, in Chromium, runs it all
 * together without line breaks.
 */
function summarizeParserError(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const detail =
    /error on line \d+ at column \d+:[^]*?(?=Below is a rendering|$)/i.exec(collapsed)?.[0] ??
    collapsed.replace(/^This page contains the following errors:\s*/i, '');
  const message = detail.trim() || 'malformed XML';
  return message.length > 140 ? `${message.slice(0, 137)}…` : message;
}
