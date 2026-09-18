/**
 * Tests for the framer, the link and both transports.
 *
 *   node web/serial-link.test.mjs
 *
 * The link is exercised through fake transports so the real read loop, write
 * queue and framing all run -- not just the pure helpers.
 */
import assert from 'node:assert/strict';
import { LineFramer, parseMessage, formatCommand } from './line-framer.js';
import { SerialLink } from './serial-link.js';
import { SerialTransport, BleTransport, describeEnvironment } from './transports.js';

// Node 22 defines navigator as a getter-only global, so patch it in place.
Object.defineProperty(globalThis, 'navigator', {
  value: { serial: { getPorts: async () => [] }, userAgent: 'test' },
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, 'window', {
  value: { isSecureContext: true },
  configurable: true,
  writable: true,
});

const tick = (n = 4) => new Promise((resolve) => setTimeout(resolve, n));
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

// ---------------------------------------------------------------------------
// A fake transport: a queue of chunks plus a parked reader, matching the
// interface in transports.js.
// ---------------------------------------------------------------------------

class FakeTransport {
  constructor({ maxChunk = 0 } = {}) {
    this.written = [];        // decoded strings, one per write() call
    this.chunks = [];         // raw chunks as handed to the transport
    this.maxChunk = maxChunk; // >0 splits writes, like BLE's MTU cap
    this._queue = [];
    this._wake = null;
    this._closing = false;
    this.ondisconnect = null;
    this.closed = false;
  }

  static get supported() { return true; }

  async open() { this._closing = false; }

  describe() { return 'fake'; }

  async write(bytes) {
    if (this.maxChunk) {
      for (let i = 0; i < bytes.length; i += this.maxChunk) {
        this.chunks.push(bytes.slice(i, i + this.maxChunk));
      }
    } else {
      this.chunks.push(bytes);
    }
    this.written.push(dec(bytes));
  }

  /** Simulate bytes arriving from the robot. */
  emit(textOrBytes) {
    this._queue.push(typeof textOrBytes === 'string' ? enc(textOrBytes) : textOrBytes);
    this._flush();
  }

  _flush() {
    if (this._wake) { const w = this._wake; this._wake = null; w(); }
  }

  async *read() {
    while (!this._closing) {
      if (this._queue.length) { yield this._queue.shift(); continue; }
      await new Promise((resolve) => { this._wake = resolve; });
    }
    while (this._queue.length) yield this._queue.shift();
  }

  async close() { this.closed = true; this._closing = true; this._flush(); }
}

async function connected(options = {}, transportOptions = {}) {
  const transport = new FakeTransport(transportOptions);
  const link = new SerialLink({
    transport, autoReconnect: false, keepAliveMs: 0, ...options,
  });
  const lines = [];
  const messages = [];
  const errors = [];
  link.on('line', (l) => lines.push(l));
  link.on('message', (m) => messages.push(m));
  link.on('error', (e) => errors.push(e));
  await link.connect();
  return { transport, link, lines, messages, errors };
}

// ---------------------------------------------------------------------------

const tests = {
  // --- LineFramer (pure) ---------------------------------------------------

  'framer reassembles a line split across three chunks'() {
    const f = new LineFramer();
    assert.deepEqual(f.push(enc('BATT')), []);
    assert.deepEqual(f.push(enc('ERY:8')), []);
    assert.deepEqual(f.push(enc('7\n')), ['BATTERY:87']);
  },

  'framer splits several lines in one chunk'() {
    const f = new LineFramer();
    assert.deepEqual(f.push(enc('A\nB\nC\n')), ['A', 'B', 'C']);
  },

  'framer holds an unterminated tail'() {
    const f = new LineFramer();
    assert.deepEqual(f.push(enc('READY\nBATTERY:8')), ['READY']);
    assert.equal(f.pending, 9);
    assert.deepEqual(f.push(enc('7\n')), ['BATTERY:87']);
  },

  'framer handles CRLF and blank lines'() {
    const f = new LineFramer();
    assert.deepEqual(f.push(enc('READY\r\n\r\n\nBATTERY:50\r\n')), ['READY', 'BATTERY:50']);
  },

  'framer does not mangle a split multi-byte character'() {
    const f = new LineFramer();
    const bytes = enc('MSG:°C\n');       // ° is two bytes
    assert.deepEqual(f.push(bytes.slice(0, 5)), []);   // splits mid-character
    assert.deepEqual(f.push(bytes.slice(5)), ['MSG:°C']);
  },

  'framer drops an oversized line and resynchronises'() {
    const f = new LineFramer({ maxLineLength: 32 });
    assert.deepEqual(f.push(enc('X'.repeat(64))), []);
    assert.equal(f.dropped, 1);
    assert.deepEqual(f.push(enc('READY\n')), ['READY']);
  },

  'framer flushes a trailing line with no newline'() {
    const f = new LineFramer();
    f.push(enc('BATTERY:99'));
    assert.deepEqual(f.flush(), ['BATTERY:99']);
    assert.deepEqual(f.flush(), []);
  },

  'framer output is independent of chunk boundaries'() {
    const stream = 'READY\nBATTERY:87\nSPEED:20,-20\nDROPPED:1\n';
    const expected = ['READY', 'BATTERY:87', 'SPEED:20,-20', 'DROPPED:1'];
    for (let split = 1; split < stream.length; split++) {
      const f = new LineFramer();
      const got = [
        ...f.push(enc(stream.slice(0, split))),
        ...f.push(enc(stream.slice(split))),
      ];
      assert.deepEqual(got, expected, `split at ${split}`);
    }
  },

  // BLE is the worst case: every chunk is capped, so lines are always split.
  'framer survives a 20-byte BLE MTU cap'() {
    const stream = 'READY\nBATTERY:87\nSPEED:20,-20\nWATCHDOG\nPONG:42\n';
    const f = new LineFramer();
    const bytes = enc(stream);
    const got = [];
    for (let i = 0; i < bytes.length; i += 20) got.push(...f.push(bytes.slice(i, i + 20)));
    assert.deepEqual(got, ['READY', 'BATTERY:87', 'SPEED:20,-20', 'WATCHDOG', 'PONG:42']);
  },

  // --- SerialLink ----------------------------------------------------------

  async 'link emits lines and parsed messages'() {
    const { transport, link, lines, messages } = await connected();
    transport.emit('SPEED:20,-20\n');
    await tick();
    assert.deepEqual(lines, ['SPEED:20,-20']);
    assert.equal(messages[0].verb, 'SPEED');
    assert.deepEqual(messages[0].args, ['20', '-20']);
    await link.disconnect();
  },

  async 'link reassembles across transport chunks'() {
    const { transport, link, lines } = await connected();
    transport.emit('BATT');
    transport.emit('ERY:8');
    transport.emit('7\n');
    await tick();
    assert.deepEqual(lines, ['BATTERY:87']);
    await link.disconnect();
  },

  async 'link reports dropped lines once per drop'() {
    const { transport, link, lines, errors } = await connected({ maxLineLength: 32 });
    transport.emit('X'.repeat(64));
    await tick();
    assert.deepEqual(lines, []);
    assert.equal(link.droppedLines, 1);
    assert.equal(errors.length, 1);
    transport.emit('READY\n');
    await tick();
    assert.deepEqual(lines, ['READY']);
    assert.equal(errors.length, 1);      // not re-reported on every chunk
    await link.disconnect();
  },

  async 'link flushes a trailing line on disconnect'() {
    const { transport, link, lines } = await connected();
    transport.emit('BATTERY:99');
    await tick();
    assert.deepEqual(lines, []);
    await link.disconnect();
    await tick();
    assert.deepEqual(lines, ['BATTERY:99']);
  },

  async 'link serialises concurrent writes'() {
    const { transport, link } = await connected();
    await Promise.all([
      link.send('DRIVE', [50]),
      link.send('ARCADE', [20, -20]),
      link.send('STOP'),
    ]);
    assert.deepEqual(transport.written, ['DRIVE:50\n', 'ARCADE:20,-20\n', 'STOP\n']);
    await link.disconnect();
  },

  // Under a BLE MTU cap an interleaved write would corrupt framing, because a
  // single line spans several GATT writes. The queue is what prevents it.
  async 'link keeps lines intact under a BLE-sized MTU cap'() {
    const { transport, link } = await connected({}, { maxChunk: 8 });
    await Promise.all([
      link.send('ARCADE', [100, -100]),
      link.send('DRIVE', [50]),
      link.send('STOP'),
    ]);
    const reassembled = dec(Buffer.concat(transport.chunks.map(Buffer.from)));
    assert.equal(reassembled, 'ARCADE:100,-100\nDRIVE:50\nSTOP\n');
    assert.ok(transport.chunks.length > 3, 'expected the writes to be split');
    await link.disconnect();
  },

  async 'a failed write does not poison the queue'() {
    const { transport, link } = await connected();
    const realWrite = transport.write.bind(transport);
    transport.write = () => Promise.reject(new Error('device gone'));
    await assert.rejects(() => link.send('DRIVE', [50]));
    transport.write = realWrite;
    await link.send('STOP');
    assert.deepEqual(transport.written, ['STOP\n']);
    await link.disconnect();
  },

  async 'a listener that throws does not stop the loop'() {
    const { transport, link, lines } = await connected();
    link.on('line', () => { throw new Error('bad listener'); });
    transport.emit('A\nB\n');
    await tick();
    assert.deepEqual(lines, ['A', 'B']);
    await link.disconnect();
  },

  async 'link sends STOP and closes the transport on disconnect'() {
    const { transport, link } = await connected();
    await link.disconnect();
    assert.ok(transport.written.includes('STOP\n'));
    assert.ok(transport.closed);
  },

  async 'keep-alive re-asserts the last setpoint'() {
    const { transport, link } = await connected({ keepAliveMs: 10 });
    await link.send('DRIVE', [50]);
    await tick(45);
    const drives = transport.written.filter((w) => w === 'DRIVE:50\n');
    assert.ok(drives.length >= 2, `expected repeats, got ${drives.length}`);
    await link.disconnect();
  },

  async 'transport cannot be swapped while connected'() {
    const { link } = await connected();
    assert.throws(() => link.setTransport(new FakeTransport()));
    await link.disconnect();
    link.setTransport(new FakeTransport());   // fine once down
  },

  // --- helpers and environment --------------------------------------------

  'framing helpers round-trip'() {
    assert.equal(formatCommand('drive', [50]), 'DRIVE:50\n');
    assert.equal(parseMessage('DRIVE:50').verb, 'DRIVE');
    assert.deepEqual(parseMessage(' speed: 20 , -20 ').args, ['20', '-20']);
    assert.equal(parseMessage('READY').verb, 'READY');
    assert.equal(parseMessage(''), null);
    assert.throws(() => formatCommand('X', ['a,b']));
    assert.throws(() => formatCommand(''));
  },

  'checksummed lines are verified'() {
    const body = 'DRIVE:50';
    const sum = [...body].reduce((x, c) => x ^ c.charCodeAt(0), 0)
      .toString(16).toUpperCase().padStart(2, '0');
    assert.equal(parseMessage(`${body}*${sum}`).verb, 'DRIVE');
    assert.equal(parseMessage(`${body}*00`), null);
  },

  'environment probe reports capabilities'() {
    const env = describeEnvironment();
    assert.equal(env.webSerial, true);          // navigator.serial is stubbed
    assert.equal(env.webBluetooth, false);
    assert.equal(env.isChromeOS, false);
    assert.ok(env.notes.some((n) => /Web Bluetooth unavailable/.test(n)));
  },

  'environment probe flags ChromeOS and insecure contexts'() {
    const saved = globalThis.navigator.userAgent;
    Object.defineProperty(globalThis, 'navigator', {
      value: { serial: navigator.serial, userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)' },
      configurable: true, writable: true,
    });
    globalThis.window.isSecureContext = false;
    const env = describeEnvironment();
    assert.equal(env.isChromeOS, true);
    assert.ok(env.notes.some((n) => /secure context/.test(n)));
    assert.ok(env.notes.some((n) => /USB-C is the reliable path/.test(n)));
    globalThis.window.isSecureContext = true;
    Object.defineProperty(globalThis, 'navigator', {
      value: { serial: { getPorts: async () => [] }, userAgent: saved },
      configurable: true, writable: true,
    });
  },

  'transports feature-detect without throwing'() {
    assert.equal(SerialTransport.supported, true);
    assert.equal(BleTransport.supported, false);
    assert.equal(SerialTransport.name, 'serial');
    assert.equal(BleTransport.name, 'ble');
  },

  async 'knownPorts tolerates a missing Web Serial'() {
    assert.deepEqual(await SerialTransport.knownPorts(), []);
  },
};

let failures = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n     ${err.stack?.split('\n').slice(0, 3).join('\n     ')}`);
  }
}
const total = Object.keys(tests).length;
console.log(`\n${total - failures}/${total} passed`);
process.exit(failures ? 1 : 0);
