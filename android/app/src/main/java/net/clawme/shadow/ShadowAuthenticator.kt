package net.clawme.shadow

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import net.clawme.shadow.protocol.ShadowCheckpointChallenge
import net.clawme.shadow.protocol.ShadowConfirmationMode

class ShadowAuthenticationException(message: String) : Exception(message)

/**
 * 本机确认。对标 iOS 的 LocalAuthentication。
 *
 * 影核协议在这里有一条不肯让步的规矩：确认必须绑定到**具体动作**，
 * 所以系统弹窗上写的是 owner 签发的 action_id 和原因，而不是「确定吗？」。
 * 认证全程在本机完成，只有「确认时间」会上行 —— 指纹/人脸模板和任何
 * 可复用的认证秘密都不进 relay。
 */
class ShadowAuthenticator(private val activity: FragmentActivity) {

    suspend fun authenticate(challenge: ShadowCheckpointChallenge) {
        // 明确确认模式下，用户在卡片上按的那一下就是确认，不再叠一层系统弹窗。
        if (challenge.mode == ShadowConfirmationMode.EXPLICIT) return

        val authenticators = when (challenge.mode) {
            ShadowConfirmationMode.BIOMETRIC ->
                BiometricManager.Authenticators.BIOMETRIC_STRONG
            ShadowConfirmationMode.SYSTEM ->
                BiometricManager.Authenticators.BIOMETRIC_STRONG or
                    BiometricManager.Authenticators.DEVICE_CREDENTIAL
            ShadowConfirmationMode.EXPLICIT -> return
        }

        when (BiometricManager.from(activity).canAuthenticate(authenticators)) {
            BiometricManager.BIOMETRIC_SUCCESS -> Unit
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED ->
                throw ShadowAuthenticationException("这台设备还没有录入所需的认证方式")
            else ->
                throw ShadowAuthenticationException("这台设备无法使用 owner 要求的认证方式")
        }

        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("确认执行 ${challenge.actionId}")
            .setSubtitle(challenge.reason)
            .setDescription("状态版本 ${challenge.expectedStateVersion} · 有效期至 ${challenge.expiresAt}")
            .setAllowedAuthenticators(authenticators)
            .apply {
                // 只有纯生物识别模式才需要取消按钮；系统认证模式自带凭据回退。
                if (challenge.mode == ShadowConfirmationMode.BIOMETRIC) {
                    setNegativeButtonText("取消")
                }
            }
            .build()

        suspendCancellableCoroutine { continuation ->
            val prompt = BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(activity),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(
                        result: BiometricPrompt.AuthenticationResult,
                    ) {
                        if (continuation.isActive) continuation.resume(Unit)
                    }

                    override fun onAuthenticationError(code: Int, message: CharSequence) {
                        if (continuation.isActive) {
                            continuation.resumeWithException(
                                ShadowAuthenticationException(message.toString())
                            )
                        }
                    }

                    override fun onAuthenticationFailed() {
                        // 单次比对失败不终止，交给系统继续让用户重试。
                    }
                },
            )
            continuation.invokeOnCancellation { prompt.cancelAuthentication() }
            prompt.authenticate(info)
        }
    }
}
