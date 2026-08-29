package dev.notifyjs.call

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.Person

/**
 * Builds the incoming-call notification.
 *
 * Kept apart from the Expo module because the same notification has to be
 * raised from two places: the JS module while the app is running, and the
 * foreground service when there is no JS to speak of.
 */
object CallNotification {
  const val CHANNEL_ID = "notifyjs_incoming_calls"
  const val WATCH_CHANNEL_ID = "notifyjs_watching"
  const val ACTION_ANSWER = "dev.notifyjs.call.ANSWER"
  const val ACTION_DECLINE = "dev.notifyjs.call.DECLINE"
  const val EXTRA_CALL_ID = "notifyjs_call_id"

  /**
   * The channel must exist before the first notification and its importance
   * cannot be changed afterwards, so the ringtone is fixed here once.
   */
  fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    if (manager.getNotificationChannel(CHANNEL_ID) == null) {
      val calls = NotificationChannel(
        CHANNEL_ID,
        "Incoming alerts",
        NotificationManager.IMPORTANCE_HIGH,
      ).apply {
        description = "Alerts urgent enough to ring like a phone call."
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
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
      manager.createNotificationChannel(calls)
    }

    if (manager.getNotificationChannel(WATCH_CHANNEL_ID) == null) {
      // The service's own notification is required by Android but is not news;
      // MIN keeps it out of the way at the bottom of the shade.
      val watching = NotificationChannel(
        WATCH_CHANNEL_ID,
        "Staying connected",
        NotificationManager.IMPORTANCE_MIN,
      ).apply {
        description = "Shown while NotifyJS keeps its connection open for alerts."
        setShowBadge(false)
      }
      manager.createNotificationChannel(watching)
    }
  }

  fun launchIntent(context: Context, callId: String?): Intent? =
    context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
      // singleTask, so answering brings the existing app forward with its
      // socket and call state intact rather than starting a second copy.
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      if (callId != null) putExtra(EXTRA_CALL_ID, callId)
    }

  fun build(context: Context, id: String, from: String, message: String): Notification? {
    val launch = launchIntent(context, id) ?: return null
    val fullScreen = PendingIntent.getActivity(
      context,
      id.hashCode(),
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    return NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.sym_call_incoming)
      .setContentTitle(from)
      .setContentText(message)
      .setStyle(NotificationCompat.BigTextStyle().bigText(message))
      // CATEGORY_CALL is what tells Android this deserves the call treatment:
      // it outranks everything else and escapes Do Not Disturb rules meant for
      // ordinary notifications.
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .addPerson(Person.Builder().setName(from).setImportant(true).build())
      // `true` asks Android to launch the intent rather than show a heads-up
      // first - this is what takes over a locked screen.
      .setFullScreenIntent(fullScreen, true)
      .setContentIntent(fullScreen)
      .setOngoing(true)
      .setAutoCancel(false)
      .addAction(
        android.R.drawable.sym_action_call,
        "Answer",
        actionIntent(context, ACTION_ANSWER, id),
      )
      .addAction(
        android.R.drawable.ic_menu_close_clear_cancel,
        "Decline",
        actionIntent(context, ACTION_DECLINE, id),
      )
      .build()
  }

  /**
   * An ordinary alert. Separate from the call path because it must not ring,
   * take over the screen, or be undismissable.
   */
  fun showAlert(context: Context, id: String, title: String, body: String) {
    val launch = launchIntent(context, null) ?: return
    val open = PendingIntent.getActivity(
      context,
      id.hashCode(),
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_notify_chat)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setContentIntent(open)
      .setAutoCancel(true)
      .build()

    try {
      androidx.core.app.NotificationManagerCompat.from(context).notify(id.hashCode(), notification)
    } catch (_: SecurityException) {
      /* POST_NOTIFICATIONS refused */
    }
  }

  private fun actionIntent(context: Context, action: String, callId: String): PendingIntent {
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
