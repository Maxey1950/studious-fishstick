import Foundation

struct USBMuxDevice: Identifiable, Equatable {
    var id: Int { deviceID }
    let deviceID: Int
    let udid: String
    let connectionType: String   // "USB" or "Network"
    let productID: Int?
}

enum UsbmuxError: Error, LocalizedError, Equatable {
    case malformedHeader
    case unexpectedVersion(UInt32)
    case malformedPayload
    case payloadTooLarge(Int)

    var errorDescription: String? {
        switch self {
        case .malformedHeader: return "Malformed usbmuxd header"
        case .unexpectedVersion(let v): return "Unexpected usbmuxd protocol version \(v)"
        case .malformedPayload: return "Malformed usbmuxd plist payload"
        case .payloadTooLarge(let n): return "usbmuxd payload too large (\(n) bytes)"
        }
    }
}

/// usbmuxd "version 1" plist protocol: 16-byte little-endian header
/// (length, version=1, request=8 for plist, tag) followed by an XML plist.
enum UsbmuxCodec {
    static let headerSize = 16
    static let maxPayload = 1 << 20

    struct Header: Equatable {
        let length: UInt32, version: UInt32, request: UInt32, tag: UInt32
        var payloadLength: Int { Int(length) - UsbmuxCodec.headerSize }
    }

    private static func le32(_ v: UInt32) -> [UInt8] {
        [UInt8(v & 0xff), UInt8((v >> 8) & 0xff), UInt8((v >> 16) & 0xff), UInt8((v >> 24) & 0xff)]
    }

    static func encode(payload: Data, tag: UInt32) -> Data {
        var out = Data()
        out.append(contentsOf: le32(UInt32(headerSize + payload.count)))
        out.append(contentsOf: le32(1))
        out.append(contentsOf: le32(8))
        out.append(contentsOf: le32(tag))
        out.append(payload)
        return out
    }

    static func decodeHeader(_ data: Data) throws -> Header {
        let b = [UInt8](data)
        guard b.count >= headerSize else { throw UsbmuxError.malformedHeader }
        func rd(_ o: Int) -> UInt32 {
            UInt32(b[o]) | UInt32(b[o + 1]) << 8 | UInt32(b[o + 2]) << 16 | UInt32(b[o + 3]) << 24
        }
        let h = Header(length: rd(0), version: rd(4), request: rd(8), tag: rd(12))
        guard h.version == 1 else { throw UsbmuxError.unexpectedVersion(h.version) }
        guard h.payloadLength >= 0 else { throw UsbmuxError.malformedHeader }
        guard h.payloadLength <= maxPayload else { throw UsbmuxError.payloadTooLarge(h.payloadLength) }
        return h
    }

    static func listDevicesRequest(tag: UInt32 = 1) throws -> Data {
        let dict: [String: Any] = [
            "MessageType": "ListDevices",
            "ClientVersionString": "iDeviceKit",
            "ProgName": "iDeviceKit",
        ]
        let payload = try PropertyListSerialization.data(fromPropertyList: dict, format: .xml, options: 0)
        return encode(payload: payload, tag: tag)
    }

    static func parseDeviceList(_ payload: Data) throws -> [USBMuxDevice] {
        guard let root = try? PropertyListSerialization.propertyList(from: payload, options: [], format: nil) as? [String: Any],
              let list = root["DeviceList"] as? [[String: Any]] else {
            throw UsbmuxError.malformedPayload
        }
        return list.compactMap { entry in
            guard let id = entry["DeviceID"] as? Int,
                  let props = entry["Properties"] as? [String: Any],
                  let udid = props["SerialNumber"] as? String else { return nil }
            return USBMuxDevice(deviceID: id, udid: udid,
                                connectionType: props["ConnectionType"] as? String ?? "Unknown",
                                productID: props["ProductID"] as? Int)
        }
    }
}
