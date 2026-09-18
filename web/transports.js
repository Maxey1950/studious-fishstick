/**
 * Transports for the VEX IQ control panel.
 *
 * Chromebook reality check
 * -----------------------
 * A "Bluetooth virtual COM port" is a Windows concept. ChromeOS has no
 * user-visible COM port mapping, so on a Chromebook there are three distinct
 * paths, not one:
 *
 *   1. USB-C + Web Serial       always works on ChromeOS; the brain enumerates
 *                               as a USB CDC device. This is the reliable path
 *                               and the panel's default.
 *   2. Bluetooth SPP/RFCOMM     Web Serial gained RFCOMM support in Chrome 117,
 *      + Web Serial             and ChromeOS was the first platform to ship it.
 *                               Requires the brain to be *already paired* in
 *                               ChromeOS Bluetooth settings, and requires the
 *                               brain to speak Bluetooth Classic. If it is a
 *                               BLE-only device, no amount of pairing will make
 *                               a serial port appear -- use path 3.
 *   3. Web Bluetooth (BLE GATT) for a BLE-only brain. Not a serial port at all:
 *                               a write characteristic and a notify
 *                               characteristic, with a ~20-byte payload cap
 *                               that guarantees fragmentation.
 *
 * All three expose the same tiny interface, so SerialLink does not care which
 * one it is driving:
 *
 *   supported (static)   feature detection
 *   open(existing?)      connect; must be called from a user gesture
 *   close()              disconnect
 *   write(Uint8Array)    send bytes (chunked internally where required)
 *   read()               async iterator of Uint8Array chunks
 *   describe()           human-readable identity for the UI
 */

// ---------------------------------------------------------------------------
// Web Serial: USB CDC, and Bluetooth RFCOMM/SPP on Chrome 117+.
// ---------------------------------------------------------------------------

export class SerialTransport {
  /**
   * @param {object} options
   * @param {number} options.baudRate       ignored by Bluetooth RFCOMM ports
   * @param {string[]} options.allowedBluetoothServiceClassIds
   *        Needed only when the brain exposes a *custom* RFCOMM service rather
   *        than standard SPP. Without it such a port is not even offered in the
   *        chooser. Standard SPP devices need nothing here.
   * @param {object[]} options.filters      optional requestPort() filters
   */
  constructor({
    baudRate = 115200,
    allowedBluetoothServiceClassIds = [],
    filters = null,
  } = {}) {
    this.baudRate = baudRate;
    this.allowedBluetoothServiceClassIds = allowedBluetoothServiceClassIds;
    this.filters = filters;

    this.port = null;
    this.writer = null;
    this._reader = null;
    this._closing = false;
    this.ondisconnect = null;
  }

  static get supported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  static get name() { return 'serial'; }

  /** Previously-permitted ports; no user gesture required. */
  static async knownPorts() {
    if (!SerialTransport.supported) return [];
    try { return await navigator.serial.getPorts(); } catch { return []; }
  }

  async open(existingPort = null) {
    if (!SerialTransport.supported) {
      throw new Error('Web Serial is unavailable. Use Chrome or Edge over HTTPS or localhost.');
    }
    this._closing = false;

    if (existingPort) {
      this.port = existingPort;
    } else {
      const request = {};
      if (this.filters) request.filters = this.filters;
      // Passing an empty array to Chrome versions that predate RFCOMM support
      // throws, so only include the key when it is actually populated.
      if (this.allowedBluetoothServiceClassIds.length) {
        request.allowedBluetoothServiceClassIds = this.allowedBluetoothServiceClassIds;
      }
      this.port = await navigator.serial.requestPort(request);
    }

    // A Bluetooth RFCOMM port ignores baudRate, but passing it is harmless and
    // keeps one code path for both.
    await this.port.open({ baudRate: this.baudRate });

    this._onDisconnect = () => { if (this.ondisconnect) this.ondisconnect(); };
    this.port.addEventListener('disconnect', this._onDisconnect);

    this.writer = this.port.writable.getWriter();
  }

