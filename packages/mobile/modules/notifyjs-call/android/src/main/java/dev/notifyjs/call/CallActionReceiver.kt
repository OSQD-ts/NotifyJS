package dev.notifyjs.call

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat

/**
 * Handles Answer and Decline tapped straight from the lock screen.
 *
 * The ringing stops here rather than in JavaScript, because JavaScript may not
 * be running - and a phone that keeps ringing after you have declined is worse
 * than one that never rang. What happens next is the app's business, so the
 * action is handed to [CallEvents], which replays it if the app is still
 * starting up.
 */
class CallActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val callId = intent.getStringExtra(CallNotification.EXTRA_CALL_ID) ?: return
    val answered = intent.action == CallNotification.ACTION_ANSWER

    CallRinger.stop()
    NotificationManagerCompat.from(context).cancel(callId.hashCode())
    CallEvents.emit(intent.action ?: CallNotification.ACTION_DECLINE, callId)

    if (!answered) {
      // A decline is recorded by the app on its next connection; the hub also
      // moves on by itself once the ring timeout expires.
      return
    }

    // Speaking the message is the app's job - the notification only ever
    // starts the conversation - so answering has to bring the app forward.
    val launch = CallNotification.launchIntent(context, callId)?.apply {
      putExtra(CallNotification.EXTRA_ANSWERED, true)
    } ?: return
    context.startActivity(launch)
  }
}
