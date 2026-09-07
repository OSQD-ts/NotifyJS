package dev.notifyjs.call

import android.content.Context

/**
 * Remembers whether the user asked to be watched over.
 *
 * Everything else in this module learns that from JavaScript, which is fine
 * until the one moment it is not: after a reboot there is no JavaScript, and
 * nothing on the device knows the phone is supposed to be alerting at all.
 * Kept in preferences rather than passed around, because the only reader that
 * matters runs before the app does.
 */
object WatchState {
  private const val PREFS = "notifyjs.watch"
  private const val KEY_WANTED = "wanted"
  private const val KEY_HUB = "hubName"

  private fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /**
   * Records what the user has chosen, not what is currently running.
   *
   * The distinction is the whole point: a service Android stopped, or one a
   * reboot took with it, must still read as "wanted" or nothing would ever
   * offer to bring it back.
   */
  fun setWanted(context: Context, wanted: Boolean, hubName: String? = null) {
    prefs(context).edit().apply {
      putBoolean(KEY_WANTED, wanted)
      if (hubName != null) putString(KEY_HUB, hubName)
      apply()
    }
  }

  fun isWanted(context: Context): Boolean = prefs(context).getBoolean(KEY_WANTED, false)

  fun hubName(context: Context): String = prefs(context).getString(KEY_HUB, null) ?: "NotifyJS"
}
