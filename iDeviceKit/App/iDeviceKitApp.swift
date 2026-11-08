import SwiftUI

@main
struct iDeviceKitApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environmentObject(model.logger.store)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
        }
    }
}
