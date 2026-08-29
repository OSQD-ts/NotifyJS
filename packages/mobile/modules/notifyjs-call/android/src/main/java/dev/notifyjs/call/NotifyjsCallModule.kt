package dev.notifyjs.call

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.Promise
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
 *
 * Ringing and speaking live in [CallRinger] and [CallSpeaker] rather than in
 * JavaScript, so that neither depends on the JS thread being scheduled or on
 * the phone's ringer being turned up.
 */
class NotifyjsCallModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "no application context" }

  override fun definition() = ModuleDefinition {
    Name("NotifyjsCall")

    Events("onCallAction", "onSpeechDone")

    OnCreate {
      // Answer and Decline arrive on a broadcast receiver, which may well have
      // run before this module existed; CallEvents replays anything missed.
      CallEvents.listen { event ->
        sendEvent(
          "onCallAction",
          mapOf(
            "action" to if (event.action == CallNotification.ACTION_ANSWER) "answer" else "decline",
            "callId" to event.callId,
          ),
        )
      }
    }

    OnDestroy {
      CallEvents.stopListening()
      CallRinger.stop()
      CallSpeaker.shutdown()
    }

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
      // Rings whether or not the notification made it: a refused permission
      // should cost the banner, not the alert.
      CallRinger.start(context, options.id)
    }

    Function("dismissCall") { id: String ->
      CallRinger.stop()
      NotificationManagerCompat.from(context).cancel(id.hashCode())
    }

    /** Answering: the ring stops, the message has yet to be spoken. */
    Function("stopRinging") {
      CallRinger.stop()
    }

    /**
     * Speaks an answered call's message out loud, on the alarm stream so a
     * silenced phone is still heard. Resolves once, when there is no more to
     * say - including when the engine fails, since a call screen waiting on a
     * promise that never settles has no way back to the feed.
     */
    AsyncFunction("speak") { text: String, language: String, rate: Double, pitch: Double, repeat: Int, promise: Promise ->
      CallSpeaker.speak(
        context,
        text,
        language,
        rate.toFloat(),
        pitch.toFloat(),
        repeat,
      ) { error ->
        sendEvent("onSpeechDone", mapOf("error" to error))
        promise.resolve(error == null)
      }
    }

    Function("stopSpeaking") {
      CallSpeaker.stop()
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
          .setData(Uri.parse("package:${context.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
      }
    }

    /**
     * Doze is the other half of "nothing arrives while the screen is off".
     * A foreground service keeps the process alive, but an app Android has
     * decided to optimise still has its network suspended in long idle
     * stretches - which is exactly the night-time hour an alert matters most.
     */
    Function("isBatteryOptimized") {
      val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || power == null) {
        false
      } else {
        power.isIgnoringBatteryOptimizations(context.packageName).not()
      }
    }

    Function("openBatterySettings") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        // The direct request dialog needs REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
        // which Play treats as a policy matter; the settings list asks the user
        // the same question without it.
        val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { context.startActivity(intent) }
      }
      Unit
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

    /**
     * Reports an Answer tapped on the notification that launched the app.
     *
     * The broadcast that carried it may have arrived before JavaScript
     * existed, in which case the intent extras are the only record left.
     * Consuming clears it, so returning to the app later does not re-answer a
     * call that ended hours ago.
     */
    Function<String?>("consumeAnsweredCall") {
      val intent = appContext.currentActivity?.intent
      val answered = intent?.getBooleanExtra(CallNotification.EXTRA_ANSWERED, false) == true
      if (!answered) {
        null
      } else {
        val id = intent?.getStringExtra(CallNotification.EXTRA_CALL_ID)
        intent?.removeExtra(CallNotification.EXTRA_ANSWERED)
        intent?.removeExtra(CallNotification.EXTRA_CALL_ID)
        id
      }
    }
  }
}
