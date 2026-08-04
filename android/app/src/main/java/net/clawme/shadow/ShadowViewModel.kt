package net.clawme.shadow

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import net.clawme.shadow.protocol.ShadowActions
import net.clawme.shadow.protocol.ShadowCheckpointChallenge
import net.clawme.shadow.protocol.ShadowConfirmationMode
import net.clawme.shadow.protocol.ShadowProjection
import net.clawme.shadow.protocol.ShadowRelayClient
import net.clawme.shadow.protocol.ShadowRelayException
import net.clawme.shadow.protocol.ShadowState
import net.clawme.shadow.protocol.SyncEnvelope

/** 当前用哪条路收变化。界面上直接显示，因为这决定了流量和延迟。 */
enum class Transport(val label: String) {
    STREAM("推送"),
    POLLING("轮询"),
}

data class ShadowUiState(
    val relayUrl: String = "",
    val taskId: String = "",
    val hasToken: Boolean = false,
    val connected: Boolean = false,
    val transport: Transport = Transport.POLLING,
    val shadow: ShadowState = ShadowState(),
    val busyRequests: Set<String> = emptySet(),
    /** 会话内的同步次数与实收字节 —— 界面上直接显示，「省流量」不靠嘴说。 */
    val syncCount: Int = 0,
    val bytesReceived: Long = 0,
    val message: String = "尚未配对",
    val error: String? = null,
)

/**
 * 手机影子的运行时。
 *
 * 它只做三件事：按游标拉自己缺的那一段、把 owner 的挑战摆到用户面前、
 * 把用户的确认交回 owner 执行。任何动作都不在手机上实现第二遍。
 */
class ShadowViewModel(application: Application) : AndroidViewModel(application) {

    private val tokens = SecureTokenStore(application)
    private val settings = ShadowSettings(application)

    private val _state = MutableStateFlow(
        ShadowUiState(
            relayUrl = settings.relayUrl,
            taskId = settings.taskId,
            hasToken = tokens.read() != null,
        )
    )
    val state: StateFlow<ShadowUiState> = _state.asStateFlow()

    private var pollJob: Job? = null

    init {
        // 冷启动时把上次的游标读回来，避免重放已经看过的历史。
        val taskId = settings.taskId
        if (taskId.isNotEmpty()) {
            settings.cursor(taskId)?.let { cursor ->
                _state.value = _state.value.copy(
                    shadow = _state.value.shadow.copy(cursors = mapOf(taskId to cursor))
                )
            }
        }
        if (isConfigured()) connect()
    }

    fun savePairing(relayUrl: String, taskId: String, token: String) {
        val trimmedTask = taskId.trim()
        val trimmedToken = token.trim()
        try {
            // 地址合法性和 HTTPS 强制在这里就判掉，别等到发请求才炸。
            ShadowRelayClient.normalizeBase(relayUrl)
        } catch (error: ShadowRelayException) {
            _state.value = _state.value.copy(error = error.message)
            return
        }
        if (trimmedTask.isEmpty()) {
            _state.value = _state.value.copy(error = "任务 ID 不能为空")
            return
        }
        if (trimmedToken.isEmpty() && tokens.read() == null) {
            _state.value = _state.value.copy(error = "首次配对必须填写令牌")
            return
        }
        if (trimmedToken.isNotEmpty()) tokens.save(trimmedToken)
        settings.relayUrl = relayUrl.trim().trimEnd('/')
        settings.taskId = trimmedTask
        _state.value = _state.value.copy(
            relayUrl = settings.relayUrl,
            taskId = trimmedTask,
            hasToken = true,
            error = null,
            message = "已保存配对，正在同步…",
        )
        connect()
    }

    /**
     * 用配对码完成配对。
     *
     * 这条路径比手抄令牌好在两处：用户输的是 10 位、短期有效、一次性的码；
     * 换来的令牌只属于这台设备，丢了手机可以在 relay 上单独吊销，不用换掉
     * 所有端的凭据、也不用重启 relay。
     */
    fun pairWithCode(relayUrl: String, taskId: String, code: String, deviceName: String) {
        val trimmedTask = taskId.trim()
        if (trimmedTask.isEmpty()) {
            _state.value = _state.value.copy(error = "任务 ID 不能为空")
            return
        }
        viewModelScope.launch {
            _state.value = _state.value.copy(message = "正在配对…", error = null)
            try {
                val paired = withContext(Dispatchers.IO) {
                    ShadowRelayClient.redeemPairingCode(relayUrl, code, deviceName)
                }
                tokens.save(paired.token)
                settings.relayUrl = relayUrl.trim().trimEnd('/')
                settings.taskId = trimmedTask
                _state.value = _state.value.copy(
                    relayUrl = settings.relayUrl,
                    taskId = trimmedTask,
                    hasToken = true,
                    message = "已配对为 ${paired.name ?: paired.deviceId}",
                    error = null,
                )
                connect()
            } catch (error: Exception) {
                _state.value = _state.value.copy(error = error.message ?: "配对失败")
            }
        }
    }

    fun forgetPairing() {
        disconnect()
        tokens.delete()
        settings.clear()
        _state.value = ShadowUiState(message = "已解除配对")
    }

