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
    while (pending.isNotEmpty()) callback(pending.removeFirst())
  }

  @Synchronized
  fun stopListening() {
    listener = null
  }
}
