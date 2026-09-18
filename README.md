# VEX IQ (2nd gen) Browser Control Panel

A browser control panel for a VEX IQ 2 brain, with a matching C++ command
parser for the robot side. Runs on a Chromebook: USB-C over Web Serial by
default, with Bluetooth SPP and BLE as selectable fallbacks.

```
web/index.html         control panel UI, with a USB / Bluetooth / BLE picker
web/line-framer.js     framing: bytes in, complete lines out (no I/O)
web/transports.js      SerialTransport (USB + Bluetooth RFCOMM), BleTransport
web/serial-link.js     transport-agnostic link: read loop, write queue, keep-alive
web/serial-link.test.mjs   26 tests over the framer, link and transports

robot/include/vex_protocol.h   framing + parsing API
robot/src/vex_protocol.cpp     implementation (no dynamic allocation)
robot/src/main.cpp             VEX IQ app: reader task, control task, watchdog
robot/test/                    host-side tests (plain g++, no VEX SDK needed)
```

Run the tests:

```
make -C robot/test run          # 98 checks
node web/serial-link.test.mjs   # 26 tests
```

The page needs a secure context. On a laptop, `python3 -m http.server -d web 8000`
and open `http://localhost:8000`. On a Chromebook, see below.

---

## Running on a Chromebook

Worth stating plainly: **a "Bluetooth virtual COM port" is a Windows concept.**
ChromeOS has no user-visible COM port mapping, so the single assumption the
original design rested on does not hold there. There are three separate paths
instead, and the panel lets you pick between them at connect time.

### 1. USB-C cable — the path that always works

ChromeOS has supported Web Serial since Chrome 89, and the brain enumerates as
an ordinary USB CDC device. This is what web-based VEXcode IQ itself uses on a
Chromebook, it needs no pairing, and it is the panel's default. **If the goal is
"working on a Chromebook today", stop here.**

### 2. Bluetooth SPP / RFCOMM through Web Serial

Chrome 117 added RFCOMM support to Web Serial, and ChromeOS was the first
platform to ship it — so this genuinely can work, with two conditions:

- the brain must be **paired in ChromeOS Settings first**; Web Serial only
  offers already-paired Bluetooth devices;
- the brain must speak **Bluetooth Classic**. If it is BLE-only, no amount of
  pairing will make a serial port appear, and you want path 3.

If the brain exposes a *custom* RFCOMM service rather than standard SPP, its
port is not offered in the chooser at all until you list its service class ID:

```js
new SerialTransport({ allowedBluetoothServiceClassIds: ['<uuid>'] })
```

`CUSTOM_RFCOMM_SERVICE_IDS` at the top of `index.html` is where to put it.

### 3. Web Bluetooth (BLE GATT)

VEX documents the IQ 2nd gen brain as having a Bluetooth 5.0 radio used for
wireless connections to tablets, but does not publish whether that is Classic
or BLE — and BLE is the likelier answer given how VEXcode connects from iPads.
BLE is not a serial port: it is a write characteristic plus a notify
characteristic, so `BleTransport` adapts it to the same byte-stream interface.

**Finding the BLE UUIDs.** The defaults are the Nordic UART Service, the
de-facto convention for serial-over-BLE, and are almost certainly not your
brain's. To find the real ones:

1. open `chrome://bluetooth-internals/#devices` on the Chromebook;
2. **Start Scan**, find the brain, click **Inspect**;
3. expand its services and note the service UUID plus the two characteristics —
   the one with `notify` is the robot→browser channel, the one with `write` or
   `write-without-response` is browser→robot;
4. paste all three into the panel's **BLE service UUIDs** box.

If no service looks like a byte pipe, the brain does not expose a general
telemetry channel over BLE and USB is the answer.

### Serving the page

