package net.clawme.shadow.ui

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import net.clawme.shadow.ShadowUiState
import net.clawme.shadow.protocol.RemoteTask
import net.clawme.shadow.protocol.ShadowActionResult
import net.clawme.shadow.protocol.ShadowCheckpointChallenge
import net.clawme.shadow.protocol.ShadowConfirmationMode

/**
 * ActionParity 绑定标识。
 *
 * 绑定检查和 UI 自动化都认它，不认按钮文案 —— 文案可以改、可以翻译、可以做 A/B，
 * 动作身份不能漂。`action-parity.json` 里 android 界面声明的就是这两个值。
 */
object ShadowTestTags {
    const val CHECKPOINT_CHALLENGE = "clawme.action.checkpoint.challenge"
    const val CHECKPOINT_CREATE = "clawme.action.checkpoint.create"
    const val PAIRING_REDEEM = "clawme.action.pairing.redeem"
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalComposeUiApi::class)
@Composable
fun ShadowCoreScreen(
    state: ShadowUiState,
    onPairWithCode: (String, String, String, String) -> Unit,
    onSavePairing: (String, String, String) -> Unit,
    onForgetPairing: () -> Unit,
    onRequestChallenge: (String, ShadowConfirmationMode) -> Unit,
    onConfirmChallenge: (ShadowCheckpointChallenge) -> Unit,
    onDismissError: () -> Unit,
) {
    var pairingVisible by remember { mutableStateOf(state.taskId.isEmpty()) }
    var challengeTarget by remember { mutableStateOf<RemoteTask?>(null) }

    Scaffold(
        // 让 testTag 以 resource-id 暴露给 UiAutomator：这是 Android 上与
        // iOS accessibilityIdentifier 真正对等的那一步，缺了它标识只在
        // Compose 测试里可见，外部机器就查不到。
        modifier = Modifier.semantics { testTagsAsResourceId = true },
        topBar = {
            TopAppBar(title = {
                Column {
                    Text("影核 · 一核多影", fontWeight = FontWeight.Bold)
                    Text(
                        "同步动作与状态，不同步屏幕",
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            })
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { Spacer(Modifier.height(4.dp)) }

            item {
                StatusCard(state) { pairingVisible = !pairingVisible }
            }

            if (pairingVisible) {
                item {
                    PairingCard(
                        state = state,
                        onPairWithCode = { relay, task, code, name ->
                            onPairWithCode(relay, task, code, name)
                            pairingVisible = false
                        },
                        onSave = { relay, task, token ->
                            onSavePairing(relay, task, token)
                            pairingVisible = false
                        },
                        onForget = onForgetPairing,
                    )
                }
            }

            val challenges = state.shadow.challenges.values.sortedBy { it.issuedAt }
            if (challenges.isNotEmpty()) {
                item { SectionTitle("Owner 确认挑战") }
                items(challenges, key = { it.requestId }) { challenge ->
                    ChallengeCard(
                        challenge = challenge,
                        busy = challenge.requestId in state.busyRequests,
                        onConfirm = { onConfirmChallenge(challenge) },
                    )
                }
            }

            val tasks = state.shadow.tasks.values.sortedBy { it.title }
            if (tasks.isNotEmpty()) {
                item { SectionTitle("任务") }
                items(tasks, key = { it.id }) { task ->
                    TaskCard(task) { challengeTarget = task }
                }
            }

            val results = state.shadow.results.values.toList().takeLast(5).reversed()
            if (results.isNotEmpty()) {
                item { SectionTitle("动作核心回执") }
                items(results, key = { it.requestId }) { ResultCard(it) }
            }

            item { Spacer(Modifier.height(24.dp)) }
        }
    }

    challengeTarget?.let { task ->
        ChallengeRequestDialog(
            task = task,
            onDismiss = { challengeTarget = null },
            onSubmit = { reason, mode ->
                onRequestChallenge(reason, mode)
                challengeTarget = null
            },
        )
    }

    state.error?.let { message ->
        AlertDialog(
            onDismissRequest = onDismissError,
            confirmButton = { TextButton(onClick = onDismissError) { Text("知道了") } },
            title = { Text("出错了") },
            text = { Text(message) },
        )
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
}

@Composable
private fun StatusCard(state: ShadowUiState, onTogglePairing: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    if (state.connected) "已连接" else "未连接",
                    fontWeight = FontWeight.Bold,
                    color = if (state.connected) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.error
                    },
                )
                TextButton(onClick = onTogglePairing) { Text("配对设置") }
            }
            Text(state.message, style = MaterialTheme.typography.bodySmall)
            if (state.taskId.isNotEmpty()) {
                Text(
                    "任务 ${state.taskId}",
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                )
            }
            // 省流量不是口号，是这台手机这次会话的实际收字节数。
            Text(
                "同步 ${state.syncCount} 次 · 实收 ${formatBytes(state.bytesReceived)}",
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

@Composable
private fun PairingCard(
    state: ShadowUiState,
    onPairWithCode: (String, String, String, String) -> Unit,
    onSave: (String, String, String) -> Unit,
    onForget: () -> Unit,
) {
    var relay by remember { mutableStateOf(state.relayUrl.ifEmpty { "https://api.clawme.net" }) }
    var task by remember { mutableStateOf(state.taskId) }
    var code by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    // 配对码是默认路径；手抄令牌留给没有 relay 管理权限的场景。
    var manualToken by remember { mutableStateOf(false) }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Relay 配对", fontWeight = FontWeight.Bold)
            OutlinedTextField(
                value = relay,
                onValueChange = { relay = it },
                label = { Text("Relay 地址") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = task,
                onValueChange = { task = it },
                label = { Text("任务 ID") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            if (manualToken) {
                OutlinedTextField(
                    value = token,
                    onValueChange = { token = it },
                    label = { Text(if (state.hasToken) "配对令牌（留空则沿用已存）" else "配对令牌") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "公网 Relay 必须 HTTPS；令牌加密后存入 Android Keystore。",
                    style = MaterialTheme.typography.labelSmall,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { onSave(relay, task, token) }) { Text("保存并同步") }
                    TextButton(onClick = { manualToken = false }) { Text("改用配对码") }
                }
            } else {
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it },
                    label = { Text("配对码") },
                    placeholder = { Text("ABCDE-12345") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag(ShadowTestTags.PAIRING_REDEEM),
                )
                Text(
                    "在电脑上执行 clawme pair 取得配对码。它几分钟后失效、只能用一次；" +
                        "换来的令牌只属于这台手机，丢了可以单独吊销。",
                    style = MaterialTheme.typography.labelSmall,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { onPairWithCode(relay, task, code, Build.MODEL ?: "Android") },
                        enabled = code.isNotBlank(),
                    ) { Text("配对这台手机") }
                    TextButton(onClick = { manualToken = true }) { Text("手动填令牌") }
                }
            }

            if (state.hasToken) {
                OutlinedButton(onClick = onForget) { Text("解除配对") }
            }
        }
    }
}

@Composable
private fun ChallengeCard(
    challenge: ShadowCheckpointChallenge,
    busy: Boolean,
    onConfirm: () -> Unit,
) {
    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.tertiaryContainer,
        ),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text("Owner 确认挑战", fontWeight = FontWeight.Bold)
                Text(challenge.mode.title, style = MaterialTheme.typography.labelMedium)
            }
            Text(challenge.reason)
            // 影核协议要求：确认前必须让人看见动作、状态版本和有效期。
            Text(
                "动作：${challenge.actionId} · 状态版本 ${challenge.expectedStateVersion}",
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
            )
            Text(
                "有效期至 ${challenge.expiresAt}",
                style = MaterialTheme.typography.labelSmall,
            )
            Button(
                onClick = onConfirm,
                enabled = !busy,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag(ShadowTestTags.CHECKPOINT_CREATE),
            ) {
                if (busy) {
                    CircularProgressIndicator(Modifier.height(16.dp))
                    Spacer(Modifier.height(8.dp))
                }
                Text(if (busy) "正在交给 Owner…" else "确认并保存接班点")
            }
        }
    }
}

