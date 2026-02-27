import SwiftUI

@main
struct ClawMeApp: App {
    // Shared state/services
    @StateObject private var connectionManager = ConnectionManager()
    
    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(connectionManager)
        }
    }
}
