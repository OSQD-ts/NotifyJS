import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes as nodeRandomBytes,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto';
import type { CryptoProvider, KeyPair } from './crypto.js';
import { fromBase64Url, toBase64Url, utf8 } from './canonical.js';

/**
 * Keys are moved around as JWK rather than DER. The JWK `x`/`d` members are
 * exactly the raw 32-byte public key and private seed, which is the same
 * representation WebCrypto and @noble use — so a key generated on the phone
 * verifies on the hub with no format negotiation.
 */
function publicKeyFromRaw(publicKey: string) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: publicKey },
    format: 'jwk',
  });
}

function privateKeyFromSeed(secretSeed: string) {
  const pub = toBase64Url(derivePublicRaw(secretSeed));
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: pub, d: secretSeed },
    format: 'jwk',
  });
}

/** Ed25519 public keys are a deterministic function of the seed. */
function derivePublicRaw(secretSeed: string): Uint8Array {
  const seed = fromBase64Url(secretSeed);
  if (seed.length !== 32) throw new Error('Ed25519 seed must be 32 bytes');
  // Build a minimal PKCS#8 wrapper around the seed to let node derive the pair.
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(seed),
  ]);
  const key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const jwk = createPublicKey(key).export({ format: 'jwk' }) as { x: string };
  return fromBase64Url(jwk.x);
}

export const nodeCrypto: CryptoProvider = {
  randomBytes(n) {
    return new Uint8Array(nodeRandomBytes(n));
  },

  async generateKeyPair(): Promise<KeyPair> {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = publicKey.export({ format: 'jwk' }) as { x: string };
    const priv = privateKey.export({ format: 'jwk' }) as { d: string };
    return { publicKey: pub.x, secretSeed: priv.d };
  },

  async sign(key, message) {
    const sig = nodeSign(null, utf8(message), privateKeyFromSeed(key.secretSeed));
    return toBase64Url(new Uint8Array(sig));
  },

  async verify(publicKey, message, sig) {
    try {
      return nodeVerify(
        null,
        utf8(message),
        publicKeyFromRaw(publicKey),
        Buffer.from(fromBase64Url(sig)),
      );
    } catch {
      // Malformed key or signature is a failed verification, not a crash —
      // this runs on attacker-controlled input from unauthenticated sockets.
      return false;
    }
  },
};
