package net.clawme.shadow

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.viewmodel.compose.viewModel
import net.clawme.shadow.ui.ShadowCoreScreen

/**
 * FragmentActivity 而不是 ComponentActivity —— BiometricPrompt 需要它来托管
 * 系统认证弹窗。
 */
class MainActivity : FragmentActivity() {

    private val requestNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            // 拒绝也照常运行：前台服务和同步都不依赖通知权限，只是 owner 的确认
            // 请求不会主动惊动用户，得自己打开 App 看。
            if (granted) ShadowSyncService.startIfConfigured(this)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ShadowNotifications.ensureChannels(this)
        askForNotificationsIfNeeded()
        ShadowSyncService.startIfConfigured(this)

        val authenticator = ShadowAuthenticator(this)
        setContent {
            MaterialTheme {
                val model: ShadowViewModel = viewModel()
                val state by model.state.collectAsState()
                ShadowCoreScreen(
                    state = state,
                    onPairWithCode = model::pairWithCode,
                    onSavePairing = model::savePairing,
                    onForgetPairing = model::forgetPairing,
                    onSelectMachine = model::selectMachine,
                    onSelectTask = model::selectTask,
                    onLaunchApp = model::launchApp,
                    onRequestChallenge = { reason, mode -> model.requestChallenge(reason, mode) },
                    onConfirmChallenge = { challenge ->
                        model.confirmChallenge(challenge, authenticator::authenticate)
                    },
                    onDismissError = model::dismissError,
                )
            }
        }
    }

    private fun askForNotificationsIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
        if (granted != PackageManager.PERMISSION_GRANTED) {
            requestNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}
