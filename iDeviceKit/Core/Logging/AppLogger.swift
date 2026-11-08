import Foundation
import os

enum LogLevel: Int, CaseIterable, Comparable, Identifiable {
    case debug, info, notice, error
    var id: Int { rawValue }
    var label: String {
        switch self {
        case .debug: return "Debug"
        case .info: return "Info"
        case .notice: return "Notice"
        case .error: return "Error"
        }
    }
    static func < (a: LogLevel, b: LogLevel) -> Bool { a.rawValue < b.rawValue }
}

struct LogEntry: Identifiable, Equatable {
    let id = UUID()
    let date: Date
    let level: LogLevel
    let category: String
    let message: String
}

/// Structured app logger. Writes to os.Logger and to the in-app LogStore.
/// RULE: never pass pairing material (keys, certificates, escrow bags) as a message.
final class AppLogger {
    static let shared = AppLogger()
    let store = LogStore()
    private let osLogger = Logger(subsystem: "dev.ideviceKit.app", category: "app")

    func log(_ level: LogLevel, _ category: String, _ message: String) {
        switch level {
        case .debug: osLogger.debug("[\(category, privacy: .public)] \(message, privacy: .public)")
        case .info: osLogger.info("[\(category, privacy: .public)] \(message, privacy: .public)")
        case .notice: osLogger.notice("[\(category, privacy: .public)] \(message, privacy: .public)")
        case .error: osLogger.error("[\(category, privacy: .public)] \(message, privacy: .public)")
        }
        let entry = LogEntry(date: Date(), level: level, category: category, message: message)
        DispatchQueue.main.async { self.store.append(entry) }
    }
}