    fun connect() {
        if (!isConfigured()) {
            _state.value = _state.value.copy(message = "请先完成 Relay 配对", connected = false)
            return
        }
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            while (isActive) {
                // 先试长连接：relay 有变化才发，省掉每三秒一次的请求头。
                val streamed = runCatching { streamLoop() }
                if (!isActive) break
                if (streamed.isFailure) {
                    _state.value = _state.value.copy(
                        transport = Transport.POLLING,
                        connected = false,
                        error = null, // 流断掉是常态，不该弹给用户看
                    )
                }
                // 流断开期间照样要追上进度，游标不变所以两条路可以随时互换。
                syncOnce()
                delay(POLL_INTERVAL_MS)
            }
        }
    }

    /** 阻塞在 IO 线程上读流，直到断开或被取消。 */
    private suspend fun streamLoop() {
        val client = client() ?: return
        val taskId = _state.value.taskId
        withContext(Dispatchers.IO) {
            client.streamSync(
                taskId = taskId,
                after = _state.value.shadow.cursor(taskId),
                isActive = { isActive },
                onEnvelope = { envelope, bytes -> applyEnvelope(taskId, envelope, bytes, Transport.STREAM) },
            )
        }
    }

    fun disconnect() {
        pollJob?.cancel()
        pollJob = null
        _state.value = _state.value.copy(connected = false, message = "已断开")
    }

    fun dismissError() {
        _state.value = _state.value.copy(error = null)
    }

    /**
     * 请求 owner 签发挑战。手机不发送 actor 身份 —— relay 用配对令牌推导执行者。
     */
    fun requestChallenge(
        reason: String,
        mode: ShadowConfirmationMode,
        actionId: String = ShadowActions.CHECKPOINT_CREATE,
    ) {
        val client = client() ?: return
        val taskId = _state.value.taskId
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    client.requestChallenge(taskId, reason, mode, actionId)
                }
                _state.value = _state.value.copy(message = "已请求 owner 确认挑战", error = null)
                syncOnce()
            } catch (error: Exception) {
                _state.value = _state.value.copy(error = error.message ?: "请求挑战失败")
            }
        }
    }

    /**
     * 确认并交给 owner 执行。
     *
     * [authenticate] 由界面提供（BiometricPrompt 绑定 Activity）。认证在本机完成，
     * 上行只带确认时间和模式：生物特征与可复用凭据一律不出这台手机。
     */
    fun confirmChallenge(
        challenge: ShadowCheckpointChallenge,
        authenticate: suspend (ShadowCheckpointChallenge) -> Unit,
    ) {
        if (challenge.requestId in _state.value.busyRequests) return
        val client = client() ?: return
        viewModelScope.launch {
            _state.value = _state.value.copy(
                busyRequests = _state.value.busyRequests + challenge.requestId,
                error = null,
            )
            try {
                authenticate(challenge)
                val confirmedAt = Instant.now().toString()
                withContext(Dispatchers.IO) {
                    client.confirmChallenge(challenge.taskId, challenge.requestId, confirmedAt)
                }
                _state.value = _state.value.copy(message = "确认已交给 owner 执行")
                // 结果通过同一条游标流回来，不另开通道。
                repeat(RESULT_POLL_ATTEMPTS) {
                    if (_state.value.shadow.results.containsKey(challenge.requestId)) return@repeat
                    delay(POLL_INTERVAL_MS)
                    syncOnce()
                }
            } catch (error: Exception) {
                _state.value = _state.value.copy(error = error.message ?: "确认失败")
            } finally {
                _state.value = _state.value.copy(
                    busyRequests = _state.value.busyRequests - challenge.requestId,
                )
            }
        }
    }

    /** 把一个信封投影进界面状态并推进游标。流和轮询共用这一条路径。 */
    private fun applyEnvelope(
        taskId: String,
        envelope: SyncEnvelope,
        bytes: Int,
        transport: Transport,
    ) {
        val current = _state.value
        val projected = ShadowProjection.apply(current.shadow, envelope, taskId)
        settings.saveCursor(taskId, envelope.payload.cursor)
        _state.value = current.copy(
            shadow = projected,
            connected = true,
            transport = transport,
            syncCount = current.syncCount + 1,
            bytesReceived = current.bytesReceived + bytes,
            message = "${envelope.type} · v${envelope.payload.stateVersion}",
            error = null,
        )
    }

    /** 拉一轮增量，has_more 时继续翻页，直到追平或到达页数上限。 */
    private suspend fun syncOnce() {
        val client = client() ?: return
        val taskId = _state.value.taskId
        try {
            var pages = 0
            while (pages < MAX_PAGES) {
                pages += 1
                val fetch = withContext(Dispatchers.IO) {
                    client.sync(taskId, _state.value.shadow.cursor(taskId))
                }
                applyEnvelope(taskId, fetch.envelope, fetch.responseBytes, Transport.POLLING)
                if (fetch.envelope.payload.hasMore != true) break
            }
        } catch (error: Exception) {
            _state.value = _state.value.copy(
                connected = false,
                error = error.message ?: "同步失败",
            )
        }
    }

    private fun isConfigured(): Boolean =
        settings.relayUrl.isNotEmpty() && settings.taskId.isNotEmpty() && tokens.read() != null

    private fun client(): ShadowRelayClient? {
        val token = tokens.read()
        if (settings.relayUrl.isEmpty() || settings.taskId.isEmpty() || token == null) {
            _state.value = _state.value.copy(error = "请先完成 Relay 配对")
            return null
        }
        return runCatching { ShadowRelayClient(settings.relayUrl, token) }
            .onFailure { _state.value = _state.value.copy(error = it.message) }
            .getOrNull()
    }

    private companion object {
        const val POLL_INTERVAL_MS = 3_000L
        const val MAX_PAGES = 10
        const val RESULT_POLL_ATTEMPTS = 20
    }
}
