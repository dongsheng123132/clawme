package net.clawme.shadow

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 配对令牌的本地保管处，对标 iOS 的 Keychain。
 *
 * 令牌用 Android Keystore 里的 AES-GCM 密钥加密后才落 SharedPreferences。
 * 密钥本身不出 Keystore（有 TEE/StrongBox 的机器上不出安全硬件），所以就算
 * 应用私有目录被 root 后翻出来，拿到的也只是密文。
 */
class SecureTokenStore(context: Context) {

    private val prefs = context.applicationContext
        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun read(): String? {
        val stored = prefs.getString(KEY_TOKEN, null) ?: return null
        val parts = stored.split(':')
        if (parts.size != 2) return null
        return runCatching {
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val cipherText = Base64.decode(parts[1], Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION).apply {
                init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(TAG_BITS, iv))
            }
            String(cipher.doFinal(cipherText), Charsets.UTF_8)
        }.getOrNull()
    }

    fun save(token: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION).apply {
            init(Cipher.ENCRYPT_MODE, secretKey())
        }
        val cipherText = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        val encoded = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) +
            ":" + Base64.encodeToString(cipherText, Base64.NO_WRAP)
        prefs.edit().putString(KEY_TOKEN, encoded).apply()
    }

    fun delete() {
        prefs.edit().remove(KEY_TOKEN).apply()
        runCatching { keyStore().deleteEntry(ALIAS) }
    }

    private fun keyStore(): KeyStore =
        KeyStore.getInstance(PROVIDER).apply { load(null) }

    private fun secretKey(): SecretKey {
        val store = keyStore()
        (store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                // 锁屏状态下不解密，等同 iOS 的 AfterFirstUnlockThisDeviceOnly。
                .setUserAuthenticationRequired(false)
                .build()
        )
        return generator.generateKey()
    }

    private companion object {
        const val PREFS = "clawme.shadowcore.v1"
        const val KEY_TOKEN = "relay-pairing-token"
        const val ALIAS = "net.clawme.shadowcore.pairing"
        const val PROVIDER = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TAG_BITS = 128
    }
}

/** Relay 地址、任务 ID 和游标不是秘密，明文存即可；令牌单独走 Keystore。 */
class ShadowSettings(context: Context) {

    private val prefs = context.applicationContext
        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    var relayUrl: String
        get() = prefs.getString(KEY_RELAY, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_RELAY, value).apply()

    var taskId: String
        get() = prefs.getString(KEY_TASK, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_TASK, value).apply()

    /** 游标必须持久化：换了进程也要从确认过的位置续传，而不是重放全部历史。 */
    fun cursor(taskId: String): String? = prefs.getString(cursorKey(taskId), null)

    fun saveCursor(taskId: String, cursor: String) {
        prefs.edit().putString(cursorKey(taskId), cursor).apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    private fun cursorKey(taskId: String) = "$KEY_CURSOR_PREFIX$taskId"

    private companion object {
        const val PREFS = "clawme.shadowcore.settings.v1"
        const val KEY_RELAY = "relay-url"
        const val KEY_TASK = "task-id"
        const val KEY_CURSOR_PREFIX = "cursor."
    }
}
