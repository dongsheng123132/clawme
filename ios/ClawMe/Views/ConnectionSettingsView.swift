import SwiftUI

struct ConnectionSettingsView: View {
    @EnvironmentObject private var connectionManager: ConnectionManager
    @Environment(\.dismiss) private var dismiss

    @State private var relayURL = ""
    @State private var taskID = ""
    @State private var token = ""
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Relay") {
                    TextField("https://api.clawme.net", text: $relayURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                    TextField("任务 ID", text: $taskID)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField(
                        connectionManager.hasStoredToken ? "留空以保留当前令牌" : "配对令牌",
                        text: $token
                    )
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                }

                Section {
                    Label(
                        connectionManager.hasStoredToken
                            ? "配对令牌已保存在本机 Keychain"
                            : "令牌只保存在本机 Keychain，不写入 UserDefaults",
                        systemImage: "key.fill"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    Text("公网地址必须使用 HTTPS。本机调试可使用 http://127.0.0.1。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }

                if connectionManager.hasStoredToken {
                    Section {
                        Button("忘记这台设备的配对", role: .destructive) {
                            connectionManager.forgetConnection()
                            relayURL = ""
                            taskID = ""
                            token = ""
                        }
                    }
                }
            }
            .navigationTitle("ClawMe 连接")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存并连接") {
                        do {
                            try connectionManager.saveConnection(
                                relayURL: relayURL,
                                taskID: taskID,
                                token: token
                            )
                            dismiss()
                        } catch {
                            errorMessage = error.localizedDescription
                        }
                    }
                }
            }
            .onAppear {
                relayURL = connectionManager.configuredRelayURL
                taskID = connectionManager.configuredTaskID
            }
        }
    }
}
