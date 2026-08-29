package dev.notifyjs.call

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

/**
 * Speaks the message of an answered call.
 *
 * This used to be `expo-speech`, which hands the text to Android's TTS with
 * default audio attributes - meaning the music stream. Answer a call on a
 * silenced phone and the message played to an empty room at whatever the media
 * volume happened to be, usually nothing. Since the whole point of the call is
 * to be heard, the utterance goes out on `USAGE_ALARM` exactly like the ring:
 * loud enough to wake somebody, and not silenced along with their texts.
 */
object CallSpeaker {
  private val ALARM_ATTRS: AudioAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_ALARM)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()

  private var tts: TextToSpeech? = null

  /** Bumped on every new request so a late callback from the previous one is ignored. */
  private var generation = 0

  /**
   * Speaks [text] [repeat] times, then calls [onDone] once.
   *
   * The engine takes a moment to initialise on first use, so the request is
   * deferred until it reports ready rather than dropped. [onDone] runs exactly
   * once whatever happens - a caller stuck waiting for it would leave the call
   * screen with no way out.
   */
  @Synchronized
  fun speak(
    context: Context,
    text: String,
    language: String,
    rate: Float,
    pitch: Float,
    repeat: Int,
    onDone: (error: String?) -> Unit,
  ) {
    val token = ++generation
    val times = repeat.coerceIn(1, 5)
    val last = "notifyjs-$token-${times - 1}"
    var finished = false
    val finish = { error: String? ->
      synchronized(this) {
        // A stopped or superseded request must not resolve the current one.
        if (!finished && token == generation) {
          finished = true
          onDone(error)
        }
      }
    }

    withEngine(context.applicationContext) { engine ->
      if (engine == null) {
        finish("the speech engine is unavailable")
        return@withEngine
      }
      if (token != generation) return@withEngine

      engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) = Unit
        override fun onDone(utteranceId: String?) {
          if (utteranceId == last) finish(null)
        }

        @Deprecated("required by the base class")
        override fun onError(utteranceId: String?) = finish("speech failed")
        override fun onError(utteranceId: String?, errorCode: Int) = finish("speech failed")

        // Stopping is a deliberate hang-up, not a failure, but the caller
        // still has to hear that nothing more is coming.
        override fun onStop(utteranceId: String?, interrupted: Boolean) = finish(null)
      })

      engine.setAudioAttributes(ALARM_ATTRS)
      engine.language = locale(language)
      engine.setSpeechRate(rate.coerceIn(0.5f, 2f))
      engine.setPitch(pitch.coerceIn(0.5f, 2f))

      // KEY_PARAM_STREAM alongside the attributes: older engines honour only
      // one or the other, and being audible matters more than being tidy.
      val params = Bundle().apply {
        putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_ALARM)
        putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1f)
      }

      for (i in 0 until times) {
        val mode = if (i == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
        val queued = engine.speak(text, mode, params, "notifyjs-$token-$i")
        if (queued != TextToSpeech.SUCCESS) {
          finish("speech failed")
          return@withEngine
        }
      }
    }
  }

  /** Hanging up mid-sentence; the utterance listener reports the stop. */
  @Synchronized
  fun stop() {
    generation++
    runCatching { tts?.stop() }
  }

  @Synchronized
  fun shutdown() {
    generation++
    runCatching { tts?.stop() }
    runCatching { tts?.shutdown() }
    tts = null
  }

  /** Reuses the engine once initialised; the first call pays the startup cost. */
  private fun withEngine(context: Context, use: (TextToSpeech?) -> Unit) {
    tts?.let {
      use(it)
      return
    }
    var engine: TextToSpeech? = null
    engine = TextToSpeech(context) { status ->
      if (status == TextToSpeech.SUCCESS) {
        tts = engine
        use(engine)
      } else {
        runCatching { engine?.shutdown() }
        use(null)
      }
    }
  }

  /**
   * An empty or unusable tag means "whatever the phone is set to", which is a
   * better guess than forcing English on someone.
   */
  private fun locale(tag: String): Locale {
    if (tag.isBlank()) return Locale.getDefault()
    return runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) Locale.forLanguageTag(tag)
      else Locale(tag)
    }.getOrDefault(Locale.getDefault())
  }
}
