import SwiftUI
import UniformTypeIdentifiers

struct PairingView: View {
    @EnvironmentObject var model: AppModel
    @State private var showImporter = false
    @State private var udid = ""
    @State private var message: String?
    @State private var exportURL: URL?
    @State private var confirmExport: String?

    var body: some View {
        List {
            SwiftUI.Section("Stored records") {
                if model.pairedUDIDs.isEmpty { Text("None").foregroundStyle(.secondary) }
                ForEach(model.pairedUDIDs, id: \.self) { u in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(u).font(.system(.footnote, design: .monospaced))
                        if let v = model.validateStored(udid: u) {
                            Text(v.isValid ? "Structure valid (not tested against device)" : "Missing: \(v.missingRequired.joined(separator: ", "))")
                                .font(.caption).foregroundStyle(v.isValid ? Color.green : Color.orange)
                        }
                        HStack {
                            Button("Export") { confirmExport = u }
                            Button("Delete", role: .destructive) { model.deletePairing(udid: u) }
                        }.buttonStyle(.bordered).font(.caption)
                    }
                }
            }
            SwiftUI.Section("Import") {
                TextField("UDID (usually the file name)", text: $udid)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Choose .plist…") { showImporter = true }.disabled(udid.isEmpty)
                if let m = message { Text(m).font(.footnote) }
            }
            SwiftUI.Section("Notes") {
                Text("Records are kept in the iOS Keychain (this device only, while unlocked). Key material is never logged or displayed. Creating a NEW pairing (lockdownd Pair, with the Trust prompt on the device) needs libimobiledevice — Milestone 6.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navyList().navigationTitle("Pairing Manager")
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.propertyList, .xml, .data]) { result in
            switch result {
            case .success(let url):
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                guard let data = try? Data(contentsOf: url) else { message = "Could not read file"; return }
                let v = model.importPairing(udid: udid, data: data)
                message = v.isValid ? "Imported." : "Rejected. Missing: \(v.missingRequired.joined(separator: ", "))"
            case .failure(let e): message = e.localizedDescription
            }
        }
        .alert("Export contains private keys", isPresented: Binding(get: { confirmExport != nil }, set: { if !$0 { confirmExport = nil } })) {
            Button("Export", role: .destructive) {
                if let u = confirmExport { exportURL = model.exportPairing(udid: u) }
                confirmExport = nil
            }
            Button("Cancel", role: .cancel) { confirmExport = nil }
        } message: { Text("Anyone with this file can impersonate your computer to the device. Share only to a place you trust.") }
        .sheet(item: Binding(get: { exportURL.map(IdentURL.init) }, set: { if $0 == nil { exportURL = nil } })) { item in
            ShareSheet(url: item.url)
        }
    }
}

struct IdentURL: Identifiable { let url: URL; var id: URL { url } }

struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [url], applicationActivities: nil) }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
