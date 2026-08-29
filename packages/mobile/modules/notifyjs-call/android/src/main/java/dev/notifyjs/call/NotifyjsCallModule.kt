package dev.notifyjs.call

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class IncomingCallOptions : Record {
  @Field val id: String = ""
  @Field val from: String = "Alert"
  @Field val message: String = ""
  @Field val severity: String? = null
}

/**
 * Raises an incoming call the way Android understands one.
 *
 * A React Native screen cannot draw over a locked phone - the JS thread may not
 * even be running. Only a notification carrying a *full-screen intent* can take
 * the screen over, and Android grants that treatment to `CATEGORY_CALL`
 * notifications on a high-importance channel. The intent points back at the
 * app's own activity, so once the user answers, the existing call screen takes
 * over and nothing about the protocol changes.
 */
class NotifyjsCallModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "no application context" }

  override fun definition() = ModuleDefinition {
    Name("NotifyjsCall")

    Function("showIncomingCall") { options: IncomingCallOptions ->
      CallNotification.ensureChannels(context)
      val notification = CallNotification.build(
        context,
        options.id,
        options.from,
        options.message,
      )
      if (notification != null) {
        try {
          NotificationManagerCompat.from(context).notify(options.id.hashCode(), notification)
        } catch (_: SecurityException) {
          // POST_NOTIFICATIONS was refused. The in-app screen still handles
          // the call when the app is open, so this degrades rather than fails.
        }
      }
    }

    Function("dismissCall") { id: String ->
      NotificationManagerCompat.from(context).cancel(id.hashCode())
    }

    // Android 14 made this a user-granted permission for anything that is not
    // a default calling app. Without it the call degrades to a banner, which is
    // worth telling the user about before they come to rely on it.
    Function("canUseFullScreen") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        true
      } else {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.canUseFullScreenIntent()
      }
    }

    Function("openFullScreenSettings") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        val intent = Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT)
          .setData(android.net.Uri.parse("package:${context.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
      }
    }

    /**
     * Starts the foreground service that keeps the socket alive off screen.
     * Without it the process is reclaimed and nothing arrives at all.
     */
    Function("startWatching") { hubName: String ->
      CallNotification.ensureChannels(context)
      NotifyjsWatchService.start(context, hubName)
    }

    Function("stopWatching") {
      NotifyjsWatchService.stop(context)
    }

    /** Posts an ordinary alert, so notifications work with no JS timers. */
    Function("showAlert") { id: String, title: String, body: String, sound: Boolean, vibrate: Boolean ->
      CallNotification.ensureChannels(context)
      CallNotification.showAlert(context, id, title, body, sound, vibrate)
    }
  }
}
