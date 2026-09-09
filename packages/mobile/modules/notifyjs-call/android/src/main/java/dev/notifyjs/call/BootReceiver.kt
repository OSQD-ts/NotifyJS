package dev.notifyjs.call

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Starts watching again after a restart.
 *
 * A reboot, or an app update, takes the process and with it the connection to
 * every hub - silently, because the ongoing notification goes too, so the one
 * cue that alerting is running is also the cue that disappears.
 *
 * This used to be unable to do anything but ask. Starting the service would
 * have kept a process alive with nothing running in it: the connection lived
 * in a React hook, and `registerRootComponent` only registers a component, so
 * a process started by anything other than a person tapping the icon had no
 * mounted tree and therefore no sockets. Posting "Listening for alerts" over
 * that would have been a lie, so it posted "not watching" instead and waited
 * for a tap.
 *
 * The connection now lives outside the tree and the service starts it as a
 * headless task, so this can simply do the thing. The notice remains as the
 * fallback for when starting fails - which is not hypothetical: an OEM that
 * has decided this app should not run will refuse, and being told is better
 * than a pager that is quietly off.
 */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    when (intent?.action) {
      Intent.ACTION_BOOT_COMPLETED,
      Intent.ACTION_MY_PACKAGE_REPLACED,
      -> Unit
      else -> return
    }

    // Somebody who turned watching off is not owed either the service or a
    // notification about it being off.
    if (!WatchState.isWanted(context)) return

    CallNotification.ensureChannels(context)

    // BOOT_COMPLETED is one of the exemptions that still permits starting a
    // foreground service from the background, which is what makes this
    // possible at all.
    val started = runCatching {
      NotifyjsWatchService.start(context, WatchState.hubName(context))
    }.isSuccess

    if (!started) CallNotification.showResume(context)
  }
}
