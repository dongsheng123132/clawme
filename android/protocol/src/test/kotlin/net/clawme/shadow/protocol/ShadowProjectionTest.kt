package net.clawme.shadow.protocol

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * 影核协议一致性测试 —— Android 端，纯 JVM，毫秒级。
 *
 * 关键点：读的是 `fixtures/shadowcore/` 里由**后端亲自吐出来**的信封
 * （`backend/scripts/emit-shadow-fixtures.mjs` 生成），不是这里手搓的假数据。
 * 后端改了线上格式而没同步各端，这些测试当场红，不用等装到手机上才发现。
 */
class ShadowProjectionTest {

    private val fixtureDir = File("../../fixtures/shadowcore")

    private fun envelope(name: String): SyncEnvelope {
        val file = File(fixtureDir, name)
        assertTrue(
            "缺少影核 fixture ${file.path}；先跑 backend/scripts/emit-shadow-fixtures.mjs",
            file.isFile,
        )
        return ShadowJson.decodeFromString(SyncEnvelope.serializer(), file.readText())
    }

    private fun projectAll(vararg names: String): ShadowState =
        names.fold(ShadowState()) { state, name ->
            ShadowProjection.apply(state, envelope(name), TASK_ID)
        }

    @Test
    fun `snapshot 建立基线并交出可续传的游标`() {
        val state = projectAll("task-snapshot.json")

        assertEquals(SYNC_PROTOCOL, envelope("task-snapshot.json").protocolVersion)
        assertEquals("sync.snapshot", state.lastEnvelopeType)
        val task = state.tasks.getValue(TASK_ID)
        assertEquals("Save a handoff checkpoint", task.title)
        assertEquals("running", task.status)
        assertEquals("uu-rescue", task.provider)
        // 游标是不透明的：手机只负责原样回传，不解析、不构造。
        assertNotNull(state.cursor(TASK_ID))
    }

    @Test
    fun `delta 只带游标之后的事件并推进任务状态`() {
        val state = projectAll("task-snapshot.json", "task-progress-delta.json")

        assertEquals("sync.delta", state.lastEnvelopeType)
        assertEquals("已完成 5/8 段", state.tasks.getValue(TASK_ID).summary)
        assertEquals(2, state.eventsOf(TASK_ID).size)
        // 事件按 sequence 严格递增，界面才能安全地按顺序渲染。
        assertEquals(
            state.eventsOf(TASK_ID).map { it.sequence }.sorted(),
            state.eventsOf(TASK_ID).map { it.sequence },
        )
    }

    @Test
    fun `重复投递同一段 delta 不会把事件算两遍`() {
        // relay 承诺至少一次投递，所以重复是正常现象，不是异常。
        val once = projectAll("task-snapshot.json", "task-progress-delta.json")
        val twice = ShadowProjection.apply(
            once,
            envelope("task-progress-delta.json"),
            TASK_ID,
        )

        assertEquals(once.eventsOf(TASK_ID).size, twice.eventsOf(TASK_ID).size)
        assertEquals(once.cursor(TASK_ID), twice.cursor(TASK_ID))
    }

    @Test
    fun `挑战事件带着动作、状态版本和有效期到达手机`() {
        val state = projectAll(
            "task-snapshot.json",
            "task-progress-delta.json",
            "checkpoint-challenge-delta.json",
        )

        assertEquals(1, state.challenges.size)
        val challenge = state.challenges.values.single()
        // 影核协议不接受"确定吗？"——确认必须绑定到具体动作和具体状态版本。
        assertEquals(ShadowActions.CHECKPOINT_CREATE, challenge.actionId)
        assertEquals("challenge-owner-1", challenge.challengeId)
        assertEquals(4, challenge.expectedStateVersion)
        assertEquals(ShadowConfirmationMode.BIOMETRIC, challenge.mode)
        assertEquals("手机确认保存当前接班点", challenge.reason)
        assertTrue(challenge.expiresAt.isNotEmpty())
    }

    @Test
    fun `owner 回执落地后挑战卡自动撤下`() {
        val state = projectAll(
            "task-snapshot.json",
            "task-progress-delta.json",
            "checkpoint-challenge-delta.json",
            "checkpoint-result-delta.json",
        )

        val result = state.results.values.single()
        assertTrue(result.ok)
        assertEquals("sync.result", result.resultType)
        assertEquals("checkpoint-1", result.checkpointId)
        assertEquals(ShadowActions.CHECKPOINT_CREATE, result.actionId)
        // 已执行的动作不该还摆着一个可以再按一次的确认按钮。
        assertTrue(state.challenges.isEmpty())
    }

    @Test
    fun `协议标识不认识就断线，绝不猜着解析`() {
        val tampered = envelope("task-snapshot.json").copy(protocolVersion = "action-parity/sync@9.9")
        try {
            ShadowProjection.apply(ShadowState(), tampered, TASK_ID)
            fail("未知协议版本必须被拒绝")
        } catch (expected: ShadowProtocolException) {
            assertTrue(expected.message!!.contains("action-parity/sync@9.9"))
        }
    }

    @Test
    fun `字段类型不对就当没有，绝不强转崩溃`() {
        val event = SyncEvent(
            eventId = "e1",
            sequence = 1,
            kind = "sync.challenge",
            occurredAt = "2026-01-01T00:00:00.000Z",
            entity = SyncEntity("task", TASK_ID),
            payload = ShadowJson.decodeFromString(
                kotlinx.serialization.json.JsonObject.serializer(),
                """{"request_id":123,"action_id":"checkpoint.create"}""",
            ),
        )
        // request_id 是数字而不是字符串 —— 缺字段的挑战不成立，直接丢弃。
        assertNull(ShadowProjection.challengeFrom(event))
    }

    private companion object {
        const val TASK_ID = "shadow-task"
    }
}
