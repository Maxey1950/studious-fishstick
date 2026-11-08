import SwiftUI

enum Theme {
    static let background = Color(red: 0.04, green: 0.07, blue: 0.14)
    static let surface = Color(red: 0.08, green: 0.12, blue: 0.22)
    static let accent = Color(red: 0.22, green: 0.52, blue: 1.0)
}

struct Card<Content: View>: View {
    var title: String?
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title = title { Text(title).font(.footnote.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase) }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
    }
}

struct KeyValueRow: View {
    let key: String
    let value: String
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(key).foregroundStyle(.secondary)
            Spacer(minLength: 12)
            Text(value).multilineTextAlignment(.trailing).textSelection(.enabled)
        }
        .font(.subheadline)
    }
}

/// Honest placeholder for functionality that needs libimobiledevice (not yet linked).
struct NotImplementedNote: View {
    let text: String
    var body: some View {
        Label(text, systemImage: "wrench.and.screwdriver")
            .font(.footnote).foregroundStyle(.secondary)
    }
}

extension View {
    func navyList() -> some View {
        self.scrollContentBackground(.hidden).background(Theme.background)
    }
}
