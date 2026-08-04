package net.clawme.shadow

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import kotlinx.coroutines.flow.StateFlow
import net.clawme.shadow.protocol.ShadowActions
import net.clawme.shadow.protocol.ShadowCheckpointChallenge
import net.clawme.shadow.protocol.ShadowConfirmationMode

/**
 * 界面到运行时的一层薄壳。
 *
 * 同步循环故意不在这里：ViewModel 随界面销毁，而连接必须活过界面。真正的
 * 运行时是进程级的 [ShadowRepository]，由前台服务托着。
 */
class ShadowViewModel(application: Application) : AndroidViewModel(application) {

    private val repository = ShadowRepository.get(application)

    val state: StateFlow<ShadowUiState> = repository.state

    fun savePairing(relayUrl: String, taskId: String, token: String) {
        repository.savePairing(relayUrl, taskId, token)
        ShadowSyncService.startIfConfigured(getApplication())
    }

    fun pairWithCode(relayUrl: String, taskId: String, code: String, deviceName: String) {
        repository.pairWithCode(relayUrl, taskId, code, deviceName)
        // 配对是异步的；服务在仓库确认配置完整之后才会真正起来。
        ShadowSyncService.startIfConfigured(getApplication())
    }

    fun forgetPairing() {
        ShadowSyncService.stop(getApplication())
        repository.forgetPairing()
    }

    fun connect() = repository.connect()

    fun dismissError() = repository.dismissError()

    fun requestChallenge(
        reason: String,
        mode: ShadowConfirmationMode,
        actionId: String = ShadowActions.CHECKPOINT_CREATE,
    ) = repository.requestChallenge(reason, mode, actionId)

    fun confirmChallenge(
        challenge: ShadowCheckpointChallenge,
        authenticate: suspend (ShadowCheckpointChallenge) -> Unit,
    ) = repository.confirmChallenge(challenge, authenticate)
}
