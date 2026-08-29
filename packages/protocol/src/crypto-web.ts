import type { CryptoProvider, KeyPair } from './crypto.js';
import { fromBase64Url, toBase64Url, utf8 } from './canonical.js';

/**
 * WebCrypto backend for the dashboard. Ed25519 landed in all current browser
 * engines; `isSupported()` lets the UI say so plainly instead of failing at
 * the moment the user tries to pair.
 */
const ALG = { name: 'Ed25519' } as const;

/**
 * WebCrypto's `BufferSource` will not accept a `Uint8Array` that TypeScript
 * types as possibly SharedArrayBuffer-backed, so copy into a plain buffer.
 */
function src(u: Uint8Array): ArrayBuffer {
  return u.slice().buffer as ArrayBuffer;
}

export async function isSupported(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}

export const webCrypto: CryptoProvider = {
  randomBytes(n) {
    const out = new Uint8Array(n);
    crypto.getRandomValues(out);
    return out;
  },

  async generateKeyPair(): Promise<KeyPair> {
    const pair = (await crypto.subtle.generateKey(ALG, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as { x: string };
    const priv = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as { d: string };
    return { publicKey: pub.x, secretSeed: priv.d };
  },

  async sign(pair, message) {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', d: pair.secretSeed, x: pair.publicKey },
      ALG,
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign(ALG, key, src(utf8(message)));
    return toBase64Url(new Uint8Array(sig));
  },

  async verify(publicKey, message, sig) {
    try {
      const key = await crypto.subtle.importKey(
        'raw',
        src(fromBase64Url(publicKey)),
        ALG,
        false,
        ['verify'],
      );
      return await crypto.subtle.verify(ALG, key, src(fromBase64Url(sig)), src(utf8(message)));
    } catch {
      return false;
    }
  },
};
