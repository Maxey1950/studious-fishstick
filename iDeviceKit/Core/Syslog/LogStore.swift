import Foundation

struct LogFilter: Equatable {
    var query = ""
    var minLevel: LogLevel = .debug

    func matches(_ e: LogEntry) -> Bool {
        guard e.level >= minLevel else { return false }
        let q = query.trimmingCharacters(in: .whitespaces)
        if q.isEmpty { return true }
        return e.message.localizedCaseInsensitiveContains(q)
            || e.category.localizedCaseInsensitiveContains(q)
    }

    func apply(_ entries: [LogEntry]) -> [LogEntry] { entries.filter(matches) }
}

/// Main-thread-only store. While paused, new entries are buffered and not shown.
final class LogStore: ObservableObject {
    @Published private(set) var entries: [LogEntry] = []
    @Published private(set) var pendingCount = 0
    @Published var isPaused = false {
        didSet { if !isPaused { flush() } }
    }
    private var pending: [LogEntry] = []
    let capacity: Int

    init(capacity: Int = 5000) { self.capacity = capacity }

    func append(_ e: LogEntry) {
        if isPaused { pending.append(e); pendingCount = pending.count; return }
        entries.append(e)
        trim()
    }

    private func flush() {
        entries.append(contentsOf: pending)
        pending.removeAll()
        pendingCount = 0
        trim()
    }

    private func trim() {
        if entries.count > capacity { entries.removeFirst(entries.count - capacity) }
    }

    func clear() { entries.removeAll(); pending.removeAll(); pendingCount = 0 }

    static func formatted(_ entries: [LogEntry]) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return entries.map { "\(f.string(from: $0.date)) \($0.level.label.uppercased()) [\($0.category)] \($0.message)" }
            .joined(separator: "\n")
    }

    static func exportFile(_ entries: [LogEntry]) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ideviceKit-log.txt")
        try formatted(entries).write(to: url, atomically: true, encoding: .utf8)
        return url
    }
}
