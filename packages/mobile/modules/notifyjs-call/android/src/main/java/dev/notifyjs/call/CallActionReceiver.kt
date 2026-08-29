package dev.notifyjs.call

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat

/**
 * Handles Answer and Decline tapped straight from the lock screen.
 *
 * Declining is handled entirely here so it works with the app closed. Answering
 * has to bring the app forward, because speaking the message is the app's job -
 * the notification only ever starts the conversation.
 */
class CallActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val callId = intent.getStringExtra(CallNotification.EXTRA_CALL_ID) ?: return
    NotificationManagerCompat.from(context).cancel(callId.hashCode())

    if (intent.action != CallNotification.ACTION_ANSWER) {
      // A decline is recorded by the app on its next connection; the hub also
      // moves on by itself once the ring timeout expires.
      return
    }

    val launch = context.packageManager
      .getLaunchIntentForPackage(context.packageName)
      ?.apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        putExtra(CallNotification.EXTRA_CALL_ID, callId)
        putExtra("notifyjs_answered", true)
      } ?: return
    context.startActivity(launch)
  }
}
