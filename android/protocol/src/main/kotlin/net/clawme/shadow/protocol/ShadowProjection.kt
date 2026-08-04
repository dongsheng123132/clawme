package net.clawme.shadow.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull

/** 信封不是本协议、或者被截断到无法解释时抛出。手机宁可断线，也不猜。 */
class ShadowProtocolException(message: String) : IllegalArgumentException(message)

/**
 * 影子端的完整可观察状态。
 *
 * 它是不可变的：每个信封进来产出一个新状态。于是「收到这串事件后界面该是什么样」
 * 变成一个纯函数问题，可以在 JVM 上用毫秒级断言测，不需要把手机接上。
 */
data class ShadowState(
    /** 每个任务各自的不透明游标；断线重连从这里续传，而不是从头重放。 */
    val cursors: Map<String, String> = emptyMap(),
    val stateVersion: Int = 0,
    val tasks: Map<String, RemoteTask> = emptyMap(),
    val attention: Map<String, List<RemoteAttention>> = emptyMap(),
    val events: Map<String, List<SyncEvent>> = emptyMap(),
    val challenges: Map<String, ShadowCheckpointChallenge> = emptyMap(),
    val results: Map<String, ShadowActionResult> = emptyMap(),
    val lastEnvelopeType: String? = null,
) {
    fun cursor(taskId: String): String? = cursors[taskId]

    fun eventsOf(taskId: String): List<SyncEvent> = events[taskId].orEmpty()
}

/**
 * 把 snapshot / delta 信封投影成界面状态。
 *
 * 与 iOS `ConnectionManager.applySyncEnvelope` 同语义：
 * 1. 推进本任务游标；
 * 2. snapshot 重置基线，delta 只叠加游标之后的事件；
 * 3. 按 event_id 去重、按 sequence 排序 —— 至少一次投递下重复事件不会算两遍；
 * 4. 从事件流里提取 owner 挑战与执行结果。
 */
object ShadowProjection {

    fun apply(state: ShadowState, envelope: SyncEnvelope, taskId: String): ShadowState {
        if (envelope.protocolVersion != SYNC_PROTOCOL) {
            throw ShadowProtocolException(
                "不支持的 ClawMe 同步协议：${envelope.protocolVersion}"
            )
        }

        var tasks = state.tasks
        var attention = state.attention
        var events = state.events
        var challenges = state.challenges
        var results = state.results

        envelope.payload.state?.let { snapshot ->
            tasks = tasks + (snapshot.task.id to snapshot.task)
            attention = attention + (snapshot.task.id to snapshot.attention)
        }

        for (event in envelope.payload.events.orEmpty()) {
            val entityId = event.entity.id
            val existing = events[entityId].orEmpty()
            if (existing.none { it.eventId == event.eventId }) {
                events = events + (entityId to (existing + event).sortedBy { it.sequence })
            }

            tasks[entityId]?.let { task ->
                tasks = tasks + (entityId to task.advancedBy(event))
            }

            challengeFrom(event)?.let { challenges = challenges + (it.requestId to it) }
            resultFrom(event)?.let {
                results = results + (it.requestId to it)
                // 结果落地即撤下挑战卡，避免用户对着已执行的动作再按一次。
                challenges = challenges - it.requestId
            }
        }

        return state.copy(
            cursors = state.cursors + (taskId to envelope.payload.cursor),
            stateVersion = envelope.payload.stateVersion,
            tasks = tasks,
            attention = attention,
            events = events,
            challenges = challenges,
            results = results,
            lastEnvelopeType = envelope.type,
        )
    }

    private fun RemoteTask.advancedBy(event: SyncEvent): RemoteTask {
        val nextStatus = when {
            event.kind == "attention.input_required" -> "waiting"
            else -> event.payload.stringOrNull("status") ?: status
        }
        return copy(
            status = nextStatus,
            summary = event.payload.stringOrNull("message") ?: summary,
        )
    }

    internal fun challengeFrom(event: SyncEvent): ShadowCheckpointChallenge? {
        if (event.kind != "sync.challenge") return null
        val payload = event.payload
        val requestId = payload.stringOrNull("request_id") ?: return null
        val actionId = payload.stringOrNull("action_id") ?: return null
        val reason = payload.stringOrNull("reason") ?: return null
        val mode = ShadowConfirmationMode.fromWire(
            payload.stringOrNull("confirmation_mode")
        ) ?: return null
        val challengeId = payload.stringOrNull("challenge_id") ?: return null
        val stateVersion = payload.intOrNull("expected_state_version") ?: return null
        val issuedAt = payload.stringOrNull("challenge_issued_at") ?: return null
        val expiresAt = payload.stringOrNull("challenge_expires_at") ?: return null
        return ShadowCheckpointChallenge(
            requestId = requestId,
            taskId = event.entity.id,
            actionId = actionId,
            reason = reason,
            mode = mode,
            challengeId = challengeId,
            expectedStateVersion = stateVersion,
            issuedAt = issuedAt,
            expiresAt = expiresAt,
        )
    }

    internal fun resultFrom(event: SyncEvent): ShadowActionResult? {
        if (event.kind !in RESULT_KINDS) return null
        val payload = event.payload
        val requestId = payload.stringOrNull("request_id") ?: return null
        return ShadowActionResult(
            requestId = requestId,
            taskId = event.entity.id,
            actionId = payload.stringOrNull("action_id") ?: ShadowActions.CHECKPOINT_CREATE,
            ok = event.kind == "sync.result" && payload.booleanOrNull("ok") == true,
            resultType = event.kind,
            checkpointId = payload.stringOrNull("checkpoint_id"),
            checkpointSha256 = payload.stringOrNull("checkpoint_sha256"),
            errorCode = payload.stringOrNull("error_code"),
            errorMessage = payload.stringOrNull("error_message"),
        )
    }

    private val RESULT_KINDS = setOf("sync.result", "sync.conflict", "sync.challenge.failed")
}

// 取值规则与 iOS 的 JSONValue 访问器一致：类型不对就当没有，绝不强转。
private fun JsonObject.stringOrNull(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonObject.intOrNull(key: String): Int? =
    (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull

private fun JsonObject.booleanOrNull(key: String): Boolean? =
    (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
