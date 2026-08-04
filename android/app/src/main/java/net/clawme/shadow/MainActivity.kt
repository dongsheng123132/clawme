package net.clawme.shadow

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.viewmodel.compose.viewModel
import net.clawme.shadow.ui.ShadowCoreScreen

/**
 * FragmentActivity 而不是 ComponentActivity —— BiometricPrompt 需要它来托管
 * 系统认证弹窗。
 */
class MainActivity : FragmentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
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
                    onRequestChallenge = { reason, mode -> model.requestChallenge(reason, mode) },
                    onConfirmChallenge = { challenge ->
                        model.confirmChallenge(challenge, authenticator::authenticate)
                    },
                    onDismissError = model::dismissError,
                )
            }
        }
    }
}
