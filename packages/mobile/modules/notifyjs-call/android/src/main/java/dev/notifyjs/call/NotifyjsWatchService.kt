package dev.notifyjs.call

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

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
 * It also starts that runtime. Keeping a process alive is no use if there is
 * nothing running in it, and `registerRootComponent` only registers a
 * component - so a process Android started for its own reasons had a
 * JavaScript context with no mounted tree and no connection to anything. As a
 * headless task service this starts `NotifyjsWatch`, which connects through
 * the same singleton the UI subscribes to, so the phone reconnects after a
 * reboot without anybody opening the app.
 */
class NotifyjsWatchService : HeadlessJsTaskService() {
  companion object {
    const val NOTIFICATION_ID = 0x0501
    const val ACTION_START = "dev.notifyjs.call.WATCH_START"
    const val ACTION_STOP = "dev.notifyjs.call.WATCH_STOP"

    fun start(context: Context, hubName: String) {
      // Recorded before the service is asked for, not after it succeeds: this
      // is the user's choice, and it has to outlive both this process and the
      // reboot that ends it.
      WatchState.setWanted(context, true, hubName)
      // Whatever a restart left standing is now answered.
      CallNotification.cancelResume(context)
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
      // Turning it off is also a choice to remember: without this, every
      // reboot would offer to resume watching that the user had deliberately
      // ended.
      WatchState.setWanted(context, false)
      CallNotification.cancelResume(context)
      // Android 8 refuses startService from a backgrounded app, and this can
      // be reached from one - a settings change applied as the app goes away.
      // The service stopping itself is not worth crashing over.
      runCatching {
        context.startService(
          Intent(context, NotifyjsWatchService::class.java).setAction(ACTION_STOP),
        )
      }
    }
  }

  private var hubName: String = "NotifyJS"

  override fun onBind(intent: Intent?): IBinder? = null

  /**
   * The JavaScript side of watching.
   *
   * No timeout, because this task's whole purpose is to outlast the moment it
   * was started in. Allowed in the foreground so that the app being open is
   * not a reason to skip it - the task is idempotent, and whichever of the two
   * arrives first, both end up on the same `hub` singleton.
   */
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig("NotifyjsWatch", Arguments.createMap(), 0, true)

  /**
   * Deliberately does not stop the service.
   *
   * The base class stops itself once its tasks finish, which is right for a
   * service that exists to run one job. This one exists to keep a process
   * alive: the task returning means the connection is established, which is
   * the point at which stopping would undo everything.
   */
  override fun onHeadlessJsTaskFinish(taskId: Int) {
    // Intentionally empty.
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      // Before the service goes: an alarm outlives the process that set it, so
      // one left armed here would go on waking a phone whose owner turned the
      // watching off.
      WatchAlarm.cancel(this)
      NetworkWatch.stop(this)
      // Through the compat shim: `stopForeground(int)` and its flags arrived in
      // API 24, and this module builds down to 23. On an older device the
      // direct call resolves to nothing at runtime and throws NoSuchMethodError
      // - so turning the watcher off would crash the service rather than stop
      // it.
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
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

    // Staying resident is not the same as staying connected. These two are
    // what get the app a reason to run once Android has stopped scheduling its
    // timers - the alarm on a fixed heartbeat, the network callback on the
    // handover that silently breaks the socket in the first place.
    //
    // After startForeground(), never before: startForegroundService() gives a
    // service about five seconds to promote itself or be killed, and that
    // budget is not there to be spent registering things.
    //
    // Re-armed on every start, deliberately: START_STICKY redelivers a null
    // intent after the process is reclaimed, and that restart is exactly the
    // moment there is no alarm pending any more.
    WatchAlarm.schedule(this)
    NetworkWatch.start(this)

    // The base class's onStartCommand is what actually starts the JavaScript
    // task, so overriding this method without calling up would leave a service
    // that keeps a process alive and runs nothing in it - which is the exact
    // failure this service was changed to fix. Its return value is discarded
    // deliberately: it answers for a service that stops when its task is done,
    // and this one does not.
    super.onStartCommand(intent, flags, startId)

    // If Android does reclaim us under memory pressure, come back.
    return START_STICKY
  }

  /**
   * Releases the network callback, and deliberately leaves the alarm armed.
   *
   * This runs for a service Android reclaimed as much as for one that was
   * asked to stop, and in the first case the pending alarm is the only thing
   * left that can bring the connection back.
   */
  override fun onDestroy() {
    NetworkWatch.stop(this)
    super.onDestroy()
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

  /**
   * Whether Android may suspend this app while the screen is off.
   *
   * Doze and this API both arrived in API 23; below that there is nothing to
   * be exempted from, so an older phone is never restricted.
   */
  private fun batteryOptimized(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false
    val power = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
    return runCatching { !power.isIgnoringBatteryOptimizations(packageName) }.getOrDefault(false)
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

    // Says so when Android is entitled to hold alerts back. The ongoing
    // notification is the one place this can be stated without interrupting
    // anybody, and it is where somebody wondering "is my pager working?"
    // actually looks. Re-evaluated whenever watching restarts rather than
    // live, which is enough for a setting that changes by hand.
    val restricted = batteryOptimized()

    return NotificationCompat.Builder(this, CallNotification.WATCH_CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle(if (restricted) "Alerts may be delayed" else "Listening for alerts")
      .setContentText(
        if (restricted) {
          "Battery optimisation is on, so Android can hold alerts back. Open NotifyJS to fix."
        } else {
          "Connected to $hubName"
        },
      )
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setOngoing(true)
      .setShowWhen(false)
      .setContentIntent(open)
      .build()
  }
}
