import SwiftUI

struct SyslogView: View {
    @EnvironmentObject var store: LogStore
    @State private var filter = LogFilter()

    var body: some View {
        let shown = filter.apply(store.entries)
        VStack(spacing: 0) {
            Text("Showing iDeviceKit's own log. Live device syslog (syslog_relay) needs libimobiledevice — Milestone 5/6.")
                .font(.footnote).foregroundStyle(.secondary).padding(8)
            Picker("Level", selection: $filter.minLevel) {
                ForEach(LogLevel.allCases) { Text($0.label).tag($0) }
            }.pickerStyle(.segmented).padding(.horizontal)
            List(shown) { e in
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(e.level.label) · \(e.category)").font(.caption2).foregroundStyle(.secondary)
                    Text(e.message).font(.system(.footnote, design: .monospaced))
                }
                .listRowBackground(Theme.surface)
            }
            .navyList()
        }
        .background(Theme.background)
        .searchable(text: $filter.query)
        .navigationTitle("Syslog")
        .toolbar {
            ToolbarItemGroup(placement: .navigationBarTrailing) {
                Button(store.isPaused ? "Resume (\(store.pendingCount))" : "Pause") { store.isPaused.toggle() }
                if let url = try? LogStore.exportFile(shown) { ShareLink(item: url) }
                Button("Clear") { store.clear() }
            }
        }
    }
}
