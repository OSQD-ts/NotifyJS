import { sha256Hex, sha256Sync } from './hash.js';

/**
 * Crockford base32: no I, L, O or U, so codes survive being read aloud over a
 * phone or copied off a screen without the classic 0/O and 1/l confusions.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAYLOAD_CHARS = 10; // 50 bits of entropy
const CHECK_CHARS = 2;

/**
 * Builds a pairing code from caller-supplied randomness.
 *
 * The two trailing check characters let a client reject a mistyped code
 * locally. That matters more than it looks: every malformed attempt that never
 * reaches the hub is one that does not burn the IP's rate-limit budget or
 * trip a lockout for the legitimate user standing next to it.
 */
export function encodePairingCode(random: Uint8Array): string {
  if (random.length < 7) throw new Error('need at least 7 random bytes');
  let payload = '';
  // 7 bytes = 56 bits; take 5 bits at a time for the first 10 characters.
  let acc = 0n;
  for (let i = 0; i < 7; i++) acc = (acc << 8n) | BigInt(random[i]!);
  for (let i = 0; i < PAYLOAD_CHARS; i++) {
    const shift = BigInt(56 - 5 * (i + 1));
    payload += ALPHABET[Number((acc >> shift) & 31n)];
  }
  return group(payload + checkChars(payload));
}

function checkChars(payload: string): string {
  const h = sha256Sync(new TextEncoder().encode('notifyjs/code/v1|' + payload));
  return ALPHABET[h[0]! & 31]! + ALPHABET[h[1]! & 31]!;
}

function group(raw: string): string {
  return raw.replace(/(.{4})(?=.)/g, '$1-');
}

/**
 * Formats a pairing code as somebody types it: uppercased, stripped of
 * anything that is not a code character, capped at the code's length, and
 * grouped for reading.
 *
 * Lives beside `encodePairingCode` because it mirrors that function's output.
 * The dashboard, the phone and the desktop app each had their own identical
 * copy, all hardcoding the length rather than using `PAIRING_CODE_LENGTH` -
 * which meant a change to how a code is shaped would have to be made in four
 * places and would be silently wrong in whichever one was missed.
 *
 * Deliberately not `normalizePairingCode`: that maps O to 0 and I to 1 for
 * comparison, which is the right answer for redeeming a code and the wrong one
 * for a text field, where a character has to stay as typed until the field is
 * left. Grouping is presentation; normalising is meaning.
 */
export function formatPairingCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, PAIRING_CODE_LENGTH)
    .replace(/(.{4})(?=.)/g, '$1-');
}

/**
 * Accepts whatever the user actually typed — lowercase, spaces, missing or
 * extra dashes, and the letters Crockford maps onto digits.
 */
export function normalizePairingCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
}

/** True when the code is well-formed and its check characters agree. */
export function isPairingCodeValid(input: string): boolean {
  const norm = normalizePairingCode(input);
  if (norm.length !== PAYLOAD_CHARS + CHECK_CHARS) return false;
  for (const ch of norm) if (!ALPHABET.includes(ch)) return false;
  const payload = norm.slice(0, PAYLOAD_CHARS);
  return checkChars(payload) === norm.slice(PAYLOAD_CHARS);
}

export const PAIRING_CODE_LENGTH = PAYLOAD_CHARS + CHECK_CHARS;

/**
 * Lookup key for a pairing code. The hub stores this instead of the code
 * itself, so a leaked store cannot be used to pair a device.
 *
 * Both the store and the pairing handler derive keys through here: if the two
 * ever computed the prefix differently, codes would silently stop matching.
 */
export function pairingCodeHash(input: string): string {
  const normalized = normalizePairingCode(input);
  return sha256Hex(new TextEncoder().encode('notifyjs/pair/' + normalized));
}
