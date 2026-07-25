import Foundation

enum JSONValue: Codable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var stringValue: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }
}

struct RemoteTask: Codable, Identifiable, Equatable {
    let id: String
    let machineId: String
    let provider: String
    let title: String
    var status: String
    var summary: String?
    let nativeThreadId: String?
    let nativeTurnId: String?
    let createdAt: String
    let updatedAt: String
}

struct RemoteAttentionOption: Codable, Identifiable, Equatable {
    let id: String
    let label: String
    let tone: String?
}

struct RemoteAttention: Codable, Identifiable, Equatable {
    let id: String
    let taskId: String
    let machineId: String
    let kind: String
    let title: String
    let detail: String?
    let risk: String?
    let options: [RemoteAttentionOption]
    let status: String
}

struct SyncEntity: Codable, Equatable {
    let type: String
    let id: String
}

struct SyncEvent: Codable, Identifiable, Equatable {
    let eventId: String
    let sequence: Int
    let kind: String
    let occurredAt: String
    let entity: SyncEntity
    let payload: [String: JSONValue]

    var id: String { eventId }

    enum CodingKeys: String, CodingKey {
        case eventId = "event_id"
        case sequence
        case kind
        case occurredAt = "occurred_at"
        case entity
        case payload
    }
}

struct TaskSyncState: Codable, Equatable {
    let task: RemoteTask
    let attention: [RemoteAttention]
}

struct SyncPayload: Codable, Equatable {
    let previousCursor: String?
    let cursor: String
    let stateVersion: Int
    let schemaVersion: String?
    let hasMore: Bool?
    let state: TaskSyncState?
    let events: [SyncEvent]?

    enum CodingKeys: String, CodingKey {
        case previousCursor = "previous_cursor"
        case cursor
        case stateVersion = "state_version"
        case schemaVersion = "schema_version"
        case hasMore = "has_more"
        case state
        case events
    }
}

struct SyncEnvelope: Codable, Equatable {
    let protocolVersion: String
    let type: String
    let streamId: String
    let messageId: String
    let sentAt: String
    let payload: SyncPayload

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case type
        case streamId = "stream_id"
        case messageId = "message_id"
        case sentAt = "sent_at"
        case payload
    }
}
