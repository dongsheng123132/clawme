package net.clawme.shadow

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * 前台服务：让连接活过界面。
 *
 * 没有它，App 一退到后台连接就断，而这个 App 的价值恰恰在你没看着它的时候 ——
 * 电脑上的任务卡住了等你拍板，你得知道。
 *
 * 选前台服务而不是 FCM 是有意的：FCM 需要 Google Play 服务，国产 Android 大多
 * 不带；而且它要 Firebase 凭据，自建用户拿不到。代价是通知栏常驻一块牌子，
 * 这里把它压到最低优先级，安静地待着。
 */
class ShadowSyncService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ShadowNotifications.ensureChannels(this)
        val repository = ShadowRepository.get(this)

        startAsForeground(ShadowNotifications.connectionNotification(this, repository.state.value))
        repository.connect()

        // 常驻通知跟着状态走，用户瞥一眼就知道现在是推送还是轮询、收了多少。
        scope.launch {
            repository.state.collectLatest { state ->
                runCatching {
                    startAsForeground(ShadowNotifications.connectionNotification(this@ShadowSyncService, state))
                }
            }
        }
    }

    private fun startAsForeground(notification: android.app.Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14 起前台服务必须声明类型，否则直接抛异常。
            startForeground(
                ShadowNotifications.FOREGROUND_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(ShadowNotifications.FOREGROUND_ID, notification)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 被系统回收后自己回来；连接恢复靠游标，不会重放历史。
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        /** 只有配对完成后才值得起服务：没配对时它除了占一块通知栏什么都做不了。 */
        fun startIfConfigured(context: Context) {
            if (!ShadowRepository.get(context).isConfigured()) return
            val intent = Intent(context, ShadowSyncService::class.java)
            runCatching { context.startForegroundService(intent) }
        }

        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, ShadowSyncService::class.java)) }
        }
    }
}
