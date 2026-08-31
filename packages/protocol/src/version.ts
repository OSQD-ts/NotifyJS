/** Wire protocol version. Bumped only on breaking envelope changes. */
export const PROTOCOL_VERSION = 1 as const;

/** Default port for the embedded hub. Configurable via `NotifierOptions.port`. */
export const DEFAULT_PORT = 7741;

/**
 * Domain-separation tags. Signatures are only ever valid for one purpose, so a
 * captured pair transcript can never be replayed as an auth one.
 *
 * There are exactly two, because exactly two things are signed. Admin frames
 * are not: they arrive on a socket that already proved its identity by signing
 * this connection's nonce, and a per-frame signature would add nothing over
 * that. A third tag used to sit here for admin, which read as though such a
 * signature existed.
 */
export const SIG_AUTH = 'notifyjs/auth/v1';
export const SIG_PAIR = 'notifyjs/pair/v1';
