package dev.notifyjs.call

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
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
  companion object {
    const val CHANNEL_ID = "notifyjs_incoming_calls"
    const val ACTION_ANSWER = "dev.notifyjs.call.ANSWER"
    const val ACTION_DECLINE = "dev.notifyjs.call.DECLINE"
    const val EXTRA_CALL_ID = "notifyjs_call_id"
  }

  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "no application context" }

  override fun definition() = ModuleDefinition {
    Name("NotifyjsCall")

    Function("showIncomingCall") { options: IncomingCallOptions ->
      ensureChannel()
      notify(options)
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
  }

  /**
   * The channel must exist before the first notification and cannot be changed
   * afterwards, so importance and the ringtone are set here once.
   */
  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return

    val channel = NotificationChannel(
      CHANNEL_ID,
      "Incoming alerts",
      NotificationManager.IMPORTANCE_HIGH,
    ).apply {
      description = "Alerts urgent enough to ring like a phone call."
      lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
      enableVibration(true)
      vibrationPattern = longArrayOf(0, 700, 800, 700, 1600)
      setSound(
        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build(),
      )
      setBypassDnd(true)
    }
    manager.createNotificationChannel(channel)
  }

  private fun notify(options: IncomingCallOptions) {
    val launch = context.packageManager
      .getLaunchIntentForPackage(context.packageName)
      ?.apply {
        // singleTask, so answering brings the existing app forward with its
        // socket and call state intact rather than starting a second copy.
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        putExtra(EXTRA_CALL_ID, options.id)
      } ?: return

    val fullScreen = PendingIntent.getActivity(
      context,
      options.id.hashCode(),
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val caller = Person.Builder().setName(options.from).setImportant(true).build()

    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.sym_call_incoming)
      .setContentTitle(options.from)
      .setContentText(options.message)
      .setStyle(NotificationCompat.BigTextStyle().bigText(options.message))
      // CATEGORY_CALL is what tells Android this deserves the call treatment:
      // it bypasses Do Not Disturb rules meant for ordinary notifications and
      // ranks above everything else on the lock screen.
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .addPerson(caller)
      // `true` asks Android to launch the intent immediately rather than
      // showing a heads-up first - this is what takes over a locked screen.
      .setFullScreenIntent(fullScreen, true)
      .setContentIntent(fullScreen)
      // A ringing call should not be dismissible by a swipe.
      .setOngoing(true)
      .setAutoCancel(false)
      .addAction(
        android.R.drawable.sym_action_call,
        "Answer",
        actionIntent(ACTION_ANSWER, options.id),
      )
      .addAction(
        android.R.drawable.ic_menu_close_clear_cancel,
        "Decline",
        actionIntent(ACTION_DECLINE, options.id),
      )
      .build()

    try {
      NotificationManagerCompat.from(context).notify(options.id.hashCode(), notification)
    } catch (_: SecurityException) {
      // POST_NOTIFICATIONS was refused. The in-app screen still handles the
      // call when the app is open, so this is a degradation, not a failure.
    }
  }

  private fun actionIntent(action: String, callId: String): PendingIntent {
    val intent = Intent(context, CallActionReceiver::class.java)
      .setAction(action)
      .putExtra(EXTRA_CALL_ID, callId)
    return PendingIntent.getBroadcast(
      context,
      (action + callId).hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }
}
