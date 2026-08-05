package net.clawme.shadow.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * ClawMe 影核（ShadowCore）线上契约 —— Android 原生影子端。
 *
 * 这份文件是 `ios/ClawMe/Models/SyncEnvelope.swift` 的逐字对照物：同一套
 * `action-parity/sync@0.1` 信封，同一组字段名。两端各自原生，但说的是同一种话。
 *
 * 刻意只依赖 kotlinx.serialization，不碰任何 Android API —— 于是整个协议层
 * 能在普通 JVM 单元测试里跑，不需要设备、模拟器或截图。
 */
const val SYNC_PROTOCOL: String = "action-parity/sync@0.1"

/** 手机端只认这几个 Action ID，全部在 action-parity.json 里声明。 */
object ShadowActions {
    const val TASK_STATUS = "task.status"
    const val TASK_EVENTS = "task.events"
    const val CHECKPOINT_CHALLENGE = "checkpoint.challenge"
    const val CHECKPOINT_CREATE = "checkpoint.create"
}

val ShadowJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
}

@Serializable
data class SyncEntity(
    val type: String,
    val id: String,
)

@Serializable
data class SyncEvent(
    @SerialName("event_id") val eventId: String,
    val sequence: Int,
    val kind: String,
    @SerialName("occurred_at") val occurredAt: String,
    val entity: SyncEntity,
    val payload: JsonObject = JsonObject(emptyMap()),
)

@Serializable
data class RemoteTask(
    val id: String,
    val machineId: String,
    val provider: String,
    val title: String,
    val status: String,
    val summary: String? = null,
    val nativeThreadId: String? = null,
    val nativeTurnId: String? = null,
    val createdAt: String,
    val updatedAt: String,
)

/**
 * owner 电脑上一个可以启动的程序。
 *
 * 注意它没有命令行、没有路径、也没有图片：手机拿到的是身份和怎么把它画出来，
 * 执行由 owner 从自己的白名单里查。图标是一个短标签加一个颜色 —— 连启动器都
 * 不传像素。
 */
@Serializable
data class RemoteApp(
    val id: String,
    val name: String,
    val label: String? = null,
    val color: String? = null,
)

@Serializable
data class RemoteMachine(
    val id: String,
    val name: String,
    val platform: String = "unknown",
    val agentVersion: String = "",
    val capabilities: List<String> = emptyList(),
    val apps: List<RemoteApp> = emptyList(),
    val lastSeenAt: String = "",
)

@Serializable
internal data class MachineListResponse(val machines: List<RemoteMachine> = emptyList())

@Serializable
internal data class TaskListResponse(val tasks: List<RemoteTask> = emptyList())

@Serializable
internal data class LaunchResponse(
    @SerialName("command_id") val commandId: String,
    val status: String = "queued",
)

@Serializable
data class CommandStatus(
    @SerialName("command_id") val commandId: String,
    val type: String = "",
    val status: String = "queued",
    val result: JsonObject? = null,
) {
    val ok: Boolean
        get() = (result?.get("ok") as? kotlinx.serialization.json.JsonPrimitive)
            ?.let { if (it.isString) null else it.content.toBooleanStrictOrNull() } == true

    /** owner 报回来的失败原因；开没开起来只有它知道，手机不猜。 */
    val failure: String?
        get() = (result?.get("error") as? kotlinx.serialization.json.JsonPrimitive)
            ?.takeIf { it.isString }?.content
}

@Serializable
data class RemoteAttentionOption(
    val id: String,
    val label: String,
    val tone: String? = null,
)

@Serializable
data class RemoteAttention(
    val id: String,
    val taskId: String,
    val machineId: String,
    val kind: String,
    val title: String,
    val detail: String? = null,
    val risk: String? = null,
    val options: List<RemoteAttentionOption> = emptyList(),
    val status: String,
)

@Serializable
data class TaskSyncState(
    val task: RemoteTask,
    val attention: List<RemoteAttention> = emptyList(),
)

@Serializable
data class SyncPayload(
    @SerialName("previous_cursor") val previousCursor: String? = null,
    val cursor: String,
    @SerialName("state_version") val stateVersion: Int,
    @SerialName("schema_version") val schemaVersion: String? = null,
    @SerialName("has_more") val hasMore: Boolean? = null,
    val state: TaskSyncState? = null,
    val events: List<SyncEvent>? = null,
)

@Serializable
data class SyncEnvelope(
    @SerialName("protocol") val protocolVersion: String,
    val type: String,
    @SerialName("stream_id") val streamId: String,
    @SerialName("message_id") val messageId: String,
    @SerialName("sent_at") val sentAt: String,
    val payload: SyncPayload,
)

/** 确认方式由 owner 在挑战里指定，手机不自选降级。 */
enum class ShadowConfirmationMode(val wire: String, val title: String) {
    EXPLICIT("explicit", "明确确认"),
    BIOMETRIC("biometric", "生物识别"),
    SYSTEM("system", "系统认证");

    companion object {
        fun fromWire(value: String?): ShadowConfirmationMode? =
            entries.firstOrNull { it.wire == value }
    }
}

/**
 * owner 节点签发的一次性挑战。它把「确认」绑定到具体动作、输入摘要和状态版本，
 * 而不是一句「确定吗？」——这是影核协议不肯让步的地方。
 */
data class ShadowCheckpointChallenge(
    val requestId: String,
    val taskId: String,
    val actionId: String,
    val reason: String,
    val mode: ShadowConfirmationMode,
    val challengeId: String,
    val expectedStateVersion: Int,
    val issuedAt: String,
    val expiresAt: String,
)

data class ShadowActionResult(
    val requestId: String,
    val taskId: String,
    val actionId: String,
    val ok: Boolean,
    val resultType: String,
    val checkpointId: String? = null,
    val checkpointSha256: String? = null,
    val errorCode: String? = null,
    val errorMessage: String? = null,
)
