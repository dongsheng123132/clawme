import SwiftUI

struct ContentView: View {
    @EnvironmentObject var connectionManager: ConnectionManager
    @State private var showSettings = false
    
    // Mail State
    @State private var showMailView = false
    @State private var mailResult: Result<MFMailComposeResult, Error>? = nil
    @State private var activeMailInstruction: Instruction?
    
    var body: some View {
        NavigationView {
            VStack(spacing: 20) {
                // Status Header
                HStack {
                    Image(systemName: connectionManager.isConnected ? "wifi" : "wifi.slash")
                        .foregroundColor(connectionManager.isConnected ? .green : .red)
                        .font(.title)
                    Text(connectionManager.isConnected ? "Online" : "Offline")
                        .font(.headline)
                    Spacer()
                }
                .padding()
                .background(Color(.secondarySystemBackground))
                .cornerRadius(12)
                .padding(.horizontal)
                
                // Dashboard Logic
                ScrollView {
                    VStack(alignment: .leading, spacing: 15) {
                        Text("Pending Instructions")
                            .font(.title2)
                            .bold()
                            .padding(.horizontal)
                        
                        if connectionManager.instructions.isEmpty {
                            EmptyStateView()
                        } else {
                            ForEach(connectionManager.instructions) { instruction in
                                InstructionCard(
                                    instruction: instruction,
                                    onAuthorize: {
                                        handleAuthorization(for: instruction)
                                    }
                                )
                            }
                        }
                    }
                }
                
                Spacer()
                
                // Voice / Action Button
                Button(action: {
                    // Start Listening logic
                }) {
                    VStack {
                        Image(systemName: "mic.fill")
                            .font(.system(size: 30))
                        Text("Ask ClawMe")
                            .font(.caption)
                    }
                    .frame(width: 80, height: 80)
                    .background(Color.blue)
                    .foregroundColor(.white)
                    .clipShape(Circle())
                    .shadow(radius: 5)
                }
                .padding(.bottom, 20)
            }
            .navigationTitle("ClawMe")
            .toolbar {
                Button(action: { showSettings.toggle() }) {
                    Image(systemName: "gear")
                }
            }
            .onAppear {
                connectionManager.connect()
            }
            .sheet(isPresented: $showMailView) {
                if let instruction = activeMailInstruction,
                   let recipient = instruction.emailRecipient,
                   let subject = instruction.emailSubject,
                   let body = instruction.emailBody {
                    MailView(
                        recipient: recipient,
                        subject: subject,
                        body: body,
                        isShowing: $showMailView,
                        result: $mailResult
                    )
                }
            }
        }
    }
    
    func handleAuthorization(for instruction: Instruction) {
        switch instruction.type {
        case .draftEmail:
            if MFMailComposeViewController.canSendMail() {
                self.activeMailInstruction = instruction
                self.showMailView = true
            } else {
                print("Can't send mail")
                // Fallback: copy to clipboard or open mailto link
                if let recipient = instruction.emailRecipient,
                   let url = URL(string: "mailto:\(recipient)") {
                    UIApplication.shared.open(url)
                }
            }
        default:
            print("Auto-executing other commands")
        }
    }
}

struct EmptyStateView: View {
    var body: some View {
        VStack {
            Image(systemName: "tray")
                .font(.largeTitle)
                .foregroundColor(.gray)
            Text("No instructions yet")
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 150)
        .background(Color(.secondarySystemBackground).opacity(0.5))
        .cornerRadius(12)
        .padding()
    }
}

// New "Smart Card" UI
struct InstructionCard: View {
    let instruction: Instruction
    let onAuthorize: () -> Void
    
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: iconFor(type: instruction.type))
                    .foregroundColor(.blue)
                    .font(.title3)
                Text(titleFor(type: instruction.type))
                    .font(.headline)
                Spacer()
                Text("WAITING AUTH")
                    .font(.caption)
                    .fontWeight(.bold)
                    .padding(4)
                    .background(Color.orange.opacity(0.2))
                    .foregroundColor(.orange)
                    .cornerRadius(4)
            }
            
            Divider()
            
            // Detail Payload View
            if instruction.type == .draftEmail {
                VStack(alignment: .leading, spacing: 4) {
                    Text("To: \(instruction.emailRecipient ?? "")")
                    Text("Subject: \(instruction.emailSubject ?? "")")
                        .bold()
                    Text(instruction.emailBody ?? "")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(3)
                }
                .padding(.vertical, 4)
            } else {
                Text(instruction.description)
                    .font(.body)
            }
            
            Button(action: onAuthorize) {
                HStack {
                    Spacer()
                    Text("Authorize & Execute")
                        .fontWeight(.semibold)
                    Spacer()
                }
                .padding()
                .background(Color.blue)
                .foregroundColor(.white)
                .cornerRadius(8)
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .cornerRadius(12)
        .shadow(color: Color.black.opacity(0.1), radius: 4, x: 0, y: 2)
        .padding(.horizontal)
    }
    
    func iconFor(type: InstructionType) -> String {
        switch type {
        case .draftEmail: return "envelope.fill"
        case .openUrl: return "safari"
        case .runShortcut: return "bolt.fill"
        case .alert: return "bell.fill"
        case .unknown: return "questionmark"
        }
    }
    
    func titleFor(type: InstructionType) -> String {
        switch type {
        case .draftEmail: return "Draft Email"
        case .openUrl: return "Open Website"
        case .runShortcut: return "Run Shortcut"
        default: return "System Alert"
        }
    }
}
