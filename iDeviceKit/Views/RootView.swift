import SwiftUI

enum Section: String, CaseIterable, Identifiable {
    case deviceInfo = "Device Information"
    case pairing = "Pairing Manager"
    case syslog = "Syslog"
    case diagnostics = "Diagnostics"
    case usbmux = "USBMux"
    case jit = "JIT Tools"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .deviceInfo: return "iphone"
        case .pairing: return "link"
        case .syslog: return "text.alignleft"
        case .diagnostics: return "stethoscope"
        case .usbmux: return "cable.connector"
        case .jit: return "bolt"
        }
    }
    @ViewBuilder var destination: some View {
        switch self {
        case .deviceInfo: DeviceInfoView()
        case .pairing: PairingView()
        case .syslog: SyslogView()
        case .diagnostics: DiagnosticsView()
        case .usbmux: USBMuxView()
        case .jit: JITView()
        }
    }
}

struct RootView: View {
    var body: some View {
        NavigationStack {
            DashboardView()
                .navigationTitle("iDeviceKit")
        }
    }
}

struct DashboardView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                Card(title: "Device") {
                    KeyValueRow(key: "Connection", value: connectionText)
                    if let d = model.primaryDevice {
                        KeyValueRow(key: "Transport", value: d.connectionType)
                        KeyValueRow(key: "Serial / UDID", value: d.udid)
                        KeyValueRow(key: "Pairing record", value: model.pairingStatus(for: d.udid) ? "Stored (not validated against device)" : "None stored")
                        KeyValueRow(key: "Model", value: "Needs lockdown (libimobiledevice)")
                        KeyValueRow(key: "iOS version", value: "Needs lockdown (libimobiledevice)")
                    }
                    Button("Refresh") { Task { await model.refresh() } }
                        .buttonStyle(.borderedProminent)
                }
                ForEach(Section.allCases) { s in
                    NavigationLink { s.destination } label: {
                        HStack {
                            Image(systemName: s.icon).frame(width: 28).foregroundStyle(Theme.accent)
                            Text(s.rawValue).foregroundStyle(.primary)
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(.secondary)
                        }
                        .padding(14)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            }
            .padding(16)
        }
        .background(Theme.background)
        .task { await model.refresh() }
    }

    private var connectionText: String {
        switch model.connection {
        case .unknown: return "Unknown"
        case .notConfigured: return "No usbmuxd endpoint configured"
        case .checking: return "Checking…"
        case .connected(let n): return n == 0 ? "usbmuxd reachable, no devices" : "\(n) device(s)"
        case .failed(let m): return m
        }
    }
}
