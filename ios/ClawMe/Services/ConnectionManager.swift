import Foundation
import Combine

class ConnectionManager: ObservableObject {
    @Published var isConnected = false
    @Published var lastMessage: String = "No messages yet"
    @Published var instructions: [Instruction] = []
    
    private var webSocketTask: URLSessionWebSocketTask?
    
    func connect() {
        // Placeholder for WebSocket connection logic
        // In a real app, this would connect to the backend URL
        print("Connecting to backend...")
        
        // Simulation of a connection for the demo
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            self.isConnected = true
            self.lastMessage = "Connected to ClawMe Backend"
            
            // Simulate receiving a command
            self.receiveMockCommand()
        }
    }
    
    func disconnect() {
        isConnected = false
        lastMessage = "Disconnected"
    }
    
    private func receiveMockCommand() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            let mockInstruction = Instruction(
                id: UUID().uuidString,
                type: .draftEmail,
                payload: [
                    "to": "boss@company.com",
                    "subject": "Project ClawMe Update",
                    "body": "Hi Boss,\n\nThe iOS Native App is coming along great. We now have Smart Authorization flows!\n\nBest,\nClawMe Dev"
                ],
                timestamp: Date()
            )
            self.instructions.append(mockInstruction)
            self.lastMessage = "Received: Draft Email request"
        }
    }
}
