package dev.notifyjs.call

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * Rings the phone for an incoming call, in the app's own process.
 *
 * The notification channel used to carry the ringtone, which meant the call was
 * only ever as loud as the ringer: silence the phone and a critical alert went
 * with it. A call that can be muted by the same switch as a text message is not
 * a call, so the sound is played here instead, on `USAGE_ALARM` - the one
 * stream that survives silent mode and Do Not Disturb, and the same one an
 * alarm clock uses to wake somebody who asked to be woken.
 *
 * A wake lock is held for the same span. Without it the CPU is free to sleep
 * between the notification being posted and anyone reaching for the phone, and
 * the ring stutters or stops on a dozing device.
 */
object CallRinger {
  /** Ring cadence: buzz, pause, buzz - matching the notification channel. */
  private val PATTERN = longArrayOf(0, 700, 800, 700, 1600)

  /**
   * A ring nobody answers has to end by itself. If the JS side dies mid-call
   * this is the only thing that stops the phone ringing until the battery does.
   */
  private const val MAX_RING_MS = 60_000L

  private val ALARM_ATTRS: AudioAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_ALARM)
    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
    .build()

  private val stopper = Handler(Looper.getMainLooper())

  private var player: MediaPlayer? = null
  private var vibrator: Vibrator? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var audio: AudioManager? = null
  private var focus: AudioFocusRequest? = null
  private var ringingId: String? = null

  /** The call currently ringing, if any. */
  fun ringing(): String? = ringingId

  @Synchronized
  fun start(context: Context, callId: String) {
    if (ringingId == callId) return
    stop()
    ringingId = callId

    val app = context.applicationContext
    keepAwake(app)
    takeAudioFocus(app)
    playRingtone(app)
    startVibrating(app)

    stopper.postDelayed({ stop() }, MAX_RING_MS)
  }

  /** Idempotent: answering, declining and cancelling all land here. */
  @Synchronized
  fun stop() {
    if (ringingId == null) return
    ringingId = null
    stopper.removeCallbacksAndMessages(null)

    runCatching { vibrator?.cancel() }
    vibrator = null

    player?.let { p ->
      runCatching { if (p.isPlaying) p.stop() }
      runCatching { p.release() }
    }
    player = null

    focus?.let { request ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) audio?.abandonAudioFocusRequest(request)
    }
    focus = null
    audio = null

    wakeLock?.let { if (it.isHeld) runCatching { it.release() } }
    wakeLock = null
  }

  /**
   * Holds the CPU up for as long as the phone is ringing.
   *
   * Timed out at the ring length so a crash between start and stop costs a
   * minute of wakefulness rather than the rest of the day.
   */
  private fun keepAwake(context: Context) {
    val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
    wakeLock = runCatching {
      power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "notifyjs:ring").apply {
        setReferenceCounted(false)
        acquire(MAX_RING_MS)
      }
    }.getOrNull()
  }

  /**
   * Asks for the audio focus a call is entitled to, ducking whatever is
   * playing. Best effort: a refusal is no reason not to ring.
   */
  private fun takeAudioFocus(context: Context) {
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    audio = manager
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      @Suppress("DEPRECATION")
      manager.requestAudioFocus(null, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
      return
    }
    val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
      .setAudioAttributes(ALARM_ATTRS)
      .build()
    focus = request
    runCatching { manager.requestAudioFocus(request) }
  }

  private fun playRingtone(context: Context) {
    val uri = ringtoneUri(context) ?: return
    player = runCatching {
      MediaPlayer().apply {
        setAudioAttributes(ALARM_ATTRS)
        setDataSource(context, uri)
        isLooping = true
        // Prepared synchronously: these are local files, and an async prepare
        // would race the answer that stops us.
        prepare()
        start()
      }
    }.getOrNull()
  }

  /**
   * The user's own ringtone, falling back through alarm and notification tones.
   * A device with none of the three is silent, which the vibration covers.
   */
  private fun ringtoneUri(context: Context): Uri? =
    RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_RINGTONE)
      ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
      ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
      ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)

  /**
   * Vibrates under alarm attributes, so a phone set to silent still buzzes -
   * the same reasoning as the ringtone above.
   */
  private fun startVibrating(context: Context) {
    val vib = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    } ?: return
    if (!vib.hasVibrator()) return
    vibrator = vib

    runCatching {
      // `0` repeats the whole pattern from the start until cancelled.
      when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ->
          vib.vibrate(
            VibrationEffect.createWaveform(PATTERN, 0),
            VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM),
          )

        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ->
          @Suppress("DEPRECATION")
          vib.vibrate(VibrationEffect.createWaveform(PATTERN, 0), ALARM_ATTRS)

        else ->
          @Suppress("DEPRECATION")
          vib.vibrate(PATTERN, 0, ALARM_ATTRS)
      }
    }
  }
}
