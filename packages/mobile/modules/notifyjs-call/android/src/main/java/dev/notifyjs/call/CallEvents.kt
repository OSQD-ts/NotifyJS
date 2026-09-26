package dev.notifyjs.call

/**
 * Carries Answer and Decline from the notification back to the app.
 *
 * The broadcast receiver runs whether or not JavaScript is up, so the two
 * cannot talk directly. Actions taken before the module is listening are held
 * here and replayed the moment it is: tapping Answer on a lock screen very
 * often *is* what starts the app, and dropping that tap would show the user a
 * call they have already answered.
 */
object CallEvents {
  data class Action(val action: String, val callId: String)

  private var listener: ((Action) -> Unit)? = null
  private val pending = ArrayDeque<Action>()

  @Synchronized
  fun emit(action: String, callId: String) {
    val event = Action(action, callId)
    val current = listener
    if (current == null) {
      // One call at a time; an older unanswered tap is not worth replaying.
      if (pending.size >= 4) pending.removeFirst()
      pending.addLast(event)
    } else {
      current(event)
    }
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
