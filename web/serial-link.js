/**
 * SerialLink - Web Serial transport for the VEX IQ control panel.
 *
 * Solves the two problems a naive read loop has:
 *
 *   1. Fragmentation. `reader.read()` resolves with whatever bytes happened to
 *      arrive. A "BATTERY:87\n" can show up as "BATT", "ERY:8", "7\n" - or two
 *      lines can arrive in one chunk. Decoding is done with a *streaming*
 *      TextDecoder (`{stream: true}`) so a multi-byte character split across
 *      chunks is not mangled, and the leftover tail is carried into the next
 *      read rather than dropped.
 *
 *   2. Lifetime. A cancelled read rejects, the port can vanish when the robot
 *      powers off, and `port.readable` is null while the device is gone. The
 *      loop below treats all of those as ordinary control flow instead of
 *      unhandled rejections, and always releases its lock so the port can be
 *      closed cleanly.
 *
 * Writes are serialised through a promise chain: two rapid clicks cannot
 * interleave their bytes, which would otherwise corrupt the framing.
 *
 * Usage:
 *
 *   const link = new SerialLink({ maxLineLength: 96 });
 *   link.on('line',   line => console.log(line));
 *   link.on('message', ({verb, args}) => ...);
 *   link.on('status', s => ...);
 *   await link.connect();             // must be inside a user gesture
 *   await link.send('DRIVE', [50]);
 */

const DEFAULTS = {
  baudRate: 115200,
  // Anything longer than this without a newline is treated as garbage and
  // dropped, so a corrupt stream cannot grow the buffer without bound.
  maxLineLength: 512,
  // Reopen automatically after an unexpected disconnect.
  autoReconnect: true,
  reconnectDelayMs: 1000,
  // Stop the robot if nothing is sent for this long. Pairs with the firmware
  // watchdog: the browser proves it is alive, the robot stops if it doesn't.
  keepAliveMs: 200,
};

