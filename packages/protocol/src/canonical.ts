/**
 * Signature transcripts are built as netstrings (`<len>:<value>` joined by
 * `|`) rather than plain concatenation. Without length prefixes, a signature
 * over ("ab", "c") and ("a", "bc") would be identical, letting an attacker
 * shift bytes between fields to forge a different-but-valid transcript.
 */
export function canonical(parts: (string | number)[]): string {
  return parts
    .map((p) => {
      const s = String(p);
      return `${s.length}:${s}`;
    })
    .join('|');
}

/** URL-safe base64 without padding, used for every binary field on the wire. */
export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  if (typeof atob === 'function') {
    const bin = atob(b64 + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64 + pad, 'base64'));
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
