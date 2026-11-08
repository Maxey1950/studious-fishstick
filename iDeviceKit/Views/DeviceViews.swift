import SwiftUI

struct DeviceInfoView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        List {
            if let d = model.primaryDevice {
                SwiftUI.Section("From usbmuxd (available now)") {
                    KeyValueRow(key: "Serial / UDID", value: d.udid)
                    KeyValueRow(key: "Connection", value: d.connectionType)
                    KeyValueRow(key: "Product ID", value: d.productID.map(String.init) ?? "n/a")
                    KeyValueRow(key: "Mux device ID", value: String(d.deviceID))
                }
            } else {
                SwiftUI.Section { Text("No device. Configure a usbmuxd endpoint under USBMux.").foregroundStyle(.secondary) }
            }
            SwiftUI.Section("Requires a lockdown session") {
                ForEach(["Device name", "Product type", "iOS version", "Build version", "Hardware model", "Battery"], id: \.self) {
                    KeyValueRow(key: $0, value: "Not available")
                }
                NotImplementedNote(text: "Needs libimobiledevice lockdownd over a validated pairing record (Milestones 4–6).")
            }
        }
        .navyList().navigationTitle("Device Information")
    }
}

struct DiagnosticsView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        List {
            SwiftUI.Section("Connection checks") {
                check("Endpoint configured", ok: model.settings.mode == .local || !model.settings.host.isEmpty)
                check("usbmuxd reachable", ok: { if case .connected = model.connection { return true }; return false }())
                check("Device listed", ok: model.primaryDevice != nil)
                check("Pairing record stored", ok: model.primaryDevice.map { model.pairingStatus(for: $0.udid) } ?? false)
            }
            SwiftUI.Section {
                if case .failed(let m) = model.connection { Text(m).font(.footnote) }
                Button("Re-run checks") { Task { await model.refresh() } }
            }
            SwiftUI.Section("Not yet implemented") {
                NotImplementedNote(text: "Device diagnostics (diagnostics_relay) and crash report retrieval (crashreportcopymobile) need libimobiledevice — Milestone 6.")
            }
        }
        .navyList().navigationTitle("Diagnostics")
    }
    private func check(_ t: String, ok: Bool) -> some View {
        Label(t, systemImage: ok ? "checkmark.circle.fill" : "xmark.circle")
            .foregroundStyle(ok ? Color.green : Color.secondary)
    }
}

struct USBMuxView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        List {
            SwiftUI.Section("Endpoint") {
                Picker("Mode", selection: $model.settings.mode) {
                    Text("Remote (TCP)").tag(USBMuxSettings.Mode.remote)
                    Text("Local socket").tag(USBMuxSettings.Mode.local)
                }.pickerStyle(.segmented)
                if model.settings.mode == .remote {
                    TextField("Host (e.g. 192.168.1.20)", text: $model.settings.host)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    Stepper("Port: \(model.settings.port)", value: $model.settings.port, in: 1...65535)
                } else {
                    TextField("Socket path", text: $model.settings.localPath)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Probe socket") { model.probeLocal() }
                    if let r = model.localProbe { Text(describe(r)).font(.footnote) }
                }
                Button("Connect / refresh") { Task { await model.refresh() } }
            }
            SwiftUI.Section("Remote usbmuxd") {
                Text("On the computer with the iPhone attached: socat TCP-LISTEN:27015,fork,reuseaddr UNIX-CONNECT:/var/run/usbmuxd\nThe connection is unauthenticated and unencrypted — use a trusted LAN or VPN only.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            SwiftUI.Section("Self-connect probe") {
                Text("Tests whether this phone's own lockdownd (TCP 62078) is reachable from this app, with no VPN. Turn on Wi-Fi sync for this phone from a computer first, and connect to Wi-Fi.")
                    .font(.footnote).foregroundStyle(.secondary)
                Button(model.selfProbeRunning ? "Probing…" : "Run probe") { Task { await model.runSelfProbe() } }
                    .disabled(model.selfProbeRunning)
                ForEach(model.selfProbe) { r in
                    VStack(alignment: .leading, spacing: 2) {
                        Label(r.target, systemImage: r.lockdownType != nil ? "checkmark.circle.fill" : (r.tcpConnected ? "exclamationmark.circle" : "xmark.circle"))
                            .foregroundStyle(r.lockdownType != nil ? Color.green : (r.tcpConnected ? Color.orange : Color.secondary))
                        Text(r.detail + (r.lockdownType.map { " (\($0))" } ?? "")).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            SwiftUI.Section("Local socket on iOS") {
                Text("iOS does not ship a usbmuxd UNIX socket reachable from third-party apps; expect ENOENT or EPERM on a device. See docs/IOS_SANDBOX_FINDINGS.md.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navyList().navigationTitle("USBMux")
    }
    private func describe(_ r: LocalProbeResult) -> String {
        switch r {
        case .reachable: return "Reachable"
        case .missing(let m): return "Not found: \(m)"
        case .denied(let m): return "Denied: \(m)"
        case .other(let m): return m
        }
    }
}

struct JITView: View {
    @State private var traced = DebuggerStatus.isBeingTraced()
    var body: some View {
        List {
            SwiftUI.Section("Status (this app)") {
                KeyValueRow(key: "Debugger attached", value: traced ? "Yes" : "No")
                Button("Re-check") { traced = DebuggerStatus.isBeingTraced() }
            }
            SwiftUI.Section("What this means") {
                Text("JIT on iOS requires a debugger attached to the target process (or the dynamic-codesigning entitlement, unavailable to normal signing). Launching or running a process is a separate thing and does not imply JIT. This screen only reports attachment of a debugger to iDeviceKit itself.")
                    .font(.footnote).foregroundStyle(.secondary)
                NotImplementedNote(text: "Target app discovery and remote debugserver diagnostics are not implemented (Milestone 7 investigation).")
            }
        }
        .navyList().navigationTitle("JIT Tools")
    }
}
