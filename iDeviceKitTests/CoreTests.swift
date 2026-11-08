import XCTest
@testable import iDeviceKit

final class CoreTests: XCTestCase {
    func entry(_ l: LogLevel, _ m: String) -> LogEntry { LogEntry(date: Date(), level: l, category: "t", message: m) }

    func testFilterByLevelAndQuery() {
        let es = [entry(.debug, "alpha"), entry(.error, "Beta failure"), entry(.info, "gamma")]
        XCTAssertEqual(LogFilter(query: "", minLevel: .info).apply(es).count, 2)
        XCTAssertEqual(LogFilter(query: "beta", minLevel: .debug).apply(es).count, 1)
    }

    func testPauseBuffersThenFlushes() {
        let s = LogStore()
        s.append(entry(.info, "a"))
        s.isPaused = true
        s.append(entry(.info, "b"))
        XCTAssertEqual(s.entries.count, 1)
        XCTAssertEqual(s.pendingCount, 1)
        s.isPaused = false
        XCTAssertEqual(s.entries.count, 2)
    }

    func testCapacityTrim() {
        let s = LogStore(capacity: 3)
        for i in 0..<5 { s.append(entry(.info, "\(i)")) }
        XCTAssertEqual(s.entries.map(\.message), ["2", "3", "4"])
    }

    func testCodecRoundTrip() throws {
        let msg = try UsbmuxCodec.listDevicesRequest(tag: 7)
        let h = try UsbmuxCodec.decodeHeader(msg.prefix(16))
        XCTAssertEqual(h.request, 8); XCTAssertEqual(h.tag, 7); XCTAssertEqual(Int(h.length), msg.count)
    }

    func testRejectsBadVersion() {
        var d = Data(count: 16); d[0] = 16; d[4] = 2
        XCTAssertThrowsError(try UsbmuxCodec.decodeHeader(d))
    }

    func testParseDeviceList() throws {
        let plist: [String: Any] = ["DeviceList": [["DeviceID": 3, "MessageType": "Attached",
            "Properties": ["SerialNumber": "UDID123", "ConnectionType": "USB", "ProductID": 4776]]]]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        let ds = try UsbmuxCodec.parseDeviceList(data)
        XCTAssertEqual(ds, [USBMuxDevice(deviceID: 3, udid: "UDID123", connectionType: "USB", productID: 4776)])
    }

    func testPairingValidation() throws {
        var rec: [String: Any] = [:]
        for k in PairingValidator.required { rec[k] = "x" }
        let ok = try PropertyListSerialization.data(fromPropertyList: rec, format: .xml, options: 0)
        XCTAssertTrue(PairingValidator.validate(ok).isValid)
        rec["HostPrivateKey"] = nil
        let bad = try PropertyListSerialization.data(fromPropertyList: rec, format: .xml, options: 0)
        XCTAssertEqual(PairingValidator.validate(bad).missingRequired, ["HostPrivateKey"])
        XCTAssertFalse(PairingValidator.validate(Data("junk".utf8)).isValid)
    }

    func testLocalProbeMissingSocket() {
        XCTAssertEqual(LocalUSBMuxProbe.probe(path: "/nonexistent/usbmuxd"), .missing("No such file or directory (errno 2)"))
    }
}
