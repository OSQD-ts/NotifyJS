package dev.notifyjs.call

import android.content.Context
import android.os.PowerManager

/**
 * Tells the app to go and look at its connection.
 *
 * The client already knows how to recover a dead socket - it pings, it
 * notices silence, it reconnects with backoff. All of that is JavaScript
 * timers, and on a dozing phone a JavaScript timer is measured against a clock
 * the OS has stopped advancing. So the machinery is sound and simply never
 * runs: the phone wakes hours later still holding a socket that died in the
 * night, with a reconnect pending that was never going to fire.
 *
 * What arrives here is the one thing JavaScript cannot arrange for itself - a
 * reason to run, delivered by something the OS does schedule. The event says
 * only "check now"; what to do about it stays in the client, which is the only
 * side that knows what it missed.
 */
object WatchEvents {
  /**
   * How long the CPU is held up for after a wake.
   *
   * Long enough for a socket to be reopened, a handshake signed and a replay
   * to arrive on a slow connection. Acquired with a timeout rather than
   * released by hand: the work is asynchronous and spread across JavaScript,
   * so there is no single place that could be trusted to let go, and a
   * wake lock leaked on a phone is a flat battery by morning.
   */
  private const val WAKE_MS = 30_000L

  private var listener: ((String) -> Unit)? = null
  private var wakeLock: PowerManager.WakeLock? = null

  /**
   * Wakes the CPU and asks the app to resync.
   *
   * Deliberately not queued when nobody is listening, unlike [CallEvents]: an
   * unheard wake means the JavaScript runtime is gone, and a runtime that
   * starts later syncs on its own as part of coming up. Replaying a stale
   * "check now" would ask it to do again what it has just done.
   */
  @Synchronized
  fun wake(context: Context, reason: String) {
    holdCpu(context)
    listener?.invoke(reason)
  }

  @Synchronized
  fun listen(callback: (String) -> Unit) {
    listener = callback
  }

  @Synchronized
  fun stopListening() {
    listener = null
  }

  /**
   * Keeps the processor up while the resync runs.
   *
   * An alarm that fires in Doze wakes the CPU only for as long as it takes to
   * deliver the broadcast; without this the phone can be asleep again before
   * the socket has finished opening, which turns a wake-up into a wasted one.
   */
  private fun holdCpu(context: Context) {
    val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
    val lock = wakeLock ?: runCatching {
      power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "notifyjs:wake").apply {
        // Not reference counted, so a wake arriving while a previous one is
        // still held extends the deadline rather than needing a matching
        // release that nothing here is in a position to issue.
        setReferenceCounted(false)
      }
    }.getOrNull()?.also { wakeLock = it } ?: return

    runCatching { lock.acquire(WAKE_MS) }
  }
}