export class SerialLink {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };

    this.port = null;
    this.reader = null;
    this.writer = null;

    this._status = 'disconnected';
    this._listeners = new Map();
    this._writeChain = Promise.resolve();
    this._keepAliveTimer = null;
    this._closing = false;       // true during an intentional disconnect()
    this._lastSent = null;       // resent by the keep-alive

    // Framing state. Deliberately instance-level, not loop-local: it has to
    // survive one read() resolving mid-line.
    this._buffer = '';
    this._decoder = null;
    this._droppedLines = 0;

    this._onPortDisconnect = this._onPortDisconnect.bind(this);
  }

  // --- events --------------------------------------------------------------
  // Events: 'line' (raw text), 'message' ({verb, args, raw}), 'status',
  // 'error', 'sent'.

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
  }

  _emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      // One bad listener must not take down the read loop.
      try { fn(payload); } catch (err) { console.error(`[SerialLink] listener for "${event}" threw`, err); }
    }
  }

  get status() { return this._status; }
  get connected() { return this._status === 'connected'; }
  get droppedLines() { return this._droppedLines; }

  _setStatus(status, detail) {
    if (this._status === status) return;
    this._status = status;
    this._emit('status', { status, detail });
  }

  // --- connection ----------------------------------------------------------

  static get supported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  /**
   * Opens a port. Must be called from a user gesture (click), because
   * requestPort() shows a chooser. Pass an existing port (e.g. from
   * navigator.serial.getPorts()) to skip the chooser on reconnect.
   */
  async connect(existingPort = null) {
    if (!SerialLink.supported) {
      throw new Error('Web Serial is not available. Use Chrome or Edge over HTTPS or localhost.');
    }
    if (this.port) return;

    this._closing = false;
    this._setStatus('connecting');

    try {
      this.port = existingPort || await navigator.serial.requestPort();
      await this.port.open({ baudRate: this.options.baudRate });
    } catch (err) {
      this.port = null;
      this._setStatus('disconnected', err.message);
      throw err;
    }

    this.port.addEventListener('disconnect', this._onPortDisconnect);

    this._buffer = '';
    this._decoder = new TextDecoder('utf-8');
    this.writer = this.port.writable.getWriter();

    this._setStatus('connected');
    this._startKeepAlive();

    // Deliberately not awaited: the loop runs for the life of the connection.
    this._readLoop().catch((err) => this._emit('error', err));
  }

  async disconnect() {
    this._closing = true;
    this._stopKeepAlive();

    // Best effort: tell the robot to stop before the link goes away. The
    // firmware watchdog covers the case where this never lands.
    if (this.connected) {
      try { await this.send('STOP'); } catch { /* link already gone */ }
    }

    // Cancelling the reader makes the pending read() resolve/reject so the
    // loop can exit and release its lock; without this, port.close() hangs.
    if (this.reader) {
      try { await this.reader.cancel(); } catch { /* already errored */ }
    }
    if (this.writer) {
      try { await this.writer.close(); } catch { /* already errored */ }
      this.writer = null;
    }
    if (this.port) {
      this.port.removeEventListener('disconnect', this._onPortDisconnect);
      try { await this.port.close(); } catch { /* already gone */ }
      this.port = null;
    }

    this._flushPartialLine();
    this._setStatus('disconnected');
  }

  _onPortDisconnect() {
    // Physical unplug / robot powered off. The read loop will unwind on its
    // own; just make sure state and UI agree.
    this._emit('error', new Error('Serial device disconnected'));
  }

  // --- read loop -----------------------------------------------------------

  async _readLoop() {
    while (this.port && !this._closing) {
      // readable is null while the device is detached; wait for it to reappear
      // rather than throwing.
      if (!this.port.readable) {
        await sleep(this.options.reconnectDelayMs);
        continue;
      }

      this.reader = this.port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) break;                 // reader cancelled
          if (value && value.length) this._ingest(value);
        }
      } catch (err) {
        // A device error kills the current reader but not necessarily the
        // port; report it and let the outer loop decide whether to retry.
        if (!this._closing) this._emit('error', err);
      } finally {
        try { this.reader.releaseLock(); } catch { /* already released */ }
        this.reader = null;
      }

      if (this._closing) break;
      await sleep(this.options.reconnectDelayMs);
    }

    this._flushPartialLine();

    if (!this._closing && this.options.autoReconnect) {
      this._setStatus('reconnecting');
      await this._attemptReconnect();
    }
  }

  /**
   * The heart of the fix: decode incrementally, split on newlines, keep the
   * unterminated tail for next time.
   */
  _ingest(chunk) {
    // {stream: true} keeps a partial multi-byte sequence inside the decoder
    // instead of emitting U+FFFD.
    this._buffer += this._decoder.decode(chunk, { stream: true });

    let start = 0;
    while (true) {
      const nl = this._buffer.indexOf('\n', start);
      if (nl === -1) break;
      const line = this._buffer.slice(start, nl).replace(/\r$/, '').trim();
      start = nl + 1;
      if (line) this._handleLine(line);
    }
    this._buffer = this._buffer.slice(start);

    // Backstop against a peer that never sends a newline.
    if (this._buffer.length > this.options.maxLineLength) {
      this._droppedLines++;
      this._buffer = '';
      this._emit('error', new Error('Oversized line dropped; resynchronising'));
    }
  }

  // Called when the stream ends: emit a trailing line that had no newline
  // rather than silently losing it.
  _flushPartialLine() {
    if (this._decoder) {
      try { this._buffer += this._decoder.decode(); } catch { /* nothing pending */ }
    }
    const line = this._buffer.replace(/\r$/, '').trim();
    this._buffer = '';
    if (line) this._handleLine(line);
  }

  _handleLine(line) {
    this._emit('line', line);
    const message = parseMessage(line);
    if (message) this._emit('message', message);
  }

  // --- writing -------------------------------------------------------------

  /**
   * Sends "VERB:a,b\n". Calls are queued, so concurrent callers can never
   * interleave bytes inside a line.
   */
  send(verb, args = []) {
    const text = formatCommand(verb, args);
    this._lastSent = { verb, args };

    const task = this._writeChain.then(async () => {
      if (!this.writer) throw new Error('Not connected');
      await this.writer.write(new TextEncoder().encode(text));
      this._emit('sent', text.trim());
    });

    // Keep the chain alive after a failed write; report the failure to the
    // caller only.
    this._writeChain = task.catch(() => {});
    return task;
  }

  // --- keep-alive ----------------------------------------------------------

  _startKeepAlive() {
    if (!this.options.keepAliveMs) return;
    this._stopKeepAlive();
    this._keepAliveTimer = setInterval(() => {
      if (!this.connected || !this._lastSent) return;
      // Re-assert the current setpoint so the firmware watchdog stays fed
      // while the robot is meant to be moving. Idempotent by construction.
      const { verb, args } = this._lastSent;
      this.send(verb, args).catch(() => {});
    }, this.options.keepAliveMs);
  }

  _stopKeepAlive() {
    if (this._keepAliveTimer !== null) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
  }

  // --- reconnect -----------------------------------------------------------

  async _attemptReconnect() {
    const port = this.port;
    this.port = null;
    this.writer = null;

    if (port) {
      port.removeEventListener('disconnect', this._onPortDisconnect);
      try { await port.close(); } catch { /* already closed */ }
    }

    // getPorts() returns already-permitted ports, so this needs no gesture.
    try {
      const [known] = await navigator.serial.getPorts();
      if (known) {
        await sleep(this.options.reconnectDelayMs);
        await this.connect(known);
        return;
      }
    } catch (err) {
      this._emit('error', err);
    }
    this._setStatus('disconnected');
  }
}

// ---------------------------------------------------------------------------
// Framing helpers - the exact mirror of robot/src/vex_protocol.cpp.
// ---------------------------------------------------------------------------

/** "BATTERY:87" -> {verb: 'BATTERY', args: ['87'], raw}. Null if unparseable. */
export function parseMessage(line) {
  let body = line.trim();
  if (!body) return null;

  // Optional "*HH" XOR checksum.
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
