import Foundation
import Combine
import LocalAuthentication
import Security

@MainActor
final class ConnectionManager: ObservableObject {
    @Published var isConnected = false
    @Published var lastMessage: String = "No messages yet"
    @Published var instructions: [Instruction] = []
    @Published var remoteTasks: [String: RemoteTask] = [:]
    @Published var taskEvents: [String: [SyncEvent]] = [:]
    @Published var checkpointChallenges: [String: ShadowCheckpointChallenge] = [:]
    @Published var shadowResults: [String: ShadowActionResult] = [:]
    @Published var busyShadowRequests: Set<String> = []
    @Published var lastShadowError: String?
    @Published private(set) var configuredRelayURL: String = ""
    @Published private(set) var configuredTaskID: String = ""
    @Published private(set) var hasStoredToken = false
    
    private var webSocketTask: URLSessionWebSocketTask?
    private var cursorByTask: [String: String] = [:]
    private let defaults: UserDefaults
    private let cursorDefaultsKey = "clawme.sync.cursors.v1"
    private let relayDefaultsKey = "clawme.connection.relay.v1"
    private let taskDefaultsKey = "clawme.connection.task.v1"
    private var activeBaseURL: URL?
    private var activeToken: String?
    private var dashboardPollingTask: Task<Void, Never>?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.cursorByTask =
            defaults.dictionary(forKey: cursorDefaultsKey) as? [String: String] ?? [:]
        self.configuredRelayURL = defaults.string(forKey: relayDefaultsKey) ?? ""
        self.configuredTaskID = defaults.string(forKey: taskDefaultsKey) ?? ""
        self.hasStoredToken = SecureTokenStore.read() != nil
    }
    
    func connect() {
        dashboardPollingTask?.cancel()
        guard
            let baseURL = URL(string: configuredRelayURL),
            !configuredTaskID.isEmpty,
            let token = SecureTokenStore.read()
        else {
            isConnected = false
            lastMessage = "请在设置中完成 Relay 配对"
            return
        }
        activeBaseURL = baseURL
        activeToken = token
        let taskID = configuredTaskID
        dashboardPollingTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    try await self.syncTask(taskID: taskID, baseURL: baseURL, token: token)
                } catch {
                    self.isConnected = false
                    self.lastMessage = error.localizedDescription
                }
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }
    
    func disconnect() {
        dashboardPollingTask?.cancel()
        dashboardPollingTask = nil
        isConnected = false
        lastMessage = "Disconnected"
    }

    func saveConnection(relayURL: String, taskID: String, token: String) throws {
        let trimmedURL = relayURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedTask = taskID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            let url = URL(string: trimmedURL),
            let scheme = url.scheme?.lowercased(),
            let host = url.host?.lowercased(),
            !trimmedTask.isEmpty
        else {
            throw ShadowClientError.invalidConfiguration
        }
        let localHosts = Set(["127.0.0.1", "localhost", "::1"])
        guard scheme == "https" || (scheme == "http" && localHosts.contains(host)) else {
            throw ShadowClientError.insecureRelay
        }
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedToken.isEmpty {
            try SecureTokenStore.save(trimmedToken)
        } else if SecureTokenStore.read() == nil {
            throw ShadowClientError.tokenRequired
        }
        configuredRelayURL = url.absoluteString.replacingOccurrences(of: "/$", with: "", options: .regularExpression)
        configuredTaskID = trimmedTask
        hasStoredToken = true
        defaults.set(configuredRelayURL, forKey: relayDefaultsKey)
        defaults.set(configuredTaskID, forKey: taskDefaultsKey)
        connect()
    }

    func forgetConnection() {
        disconnect()
        SecureTokenStore.delete()
        configuredRelayURL = ""
        configuredTaskID = ""
        hasStoredToken = false
        activeBaseURL = nil
        activeToken = nil
        defaults.removeObject(forKey: relayDefaultsKey)
        defaults.removeObject(forKey: taskDefaultsKey)
    }

    /// Pulls only the state changes after this device's durable cursor.
    /// The first request receives a snapshot; later requests receive deltas.
    func syncTask(
        taskID: String,
        baseURL: URL,
        token: String,
        maxPages: Int = 10
    ) async throws {
        activeBaseURL = baseURL
        activeToken = token
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

    /// Queues a challenge request. The relay binds the action to the identity
    /// represented by the token; no actor identifier is accepted from the app.
    @discardableResult
    func requestCheckpoint(
        taskID: String,
        reason: String,
        mode: ShadowConfirmationMode
    ) async throws -> String {
        let (baseURL, token) = try activeConnection()
        let url = baseURL
            .appendingPathComponent("v3")
            .appendingPathComponent("tasks")
            .appendingPathComponent(taskID)
            .appendingPathComponent("shadow")
            .appendingPathComponent("checkpoint-challenges")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(token, forHTTPHeaderField: "X-ClawMe-Token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = try JSONEncoder().encode(
            ChallengeRequestBody(reason: reason, confirmationMode: mode.rawValue)
        )
        let data = try await send(request)
        let queued = try JSONDecoder().decode(ChallengeQueuedResponse.self, from: data)
        lastMessage = "已请求 owner 确认挑战"
        Task { await watchTask(taskID: taskID, requestID: queued.requestId, waitForResult: false) }
        return queued.requestId
    }

    /// Shows the exact owner-issued action, performs the requested native
    /// authentication locally, then submits only the confirmation timestamp.
    func confirmCheckpoint(_ challenge: ShadowCheckpointChallenge) async throws {
        guard !busyShadowRequests.contains(challenge.requestId) else { return }
        busyShadowRequests.insert(challenge.requestId)
        lastShadowError = nil
        defer { busyShadowRequests.remove(challenge.requestId) }
        do {
            try await authenticate(
                mode: challenge.mode,
                reason: "确认执行：\(challenge.reason)"
            )
            let (baseURL, token) = try activeConnection()
            let url = baseURL
                .appendingPathComponent("v3")
                .appendingPathComponent("tasks")
                .appendingPathComponent(challenge.taskId)
                .appendingPathComponent("shadow")
                .appendingPathComponent("checkpoint-challenges")
                .appendingPathComponent(challenge.requestId)
                .appendingPathComponent("confirm")
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue(token, forHTTPHeaderField: "X-ClawMe-Token")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(
                ChallengeConfirmationBody(
                    confirmedAt: ISO8601DateFormatter().string(from: Date())
                )
            )
            _ = try await send(request)
            lastMessage = "确认已交给 owner 执行"
            Task {
                await watchTask(
                    taskID: challenge.taskId,
                    requestID: challenge.requestId,
                    waitForResult: true
                )
            }
        } catch {
            lastShadowError = error.localizedDescription
            throw error
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
            if let challenge = checkpointChallenge(from: event) {
                checkpointChallenges[challenge.requestId] = challenge
            }
            if let result = shadowResult(from: event) {
                shadowResults[result.requestId] = result
                checkpointChallenges.removeValue(forKey: result.requestId)
            }
        }
        isConnected = true
        lastMessage = "\(envelope.type) · v\(envelope.payload.stateVersion)"
    }

    private func activeConnection() throws -> (URL, String) {
        guard let baseURL = activeBaseURL, let token = activeToken, !token.isEmpty else {
            throw ShadowClientError.notConnected
        }
        return (baseURL, token)
    }

    private func watchTask(taskID: String, requestID: String, waitForResult: Bool) async {
        guard let baseURL = activeBaseURL, let token = activeToken else { return }
        for _ in 0..<60 {
            if waitForResult {
                if shadowResults[requestID] != nil { return }
            } else if checkpointChallenges[requestID] != nil || shadowResults[requestID] != nil {
                return
            }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            try? await syncTask(taskID: taskID, baseURL: baseURL, token: token)
        }
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(RelayErrorBody.self, from: data))
                .flatMap { $0.message ?? $0.error }
                ?? "ClawMe Relay HTTP \(http.statusCode)"
            throw ShadowClientError.relay(message)
        }
        return data
    }

    private func authenticate(mode: ShadowConfirmationMode, reason: String) async throws {
        guard mode != .explicit else { return }
        let context = LAContext()
        context.localizedCancelTitle = "取消"
        let policy: LAPolicy = mode == .biometric
            ? .deviceOwnerAuthenticationWithBiometrics
            : .deviceOwnerAuthentication
        var evaluationError: NSError?
        guard context.canEvaluatePolicy(policy, error: &evaluationError) else {
            throw evaluationError ?? ShadowClientError.authenticationUnavailable
        }
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, Error>) in
            context.evaluatePolicy(policy, localizedReason: reason) { success, error in
                if success {
                    continuation.resume()
                } else {
                    continuation.resume(
                        throwing: error ?? ShadowClientError.authenticationFailed
                    )
                }
            }
        }
    }

    private func checkpointChallenge(from event: SyncEvent) -> ShadowCheckpointChallenge? {
        guard event.kind == "sync.challenge" else { return nil }
        let payload = event.payload
        guard
            let requestId = payload["request_id"]?.stringValue,
            let actionId = payload["action_id"]?.stringValue,
            let reason = payload["reason"]?.stringValue,
            let modeValue = payload["confirmation_mode"]?.stringValue,
            let mode = ShadowConfirmationMode(rawValue: modeValue),
            let challengeId = payload["challenge_id"]?.stringValue,
            let stateVersion = payload["expected_state_version"]?.intValue,
            let issuedAt = payload["challenge_issued_at"]?.stringValue,
            let expiresAt = payload["challenge_expires_at"]?.stringValue
        else { return nil }
        return ShadowCheckpointChallenge(
            requestId: requestId,
            taskId: event.entity.id,
            actionId: actionId,
            reason: reason,
            mode: mode,
            challengeId: challengeId,
            expectedStateVersion: stateVersion,
            issuedAt: issuedAt,
            expiresAt: expiresAt
        )
    }

    private func shadowResult(from event: SyncEvent) -> ShadowActionResult? {
        guard ["sync.result", "sync.conflict", "sync.challenge.failed"].contains(event.kind) else {
            return nil
        }
        let payload = event.payload
        guard let requestId = payload["request_id"]?.stringValue else { return nil }
        return ShadowActionResult(
            requestId: requestId,
            taskId: event.entity.id,
            actionId: payload["action_id"]?.stringValue ?? "checkpoint.create",
            ok: event.kind == "sync.result" && payload["ok"]?.boolValue == true,
            resultType: event.kind,
            checkpointId: payload["checkpoint_id"]?.stringValue,
            checkpointSHA256: payload["checkpoint_sha256"]?.stringValue,
            errorCode: payload["error_code"]?.stringValue,
            errorMessage: payload["error_message"]?.stringValue
        )
    }
}

