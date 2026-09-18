/**
 * LineFramer - bytes in, complete lines out. No I/O, no transport knowledge.
 *
 * Every transport this panel supports fragments differently:
 *
 *   USB CDC serial   chunks follow USB packet boundaries (up to 64 bytes)
 *   Bluetooth SPP    chunks follow RFCOMM framing, timing-dependent
 *   BLE notify       chunks are hard-capped at ATT MTU - 3 (often 20 bytes)
 *
 * BLE is the worst case and the one that makes this class non-negotiable: a
 * 20-byte cap means "BATTERY:87\nSPEED:20,-20\n" is *always* delivered split.
 * Framing therefore lives here, once, rather than in each transport.
 *
 * This is the exact mirror of proto::LineAssembler in robot/src/vex_protocol.cpp.
 */

const DEFAULT_MAX_LINE = 512;

export class LineFramer {
  constructor({ maxLineLength = DEFAULT_MAX_LINE } = {}) {
    this.maxLineLength = maxLineLength;
    // One long-lived decoder: a per-chunk TextDecoder emits U+FFFD when a
    // multi-byte character straddles a chunk boundary.
    this._decoder = new TextDecoder('utf-8');
    this._buffer = '';
    this._dropped = 0;
  }

  /** Lines lost to overflow. Non-zero means the peer is out of sync. */
  get dropped() { return this._dropped; }

  /** Bytes currently held as an unterminated tail. */
  get pending() { return this._buffer.length; }

  /**
   * Feeds a chunk (Uint8Array or string) and returns any complete lines.
   * The unterminated tail is kept for the next call.
   */
  push(chunk) {
    this._buffer += typeof chunk === 'string'
      ? chunk
      : this._decoder.decode(chunk, { stream: true });

    const lines = [];
    let start = 0;
    while (true) {
      const nl = this._buffer.indexOf('\n', start);
      if (nl === -1) break;
      const line = this._buffer.slice(start, nl).replace(/\r$/, '').trim();
      start = nl + 1;
      if (line) lines.push(line);
    }
    this._buffer = this._buffer.slice(start);

    // Backstop against a peer that never sends a newline. Drop the whole
    // partial line rather than emitting a truncated prefix that might parse.
    if (this._buffer.length > this.maxLineLength) {
      this._dropped++;
      this._buffer = '';
    }
    return lines;
  }

  /**
   * Called when the stream ends. Returns a trailing line that had no newline,
   * rather than silently losing it.
   */
  flush() {
    try { this._buffer += this._decoder.decode(); } catch { /* nothing pending */ }
    const line = this._buffer.replace(/\r$/, '').trim();
    this._buffer = '';
    return line ? [line] : [];
  }

  reset() {
    this._buffer = '';
    this._decoder = new TextDecoder('utf-8');
  }
}

// ---------------------------------------------------------------------------
// Wire format helpers - mirror of proto::parseCommand / proto::formatCommand.
// ---------------------------------------------------------------------------

/** "BATTERY:87" -> {verb: 'BATTERY', args: ['87'], raw}. Null if unparseable. */
export function parseMessage(line) {
  let body = String(line).trim();
  if (!body) return null;

  const checked = /^(.*)\*([0-9a-fA-F]{2})$/.exec(body);
  if (checked) {
    const [, payload, hex] = checked;
    if (xorChecksum(payload) !== parseInt(hex, 16)) return null;
    body = payload.trim();
    if (!body) return null;
  }

  const colon = body.indexOf(':');
  const verb = (colon === -1 ? body : body.slice(0, colon)).trim().toUpperCase();
  if (!verb) return null;

  const args = colon === -1
    ? []
    : body.slice(colon + 1).split(',').map((a) => a.trim());

  return { verb, args, raw: line };
}

/** Inverse of parseMessage. Throws on arguments that would reframe the line. */
export function formatCommand(verb, args = []) {
  const name = String(verb).trim().toUpperCase();
  if (!name) throw new Error('Command verb is required');

  const parts = args.map((a) => {
    const s = String(a).trim();
    if (/[,:\r\n]/.test(s)) throw new Error(`Argument "${s}" contains a delimiter`);
    return s;
  });

  return parts.length ? `${name}:${parts.join(',')}\n` : `${name}\n`;
}

export function xorChecksum(text) {
  let x = 0;
  for (let i = 0; i < text.length; i++) x ^= text.charCodeAt(i) & 0xff;
  return x;
}
