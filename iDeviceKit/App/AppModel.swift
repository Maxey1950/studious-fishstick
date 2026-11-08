import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    enum Connection: Equatable {
        case unknown
        case notConfigured
        case checking
        case connected(count: Int)
        case failed(String)
    }

    @Published var settings = USBMuxSettings.load() { didSet { settings.save() } }
    @Published private(set) var connection: Connection = .unknown
    @Published private(set) var devices: [USBMuxDevice] = []
    @Published private(set) var localProbe: LocalProbeResult?
    @Published private(set) var pairedUDIDs: [String] = []
    @Published var lastError: String?
    @Published private(set) var selfProbe: [SelfProbeResult] = []
    @Published private(set) var selfProbeRunning = false

    let logger = AppLogger.shared
    private let pairing: PairingStoring
    private let client = RemoteUSBMuxClient()

    init(pairing: PairingStoring = KeychainPairingStore()) {
        self.pairing = pairing
        reloadPairings()
    }

    var primaryDevice: USBMuxDevice? { devices.first }

    func pairingStatus(for udid: String) -> Bool { pairedUDIDs.contains(udid) }

    func refresh() async {
        logger.log(.info, "usbmux", "Refresh (mode: \(settings.mode.rawValue))")
        switch settings.mode {
        case .local:
            let r = LocalUSBMuxProbe.probe(path: settings.localPath)
            localProbe = r
            devices = []
            switch r {
            case .reachable:
                connection = .failed("Socket reachable, but listing over a UNIX socket is not implemented yet")
            case .missing(let m), .denied(let m), .other(let m):
                connection = .failed("Local usbmuxd unavailable: \(m)")
                logger.log(.notice, "usbmux", "Local probe: \(m)")
            }
        case .remote:
            guard !settings.host.trimmingCharacters(in: .whitespaces).isEmpty else {
                connection = .notConfigured; devices = []; return
            }
            connection = .checking
            do {
                devices = try await client.listDevices(host: settings.host, port: settings.port)
                connection = .connected(count: devices.count)
                logger.log(.info, "usbmux", "Remote usbmuxd returned \(devices.count) device(s)")
            } catch {
                devices = []
                connection = .failed(error.localizedDescription)
                logger.log(.error, "usbmux", "Remote list failed: \(error.localizedDescription)")
            }
        }
    }

    func runSelfProbe() async {
        selfProbeRunning = true
        let r = await SelfProbe.run()
        selfProbe = r
        selfProbeRunning = false
        for x in r { logger.log(.notice, "selfprobe", "\(x.target): tcp=\(x.tcpConnected) lockdown=\(x.lockdownType ?? "no") \(x.detail)") }
    }

    func probeLocal() {
        localProbe = LocalUSBMuxProbe.probe(path: settings.localPath)
    }

    // MARK: Pairing (values are never logged)

    func reloadPairings() {
        do { pairedUDIDs = try pairing.list() }
        catch { lastError = error.localizedDescription; logger.log(.error, "pairing", "List failed: \(error.localizedDescription)") }
    }

    func importPairing(udid: String, data: Data) -> PairingValidation {
        let v = PairingValidator.validate(data)
        guard v.isValid else {
            logger.log(.error, "pairing", "Import rejected for \(udid): missing \(v.missingRequired.joined(separator: ","))")
            return v
        }
        do {
            try pairing.save(udid: udid, record: data)
            logger.log(.notice, "pairing", "Stored pairing record for \(udid)")
            reloadPairings()
        } catch {
            lastError = error.localizedDescription
            logger.log(.error, "pairing", "Save failed: \(error.localizedDescription)")
        }
        return v
    }

    func validateStored(udid: String) -> PairingValidation? {
        guard let d = try? pairing.load(udid: udid) else { return nil }
        return PairingValidator.validate(d)
    }

    func exportPairing(udid: String) -> URL? {
        guard let d = try? pairing.load(udid: udid) else { return nil }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(udid).plist")
        do {
            try d.write(to: url, options: [.atomic, .completeFileProtection])
            logger.log(.notice, "pairing", "Exported record for \(udid) (contains private keys)")
            return url
        } catch { lastError = error.localizedDescription; return nil }
    }

    func deletePairing(udid: String) {
        do { try pairing.delete(udid: udid); logger.log(.notice, "pairing", "Deleted record for \(udid)") }
        catch { lastError = error.localizedDescription }
        reloadPairings()
    }
}