  /** True when this port is a Bluetooth RFCOMM port rather than USB. */
  get isBluetooth() {
    try { return Boolean(this.port?.getInfo().bluetoothServiceClassId); }
    catch { return false; }
  }

  describe() {
    if (!this.port) return 'no port';
    let info = {};
    try { info = this.port.getInfo(); } catch { /* not all builds implement it */ }
    if (info.bluetoothServiceClassId) return 'Bluetooth serial (RFCOMM)';
    if (info.usbVendorId !== undefined) {
      const hex = (n) => n.toString(16).padStart(4, '0');
      return `USB serial ${hex(info.usbVendorId)}:${hex(info.usbProductId ?? 0)}`;
    }
    return 'serial port';
  }

  async write(bytes) {
    if (!this.writer) throw new Error('Not connected');
    await this.writer.write(bytes);
  }

  /** Yields chunks until the port closes or the reader is cancelled. */
  async *read() {
    while (this.port && !this._closing) {
      // readable is null while the device is detached; wait rather than throw.
      if (!this.port.readable) {
        await sleep(200);
        continue;
      }
      this._reader = this.port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await this._reader.read();
          if (done) break;
          if (value && value.length) yield value;
        }
      } finally {
        try { this._reader.releaseLock(); } catch { /* already released */ }
        this._reader = null;
      }
      if (this._closing) break;
      await sleep(200);
    }
  }

  async close() {
    this._closing = true;
    // Cancelling is what makes a pending read() settle so the iterator can
    // finish and release its lock; without it port.close() hangs.
    if (this._reader) { try { await this._reader.cancel(); } catch { /* errored */ } }
    if (this.writer) {
      try { await this.writer.close(); } catch { /* errored */ }
      this.writer = null;
    }
    if (this.port) {
      try { this.port.removeEventListener('disconnect', this._onDisconnect); } catch { /* n/a */ }
      try { await this.port.close(); } catch { /* already gone */ }
      this.port = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Web Bluetooth GATT, for a BLE-only brain.
// ---------------------------------------------------------------------------

/**
 * Default UUIDs are the Nordic UART Service, the de-facto convention for
 * "serial over BLE". THESE ARE ALMOST CERTAINLY NOT YOUR BRAIN'S UUIDs --
 * see README "Finding the BLE UUIDs" for how to discover the real ones with
 * chrome://bluetooth-internals, then pass them to the constructor.
 */
export const NORDIC_UART = {
  service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  write:   '6e400002-b5a3-f393-e0a9-e50e24dcca9e',  // phone -> device
  notify:  '6e400003-b5a3-f393-e0a9-e50e24dcca9e',  // device -> phone
};

export class BleTransport {
  constructor({
    service = NORDIC_UART.service,
    writeCharacteristic = NORDIC_UART.write,
    notifyCharacteristic = NORDIC_UART.notify,
    namePrefix = null,
    // ATT_MTU defaults to 23 bytes, of which 3 are protocol overhead. Writing
    // more than this in one call fails on many stacks, so outgoing data is
    // chunked. 20 is the safe floor; raise it if your device negotiates higher.
    maxChunk = 20,
  } = {}) {
    this.serviceUuid = service;
    this.writeUuid = writeCharacteristic;
    this.notifyUuid = notifyCharacteristic;
    this.namePrefix = namePrefix;
    this.maxChunk = maxChunk;

    this.device = null;
    this.server = null;
    this._writeChar = null;
    this._notifyChar = null;
    this._queue = [];          // chunks received but not yet yielded
    this._wake = null;         // resolver parked in read()
    this._closing = false;
    this.ondisconnect = null;
  }

  static get supported() {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  static get name() { return 'ble'; }

  async open(existingDevice = null) {
    if (!BleTransport.supported) {
      throw new Error('Web Bluetooth is unavailable in this browser.');
    }
    this._closing = false;

    this.device = existingDevice || await navigator.bluetooth.requestDevice({
      filters: this.namePrefix
        ? [{ namePrefix: this.namePrefix }]
        : [{ services: [this.serviceUuid] }],
      optionalServices: [this.serviceUuid],
    });

    this._onGattDisconnect = () => {
      this._flushWaiter();
      if (this.ondisconnect) this.ondisconnect();
    };
    this.device.addEventListener('gattserverdisconnected', this._onGattDisconnect);

    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(this.serviceUuid);
    this._writeChar = await service.getCharacteristic(this.writeUuid);
    this._notifyChar = await service.getCharacteristic(this.notifyUuid);

    this._onValue = (event) => {
      // event.target.value is a DataView over a buffer the stack may reuse,
      // so copy it before queueing.
      const dv = event.target.value;
      this._queue.push(new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength)));
      this._flushWaiter();
    };
    this._notifyChar.addEventListener('characteristicvaluechanged', this._onValue);
    await this._notifyChar.startNotifications();
  }

  describe() {
    return this.device ? `BLE ${this.device.name || this.device.id}` : 'no device';
  }

  /** Splits writes at the MTU cap; the framer on the far side reassembles. */
  async write(bytes) {
    if (!this._writeChar) throw new Error('Not connected');
    for (let i = 0; i < bytes.length; i += this.maxChunk) {
      const slice = bytes.slice(i, i + this.maxChunk);
      // writeValueWithoutResponse is much faster, but is not universally
      // implemented; fall back rather than fail the send.
      if (this._writeChar.writeValueWithoutResponse) {
        await this._writeChar.writeValueWithoutResponse(slice);
      } else {
        await this._writeChar.writeValue(slice);
      }
    }
  }

  async *read() {
    while (!this._closing) {
      if (this._queue.length) {
        yield this._queue.shift();
        continue;
      }
      if (!this.device?.gatt?.connected) break;
      await new Promise((resolve) => { this._wake = resolve; });
    }
    // Drain anything that landed as the link went down.
    while (this._queue.length) yield this._queue.shift();
  }

  _flushWaiter() {
    if (this._wake) {
      const resolve = this._wake;
      this._wake = null;
      resolve();
    }
  }

  async close() {
    this._closing = true;
    this._flushWaiter();

    if (this._notifyChar) {
      this._notifyChar.removeEventListener('characteristicvaluechanged', this._onValue);
      try { await this._notifyChar.stopNotifications(); } catch { /* already down */ }
      this._notifyChar = null;
    }
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnect);
      try { this.device.gatt.disconnect(); } catch { /* already down */ }
      this.device = null;
    }
    this._writeChar = null;
    this.server = null;
  }
}

// ---------------------------------------------------------------------------
// Environment probe - drives the UI's "what can this machine actually do" note.
// ---------------------------------------------------------------------------

export function describeEnvironment() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isChromeOS = /\bCrOS\b/.test(ua);
  const secure = typeof window !== 'undefined' ? window.isSecureContext : true;

  const notes = [];
  if (!secure) {
    notes.push('This page is not in a secure context. Serve it over HTTPS or from localhost.');
  }
  if (isChromeOS) {
    notes.push('ChromeOS: USB-C is the reliable path. Bluetooth serial needs the brain paired in Settings first, and only works if the brain speaks Bluetooth Classic.');
  }
  if (!SerialTransport.supported) {
    notes.push('Web Serial unavailable - Chrome/Edge only.');
  }
  if (!BleTransport.supported) {
    notes.push('Web Bluetooth unavailable - the BLE fallback will not work here.');
  }

  return {
    isChromeOS,
    secureContext: secure,
    webSerial: SerialTransport.supported,
    webBluetooth: BleTransport.supported,
    notes,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