Web Serial and Web Bluetooth both require a secure context, and `file://` does
not qualify. Chromebooks have no convenient localhost without enabling the Linux
container, so `.github/workflows/pages.yml` publishes `web/` to GitHub Pages on
every push to `main` (enable it once under **Settings → Pages → Source: GitHub
Actions**). Open the Pages URL on the Chromebook and connect from there.

### What this changed in the code

The framing logic did not change at all — which is the point of having split it
out. `LineFramer` is pure and transport-independent, transports only move bytes,
and `SerialLink` owns the read loop, write queue and keep-alive regardless of
what is underneath.

BLE did add one hard constraint: the default ATT MTU is 23 bytes, of which 3 are
overhead, so **every** write is chunked at 20 bytes and every notification
arrives capped at 20 bytes. `ARCADE:100,-100\n` does not fit in one packet. That
makes two of the original design decisions load-bearing rather than merely
tidy:

- the framer must reassemble, because on BLE a split line is not an edge case
  produced by unlucky timing — it is guaranteed on every line;
- the write queue must serialise, because two concurrent sends would interleave
  their 20-byte chunks and corrupt both lines.

Both have tests pinned to a 20-byte cap (`framer survives a 20-byte BLE MTU cap`,
`link keeps lines intact under a BLE-sized MTU cap`).

The robot-side C++ needs no changes: `printf` goes to whichever channel the
active connection uses, and `LineAssembler` already tolerates arbitrary
fragmentation.

---

## Architecture review

The shape you described — text lines over a virtual COM port, telemetry
streaming one way, commands the other — is the right one. It is debuggable with
a plain terminal, it survives a firmware change on either side, and it costs
almost nothing on an IQ brain. The problems are in the details, and four of
them will bite in a real match.

**1. `getchar()` in the main loop serialises everything.** `getchar()` blocks
until a byte arrives. If it lives in the same loop as your telemetry and motor
updates, then telemetry stalls whenever the browser is quiet, and command
handling stalls whenever you `sleep` between telemetry sends. In
`robot/src/main.cpp` the blocking read gets its own `vex::task`, and control and
telemetry run on their own fixed-rate loops. The reader only ever parses and
updates a setpoint; motors are written from exactly one place.

**2. A wireless link that drops does not send `STOP`.** Closing the tab,
sleeping the laptop, or walking out of Bluetooth range all leave the last
command in force — the robot keeps driving. Two mechanisms fix this together:

- the firmware watchdog (`kWatchdogMs`, 500 ms): if no command arrives, the
  drive is zeroed and `WATCHDOG\n` is reported;
- the browser keep-alive (`keepAliveMs`, 200 ms): the current setpoint is
  re-sent periodically, so "still driving" is something the browser actively
  asserts rather than something the robot assumes.

This is the single highest-value change here. Commands are idempotent
setpoints, not deltas, which is what makes re-sending safe.

**3. Fragmentation cuts both ways.** You already parse incoming characters into
a buffer on the robot, which is the right instinct — but the same problem exists
in the browser, and it is easier to get wrong there because `reader.read()`
*looks* like it returns a message. It returns whatever bytes arrived. Both sides
here use the same rule: accumulate, split on `\n`, keep the unterminated tail.

**4. Silent corruption is worse than loud failure.** A truncated `DRIVE:5` from
a garbled `DRIVE:50` is a valid command with the wrong value. So: a line that
overruns its buffer is dropped whole and counted (never parsed as a truncated
prefix), an argument that is not a well-formed integer is rejected rather than
becoming `0` via `atoi`, and the drop counter is streamed back as telemetry so
the panel can show that the link is degrading.

### Wire format

```
VERB[:arg[,arg...]][*HH]\n
```

Case-insensitive verb, comma-separated arguments, optional trailing `*HH` XOR
checksum over everything before the `*`. The checksum is verified when present
and not required when absent, so you can still type commands by hand into a
serial terminal while the panel sends checksummed ones.

