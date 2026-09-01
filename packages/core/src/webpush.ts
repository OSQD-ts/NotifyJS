/**
 * Web Push: the browser as a real client, rather than a tab that happens to be
 * open.
 *
 * The dashboard used to raise alerts with `new Notification(...)`, which lives
 * and dies with the page. Close the tab and the browser stops being a client
 * at all. This is the other half - a push the browser's own service worker
 * receives while nothing of ours is running.
 *
 * It also happens to be how iOS works at all. Safari has delivered Web Push to
 * home-screen web apps since 16.4, so a hub with this reaches an iPhone with no
 * Apple Developer account, no App Store review, and no native build.
 *
 * Two RFCs, implemented here rather than pulled in:
 *
 *   RFC 8291  message encryption - ECDH on P-256 to a key the browser
 *             generated, HKDF, AES-128-GCM
 *   RFC 8292  VAPID - a signed assertion identifying this hub to the push
 *             service, so a subscription is only usable by whoever created it
 *
 * The point of the first one is worth stating plainly, because it is what makes
 * this fit a project that otherwise refuses to route your alerts through
 * anybody: the push service is handed ciphertext. Mozilla, Google and Apple
 * forward bytes they cannot read, keyed to a public key their own browser
 * generated and never sent us in the clear. That is a materially better
 * position than the Expo path in `push.ts`, which hands a third party the
 * notification title.
 *
 * Written against `node:crypto` instead of the `web-push` package on purpose.
 * This is ~200 lines of standard primitives; the dependency is a much larger
 * surface for a project that pins every action to a SHA and builds its
 * container with `--ignore-scripts`.
 */
import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign as signBuffer,
} from 'node:crypto';

import type { WebPushKeys } from '@osqd/notifyjs-protocol';

/** An application server keypair, base64url, raw rather than DER. */
export interface VapidKeys {
  /** Uncompressed P-256 point, 65 bytes. This is what a browser is given. */
  publicKey: string;
  /** The scalar, 32 bytes. */
  privateKey: string;
}

export interface WebPushTarget {
  endpoint: string;
  keys: WebPushKeys;
}

const CURVE = 'prime256v1';

/** Record size. One record is always enough here; a push payload is capped
 * around 4KB by every push service anyway. */
const RECORD_SIZE = 4096;

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * HKDF, in the one shape RFC 8188 uses: a single-block expand.
 *
 * Every output here is 32 bytes or fewer, so the expand loop reduces to one
 * HMAC over `info || 0x01`. Spelling that out is shorter and easier to check
 * against the RFC than a general implementation would be.
 */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.of(1)])).subarray(0, length);
}

/** A fresh application server keypair. Generated once per hub and kept. */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  return {
    publicKey: b64url(ecdh.getPublicKey()),
    // Left-padded to 32 bytes: `getPrivateKey` returns the scalar with leading
    // zero bytes trimmed, and a JWK `d` of the wrong length is rejected.
    privateKey: b64url(leftPad(ecdh.getPrivateKey(), 32)),
  };
}

function leftPad(buf: Buffer, length: number): Buffer {
  if (buf.length >= length) return buf;
  return Buffer.concat([Buffer.alloc(length - buf.length), buf]);
}

/**
 * One encrypted push body, ready to be the request payload.
 *
 * `override` exists so the RFC 8291 example can be reproduced exactly: the salt
 * and the sender keypair are the only randomness in here, and a test that
 * cannot fix them can only check that this round-trips against itself - which
 * would pass just as happily with the info strings wrong in a matching way.
 */
export function encryptPayload(
  plaintext: Buffer,
  target: WebPushKeys,
  override?: { salt?: Buffer; senderPrivateKey?: Buffer },
): Buffer {
  const uaPublic = fromB64url(target.p256dh);
  const authSecret = fromB64url(target.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('p256dh is not an uncompressed P-256 point');
  }
  if (authSecret.length !== 16) throw new Error('auth secret is not 16 bytes');

  const ecdh = createECDH(CURVE);
  if (override?.senderPrivateKey) ecdh.setPrivateKey(override.senderPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const salt = override?.salt ?? randomBytes(16);

  // RFC 8291 section 3.4. The auth secret is the salt for a first HKDF whose
  // info binds the result to *both* public keys - which is what stops a push
  // service that has seen one subscription from forging for another.
  const ikm = hkdf(
    authSecret,
    sharedSecret,
    Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]),
    32,
  );

  // RFC 8188 section 2.2, the aes128gcm content encoding proper.
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  // A single record, so the padding delimiter is 0x02 ("last record"). 0x01
  // would say another record follows, and the receiver would wait for one.
  const padded = Buffer.concat([plaintext, Buffer.of(2)]);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  // RFC 8188 section 2.1: salt | record size | key id length | key id.
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);

  return Buffer.concat([header, asPublic, ciphertext]);
}

