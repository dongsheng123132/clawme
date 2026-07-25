import Foundation
import Combine

@MainActor
final class ConnectionManager: ObservableObject {
    @Published var isConnected = false
    @Published var lastMessage: String = "No messages yet"
    @Published var instructions: [Instruction] = []
    @Published var remoteTasks: [String: RemoteTask] = [:]
    @Published var taskEvents: [String: [SyncEvent]] = [:]
    
    private var webSocketTask: URLSessionWebSocketTask?
    private var cursorByTask: [String: String] = [:]
    private let defaults: UserDefaults
    private let cursorDefaultsKey = "clawme.sync.cursors.v1"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.cursorByTask =
            defaults.dictionary(forKey: cursorDefaultsKey) as? [String: String] ?? [:]
    }
    
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

    /// Pulls only the state changes after this device's durable cursor.
    /// The first request receives a snapshot; later requests receive deltas.
    func syncTask(
        taskID: String,
        baseURL: URL,
        token: String,
        maxPages: Int = 10
    ) async throws {
        for _ in 0..<maxPages {
            var url = baseURL
                .appendingPathComponent("v3")
                .appendingPathComponent("sync")
                .appendingPathComponent("tasks")
                .appendingPathComponent(taskID)
            var components = URLComponents(
                url: url,
                resolvingAgainstBaseURL: false
            )
            var queryItems = [URLQueryItem(name: "limit", value: "100")]
            if let cursor = cursorByTask[taskID] {
                queryItems.append(URLQueryItem(name: "after", value: cursor))
            }
            components?.queryItems = queryItems
            guard let requestURL = components?.url else {
                throw URLError(.badURL)
            }
            url = requestURL

            var request = URLRequest(url: url)
            request.setValue(token, forHTTPHeaderField: "X-ClawMe-Token")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let (data, response) = try await URLSession.shared.data(for: request)
            guard
                let http = response as? HTTPURLResponse,
                (200..<300).contains(http.statusCode)
            else {
                throw URLError(.badServerResponse)
            }
            let envelope = try JSONDecoder().decode(SyncEnvelope.self, from: data)
            guard envelope.protocolVersion == "action-parity/sync@0.1" else {
                throw DecodingError.dataCorrupted(
                    .init(
                        codingPath: [],
                        debugDescription: "Unsupported ClawMe sync protocol"
                    )
                )
            }
            applySyncEnvelope(envelope, taskID: taskID)
            if envelope.payload.hasMore != true { break }
        }
    }

    private func applySyncEnvelope(_ envelope: SyncEnvelope, taskID: String) {
        cursorByTask[taskID] = envelope.payload.cursor
        defaults.set(cursorByTask, forKey: cursorDefaultsKey)
        if let snapshot = envelope.payload.state {
            remoteTasks[snapshot.task.id] = snapshot.task
        }

        for event in envelope.payload.events ?? [] {
            var list = taskEvents[event.entity.id] ?? []
            if !list.contains(where: { $0.id == event.id }) {
                list.append(event)
                list.sort { $0.sequence < $1.sequence }
                taskEvents[event.entity.id] = list
            }
            if var task = remoteTasks[event.entity.id] {
                if event.kind == "attention.input_required" {
                    task.status = "waiting"
                } else if let status = event.payload["status"]?.stringValue {
                    task.status = status
                }
                if let message = event.payload["message"]?.stringValue {
                    task.summary = message
                }
                remoteTasks[task.id] = task
            }
        }
        isConnected = true
        lastMessage = "\(envelope.type) · v\(envelope.payload.stateVersion)"
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
