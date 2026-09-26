package dev.notifyjs.call

/**
 * Carries Answer and Decline from the notification back to the app.
 *
 * The broadcast receiver runs whether or not JavaScript is up, so the two cannot
 * talk directly. Every tap is held here and collected by the app through
 * `consumePendingCallActions`; the event the module sends is a nudge, not the
 * delivery. Tapping Answer on a lock screen very often *is* what starts the app,
 * and dropping that tap would show somebody a call they had already answered -
 * or, for a decline, leave the hub ringing a phone whose owner has said no.
 */
object CallEvents {
  data class Action(val action: String, val callId: String)

  private var listener: ((Action) -> Unit)? = null
  private val pending = ArrayDeque<Action>()

  @Synchronized
  fun emit(action: String, callId: String) {
    val event = Action(action, callId)

    // Queued whether or not anything is listening, and the listener is only a
    // nudge to come and collect it. Queueing solely when `listener == null` left
    // a window that swallowed taps outright: the module installs its listener
    // while the registry is being built, so between that moment and the bundle
    // subscribing there *was* a listener and no subscriber, and the event went to
    // an emitter with nobody on it. One call at a time; an older unanswered tap is
    // not worth keeping.
    if (pending.size >= 8) pending.removeFirst()
    pending.addLast(event)

    listener?.invoke(event)
  }

  @Synchronized
  fun listen(callback: (Action) -> Unit) {
    listener = callback
  }

  /**
   * Hands over the taps that arrived before anybody was listening, and forgets
   * them.
   *
   * `listen` used to replay them itself, and that never reached JavaScript: the
   * module installs its listener from `OnCreate`, which runs while the module
   * registry is being built - before the bundle has executed, let alone
   * subscribed - so every replayed tap was sent to an emitter with no
   * subscribers and dropped. Answer survived only because it has a second path
   * through the activity intent; Decline had none, so a decline from a lock
   * screen was lost and the hub waited out the whole ring before escalating to
   * the next person.
   *
   * Pulled rather than pushed, exactly like `consumeAnsweredCall`, because that
   * is the shape that demonstrably works across this boundary.
   */
  @Synchronized
  fun drainPending(): List<Action> {
    val held = pending.toList()
    pending.clear()
    return held
  }

  @Synchronized
  fun stopListening() {
    listener = null
  }
}
