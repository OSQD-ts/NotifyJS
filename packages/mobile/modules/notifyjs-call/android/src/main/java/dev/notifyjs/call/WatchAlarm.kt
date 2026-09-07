package dev.notifyjs.call

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * A heartbeat that survives Doze.
 *
 * The foreground service keeps the process resident, which is a different
 * thing from keeping it running: with the screen off and the phone still,
 * Android suspends the CPU and defers timers until a maintenance window. The
 * client's own keepalive is a `setInterval` and its reconnect is a
 * `setTimeout`, so both stop exactly when the connection is most likely to be
 * quietly dropped by a NAT that has grown bored of it.
 *
 * An alarm is the sanctioned way to be woken anyway. This one carries no
 * payload and does no work beyond firing [WatchEvents], which is enough: the
 * client resyncs, notices the socket is dead, and reconnects.
 */
object WatchAlarm {
  const val ACTION_WAKE = "dev.notifyjs.call.WATCH_WAKE"
  private const val REQUEST = 0x0502

  /**
   * How often to look.
   *
   * Matched to what Doze actually grants rather than to what we would like:
   * an allow-while-idle alarm is released roughly every nine minutes per app
   * while the device is idle, and asking for it more often just has the
   * request held back to the same cadence while costing battery on a phone
   * that is awake. Nine minutes is therefore the worst case for noticing a
   * socket that died in the night - and while the phone is awake the client's
   * own thirty-second keepalive is still the thing that finds it first.
   */
  private const val INTERVAL_MS = 9 * 60 * 1000L

  /**
   * Arms the next wake.
   *
   * One shot, and re-armed on each firing. A repeating alarm cannot be given
   * the allow-while-idle exemption, so a `setRepeating` heartbeat would be
   * held back until the phone came out of Doze - which is to say, until
   * exactly the moment it was no longer needed.
   */
  fun schedule(context: Context) {
    val manager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
    val at = System.currentTimeMillis() + INTERVAL_MS
    runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        // `setAndAllowWhileIdle`, not the exact variant: exact alarms need
        // SCHEDULE_EXACT_ALARM from Android 12, which is user-revocable and
        // treated by Play as something an app must justify. A heartbeat has
        // no need to be punctual - only to happen - and the inexact form
        // carries the same Doze exemption for free.
        manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending(context))
      } else {
        // Doze does not exist before API 23, so an ordinary alarm is already
        // as reliable as the exemption would make it.
        manager.set(AlarmManager.RTC_WAKEUP, at, pending(context))
      }
    }
  }

  fun cancel(context: Context) {
    val manager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
    runCatching { manager.cancel(pending(context)) }
  }

  private fun pending(context: Context): PendingIntent = PendingIntent.getBroadcast(
    context,
    REQUEST,
    Intent(context, WatchAlarmReceiver::class.java).setAction(ACTION_WAKE),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )
}

/**
 * Receives the heartbeat and immediately arms the next one.
 *
 * A broadcast rather than a service start: launching a service from the
 * background is restricted, and this fires precisely when the app is furthest
 * from the foreground. A receiver is always allowed to run.
 */
class WatchAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    WatchEvents.wake(context, "alarm")
    // Re-armed even if nothing was listening. The alarm is what makes the app
    // recoverable at all, so the one thing it must never do is stop.
    WatchAlarm.schedule(context)
  }
}
