import Foundation
import Network
import Darwin

/// lockdownd framing: 4-byte big-endian length + XML/binary plist.
enum LockdownFraming {
    static func frame(_ plist: [String: Any]) throws -> Data {
        let body = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        var out = Data()
        let n = UInt32(body.count)
        out.append(contentsOf: [UInt8(n >> 24), UInt8((n >> 16) & 0xff), UInt8((n >> 8) & 0xff), UInt8(n & 0xff)])
        out.append(body)
        return out
    }

    static func payloadLength(header: Data) throws -> Int {
        let b = [UInt8](header)
        guard b.count == 4 else { throw UsbmuxError.malformedHeader }
        let n = Int(b[0]) << 24 | Int(b[1]) << 16 | Int(b[2]) << 8 | Int(b[3])
        guard n > 0, n <= 1 << 20 else { throw UsbmuxError.payloadTooLarge(n) }
        return n
    }
}

struct SelfProbeResult: Identifiable, Equatable {
    var id: String { target }
    let target: String          // "host:port (iface)"
    let tcpConnected: Bool
    let lockdownType: String?   // e.g. com.apple.mobile.lockdown when lockdownd answered
    let detail: String
}

/// Answers one question: can this app reach lockdownd (TCP 62078) on this same phone, without any VPN?
enum SelfProbe {
    static func ipv4Interfaces() -> [(name: String, address: String)] {
        var out: [(String, String)] = []
        var ifap: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifap) == 0, let first = ifap else { return [] }
        defer { freeifaddrs(ifap) }
        for p in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let a = p.pointee
            guard let sa = a.ifa_addr, sa.pointee.sa_family == sa_family_t(AF_INET),
                  (a.ifa_flags & UInt32(IFF_UP)) != 0 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            out.append((String(cString: a.ifa_name), String(cString: host)))
        }
        return out
    }

    static func run(port: UInt16 = 62078) async -> [SelfProbeResult] {
        var targets: [(String, String)] = [("lo0", "127.0.0.1")]
        for i in ipv4Interfaces() where i.address != "127.0.0.1" { targets.append((i.name, i.address)) }
        var results: [SelfProbeResult] = []
        for (iface, ip) in targets { results.append(await probe(host: ip, iface: iface, port: port)) }
        return results
    }

    static func probe(host: String, iface: String, port: UInt16, timeout: TimeInterval = 4) async -> SelfProbeResult {
        let label = "\(host):\(port) (\(iface))"
        let client = RemoteUSBMuxClient()
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            return SelfProbeResult(target: label, tcpConnected: false, lockdownType: nil, detail: "bad port")
        }
        let conn = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: .tcp)
        let timer = DispatchWorkItem { conn.cancel() }
        client.queue.asyncAfter(deadline: .now() + timeout, execute: timer)
        defer { timer.cancel(); conn.cancel() }
        do {
            try await client.connect(conn)
        } catch {
            return SelfProbeResult(target: label, tcpConnected: false, lockdownType: nil, detail: error.localizedDescription)
        }
        do {
            try await client.send(conn, try LockdownFraming.frame(["Request": "QueryType", "Label": "iDeviceKit"]))
            let n = try LockdownFraming.payloadLength(header: try await client.receive(conn, exactly: 4))
            let body = try await client.receive(conn, exactly: n)
            let dict = try PropertyListSerialization.propertyList(from: body, options: [], format: nil) as? [String: Any]
            let type = dict?["Type"] as? String
            return SelfProbeResult(target: label, tcpConnected: true, lockdownType: type,
                                   detail: type == nil ? "Connected, reply had no Type" : "lockdownd answered")
        } catch {
            return SelfProbeResult(target: label, tcpConnected: true, lockdownType: nil,
                                   detail: "TCP connected but no lockdownd reply: \(error.localizedDescription)")
        }
    }
}
