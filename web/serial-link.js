/**
 * SerialLink - transport-agnostic link to the VEX IQ brain.
 *
 * Framing lives in LineFramer, I/O lives in a Transport, and this class owns
 * the parts that are the same regardless of how bytes travel: the read loop,
 * the write queue, the keep-alive, reconnection and events.
 *
 * That split is what makes the Chromebook story tractable -- USB serial,
 * Bluetooth RFCOMM and BLE GATT fragment differently and fail differently, but
 * none of that reaches the UI.
 *
 *   import { SerialLink } from './serial-link.js';
 *   import { SerialTransport, BleTransport } from './transports.js';
 *
 *   const link = new SerialLink({ transport: new SerialTransport() });
 *   link.on('message', ({ verb, args }) => ...);
 *   await link.connect();              // inside a click handler
 *   await link.send('DRIVE', [50]);
 */

import { LineFramer, parseMessage, formatCommand, xorChecksum } from './line-framer.js';
import { SerialTransport, BleTransport, NORDIC_UART, describeEnvironment } from './transports.js';

export { LineFramer, parseMessage, formatCommand, xorChecksum };
export { SerialTransport, BleTransport, NORDIC_UART, describeEnvironment };

const DEFAULTS = {
  maxLineLength: 512,
  autoReconnect: true,
  reconnectDelayMs: 1000,
  // Re-assert the current setpoint this often so the firmware watchdog stays
  // fed while the robot is meant to be moving.
  keepAliveMs: 200,
};

export class SerialLink {
  constructor({ transport = null, ...options } = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.transport = transport || new SerialTransport();

    this.framer = new LineFramer({ maxLineLength: this.options.maxLineLength });

    this._status = 'disconnected';
    this._listeners = new Map();
    this._writeChain = Promise.resolve();
    this._keepAliveTimer = null;
    this._closing = false;
    this._lastSent = null;
    this._lastDropped = 0;
    this._encoder = new TextEncoder();
  }

  // --- events --------------------------------------------------------------
  // 'line' (raw text), 'message' ({verb, args, raw}), 'status', 'error', 'sent'

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
  get droppedLines() { return this.framer.dropped; }

  _setStatus(status, detail) {
    if (this._status === status) return;
    this._status = status;
    this._emit('status', { status, detail, transport: this.transport.describe?.() });
  }

  /** Swap transports while disconnected (the UI's USB / Bluetooth / BLE picker). */
  setTransport(transport) {
    if (this.connected) throw new Error('Disconnect before changing transport');
    this.transport = transport;
  }

  // --- connection ----------------------------------------------------------

  static get supported() {
    return SerialTransport.supported || BleTransport.supported;
  }

  /** Opens the link. Must be called from a user gesture (click). */
  async connect(existing = null) {
    if (this.connected || this._status === 'connecting') return;

    this._closing = false;
    this._setStatus('connecting');

    try {
      await this.transport.open(existing);
    } catch (err) {
      this._setStatus('disconnected', err.message);
      throw err;
    }

    this.framer.reset();
    this.transport.ondisconnect = () => {
      this._emit('error', new Error('Device disconnected'));
    };

    this._setStatus('connected');
    this._startKeepAlive();

    // Deliberately not awaited: the loop runs for the life of the connection.
    this._readLoop().catch((err) => this._emit('error', err));
  }

  async disconnect() {
    this._closing = true;
    this._stopKeepAlive();

    // Best effort: stop the robot before the link goes away. The firmware
    // watchdog covers the case where this never lands.
    if (this.connected) {
      try { await this.send('STOP'); } catch { /* link already gone */ }
    }

    try { await this.transport.close(); } catch (err) { this._emit('error', err); }

    this._flushFramer();
    this._setStatus('disconnected');
  }

  // --- read loop -----------------------------------------------------------

  async _readLoop() {
    try {
      for await (const chunk of this.transport.read()) {
        for (const line of this.framer.push(chunk)) this._handleLine(line);
        // The framer drops an oversized line silently; surface it here.
        this._checkDropped();
      }
    } catch (err) {
      if (!this._closing) this._emit('error', err);
    }

    this._flushFramer();

    if (!this._closing && this.options.autoReconnect) {
      this._setStatus('reconnecting');
      await this._attemptReconnect();
    }
  }

  _checkDropped() {
    const n = this.framer.dropped;
    if (n !== this._lastDropped) {
      this._lastDropped = n;
      this._emit('error', new Error('Oversized line dropped; resynchronising'));
    }
  }

  _flushFramer() {
    for (const line of this.framer.flush()) this._handleLine(line);
  }

  _handleLine(line) {
    this._emit('line', line);
    const message = parseMessage(line);
    if (message) this._emit('message', message);
  }

  // --- writing -------------------------------------------------------------

  /**
   * Sends "VERB:a,b\n". Calls are queued, so concurrent callers can never
   * interleave bytes inside a line -- which matters most on BLE, where a
   * single line is already split across several GATT writes.
   */
  send(verb, args = []) {
    const text = formatCommand(verb, args);
    this._lastSent = { verb, args };

    const task = this._writeChain.then(async () => {
      if (!this.connected) throw new Error('Not connected');
      await this.transport.write(this._encoder.encode(text));
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
      // Commands are idempotent setpoints, which is what makes re-sending safe.
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
    try { await this.transport.close(); } catch { /* already down */ }

    // Reopening a previously-permitted Web Serial port needs no user gesture.
    // Web Bluetooth generally does, so BLE reconnection stays manual.
    if (this.transport instanceof SerialTransport) {
      try {
        const [known] = await SerialTransport.knownPorts();
        if (known) {
          await sleep(this.options.reconnectDelayMs);
          await this.connect(known);
          return;
        }
      } catch (err) {
        this._emit('error', err);
      }
    }
    this._setStatus('disconnected', 'reconnect requires a click');
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
