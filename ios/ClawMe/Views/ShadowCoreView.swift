import SwiftUI

struct ShadowCoreSection: View {
    let tasks: [RemoteTask]
    let challenges: [ShadowCheckpointChallenge]
    let results: [ShadowActionResult]
    let busyRequests: Set<String>
    let onRequest: (RemoteTask, String, ShadowConfirmationMode) async throws -> Void
    let onConfirm: (ShadowCheckpointChallenge) async throws -> Void

    @State private var requestTask: RemoteTask?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("影核 · 一核多影", systemImage: "square.stack.3d.up.fill")
                    .font(.title2.bold())
                Spacer()
                Text("OWNER 执行")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal)

            ForEach(challenges) { challenge in
                ShadowChallengeCard(
                    challenge: challenge,
                    isBusy: busyRequests.contains(challenge.requestId)
                ) {
                    try await onConfirm(challenge)
                }
            }

            ForEach(tasks) { task in
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        VStack(alignment: .leading) {
                            Text(task.title).font(.headline)
                            Text(task.status)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("保存接班点") { requestTask = task }
                            .buttonStyle(.borderedProminent)
                            // ActionParity 绑定标识：绑定检查与 UI 测试都靠它，不靠按钮文案
                            .accessibilityIdentifier("clawme.action.checkpoint.challenge")
                    }
                    if let summary = task.summary, !summary.isEmpty {
                        Text(summary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                .padding()
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .padding(.horizontal)
            }

            ForEach(results.prefix(5)) { result in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: result.ok ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                        .foregroundStyle(result.ok ? .green : .orange)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(result.ok ? "动作核心已保存检查点" : "动作未执行")
                            .font(.subheadline.bold())
                        if let checkpointId = result.checkpointId {
                            Text(checkpointId).font(.caption.monospaced())
                        }
                        if let message = result.errorMessage ?? result.errorCode {
                            Text(message).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                }
                .padding()
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .padding(.horizontal)
            }
        }
        .sheet(item: $requestTask) { task in
            CheckpointRequestSheet(task: task) { reason, mode in
                try await onRequest(task, reason, mode)
                requestTask = nil
            }
        }
    }
}

private struct ShadowChallengeCard: View {
    let challenge: ShadowCheckpointChallenge
    let isBusy: Bool
    let onConfirm: () async throws -> Void

    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Owner 确认挑战", systemImage: "checkmark.shield.fill")
                    .font(.headline)
                Spacer()
                Text(challenge.mode.title)
                    .font(.caption.bold())
                    .foregroundStyle(.orange)
            }
            Text(challenge.reason)
                .font(.body)
                .textSelection(.enabled)
            Text("动作：\(challenge.actionId) · 状态版本 \(challenge.expectedStateVersion)")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            Text("有效期：\(challenge.expiresAt)")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let errorMessage {
                Text(errorMessage).font(.caption).foregroundStyle(.red)
            }
            Button {
                Task {
                    do {
                        try await onConfirm()
                    } catch {
                        errorMessage = error.localizedDescription
                    }
                }
            } label: {
                HStack {
                    if isBusy { ProgressView().tint(.white) }
                    Text(isBusy ? "正在交给 Owner…" : "确认并保存接班点")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(isBusy)
            .accessibilityIdentifier("clawme.action.checkpoint.create")
        }
        .padding()
        .background(Color.orange.opacity(0.09))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color.orange.opacity(0.35))
        )
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .padding(.horizontal)
    }
}

private struct CheckpointRequestSheet: View {
    let task: RemoteTask
    let onSubmit: (String, ShadowConfirmationMode) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var reason = "手机端请求保存当前接班点"
    @State private var mode = ShadowConfirmationMode.system
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("要执行的动作") {
                    Text("checkpoint.create").font(.body.monospaced())
                    TextField("保存原因", text: $reason, axis: .vertical)
                        .lineLimit(2...5)
                }
                Section("确认方式") {
                    Picker("确认方式", selection: $mode) {
                        ForEach(ShadowConfirmationMode.allCases) { item in
                            Text(item.title).tag(item)
                        }
                    }
                }
                Section {
                    Text("Relay 只排队；检查点由 \(task.title) 所在电脑的 UURescue 动作核心执行。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle("请求 Owner 挑战")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSubmitting ? "发送中…" : "发送") {
                        Task {
                            isSubmitting = true
                            defer { isSubmitting = false }
                            do {
                                try await onSubmit(reason, mode)
                                dismiss()
                            } catch {
                                errorMessage = error.localizedDescription
                            }
                        }
                    }
                    .disabled(reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSubmitting)
                }
            }
        }
    }
}