private struct ChallengeRequestBody: Encodable {
    let reason: String
    let confirmationMode: String

    enum CodingKeys: String, CodingKey {
        case reason
        case confirmationMode = "confirmation_mode"
    }
}

private struct ChallengeQueuedResponse: Decodable {
    let requestId: String

    enum CodingKeys: String, CodingKey {
        case requestId = "request_id"
    }
}

private struct ChallengeConfirmationBody: Encodable {
    let confirmedAt: String

    enum CodingKeys: String, CodingKey {
        case confirmedAt = "confirmed_at"
    }
}

private struct RelayErrorBody: Decodable {
    let error: String?
    let message: String?
}

private enum ShadowClientError: LocalizedError {
    case notConnected
    case relay(String)
    case authenticationUnavailable
    case authenticationFailed
    case invalidConfiguration
    case insecureRelay
    case tokenRequired
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .notConnected: return "请先同步任务并建立 ClawMe 连接"
        case .relay(let message): return message
        case .authenticationUnavailable: return "这台设备无法使用所需的系统认证"
        case .authenticationFailed: return "系统认证未通过"
        case .invalidConfiguration: return "Relay 地址或任务 ID 无效"
        case .insecureRelay: return "公网 Relay 必须使用 HTTPS；HTTP 仅允许本机调试"
        case .tokenRequired: return "首次配对必须填写令牌"
        case .keychain(let status): return "无法保存配对令牌（\(status)）"
        }
    }
}

private enum SecureTokenStore {
    private static let service = "net.clawme.shadowcore"
    private static let account = "relay-pairing-token"

    static func read() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard
            SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
            let data = result as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ token: String) throws {
        let data = Data(token.utf8)
        let status: OSStatus
        if read() == nil {
            var query = baseQuery
            query[kSecValueData as String] = data
            status = SecItemAdd(query as CFDictionary, nil)
        } else {
            status = SecItemUpdate(
                baseQuery as CFDictionary,
                [kSecValueData as String: data] as CFDictionary
            )
        }
        guard status == errSecSuccess else { throw ShadowClientError.keychain(status) }
    }

    static func delete() {
        SecItemDelete(baseQuery as CFDictionary)
    }

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
    }
}
