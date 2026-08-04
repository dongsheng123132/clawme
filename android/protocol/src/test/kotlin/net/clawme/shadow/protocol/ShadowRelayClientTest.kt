package net.clawme.shadow.protocol

import java.io.BufferedInputStream
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URLEncoder
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

private data class RecordedRequest(
    val method: String,
    val path: String,
    val query: String?,
    val headers: Map<String, String>,
    val body: String,
)

/**
 * 一个只够用来断言的 HTTP/1.1 服务端。
 *
 * 刻意不引 MockWebServer：Android 单元测试的 classpath 里没有 jdk.httpserver，
 * 而这里真正需要的只是"真 socket、真请求行、真 header、真 body"。四十行原始
 * 实现比多一个测试依赖更诚实 —— 被断言的是 ShadowRelayClient 实际发出去的字节。
 */
private class TinyRelay {
    private val server = ServerSocket(0, 0, InetAddress.getByName("127.0.0.1"))
    val requests = CopyOnWriteArrayList<RecordedRequest>()

    @Volatile
    var response: Pair<Int, String> = 200 to "{}"

    /**
     * 设成非 null 时按 SSE 应答：逐帧写出后关闭连接。
     * 每一项是一个完整的帧体（不含结尾空行），例如 "event: sync\ndata: {...}"。
     */
    @Volatile
    var streamFrames: List<String>? = null

    val port: Int get() = server.localPort

    init {
        thread(isDaemon = true) {
            while (!server.isClosed) {
                runCatching { server.accept() }.getOrNull()?.use { socket ->
                    val input = BufferedInputStream(socket.getInputStream())

                    fun readLine(): String {
                        val buffer = StringBuilder()
                        while (true) {
                            val byte = input.read()
                            if (byte == -1 || byte == '\n'.code) break
                            if (byte != '\r'.code) buffer.append(byte.toChar())
                        }
                        return buffer.toString()
                    }

                    val requestLine = readLine().split(' ')
                    if (requestLine.size < 2) return@use
                    val headers = mutableMapOf<String, String>()
                    while (true) {
                        val line = readLine()
                        if (line.isEmpty()) break
                        val separator = line.indexOf(':')
                        if (separator > 0) {
                            headers[line.substring(0, separator).trim().lowercase()] =
                                line.substring(separator + 1).trim()
                        }
                    }
                    val length = headers["content-length"]?.toIntOrNull() ?: 0
                    val body = ByteArray(length).also { if (length > 0) input.readNBytes(it, 0, length) }

                    val target = requestLine[1]
                    val split = target.indexOf('?')
                    requests += RecordedRequest(
                        method = requestLine[0],
                        path = if (split >= 0) target.substring(0, split) else target,
                        query = if (split >= 0) target.substring(split + 1) else null,
                        headers = headers,
                        body = body.toString(Charsets.UTF_8),
                    )

                    val frames = streamFrames
                    if (frames != null) {
                        // SSE：不带 Content-Length，逐帧写出，靠关闭连接结束。
                        socket.getOutputStream().apply {
                            write(
                                (
                                    "HTTP/1.1 200 OK\r\n" +
                                        "Content-Type: text/event-stream\r\n" +
                                        "Cache-Control: no-cache\r\n" +
                                        "Connection: close\r\n\r\n"
                                    ).toByteArray(Charsets.UTF_8)
                            )
                            flush()
                            for (frame in frames) {
                                write("$frame\n\n".toByteArray(Charsets.UTF_8))
                                flush()
                            }
                        }
                        return@use
                    }

                    val (status, payload) = response
                    val bytes = payload.toByteArray(Charsets.UTF_8)
                    socket.getOutputStream().apply {
                        write(
                            (
                                "HTTP/1.1 $status OK\r\n" +
                                    "Content-Type: application/json\r\n" +
                                    "Content-Length: ${bytes.size}\r\n" +
                                    "Connection: close\r\n\r\n"
                                ).toByteArray(Charsets.UTF_8)
                        )
                        write(bytes)
                        flush()
                    }
                }
            }
        }
    }

    fun close() = server.close()
}

/**
 * 手机 ↔ relay 的真实 HTTP 行为测试。
 *
 * 回放的响应体直接取自 `fixtures/shadowcore/`，也就是后端亲自吐出来的那批信封，
 * 而不是这里手搓的假数据。
 */
class ShadowRelayClientTest {

    private lateinit var relay: TinyRelay

    @Before
    fun start() {
        relay = TinyRelay()
    }

    @After
    fun stop() {
        relay.close()
    }

    private fun client() = ShadowRelayClient("http://127.0.0.1:${relay.port}", TOKEN)

    private fun fixture(name: String) = File("../../fixtures/shadowcore/$name").readText()

