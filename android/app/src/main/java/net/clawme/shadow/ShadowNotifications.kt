package net.clawme.shadow

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import net.clawme.shadow.protocol.ShadowCheckpointChallenge

/**
 * 通知。
 *
 * 两个渠道，分得很清楚：连接状态是常驻的、静默的，用户不该被它打扰；
 * owner 的确认挑战是要惊动人的，因为那正是这个 App 存在的理由 ——
 * 电脑上的任务卡住了，等你拍板。
 */
object ShadowNotifications {

    const val CONNECTION_CHANNEL = "clawme.connection"
    const val CHALLENGE_CHANNEL = "clawme.challenge"
    const val FOREGROUND_ID = 1001

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(
                CONNECTION_CHANNEL,
                "连接状态",
                // 常驻通知压到最低优先级：它是 Android 要求前台服务必须露出的
                // 那块牌子，不是给人看的消息。
                NotificationManager.IMPORTANCE_MIN,
            ).apply {
                description = "保持与 Relay 的连接，让 owner 的确认请求能立刻送达"
                setShowBadge(false)
            }
        )
        manager.createNotificationChannel(
            NotificationChannel(
                CHALLENGE_CHANNEL,
                "确认请求",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "电脑上的动作等待你确认"
            }
        )
    }

    fun connectionNotification(context: Context, state: ShadowUiState): Notification {
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val detail = when {
            !state.hasToken -> "尚未配对"
            state.connected -> "${state.transport.label} · 已收 ${formatBytes(state.bytesReceived)}"
            else -> "正在重连…"
        }
        return NotificationCompat.Builder(context, CONNECTION_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("ClawMe 影核")
            .setContentText(detail)
            .setContentIntent(open)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    fun postChallenge(context: Context, challenge: ShadowCheckpointChallenge) {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        val open = PendingIntent.getActivity(
            context,
            challenge.requestId.hashCode(),
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, CHALLENGE_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle("等待确认：${challenge.actionId}")
            .setContentText(challenge.reason)
            // 通知里只说要确认什么，确认本身必须回到 App 里做 —— 那里才有
            // 动作、状态版本和有效期，也才有生物识别。
            .setStyle(NotificationCompat.BigTextStyle().bigText(challenge.reason))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .build()
        runCatching { manager.notify(challenge.requestId.hashCode(), notification) }
    }

    fun cancelChallenge(context: Context, requestId: String) {
        runCatching { NotificationManagerCompat.from(context).cancel(requestId.hashCode()) }
    }

    private fun formatBytes(bytes: Long): String = when {
        bytes < 1024 -> "$bytes B"
        bytes < 1024 * 1024 -> String.format("%.1f KB", bytes / 1024.0)
        else -> String.format("%.2f MB", bytes / (1024.0 * 1024.0))
    }
}
