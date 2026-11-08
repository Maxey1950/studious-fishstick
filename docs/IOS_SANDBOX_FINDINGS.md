# iOS sandbox findings (target: iOS 26.2)

**Confidence legend:** ✅ established/architectural · ⚠️ widely reported, *not verified by this project* · ❓ unknown, must be tested on a real device.
Nothing here was tested on an iOS 26.2 device yet (no device or Mac available during authoring). The app's USBMux screen contains real probes so you can produce evidence.

| # | Question | Finding |
|---|----------|---------|
| 1 | Does iOS expose a local usbmuxd endpoint? | ✅ usbmuxd is a *host-side* daemon (macOS/Linux/Windows) that multiplexes TCP over USB to the phone. iOS itself does not run it. There is nothing at `/var/run/usbmuxd` on a device. The in-app probe (USBMux → Local socket) reports ENOENT/EPERM to confirm. (On the iOS *Simulator* the host's socket is visible, so the probe can succeed there.) |
| 2 | Can the app sandbox reach it? | ✅ Moot on-device (no socket). Arbitrary filesystem sockets outside the container are denied by the sandbox. |
| 3 | Supported network transport? | ✅ A *remote* usbmuxd over TCP works: run `socat TCP-LISTEN:27015,fork,reuseaddr UNIX-CONNECT:/var/run/usbmuxd` on a computer with the phone attached. iDeviceKit implements the usbmuxd plist protocol (ListDevices) over this. Needs the Local Network permission (declared in Info.plist). Unauthenticated/unencrypted: LAN/VPN only. ⚠️ Connecting directly to a device's lockdownd (TCP 62078) over Wi‑Fi sync is possible in principle with a pairing record; requires Wi‑Fi sync enabled — ❓ untested. |
| 4 | Pairing records through that transport? | ✅ Pairing records are plain plists (certs + keys) that lockdownd uses to start a TLS session; they are transport-independent. A record generated on a computer can be imported into the app (Keychain). Creating a *new* pairing requires the user to tap "Trust" on the device and needs a usbmux/lockdown channel. ❓ Whether iOS 26.2 still accepts records for the services we need is untested. |
| 5 | Restricted APIs | ✅ No arbitrary process spawning/`fork`/`exec`; no executing downloaded binaries (so CLI tools must be linked as *libraries*, never bundled ELF/Mach-O executables). ✅ Apps cannot read other apps' containers or system logs (`/var/log`, OSLogStore is own-process only). ✅ Raw USB access to the host port is not available to third-party apps. |
| 6 | Entitlements unavailable to ordinary apps | ✅ `com.apple.private.*` entitlements, dynamic-codesigning (JIT), and `get-task-allow` on distribution builds are not obtainable. ⚠️ Network Extension (packet-tunnel/loopback-VPN approaches used by some community tools) is reported as unavailable to free Personal Team profiles — ❓ verify. |

## JIT (separate investigation, Milestone 7)
- ✅ JIT = writable+executable memory. On stock iOS this needs a debugger attached to the target process (or a private entitlement). Running a process is unrelated.
- ✅ iOS 17+ moved developer services behind RemoteXPC/CoreDevice tunnels (RSD). ⚠️ libimobiledevice 1.4.0 targets the classic lockdown/`com.apple.debugserver` path; I do not expect it to cover the iOS 17+/26 tunnel — ❓ to be confirmed by reading its source before any "JIT" feature is promised.
- The JIT Tools screen therefore only reports whether a debugger is attached to **iDeviceKit itself** (`P_TRACED`). It does not enable JIT.

## Consequence for design
The workable architecture is: **iPhone app ⇄ (TCP) ⇄ remote usbmuxd on a computer ⇄ USB ⇄ target phone**, with libimobiledevice linked as static libraries and its socket layer pointed at the TCP endpoint. Self-management of the *same* phone from inside the app is not supported by standard signing and is not attempted.
