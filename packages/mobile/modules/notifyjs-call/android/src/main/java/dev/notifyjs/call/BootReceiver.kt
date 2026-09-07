package dev.notifyjs.call

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Says so when a restart has left the phone not alerting.
 *
 * A reboot, or an app update, takes the process and with it the connection to
 * every hub. Nothing brings that back on its own, and the failure is silent -
 * the ongoing notification is gone, so the one cue that alerting is running is
 * also the cue that vanishes, and it vanishes at exactly the moment nobody is
 * looking at their phone.
 *
 * What this deliberately does *not* do is start [NotifyjsWatchService].
 * Starting it would be easy and would be a lie: the service keeps a process
 * alive, it does not create one that is doing anything. On boot there is no
 * React Native context and no mounted component, so the client that owns the
 * sockets never runs - and the service would sit there showing "Listening for
 * alerts" while listening to nothing at all. A notification that overstates
 * what is happening is worse than none on a pager.
 *
 * So this asks. One tap opens the app, which mounts, reconnects, and starts
 * the service the ordinary way.
 */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    when (intent?.action) {
      Intent.ACTION_BOOT_COMPLETED,
      Intent.ACTION_MY_PACKAGE_REPLACED,
      -> Unit
      else -> return
    }

    // Somebody who turned watching off is not owed a notification about it
    // being off.
    if (!WatchState.isWanted(context)) return

    CallNotification.ensureChannels(context)
    CallNotification.showResume(context, WatchState.hubName(context))
  }
}
