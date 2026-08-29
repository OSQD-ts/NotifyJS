import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import * as Crypto from 'expo-crypto';
import type { CryptoProvider, KeyPair } from '@notifyjs/protocol';
import { fromBase64Url, toBase64Url, utf8 } from '@notifyjs/protocol';

/**
 * React Native has no `node:crypto` and no WebCrypto Ed25519, so the phone
 * uses @noble - a small audited pure-JS implementation. The wire format is
 * identical to what the hub produces, because all three backends exchange raw
 * 32-byte keys rather than any platform-specific encoding.
 */
/**
 * @noble's async entry points reach for `crypto.subtle`, which React Native
 * does not have - the failure is a bare "crypto.subtle must be defined" at
 * pairing time. Installing this hook lets the synchronous API do the hashing
 * itself, so every call below uses the sync variants deliberately.
 */
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

export const nobleCrypto: CryptoProvider = {
  randomBytes(n) {
    return Crypto.getRandomBytes(n);
  },

  async generateKeyPair(): Promise<KeyPair> {
    // Uses the platform CSPRNG (SecRandomCopyBytes / SecureRandom) rather than
    // JavaScript's Math.random-backed fallbacks.
    const seed = Crypto.getRandomBytes(32);
    const publicKey = ed.getPublicKey(seed);
    return { publicKey: toBase64Url(publicKey), secretSeed: toBase64Url(seed) };
  },

  async sign(key, message) {
    const sig = ed.sign(utf8(message), fromBase64Url(key.secretSeed));
    return toBase64Url(sig);
  },

  async verify(publicKey, message, sig) {
    try {
      return ed.verify(fromBase64Url(sig), utf8(message), fromBase64Url(publicKey));
    } catch {
      return false;
    }
  },
};
