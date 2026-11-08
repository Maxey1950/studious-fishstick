import Foundation
import Network
import Darwin

struct USBMuxSettings: Codable, Equatable {
    enum Mode: String, Codable, CaseIterable, Identifiable {
        case local, remote
        var id: String { rawValue }
    }
    var mode: Mode = .remote
    var localPath = "/var/run/usbmuxd"
    var host = ""
    var port: Int = 27015

    private static let key = "usbmux.settings.v1"
    static func load() -> USBMuxSettings {
        guard let d = UserDefaults.standard.data(forKey: key),
              let s = try? JSONDecoder().decode(USBMuxSettings.self, from: d) else { return USBMuxSettings() }
        return s
    }
    func save() {
        if let d = try? JSONEncoder().encode(self) { UserDefaults.standard.set(d, forKey: Self.key) }
    }
}

enum TransportError: Error, LocalizedError {
    case notConfigured, timeout, closed, invalidPort, posix(String, Int32), network(String)
    var errorDescription: String? {
        switch self {
        case .notConfigured: return "No remote usbmuxd host configured"
        case .timeout: return "Connection timed out"
        case .closed: return "Connection closed by peer"
        case .invalidPort: return "Invalid port"
        case .posix(let what, let e): return "\(what) failed: \(String(cString: strerror(e))) (errno \(e))"
        case .network(let m): return m
        }
    }
}

/// Result of probing the local usbmuxd UNIX socket from inside this app's sandbox.
enum LocalProbeResult: Equatable {
    case reachable
    case missing(String)
    case denied(String)
    case other(String)
}

enum LocalUSBMuxProbe {
    static func probe(path: String) -> LocalProbeResult {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return .other("socket() failed, errno \(errno)") }
        defer { close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let cap = MemoryLayout.size(ofValue: addr.sun_path)
        guard path.utf8.count < cap else { return .other("Path too long") }
        withUnsafeMutablePointer(to: &addr.sun_path) { p in
            p.withMemoryRebound(to: CChar.self, capacity: cap) { dst in
                _ = path.withCString { strncpy(dst, $0, cap - 1) }
            }
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, len) }
        }
        if rc == 0 { return .reachable }
        let e = errno
        let text = "\(String(cString: strerror(e))) (errno \(e))"
        switch e {
        case ENOENT: return .missing(text)
        case EPERM, EACCES: return .denied(text)
        default: return .other(text)
        }
    }
}

/// Minimal async TCP client for a *remote* usbmuxd (e.g. `socat TCP-LISTEN:27015,fork UNIX-CONNECT:/var/run/usbmuxd`).
final class RemoteUSBMuxClient {
    private let queue = DispatchQueue(label: "usbmux.remote")

    func listDevices(host: String, port: Int, timeout: TimeInterval = 5) async throws -> [USBMuxDevice] {
        guard !host.trimmingCharacters(in: .whitespaces).isEmpty else { throw TransportError.notConfigured }
        guard let nwPort = NWEndpoint.Port(rawValue: UInt16(clamping: port)), port > 0, port < 65536 else {
            throw TransportError.invalidPort
        }
        let conn = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: .tcp)
        let timer = DispatchWorkItem { conn.cancel() }
        queue.asyncAfter(deadline: .now() + timeout, execute: timer)
        defer { timer.cancel(); conn.cancel() }

        try await connect(conn)
        try await send(conn, try UsbmuxCodec.listDevicesRequest())
        let headerData = try await receive(conn, exactly: UsbmuxCodec.headerSize)
        let header = try UsbmuxCodec.decodeHeader(headerData)
        let payload = try await receive(conn, exactly: header.payloadLength)
        return try UsbmuxCodec.parseDeviceList(payload)
    }

    private func connect(_ c: NWConnection) async throws {
        try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
            let lock = NSLock()
            var done = false
            func finish(_ r: Result<Void, Error>) {
                lock.lock(); defer { lock.unlock() }
                guard !done else { return }
                done = true
                k.resume(with: r)
            }
            c.stateUpdateHandler = { state in
                switch state {
                case .ready: finish(.success(()))
                case .failed(let e): finish(.failure(TransportError.network(e.localizedDescription)))
                case .waiting(let e): finish(.failure(TransportError.network("Unreachable: \(e.localizedDescription)")))
                case .cancelled: finish(.failure(TransportError.timeout))
                default: break
                }
            }
            c.start(queue: queue)
        }
    }

    private func send(_ c: NWConnection, _ data: Data) async throws {
        try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
            c.send(content: data, completion: .contentProcessed { err in
                if let err = err { k.resume(throwing: TransportError.network(err.localizedDescription)) }
                else { k.resume() }
            })
        }
    }

    private func receive(_ c: NWConnection, exactly n: Int) async throws -> Data {
        if n == 0 { return Data() }
        return try await withCheckedThrowingContinuation { (k: CheckedContinuation<Data, Error>) in
            c.receive(minimumIncompleteLength: n, maximumLength: n) { data, _, _, err in
                if let err = err { k.resume(throwing: TransportError.network(err.localizedDescription)) }
                else if let data = data, data.count == n { k.resume(returning: data) }
                else { k.resume(throwing: TransportError.closed) }
            }
        }
    }
}