    @Test
    fun `首次同步不带游标，之后只请求游标之后的那一段`() {
        relay.response = 200 to fixture("task-snapshot.json")
        val snapshot = client().sync(TASK_ID, after = null)

        assertEquals(SYNC_PROTOCOL, snapshot.envelope.protocolVersion)
        assertEquals("sync.snapshot", snapshot.envelope.type)
        assertFalse("首次同步不该带 after", relay.requests[0].query!!.contains("after="))
        assertEquals(TOKEN, relay.requests[0].headers["x-clawme-token"])

        val cursor = snapshot.envelope.payload.cursor
        relay.response = 200 to fixture("task-progress-delta.json")
        client().sync(TASK_ID, after = cursor)

        // 游标必须原样带上去 —— 这就是"只传我缺的那一段"落到线上的样子。
        val query = relay.requests[1].query!!
        assertTrue(query.contains("after="))
        assertTrue(query.contains(URLEncoder.encode(cursor, "UTF-8")))
    }

    @Test
    fun `实收字节被如实记账，省流量这句话可以被称重`() {
        val payload = fixture("task-progress-delta.json")
        relay.response = 200 to payload
        val fetch = client().sync(TASK_ID, after = "cm1.whatever")

        assertEquals(payload.toByteArray(Charsets.UTF_8).size, fetch.responseBytes)
    }

    @Test
    fun `请求挑战时手机不上传自己的身份`() {
        relay.response = 202 to """{"request_id":"request-1","status":"pending","created":true}"""
        val requestId = client().requestChallenge(
            taskId = TASK_ID,
            reason = "手机确认保存当前接班点",
            mode = ShadowConfirmationMode.BIOMETRIC,
            idempotencyKey = "phone-request-1",
        )

        assertEquals("request-1", requestId)
        val request = relay.requests.single()
        assertEquals("POST", request.method)
        assertEquals("/v3/tasks/$TASK_ID/shadow/checkpoint-challenges", request.path)
        // 幂等键必须在：命令至少一次投递，动作只能生效一次。
        assertEquals("phone-request-1", request.headers["idempotency-key"])

        val body = ShadowJson.parseToJsonElement(request.body).jsonObject
        assertEquals("biometric", body.string("confirmation_mode"))
        assertEquals("checkpoint.create", body.string("action_id"))
        // relay 从配对令牌推导执行者。手机声称自己是谁，一律不作数。
        assertNull("手机不得自报 actor", body["actor"])
        assertNull(body["actor_id"])
    }

    @Test
    fun `确认只回传时间与模式，生物特征不出手机`() {
        relay.response = 202 to """{"request_id":"request-1","command_id":"command-1","status":"queued"}"""
        client().confirmChallenge(TASK_ID, "request-1", "2026-08-04T10:00:00Z")

        val request = relay.requests.single()
        assertEquals(
            "/v3/tasks/$TASK_ID/shadow/checkpoint-challenges/request-1/confirm",
            request.path,
        )
        val body = ShadowJson.parseToJsonElement(request.body).jsonObject
        assertEquals("2026-08-04T10:00:00Z", body.string("confirmed_at"))
        assertEquals(setOf("confirmed_at"), body.keys)
        // 指纹模板、人脸特征、可复用凭据 —— 一个字节都不该出现在上行里。
        val lowered = request.body.lowercase()
        listOf("biometric_template", "fingerprint", "face", "signature", "private_key")
            .forEach { assertFalse("上行不得包含 $it", lowered.contains(it)) }
    }

    @Test
    fun `relay 报错时把原因带回来，而不是吞掉`() {
        relay.response = 409 to
            """{"error":"shadow_action_unavailable","message":"pc-shadow does not declare checkpoint.create"}"""
        try {
            client().requestChallenge(TASK_ID, "试试", ShadowConfirmationMode.SYSTEM)
            fail("relay 拒绝时必须抛出")
        } catch (error: ShadowRelayException) {
            assertEquals("shadow_action_unavailable", error.code)
            assertEquals(409, error.httpStatus)
            assertTrue(error.message.contains("checkpoint.create"))
        }
    }

    @Test
    fun `流式接收：保活注释被忽略，信封按顺序交付`() {
        val snapshot = fixture("task-snapshot.json").replace(Regex("\\s+"), " ")
        val delta = fixture("task-progress-delta.json").replace(Regex("\\s+"), " ")
        relay.streamFrames = listOf(
            "event: sync\ndata: $snapshot",
            ": keep-alive",                 // 中间设备防掐断用的注释，不该被当成数据
            "event: sync\ndata: $delta",
        )

        val received = mutableListOf<SyncEnvelope>()
        var bytes = 0
        client().streamSync(TASK_ID, after = null, isActive = { true }) { envelope, size ->
            received += envelope
            bytes += size
        }

        assertEquals(2, received.size)
        assertEquals("sync.snapshot", received[0].type)
        assertEquals("sync.delta", received[1].type)
        assertTrue("字节数要如实记账，才能跟轮询比", bytes > 0)

        val request = relay.requests.single()
        assertEquals("/v3/sync/tasks/$TASK_ID/stream", request.path)
        assertEquals("text/event-stream", request.headers["accept"])
        assertEquals(TOKEN, request.headers["x-clawme-token"])
    }

