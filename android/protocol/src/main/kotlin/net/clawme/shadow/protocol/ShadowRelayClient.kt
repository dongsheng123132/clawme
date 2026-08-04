package net.clawme.shadow.protocol

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import java.util.UUID
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/** Relay 拒绝或网络失败时抛出，带上 relay 自己给的可读原因。 */
class ShadowRelayException(
    val code: String,
    override val message: String,
    val httpStatus: Int? = null,
) : IOException(message)

/** 一次同步实际过网的字节数 —— 「省流量」这句话得能被称重。 */
data class SyncFetch(
    val envelope: SyncEnvelope,
    val responseBytes: Int,
)

/** 配对成功后 relay 返回的设备身份。令牌明文只在这一次出现。 */
data class PairedDevice(
    val token: String,
    val deviceId: String,
    val actorId: String,
    val role: String,
    val surface: String?,
    val name: String?,
)

/**
 * ClawMe v3 relay 的手机端调用方。
 *
 * 只用 java.net，不引第三方 HTTP 库：既少一层依赖，也让整个客户端能在普通
 * JVM 测试里跑真实 HTTP，而不是靠 mock 假装联通。
 */
class ShadowRelayClient(
    baseUrl: String,
    private val token: String,
    private val connectTimeoutMs: Int = 10_000,
    private val readTimeoutMs: Int = 15_000,
) {
    private val base: URI = normalizeBase(baseUrl)

    /**
     * 拉取本设备游标之后的变化。首次（after=null）拿 snapshot，之后只拿 delta。
     * 屏幕一帧都不会过来。
     */
    fun sync(taskId: String, after: String?, limit: Int = 100): SyncFetch {
        val query = buildString {
            append("limit=").append(limit)
            if (after != null) {
                append("&after=").append(URLEncoder.encode(after, "UTF-8"))
            }
        }
        val url = resolve("v3/sync/tasks/${encodeSegment(taskId)}?$query")
        val body = request("GET", url, null)
        val envelope = ShadowJson.decodeFromString(SyncEnvelope.serializer(), body)
        if (envelope.protocolVersion != SYNC_PROTOCOL) {
            throw ShadowProtocolException("不支持的 ClawMe 同步协议：${envelope.protocolVersion}")
        }
        return SyncFetch(envelope, body.toByteArray(Charsets.UTF_8).size)
    }

    /**
     * 请求 owner 签发确认挑战。
     *
     * 注意这里不发送任何 actor 身份：relay 从配对令牌推导执行者，手机说自己是谁不算数。
     */
    fun requestChallenge(
        taskId: String,
        reason: String,
        mode: ShadowConfirmationMode,
        actionId: String = ShadowActions.CHECKPOINT_CREATE,
        idempotencyKey: String = UUID.randomUUID().toString(),
    ): String {
        val payload = buildJson(
            "reason" to reason,
            "confirmation_mode" to mode.wire,
            "action_id" to actionId,
        )
        val url = resolve("v3/tasks/${encodeSegment(taskId)}/shadow/checkpoint-challenges")
        val body = request("POST", url, payload, mapOf("Idempotency-Key" to idempotencyKey))
        return ShadowJson.parseToJsonElement(body).jsonObject["request_id"]
            ?.let { (it as? JsonPrimitive)?.content }
            ?: throw ShadowRelayException("invalid_relay_response", "relay 没有返回 request_id")
    }

    /**
     * 提交确认。只带确认时间 —— 生物特征、可复用凭据一律不出手机。
     */
    fun confirmChallenge(taskId: String, requestId: String, confirmedAt: String) {
        val url = resolve(
            "v3/tasks/${encodeSegment(taskId)}/shadow/checkpoint-challenges/" +
                "${encodeSegment(requestId)}/confirm"
        )
        request("POST", url, buildJson("confirmed_at" to confirmedAt))
    }

    private fun request(
        method: String,
        url: URL,
        body: String?,
        extraHeaders: Map<String, String> = emptyMap(),
    ): String {
        val connection = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            instanceFollowRedirects = false
            setRequestProperty("X-ClawMe-Token", token)
            setRequestProperty("Accept", "application/json")
            extraHeaders.forEach { (key, value) -> setRequestProperty(key, value) }
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
        }
        try {
            if (body != null) {
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
                .orEmpty()
            if (status !in 200..299) throw relayError(status, text)
            return text
        } finally {
            connection.disconnect()
        }
    }

    private fun relayError(status: Int, text: String): ShadowRelayException {
        val parsed = runCatching { ShadowJson.parseToJsonElement(text).jsonObject }.getOrNull()
        val code = parsed?.get("error")?.let { (it as? JsonPrimitive)?.content } ?: "relay_http_$status"
        val message = parsed?.get("message")?.let { (it as? JsonPrimitive)?.content }
            ?: parsed?.get("error")?.let { (it as? JsonPrimitive)?.content }
            ?: "ClawMe Relay HTTP $status"
        return ShadowRelayException(code, message, status)
    }

    private fun resolve(path: String): URL =
        URI("${base.scheme}://${base.authority}${base.path}/$path").toURL()

    private fun buildJson(vararg pairs: Pair<String, String>): String =
        ShadowJson.encodeToString(
            JsonObject.serializer(),
            JsonObject(pairs.associate { (k, v) -> k to JsonPrimitive(v) }),
        )

    companion object {
        private val LOCAL_HOSTS = setOf("127.0.0.1", "localhost", "::1", "10.0.2.2")

        /**
         * 用配对码换取本机的设备令牌。
         *
         * 这是唯一不带令牌的调用 —— 新手机此刻还没有任何凭据，配对码本身就是
         * 那一次的凭据。换来的令牌只属于这台设备，可以在 relay 上单独吊销，
         * 不影响其他设备，也不需要重启 relay。
         */
        fun redeemPairingCode(
            baseUrl: String,
            code: String,
            deviceName: String,
            connectTimeoutMs: Int = 10_000,
            readTimeoutMs: Int = 15_000,
        ): PairedDevice {
            val base = normalizeBase(baseUrl)
            val url = URI("${base.scheme}://${base.authority}${base.path}/v3/pairing/redeem").toURL()
            val body = ShadowJson.encodeToString(
                JsonObject.serializer(),
                JsonObject(
                    mapOf(
                        // relay 那边容忍大小写、连字符和空格，这里原样送过去即可。
                        "code" to JsonPrimitive(code.trim()),
                        "device_name" to JsonPrimitive(deviceName.trim()),
                    )
                ),
            )
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = connectTimeoutMs
                readTimeout = readTimeoutMs
                instanceFollowRedirects = false
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
            }
            try {
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                val status = connection.responseCode
                val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
                    ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
                    .orEmpty()
                if (status !in 200..299) {
                    val parsed = runCatching { ShadowJson.parseToJsonElement(text).jsonObject }.getOrNull()
                    val code0 = parsed?.get("error")?.let { (it as? JsonPrimitive)?.content }
                        ?: "relay_http_$status"
                    val message = parsed?.get("message")?.let { (it as? JsonPrimitive)?.content }
                        ?: when (code0) {
                            "invalid_pairing_code" -> "配对码无效或已过期"
                            "too_many_attempts" -> "尝试次数过多，请稍后再试"
                            else -> "配对失败（HTTP $status）"
                        }
                    throw ShadowRelayException(code0, message, status)
                }
                val json = ShadowJson.parseToJsonElement(text).jsonObject
                fun str(key: String) = (json[key] as? JsonPrimitive)?.content
                return PairedDevice(
                    token = str("token")
                        ?: throw ShadowRelayException("invalid_relay_response", "relay 没有返回令牌"),
                    deviceId = str("device_id").orEmpty(),
                    actorId = str("actor_id").orEmpty(),
                    role = str("role").orEmpty(),
                    surface = str("surface"),
                    name = str("name"),
                )
            } finally {
                connection.disconnect()
            }
        }

        /**
         * 公网 relay 必须走 HTTPS；明文只留给本机和模拟器回环调试。
         * 与 iOS `saveConnection` 同一条规矩，两端不能有一端偷偷放宽。
         */
        fun normalizeBase(raw: String): URI {
            val trimmed = raw.trim().trimEnd('/')
            val uri = runCatching { URI(trimmed) }.getOrNull()
                ?: throw ShadowRelayException("invalid_relay_url", "Relay 地址无效")
            val scheme = uri.scheme?.lowercase()
            val host = uri.host?.lowercase()
            if (scheme == null || host == null) {
                throw ShadowRelayException("invalid_relay_url", "Relay 地址无效")
            }
            if (scheme != "https" && !(scheme == "http" && host in LOCAL_HOSTS)) {
                throw ShadowRelayException(
                    "insecure_relay",
                    "公网 Relay 必须使用 HTTPS；HTTP 仅允许本机调试",
                )
            }
            return uri
        }

        private fun encodeSegment(value: String): String =
            URLEncoder.encode(value, "UTF-8").replace("+", "%20")
    }
}
