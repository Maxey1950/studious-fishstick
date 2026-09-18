/**
 * Tests for SerialLink, driven through a fake Web Serial port so the actual
 * read loop runs -- not just the pure helpers.
 *
 *   node web/serial-link.test.mjs
 */
import assert from 'node:assert/strict';
import { SerialLink, parseMessage, formatCommand } from './serial-link.js';

// --- fake Web Serial -------------------------------------------------------

class FakePort {
  constructor() {
    this.written = [];
    this._queue = [];          // chunks waiting to be read
    this._pending = null;      // resolver for an in-flight read()
    this._done = false;
    this._listeners = {};

    const port = this;
    this.readable = {
      getReader() {
        return {
          read() {
            if (port._queue.length) {
              return Promise.resolve({ value: port._queue.shift(), done: false });
            }
            if (port._done) return Promise.resolve({ done: true });
            return new Promise((resolve) => { port._pending = resolve; });
          },
          cancel() { port._finish(); return Promise.resolve(); },
          releaseLock() {},
        };
      },
    };
    this.writable = {
      getWriter() {
        return {
          write(bytes) {
            port.written.push(new TextDecoder().decode(bytes));
            return Promise.resolve();
          },
          close() { return Promise.resolve(); },
        };
      },
    };
  }

  /** Simulate bytes arriving from the robot. */
  emit(text) {
    const bytes = new TextEncoder().encode(text);
    if (this._pending) {
      const resolve = this._pending;
      this._pending = null;
      resolve({ value: bytes, done: false });
    } else {
      this._queue.push(bytes);
    }
  }

  /** Simulate raw bytes (for split multi-byte character tests). */
  emitBytes(bytes) {
    if (this._pending) {
      const resolve = this._pending;
      this._pending = null;
      resolve({ value: bytes, done: false });
    } else {
      this._queue.push(bytes);
    }
  }

  _finish() {
    this._done = true;
    if (this._pending) {
      const resolve = this._pending;
      this._pending = null;
      resolve({ done: true });
    }
  }

  open() { return Promise.resolve(); }
  close() { this._finish(); return Promise.resolve(); }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener() {}
}

// Node 22 defines navigator as a getter-only global, so patch it in place.
Object.defineProperty(globalThis, 'navigator', {
  value: { serial: { getPorts: async () => [] } },
  configurable: true,
  writable: true,
});

const tick = (n = 4) => new Promise((resolve) => setTimeout(resolve, n));

/** Connects a link to a fresh fake port with autoReconnect/keep-alive off. */
async function connected(options = {}) {
  const port = new FakePort();
  const link = new SerialLink({ autoReconnect: false, keepAliveMs: 0, ...options });
  const lines = [];
  const messages = [];
  link.on('line', (l) => lines.push(l));
  link.on('message', (m) => messages.push(m));
  await link.connect(port);
  return { port, link, lines, messages };
}

// --- tests -----------------------------------------------------------------

