/** Wire protocol version. Bumped only on breaking envelope changes. */
export const PROTOCOL_VERSION = 1 as const;

/** Default port for the embedded hub. Configurable via `NotifierOptions.port`. */
export const DEFAULT_PORT = 7741;

/** Domain-separation tags. Signatures are only ever valid for one purpose. */
export const SIG_AUTH = 'notifyjs/auth/v1';
export const SIG_PAIR = 'notifyjs/pair/v1';
export const SIG_ADMIN = 'notifyjs/admin/v1';