@Composable
private fun TaskCard(task: RemoteTask, onRequestChallenge: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(task.title, fontWeight = FontWeight.Bold)
            Text(task.status, style = MaterialTheme.typography.labelSmall)
            task.summary?.takeIf { it.isNotEmpty() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall)
            }
            Button(
                onClick = onRequestChallenge,
                modifier = Modifier.testTag(ShadowTestTags.CHECKPOINT_CHALLENGE),
            ) {
                Text("保存接班点")
            }
        }
    }
}

@Composable
private fun ResultCard(result: ShadowActionResult) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                if (result.ok) "动作核心已保存检查点" else "动作未执行",
                fontWeight = FontWeight.Bold,
                color = if (result.ok) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.error
                },
            )
            Text(
                result.actionId,
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
            )
            result.checkpointId?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace)
            }
            (result.errorMessage ?: result.errorCode)?.let {
                Text(it, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun ChallengeRequestDialog(
    task: RemoteTask,
    onDismiss: () -> Unit,
    onSubmit: (String, ShadowConfirmationMode) -> Unit,
) {
    var reason by remember { mutableStateOf("手机端请求保存当前接班点") }
    var mode by remember { mutableStateOf(ShadowConfirmationMode.SYSTEM) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("请求 Owner 挑战") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("checkpoint.create", fontFamily = FontFamily.Monospace)
                OutlinedTextField(
                    value = reason,
                    onValueChange = { reason = it },
                    label = { Text("保存原因") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Text("确认方式", style = MaterialTheme.typography.labelMedium)
                ShadowConfirmationMode.entries.forEach { option ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .selectable(selected = mode == option, onClick = { mode = option }),
                        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = mode == option, onClick = { mode = option })
                        Text(option.title)
                    }
                }
                Text(
                    "Relay 只排队；检查点由 ${task.title} 所在电脑的动作核心执行。",
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onSubmit(reason, mode) },
                enabled = reason.isNotBlank(),
            ) { Text("发送") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

private fun formatBytes(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> String.format("%.1f KB", bytes / 1024.0)
    else -> String.format("%.2f MB", bytes / (1024.0 * 1024.0))
}
