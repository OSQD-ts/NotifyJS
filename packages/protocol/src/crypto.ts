/**
 * Device identity is an Ed25519 keypair generated on the device itself. The
 * hub only ever learns the public half, so a compromised hub store cannot be
 * used to impersonate a device — there is nothing in it to replay.
 *
 * Each platform supplies the primitive through this interface: `node:crypto`
 * on the hub and CLI, WebCrypto in the dashboard, `@noble/ed25519` on React
 * Native. Everything above this line is platform-agnostic.
 */
export interface KeyPair {
  /** Raw 32-byte public key, base64url. Sent to the hub during pairing. */
  publicKey: string;
  /** Raw 32-byte private seed, base64url. Never leaves the device. */
  secretSeed: string;
}

export interface CryptoProvider {
  randomBytes(n: number): Uint8Array;
  generateKeyPair(): Promise<KeyPair>;
  /**
   * Signs a canonical transcript, returning a base64url signature.
   *
   * Takes the whole pair rather than just the seed: WebCrypto cannot derive a
   * public key from a private one, so the browser backend needs both halves.
   */
  sign(key: KeyPair, message: string): Promise<string>;
  verify(publicKey: string, message: string, sig: string): Promise<boolean>;
}

/**
 * Length-independent equality for hex/base64 strings.
 *
 * Comparing secrets with `===` leaks how many leading characters matched via
 * timing, which is enough to recover a token one character at a time. This
 * always walks the full length of both inputs.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