| Direction | Command | Meaning |
|---|---|---|
| → robot | `DRIVE:<pct>` | both sides, -100..100 |
| → robot | `ARCADE:<l>,<r>` | independent sides |
| → robot | `FORWARD\|BACK\|LEFT\|RIGHT[:pct]` | nudge, pct defaults to 50 |
| → robot | `STOP` | zero the drive |
| → robot | `PING[:id]` | latency probe |
| ← panel | `BATTERY:<pct>` | telemetry, 5 Hz |
| ← panel | `SPEED:<l>,<r>` | applied setpoint |
| ← panel | `DROPPED:<n>` | lines lost to overflow |
| ← panel | `WATCHDOG` | drive stopped on timeout |
| ← panel | `PONG[:id]`, `READY`, `ERR:<code>` | |

### C++ side

`proto::LineAssembler` turns a byte stream into complete lines: fixed-size
buffer, no allocation, accepts LF/CRLF/CR, drops blank lines, and on overflow
discards through to the next terminator so the *next* line parses cleanly
instead of the parser staying out of phase.

`proto::parseCommand` fills a `Command` with an upper-cased verb and up to four
trimmed arguments. Accessors are strict by design:

```cpp
int pct;
if (!cmd.getIntClamped(0, -100, 100, &pct)) { /* refuse; don't guess */ }
```

`getInt` fails on `"5x"` and on `""` rather than returning 0, and
`getIntClamped` saturates out-of-range values instead of rejecting them — a
speed of 900 is a bug worth clamping, not a reason to ignore the command.

`proto::CommandRouter` maps verbs to handlers, so adding a command is one
`on("VERB", handler)` line rather than another branch in an `if`/`else` chain:

```cpp
router.on("DRIVE", onDrive);
router.feed(bytes, n, &assembler, &robotState);   // assemble + parse + dispatch
```

The whole protocol layer is free of VEX headers, so `robot/test` compiles and
runs it on a laptop. The `testChunkingIsIrrelevant` case re-feeds the same
stream at every possible split point and asserts identical output — that is the
property that actually matters for a fragmented link, and it is cheap to assert.

### JavaScript side

`SerialLink` keeps its decode buffer on the instance, not inside the loop, so a
`read()` resolving mid-line loses nothing:

```js
_ingest(chunk) {
  this._buffer += this._decoder.decode(chunk, { stream: true });
  // ... split on '\n', emit complete lines, keep the tail
}
```

Details worth carrying into your own version:

- **`{ stream: true }`** on a single long-lived `TextDecoder`. A fresh
  `TextDecoder` per chunk emits `U+FFFD` when a multi-byte character straddles
  a chunk boundary. There is a test for exactly this.
- **Cancellation is normal, not exceptional.** `reader.cancel()` is what makes a
  pending `read()` settle so the loop can exit and release its lock; without it
  `port.close()` hangs. `port.readable` is `null` while the device is detached,
  which the loop waits out rather than throwing on.
- **Writes are queued** through a promise chain. Two rapid clicks writing
  concurrently can interleave bytes and corrupt a line; the chain makes that
  impossible, and a failed write does not poison later ones.
- **The trailing partial line is flushed** when the stream ends, instead of
  being dropped.
- **Listener exceptions are caught.** One bad `console.log` handler should not
  kill the read loop for everything else.

`autoReconnect` reopens a previously permitted port via
`navigator.serial.getPorts()`, which needs no user gesture — only the first
`requestPort()` does.

### Worth doing next

- **Sequence numbers.** `DRIVE:50` twice is ambiguous between "re-sent
  keep-alive" and "new command"; a `SEQ` argument makes duplicates detectable
  and lets you measure actual loss rather than inferring it.
- **Rate-limit the UI.** A slider that fires on every `input` event can
  outrun the link. Throttle to ~20 Hz, or send on a timer from the latest value.
- **Bound the telemetry.** At 5 Hz with three messages this is fine; if you add
  per-motor data, consider one combined line per tick rather than many, since
  every line pays the framing and Bluetooth packetisation cost.
