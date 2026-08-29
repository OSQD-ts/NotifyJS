package dev.notifyjs.call

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Keeps the app's process alive so its WebSocket survives.
 *
 * Without this, Android reclaims the process once the app leaves the screen -
 * and with it the socket the hub delivers over. The result is an alerting app
 * that only alerts while you are looking at it, which is the opposite of the
 * point. A foreground service is the sanctioned way to say "this process is
 * doing something the user asked for", and the persistent notification is the
 * price Android charges for it.
 *
 * The service holds no state and does no work. Its entire job is to exist, so
 * that the JavaScript runtime holding the connection is not killed.
 */
class NotifyjsWatchService : Service() {
  companion object {
    const val NOTIFICATION_ID = 0x0501
    const val ACTION_START = "dev.notifyjs.call.WATCH_START"
    const val ACTION_STOP = "dev.notifyjs.call.WATCH_STOP"

    fun start(context: Context, hubName: String) {
      val intent = Intent(context, NotifyjsWatchService::class.java)
        .setAction(ACTION_START)
        .putExtra("hubName", hubName)
      // startForegroundService requires startForeground() within a few
      // seconds, which onStartCommand does immediately below.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      context.startService(
        Intent(context, NotifyjsWatchService::class.java).setAction(ACTION_STOP),
      )
    }
  }

  private var hubName: String = "NotifyJS"

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }

    intent?.getStringExtra("hubName")?.let { hubName = it }
    CallNotification.ensureChannels(this)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(
        NOTIFICATION_ID,
        buildNotification(),
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
      )
    } else {
      startForeground(NOTIFICATION_ID, buildNotification())
    }

    // If Android does reclaim us under memory pressure, come back.
    return START_STICKY
  }

  /**
   * Swiping the app away from recents removes the task but must not stop the
   * watching - that is exactly the case this service exists for.
   */
  override fun onTaskRemoved(rootIntent: Intent?) {
    super.onTaskRemoved(rootIntent)
    // The JS runtime went with the task, so ask Android to restart the app's
    // process shortly; the client reconnects on its own from stored keys.
    val restart = CallNotification.launchIntent(this, null)
    if (restart != null) {
      val pending = PendingIntent.getActivity(
        this,
        NOTIFICATION_ID,
        restart,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      // Nudge rather than force: launching an activity from the background is
      // restricted, so this is a best-effort revival.
      try {
        pending.send()
      } catch (_: Exception) {
        /* the user will see the ongoing notification either way */
      }
    }
  }

  private fun buildNotification(): Notification {
    val launch = CallNotification.launchIntent(this, null)
    val open = launch?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    return NotificationCompat.Builder(this, CallNotification.WATCH_CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle("Listening for alerts")
      .setContentText("Connected to $hubName")
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setOngoing(true)
      .setShowWhen(false)
      .setContentIntent(open)
      .build()
  }
}
