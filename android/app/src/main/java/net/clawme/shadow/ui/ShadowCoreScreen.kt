package net.clawme.shadow.ui

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import net.clawme.shadow.ShadowUiState
import net.clawme.shadow.protocol.RemoteApp
import net.clawme.shadow.protocol.RemoteMachine
import net.clawme.shadow.protocol.RemoteTask
import net.clawme.shadow.protocol.ShadowActionResult
import net.clawme.shadow.protocol.ShadowCheckpointChallenge
import net.clawme.shadow.protocol.ShadowConfirmationMode

/**
 * ActionParity 绑定标识。
 *
 * 绑定检查和 UI 自动化都认它，不认按钮文案 —— 文案可以改、可以翻译、可以做 A/B，
 * 动作身份不能漂。`action-parity.json` 里 android 界面声明的就是这些值。
 */
object ShadowTestTags {
    const val CHECKPOINT_CHALLENGE = "clawme.action.checkpoint.challenge"
    const val CHECKPOINT_CREATE = "clawme.action.checkpoint.create"
    const val PAIRING_REDEEM = "clawme.action.pairing.redeem"
    const val APP_LAUNCH = "clawme.action.app.launch"
    const val MACHINE_SELECT = "clawme.action.machine.select"
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalComposeUiApi::class)
@Composable
fun ShadowCoreScreen(
    state: ShadowUiState,
    onPairWithCode: (String, String, String) -> Unit,
    onSavePairing: (String, String) -> Unit,
    onForgetPairing: () -> Unit,
    onSelectMachine: (String) -> Unit,
    onSelectTask: (String) -> Unit,
    onLaunchApp: (RemoteApp) -> Unit,
    onRequestChallenge: (String, ShadowConfirmationMode) -> Unit,
    onConfirmChallenge: (ShadowCheckpointChallenge) -> Unit,
    onDismissError: () -> Unit,
) {
    var pairingVisible by remember { mutableStateOf(!state.hasToken) }
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
                .padding(padding),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { Spacer(Modifier.height(4.dp)) }

            item {
                StatusCard(state, Modifier.padding(horizontal = 16.dp)) {
                    pairingVisible = !pairingVisible
                }
            }

            if (pairingVisible) {
                item {
                    PairingCard(
                        state = state,
                        modifier = Modifier.padding(horizontal = 16.dp),
                        onPairWithCode = { relay, code, name ->
                            onPairWithCode(relay, code, name)
                            pairingVisible = false
                        },
                        onSave = { relay, token ->
                            onSavePairing(relay, token)
                            pairingVisible = false
                        },
                        onForget = onForgetPairing,
                    )
                }
            }

            // ── 第一层：切机器 ────────────────────────────────────
            if (state.machines.isNotEmpty()) {
                item { SectionTitle("电脑") }
                item {
                    MachineRow(
                        machines = state.machines,
                        selectedId = state.selectedMachine?.id,
                        onSelect = onSelectMachine,
                    )
                }
            }

            // ── 第二层：点图标在那台电脑上开程序 ──────────────────
            val machine = state.selectedMachine
            val apps = machine?.apps.orEmpty()
            if (machine != null) {
                item { SectionTitle("在 ${machine.name} 上打开") }
                if (apps.isEmpty()) {
                    item {
                        HintCard(
                            "这台电脑还没有声明可启动的程序。\n" +
                                "在 owner 代理的配置里列出要开放的程序，它会随心跳上报。",
                            Modifier.padding(horizontal = 16.dp),
                        )
                    }
                } else {
                    item {
                        AppGrid(
                            apps = apps,
                            launching = state.launching,
                            onLaunch = onLaunchApp,
                        )
                    }
                }
            }

            state.launchNote?.let { note ->
                item { HintCard(note, Modifier.padding(horizontal = 16.dp)) }
            }

            // ── 确认挑战：最要紧的东西排在任务前面 ────────────────
            val challenges = state.shadow.challenges.values.sortedBy { it.issuedAt }
            if (challenges.isNotEmpty()) {
                item { SectionTitle("Owner 确认挑战") }
                items(challenges, key = { it.requestId }) { challenge ->
                    ChallengeCard(
                        challenge = challenge,
                        busy = challenge.requestId in state.busyRequests,
                        modifier = Modifier.padding(horizontal = 16.dp),
                        onConfirm = { onConfirmChallenge(challenge) },
                    )
                }
            }

            // ── 任务：也可以横划切换 ──────────────────────────────
            if (state.tasks.isNotEmpty()) {
                item { SectionTitle("任务") }
                item {
                    TaskRow(
                        tasks = state.tasks,
                        selectedId = state.taskId,
                        onSelect = onSelectTask,
                    )
                }
                state.selectedTask?.let { task ->
                    item {
                        TaskDetailCard(
                            task = task,
                            modifier = Modifier.padding(horizontal = 16.dp),
                            onRequestChallenge = { challengeTarget = task },
                        )
                    }
                }
            }

            val results = state.shadow.results.values.toList().takeLast(5).reversed()
            if (results.isNotEmpty()) {
                item { SectionTitle("动作核心回执") }
                items(results, key = { it.requestId }) {
                    ResultCard(it, Modifier.padding(horizontal = 16.dp))
                }
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
    Text(
        text,
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(horizontal = 16.dp),
    )
}

@Composable
private fun HintCard(text: String, modifier: Modifier = Modifier) {
    Card(modifier.fillMaxWidth()) {
        Text(
            text,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(16.dp),
        )
    }
}

// ── 机器切换 ─────────────────────────────────────────────────

@Composable
private fun MachineRow(
    machines: List<RemoteMachine>,
    selectedId: String?,
    onSelect: (String) -> Unit,
) {
    LazyRow(
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        items(machines, key = { it.id }) { machine ->
            val selected = machine.id == selectedId
            Card(
                modifier = Modifier
                    .width(150.dp)
                    .testTag(ShadowTestTags.MACHINE_SELECT)
                    .selectable(selected = selected, onClick = { onSelect(machine.id) }),
                colors = CardDefaults.cardColors(
                    containerColor = if (selected) {
                        MaterialTheme.colorScheme.primaryContainer
                    } else {
                        MaterialTheme.colorScheme.surfaceVariant
                    },
                ),
            ) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        // 在线与否用一个点表示：owner 的心跳决定它，不是手机猜的。
                        Text(
                            if (machine.apps.isNotEmpty()) "●" else "○",
                            color = MaterialTheme.colorScheme.primary,
                            fontSize = 12.sp,
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(
                            machine.name,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Text(
                        "${machine.platform} · ${machine.apps.size} 个程序",
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
        }
    }
}

// ── 程序磁贴 ─────────────────────────────────────────────────

/**
 * 图标不是图片，是首字母加颜色。
 *
 * 传真图标要么把二进制塞进事件流，要么让手机去电脑上抓图 —— 两条都跟
 * 「同步动作不同步屏幕」相悖，而且为了几个像素引一堆麻烦。
 */
@Composable
private fun AppGrid(
    apps: List<RemoteApp>,
    launching: Set<String>,
    onLaunch: (RemoteApp) -> Unit,
) {
    val columns = 4
    Column(
        Modifier.padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        apps.chunked(columns).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                row.forEach { app ->
                    AppTile(
                        app = app,
                        busy = app.id in launching,
                        modifier = Modifier.weight(1f),
                        onLaunch = { onLaunch(app) },
                    )
                }
                // 补齐最后一行，避免图标被拉宽
                repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

@Composable
private fun AppTile(
    app: RemoteApp,
    busy: Boolean,
    modifier: Modifier = Modifier,
    onLaunch: () -> Unit,
) {
    val tint = remember(app.color) { parseColor(app.color) }
    Column(
        modifier = modifier
            .testTag(ShadowTestTags.APP_LAUNCH)
            .selectable(selected = false, enabled = !busy, onClick = onLaunch),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Surface(
            shape = RoundedCornerShape(16.dp),
            color = tint ?: MaterialTheme.colorScheme.secondaryContainer,
            modifier = Modifier.size(56.dp),
        ) {
            Box(contentAlignment = Alignment.Center) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(22.dp))
                } else {
                    Text(
                        app.label ?: app.name.take(2),
                        fontWeight = FontWeight.Bold,
                        color = if (tint != null) Color.White else MaterialTheme.colorScheme.onSecondaryContainer,
                    )
                }
            }
        }
        Text(
            app.name,
            style = MaterialTheme.typography.labelSmall,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
        )
    }
}

private fun parseColor(value: String?): Color? {
    if (value == null || !value.matches(Regex("^#[0-9a-fA-F]{6}$"))) return null
    return runCatching { Color(android.graphics.Color.parseColor(value)) }.getOrNull()
}

// ── 任务 ─────────────────────────────────────────────────────

@Composable
private fun TaskRow(tasks: List<RemoteTask>, selectedId: String, onSelect: (String) -> Unit) {
    LazyRow(
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        items(tasks, key = { it.id }) { task ->
            val selected = task.id == selectedId
            Card(
                modifier = Modifier
                    .width(170.dp)
                    .selectable(selected = selected, onClick = { onSelect(task.id) }),
                colors = CardDefaults.cardColors(
                    containerColor = if (selected) {
                        MaterialTheme.colorScheme.primaryContainer
                    } else {
                        MaterialTheme.colorScheme.surfaceVariant
                    },
                ),
            ) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        task.title,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text("${task.provider} · ${task.status}", style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
}

@Composable
private fun TaskDetailCard(
    task: RemoteTask,
    modifier: Modifier = Modifier,
    onRequestChallenge: () -> Unit,
) {
    Card(modifier.fillMaxWidth()) {
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

// ── 确认挑战 ─────────────────────────────────────────────────

@Composable
private fun ChallengeCard(
    challenge: ShadowCheckpointChallenge,
    busy: Boolean,
    modifier: Modifier = Modifier,
    onConfirm: () -> Unit,
) {
    Card(
        modifier.fillMaxWidth(),
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
                    CircularProgressIndicator(Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                }
                Text(if (busy) "正在交给 Owner…" else "确认并保存接班点")
            }
        }
    }
}

@Composable
private fun ResultCard(result: ShadowActionResult, modifier: Modifier = Modifier) {
    Card(modifier.fillMaxWidth()) {
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

// ── 状态与配对 ───────────────────────────────────────────────

@Composable
private fun StatusCard(state: ShadowUiState, modifier: Modifier = Modifier, onTogglePairing: () -> Unit) {
    Card(modifier.fillMaxWidth()) {
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
            // 省流量不是口号，是这台手机这次会话的实际收字节数。
            // 传输方式也一起显示：推送和轮询的流量差别就在这一行里。
            Text(
                "${state.transport.label} · 同步 ${state.syncCount} 次 · 实收 ${formatBytes(state.bytesReceived)}",
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

@Composable
private fun PairingCard(
    state: ShadowUiState,
    modifier: Modifier = Modifier,
    onPairWithCode: (String, String, String) -> Unit,
    onSave: (String, String) -> Unit,
    onForget: () -> Unit,
) {
    var relay by remember { mutableStateOf(state.relayUrl.ifEmpty { "https://api.clawme.net" }) }
    var code by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    // 配对码是默认路径；手抄令牌留给没有 relay 管理权限的场景。
    var manualToken by remember { mutableStateOf(false) }

    Card(modifier.fillMaxWidth()) {
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
                    Button(onClick = { onSave(relay, token) }) { Text("保存并同步") }
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
                        onClick = { onPairWithCode(relay, code, Build.MODEL ?: "Android") },
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
                        verticalAlignment = Alignment.CenterVertically,
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
