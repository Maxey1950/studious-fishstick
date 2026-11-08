import Foundation
import Security

/// Result of structural validation. Contains key NAMES only, never values.
struct PairingValidation: Equatable {
    var isValid: Bool
    var missingRequired: [String]
    var missingOptional: [String]
    var parseError: String?
}

enum PairingValidator {
    // Structural check only. Whether the device still accepts the record needs a lockdown session (Milestone 6).
    static let required = ["DeviceCertificate", "HostCertificate", "HostID", "RootCertificate", "SystemBUID", "HostPrivateKey"]
    static let optional = ["RootPrivateKey", "EscrowBag", "WiFiMACAddress"]

    static func validate(_ data: Data) -> PairingValidation {
        guard let obj = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
              let dict = obj as? [String: Any] else {
            return PairingValidation(isValid: false, missingRequired: required, missingOptional: optional,
                                     parseError: "Not a valid property list dictionary")
        }
        let mr = required.filter { dict[$0] == nil }
        let mo = optional.filter { dict[$0] == nil }
        return PairingValidation(isValid: mr.isEmpty, missingRequired: mr, missingOptional: mo, parseError: nil)
    }
}

protocol PairingStoring {
    func save(udid: String, record: Data) throws
    func load(udid: String) throws -> Data?
    func delete(udid: String) throws
    func list() throws -> [String]
}

struct KeychainError: Error, LocalizedError {
    let status: OSStatus
    var errorDescription: String? { "Keychain error \(status)" }
}

/// Stores records in the Keychain, this-device-only, available only while unlocked.
struct KeychainPairingStore: PairingStoring {
    private let service = "dev.ideviceKit.pairing"

    private func base(_ udid: String?) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        if let udid = udid { q[kSecAttrAccount as String] = udid }
        return q
    }

    func save(udid: String, record: Data) throws {
        SecItemDelete(base(udid) as CFDictionary)
        var q = base(udid)
        q[kSecValueData as String] = record
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let s = SecItemAdd(q as CFDictionary, nil)
        guard s == errSecSuccess else { throw KeychainError(status: s) }
    }

    func load(udid: String) throws -> Data? {
        var q = base(udid)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let s = SecItemCopyMatching(q as CFDictionary, &out)
        if s == errSecItemNotFound { return nil }
        guard s == errSecSuccess else { throw KeychainError(status: s) }
        return out as? Data
    }

    func delete(udid: String) throws {
        let s = SecItemDelete(base(udid) as CFDictionary)
        guard s == errSecSuccess || s == errSecItemNotFound else { throw KeychainError(status: s) }
    }

    func list() throws -> [String] {
        var q = base(nil)
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitAll
        var out: CFTypeRef?
        let s = SecItemCopyMatching(q as CFDictionary, &out)
        if s == errSecItemNotFound { return [] }
        guard s == errSecSuccess else { throw KeychainError(status: s) }
        return ((out as? [[String: Any]]) ?? []).compactMap { $0[kSecAttrAccount as String] as? String }.sorted()
    }
}