/**
 * The `Authorization` header a push service requires, per RFC 8292.
 *
 * The JWT is scoped to the push service's own origin and expires, so one
 * captured from a request to Mozilla is no use against Apple, and no use
 * against Mozilla tomorrow.
 */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now: number = Date.now(),
): string {
  const audience = new URL(endpoint).origin;

  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: audience,
    // Twelve hours. The RFC caps this at 24; well short of it means a clock
    // skewed by an hour on either side still works.
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: subject,
  };

  const signingInput = [header, claims]
    .map((part) => b64url(Buffer.from(JSON.stringify(part))))
    .join('.');

  const publicKey = fromB64url(keys.publicKey);
  const privateKey = fromB64url(keys.privateKey);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: b64url(publicKey.subarray(1, 33)),
    y: b64url(publicKey.subarray(33, 65)),
    d: b64url(privateKey),
  };

  // `ieee-p1363` is r||s, which is what JWS ES256 is defined as. Node's default
  // for EC is DER, and a DER signature here is rejected by every push service
  // with a 401 that says nothing about why.
  const signature = signBuffer('sha256', Buffer.from(signingInput), {
    key: createPrivateKey({ key: jwk, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  });

  return `vapid t=${signingInput}.${b64url(signature)}, k=${keys.publicKey}`;
}

/** What the service worker is handed. Deliberately small - see `send`. */
export interface WebPushPayload {
  title: string;
  body?: string;
  tag?: string;
  severity?: string;
  /** Where a click should land. Relative to the dashboard root. */
  url?: string;
}

export interface WebPushSenderOptions {
  enabled: boolean;
  /** The VAPID `sub` claim: a `mailto:` or `https:` URI identifying the hub. */
  subject: string;
  /** How long a push service should hold a message for a browser that is offline. */
  ttlSeconds: number;
}

/**
 * Sends one encrypted push per subscription.
 *
 * No batching, unlike the Expo sender: every subscription has its own endpoint,
 * its own keys and its own encryption, so there is nothing to batch. A handful
 * of parallel requests is the whole of it.
 */
export class WebPushSender {
  constructor(
    private readonly opts: WebPushSenderOptions,
    private readonly keys: () => VapidKeys,
    private readonly log: (line: string, meta?: Record<string, unknown>) => void,
    private readonly onResult: (ok: boolean, count: number) => void = () => {},
    /**
     * A subscription the push service says is gone.
     *
     * A browser that has revoked permission, or a profile that was deleted,
     * leaves an endpoint that answers 404 or 410 forever. Nothing else would
     * ever retire it, so the one party that can is told.
     */
    private readonly onUnreachable: (deviceId: string) => void = () => {},
  ) {}

  get enabled(): boolean {
    return this.opts.enabled;
  }

  async send(targets: Array<WebPushTarget & { deviceId: string }>, payload: WebPushPayload): Promise<void> {
    if (!this.opts.enabled || targets.length === 0) return;

    const body = Buffer.from(JSON.stringify(payload));
    const results = await Promise.all(targets.map((t) => this.sendOne(t, body)));

    const ok = results.filter(Boolean).length;
    this.onResult(ok > 0, ok);
  }

  private async sendOne(
    target: WebPushTarget & { deviceId: string },
    body: Buffer,
  ): Promise<boolean> {
    let encrypted: Buffer;
    try {
      encrypted = encryptPayload(body, target.keys);
    } catch (err) {
      // A malformed subscription can never be delivered to, so retiring it is
      // the only outcome that does not repeat this on every future alert.
      this.log('web push subscription is unusable', {
        deviceId: target.deviceId,
        error: (err as Error).message,
      });
      this.onUnreachable(target.deviceId);
      return false;
    }

    try {
      const response = await fetch(target.endpoint, {
        method: 'POST',
        headers: {
          authorization: vapidAuthorization(target.endpoint, this.keys(), this.opts.subject),
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(this.opts.ttlSeconds),
          // `high` is what tells a phone to wake for this rather than hold it
          // until the radio is next up anyway. This is a pager.
          urgency: 'high',
        },
        body: encrypted,
        signal: AbortSignal.timeout(10_000),
      });

      // 404 is "no such subscription", 410 is "it existed and is gone". Both
      // are permanent, and both mean this device will never be reached again
      // through this endpoint.
      if (response.status === 404 || response.status === 410) {
        this.log('web push subscription is gone', { deviceId: target.deviceId });
        this.onUnreachable(target.deviceId);
        return false;
      }

      if (!response.ok) {
        this.log('web push rejected', {
          deviceId: target.deviceId,
          status: response.status,
          detail: (await response.text().catch(() => '')).slice(0, 200),
        });
        return false;
      }
      return true;
    } catch (err) {
      // A push service that is unreachable is not a subscription that is dead.
      this.log('web push failed', { deviceId: target.deviceId, error: (err as Error).message });
      return false;
    }
  }
}
