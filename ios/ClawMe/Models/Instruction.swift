import Foundation

enum InstructionType: String, Codable {
    case openUrl = "open_url"
    case runShortcut = "run_shortcut"
    case draftEmail = "draft_email" // New Power User feature
    case alert = "alert"
    case unknown
}

struct Instruction: Identifiable, Codable {
    let id: String
    let type: InstructionType
    let payload: [String: String]
    let timestamp: Date
    
    // Helper accessors for cleaner UI code
    var emailRecipient: String? { payload["to"] }
    var emailSubject: String? { payload["subject"] }
    var emailBody: String? { payload["body"] }
    
    var description: String {
        switch type {
        case .openUrl:
            return "Open: \(payload["url"] ?? "Unknown URL")"
        case .runShortcut:
            return "Run Shortcut: \(payload["name"] ?? "Unknown")"
        case .draftEmail:
            return "Draft Email to: \(payload["to"] ?? "Recipient")"
        case .alert:
            return "Alert: \(payload["message"] ?? "")"
        case .unknown:
            return "Unknown Command"
        }
    }
}