    @Test
    fun `流式接收：带游标连接时把游标带上去`() {
        relay.streamFrames = listOf(": keep-alive")
        client().streamSync(TASK_ID, after = "cm1.somecursor", isActive = { true }) { _, _ -> }

        // 断线重连要从确认过的位置续传，而不是重放全部历史。
        assertTrue(relay.requests.single().query!!.contains("after=cm1.somecursor"))
    }

    @Test
    fun `流式接收：relay 中止时抛出，让调用方决定退回轮询`() {
        relay.streamFrames = listOf("""event: error${'\n'}data: {"error":"invalid_cursor"}""")
        try {
            client().streamSync(TASK_ID, after = null, isActive = { true }) { _, _ -> }
            fail("relay 中止流时必须抛出")
        } catch (error: ShadowRelayException) {
            assertEquals("stream_error", error.code)
        }
    }

    @Test
    fun `流式接收：isActive 变 false 就停下，不等服务端关`() {
        val snapshot = fixture("task-snapshot.json").replace(Regex("\\s+"), " ")
        relay.streamFrames = List(50) { "event: sync\ndata: $snapshot" }

        var count = 0
        // 界面离开或任务切换时要能立刻收手，否则连接和内存都会积累。
        client().streamSync(TASK_ID, after = null, isActive = { count < 3 }) { _, _ -> count += 1 }

        assertEquals(3, count)
    }

    @Test
    fun `流式接收：协议标识不认识就断，绝不猜着解析`() {
        relay.streamFrames = listOf(
            """event: sync${'\n'}data: {"protocol":"action-parity/sync@9.9","type":"sync.delta",""" +
                """"stream_id":"s","message_id":"m","sent_at":"t",""" +
                """"payload":{"cursor":"c","state_version":1,"events":[]}}"""
        )
        try {
            client().streamSync(TASK_ID, after = null, isActive = { true }) { _, _ -> }
            fail("未知协议版本必须被拒绝")
        } catch (expected: ShadowProtocolException) {
            assertTrue(expected.message!!.contains("9.9"))
        }
    }

    @Test
    fun `配对码换令牌：不带任何已有凭据，因为这台手机还没有`() {
        relay.response = 201 to """
            {"token":"aa11bb22","device_id":"dev-1a2b","actor_id":"android-1a2b",
             "role":"controller","surface":"android","name":"Pixel"}
        """.trimIndent()

        val paired = ShadowRelayClient.redeemPairingCode(
            "http://127.0.0.1:${relay.port}",
            code = "abcde-12345",
            deviceName = "Pixel",
        )

        assertEquals("aa11bb22", paired.token)
        assertEquals("dev-1a2b", paired.deviceId)
        assertEquals("controller", paired.role)

        val request = relay.requests.single()
        assertEquals("POST", request.method)
        assertEquals("/v3/pairing/redeem", request.path)
        // 兑换是唯一不带令牌的调用：配对码本身就是那一次的凭据。
        assertNull("配对请求不该带令牌头", request.headers["x-clawme-token"])

        val body = ShadowJson.parseToJsonElement(request.body).jsonObject
        assertEquals("abcde-12345", body.string("code"))
        assertEquals("Pixel", body.string("device_name"))
    }

    @Test
    fun `配对码无效时给出人能看懂的原因`() {
        relay.response = 401 to
            """{"error":"invalid_pairing_code","message":"pairing code is invalid or expired"}"""
        try {
            ShadowRelayClient.redeemPairingCode(
                "http://127.0.0.1:${relay.port}",
                code = "22222-22222",
                deviceName = "Pixel",
            )
            fail("无效配对码必须抛出")
        } catch (error: ShadowRelayException) {
            assertEquals("invalid_pairing_code", error.code)
            assertEquals(401, error.httpStatus)
        }
    }

    @Test
    fun `配对同样受 HTTPS 约束，不能因为方便就开个后门`() {
        try {
            ShadowRelayClient.redeemPairingCode("http://api.clawme.net", "22222-22222", "Pixel")
            fail("公网明文配对必须被拒绝")
        } catch (error: ShadowRelayException) {
            assertEquals("insecure_relay", error.code)
        }
    }

    @Test
    fun `公网 relay 必须 HTTPS，明文只留给本机调试`() {
        // 与 iOS saveConnection 同一条规矩：两端不能有一端偷偷放宽。
        assertNotNull(ShadowRelayClient.normalizeBase("https://api.clawme.net"))
        assertNotNull(ShadowRelayClient.normalizeBase("http://127.0.0.1:31871"))
        assertNotNull(ShadowRelayClient.normalizeBase("http://10.0.2.2:31871"))

        try {
            ShadowRelayClient.normalizeBase("http://api.clawme.net")
            fail("公网明文 relay 必须被拒绝")
        } catch (error: ShadowRelayException) {
            assertEquals("insecure_relay", error.code)
        }
    }

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.content

    private companion object {
        const val TASK_ID = "shadow-task"
        const val TOKEN = "phone-pairing-token"
    }
}