const tests = {
  async 'reassembles a line split across three chunks'() {
    const { port, link, lines } = await connected();
    port.emit('BATT');
    port.emit('ERY:8');
    port.emit('7\n');
    await tick();
    assert.deepEqual(lines, ['BATTERY:87']);
    await link.disconnect();
  },

  async 'splits several lines arriving in one chunk'() {
    const { port, link, lines } = await connected();
    port.emit('BATTERY:87\nSPEED:20,-20\nREADY\n');
    await tick();
    assert.deepEqual(lines, ['BATTERY:87', 'SPEED:20,-20', 'READY']);
    await link.disconnect();
  },

  async 'holds an unterminated tail instead of emitting it'() {
    const { port, link, lines } = await connected();
    port.emit('READY\nBATTERY:8');
    await tick();
    assert.deepEqual(lines, ['READY']);   // the partial line is NOT emitted
    port.emit('7\n');
    await tick();
    assert.deepEqual(lines, ['READY', 'BATTERY:87']);
    await link.disconnect();
  },

  async 'handles CRLF and blank lines'() {
    const { port, link, lines } = await connected();
    port.emit('READY\r\n\r\n\nBATTERY:50\r\n');
    await tick();
    assert.deepEqual(lines, ['READY', 'BATTERY:50']);
    await link.disconnect();
  },

  async 'does not mangle a multi-byte character split across chunks'() {
    const { port, link, lines } = await connected();
    const bytes = new TextEncoder().encode('MSG:°C\n');  // ° is two bytes
    port.emitBytes(bytes.slice(0, 5));                   // splits mid-character
    await tick();
    port.emitBytes(bytes.slice(5));
    await tick();
    assert.deepEqual(lines, ['MSG:°C']);
    await link.disconnect();
  },

  async 'emits parsed messages alongside raw lines'() {
    const { port, link, messages } = await connected();
    port.emit('SPEED:20,-20\n');
    await tick();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].verb, 'SPEED');
    assert.deepEqual(messages[0].args, ['20', '-20']);
    await link.disconnect();
  },

  async 'drops an oversized line and resynchronises'() {
    const { port, link, lines } = await connected({ maxLineLength: 32 });
    const errors = [];
    link.on('error', (e) => errors.push(e));
    port.emit('X'.repeat(64));
    await tick();
    assert.deepEqual(lines, []);
    assert.equal(link.droppedLines, 1);
    port.emit('READY\n');
    await tick();
    assert.deepEqual(lines, ['READY']);   // next line still parses
    assert.equal(errors.length, 1);
    await link.disconnect();
  },

  async 'flushes a trailing line with no newline when the stream ends'() {
    const { port, link, lines } = await connected();
    port.emit('BATTERY:99');
    await tick();
    assert.deepEqual(lines, []);
    await link.disconnect();               // cancels the reader
    await tick();
    assert.deepEqual(lines, ['BATTERY:99']);
  },

  async 'serialises concurrent writes'() {
    const { port, link } = await connected();
    await Promise.all([
      link.send('DRIVE', [50]),
      link.send('ARCADE', [20, -20]),
      link.send('STOP'),
    ]);
    assert.deepEqual(port.written, ['DRIVE:50\n', 'ARCADE:20,-20\n', 'STOP\n']);
    await link.disconnect();
  },

  async 'a failed write does not poison the queue'() {
    const { port, link } = await connected();
    link.writer = { write: () => Promise.reject(new Error('device gone')) };
    await assert.rejects(() => link.send('DRIVE', [50]));
    link.writer = port.writable.getWriter();
    await link.send('STOP');               // the chain still works
    assert.deepEqual(port.written, ['STOP\n']);
    await link.disconnect();
  },

  async 'a listener that throws does not stop the loop'() {
    const { port, link, lines } = await connected();
    link.on('line', () => { throw new Error('bad listener'); });
    port.emit('A\nB\n');
    await tick();
    assert.deepEqual(lines, ['A', 'B']);
    await link.disconnect();
  },

  async 'sends STOP on disconnect'() {
    const { port, link } = await connected();
    await link.disconnect();
    assert.ok(port.written.includes('STOP\n'));
  },

  async 'chunk boundaries never change the result'() {
    const stream = 'READY\nBATTERY:87\nSPEED:20,-20\nDROPPED:1\n';
    for (let split = 1; split < stream.length; split++) {
      const { port, link, lines } = await connected();
      port.emit(stream.slice(0, split));
      port.emit(stream.slice(split));
      await tick();
      assert.deepEqual(lines, ['READY', 'BATTERY:87', 'SPEED:20,-20', 'DROPPED:1'],
        `split at ${split}`);
      await link.disconnect();
    }
  },

  async 'framing helpers round-trip'() {
    const text = formatCommand('drive', [50]);
    assert.equal(text, 'DRIVE:50\n');
    assert.equal(parseMessage(text.trim()).verb, 'DRIVE');
    assert.throws(() => formatCommand('X', ['a,b']));
    assert.throws(() => formatCommand(''));
  },
};

let failures = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}
console.log(`\n${Object.keys(tests).length - failures}/${Object.keys(tests).length} passed`);
process.exit(failures ? 1 : 0);
