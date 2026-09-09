import { randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256Hex, type Capability, type Role } from '@osqd/notifyjs-protocol';
import { hasCapability } from '@osqd/notifyjs-protocol';

/**
 * A bearer token that lets something publish over HTTP.
 *
 * Every other way into this hub speaks the WebSocket protocol and proves
 * itself with a signature over a per-connection nonce. That is the stronger
 * scheme and it stays the default - but it also means the only things that
 * can page you are programs you wrote against this project. Everything else
 * that already knows how to raise an alarm - Alertmanager, Grafana, Sentry,
 * a uptime checker, a line of `curl` in a cron job - speaks exactly one
 * protocol: POST some JSON at a URL with a bearer token.
 *
 * So this is deliberately the weaker credential, and is treated like one. It
 * is stored as a hash, it carries a role rather than being all-powerful, it
 * can be revoked without touching any device, and the whole feature is off
 * until somebody turns it on.
 */
export interface IngestToken {
  id: string;
  /** sha256 of the token, domain-separated. The token itself is never stored. */
  hash: string;
  /** Which role's permissions this token publishes with. */
  role: string;
  /** What it is for, so an operator can tell two tokens apart. */
  label?: string;
  createdAt: number;
  lastUsedAt?: number;
  /** Set when revoked; a revoked token is kept so the audit trail still resolves. */
  revokedAt?: number;
}

/**
 * The prefix is not decoration.
 *
 * A token that announces what it is can be recognised by secret scanners in
 * CI, in a git history, or in a pasted log - which is the difference between
 * "this leaked and somebody told us" and "this leaked". It also stops a
 * pairing code, a metrics token or a session id from ever being mistaken for
 * one of these by code that only checks the length.
 */
export const INGEST_TOKEN_PREFIX = 'njs_';

/** 32 bytes of randomness, which is the whole of the secret. */
const TOKEN_BYTES = 32;

/**
 * Hashed with its own domain string, so a value that happens to collide with a
 * pairing code's hash cannot be replayed as one, and vice versa.
 */
export function ingestTokenHash(token: string): string {
  return sha256Hex(new TextEncoder().encode('notifyjs/ingest/' + token));
}

/** Mints a token. The plaintext is returned once and never stored. */
export function mintIngestToken(): { id: string; token: string; hash: string } {
  const token = INGEST_TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
  return { id: randomBytes(8).toString('hex'), token, hash: ingestTokenHash(token) };
}

/**
 * Reads the token out of an Authorization header.
 *
 * Returns undefined for anything that is not exactly one `Bearer <token>`, so
 * a header carrying two schemes, or a token with whitespace in it, is rejected
 * here rather than being trimmed into something that matches.
 */
export function bearerFrom(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header.trim());
  return m ? m[1] : undefined;
}

/**
 * Compares two hashes without leaking where they first differ.
 *
 * The offered token is hashed before it gets here, so both sides are
 * fixed-length hex and the length check below can never be the thing that
 * distinguishes a near-miss from a wrong guess.
 */
export function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Finds the token this request is presenting, if it is a live one.
 *
 * Every stored token is compared even after a match is found. Returning early
 * would make the response time depend on where in the list the token sits,
 * which over enough requests is a way to learn how many tokens exist and
 * roughly where a guess landed among them.
 */
export function findIngestToken(
  tokens: Iterable<IngestToken>,
  offered: string,
): IngestToken | undefined {
  const wanted = ingestTokenHash(offered);
  let found: IngestToken | undefined;
  for (const token of tokens) {
    if (token.revokedAt) continue;
    if (hashesMatch(token.hash, wanted)) found = token;
  }
  return found;
}

/**
 * Whether a token's role may do the thing being asked.
 *
 * Publishing over HTTP is the same permission as publishing over a socket, so
 * this reuses the role's capabilities rather than inventing a parallel set. A
 * token can therefore never do more than a paired device in the same role.
 */
export function tokenMay(role: Role | undefined, capability: Capability): boolean {
  return role ? hasCapability(role, capability) : false;
}

/**
 * Whether an address is this machine.
 *
 * Loopback is the one case where a bearer token on a cleartext connection is
 * not exposed to anything: there is no hop between the caller and the hub. It
 * is what lets a reverse proxy terminate TLS in front of a hub bound to
 * localhost without having to relax the rule for everybody.
 *
 * Must only ever be given a socket's own address. Passing it a value derived
 * from `X-Forwarded-For` would let a caller decide for itself whether it is
 * on-box, which is the whole thing the rule above is there to stop.
 */
export function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
}
