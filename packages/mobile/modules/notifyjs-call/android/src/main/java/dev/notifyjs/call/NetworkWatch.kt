package dev.notifyjs.call

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest

/**
 * Reconnects the moment the phone has a network again.
 *
 * Walking out of the house swaps Wi-Fi for cellular, and the socket does not
 * survive it. Nothing tells the app so: the old network simply stops carrying
 * packets, and TCP will sit on a connection like that for many minutes before
 * admitting it is gone. Until then the client believes it is connected, the
 * hub writes alerts into a socket nobody is reading, and the person holding
 * the phone hears nothing.
 *
 * A network callback turns that into an event. It costs one registration and
 * makes the handover case - which is most of them - recover in about a second
 * instead of waiting for [WatchAlarm].
 */
object NetworkWatch {
  private var callback: ConnectivityManager.NetworkCallback? = null

  fun start(context: Context) {
    if (callback != null) return
    val app = context.applicationContext
    val manager = app.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return

    val cb = object : ConnectivityManager.NetworkCallback() {
      /**
       * Also fires once on registration when a network is already up, which
       * is a resync on service start rather than a spurious one - the socket
       * may well have died while the service was being restarted.
       */
      override fun onAvailable(network: Network) {
        WatchEvents.wake(app, "network")
      }
    }

    // The request form rather than `registerDefaultNetworkCallback`, which
    // arrived in API 24 and this module builds below that.
    val request = NetworkRequest.Builder()
      .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      .build()

    runCatching { manager.registerNetworkCallback(request, cb) }
      .onSuccess { callback = cb }
  }

  fun stop(context: Context) {
    val cb = callback ?: return
    callback = null
    val manager = context.applicationContext
      .getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
    // Throws if the callback was never registered, which a failed start
    // leaves possible.
    runCatching { manager.unregisterNetworkCallback(cb) }
  }
}
