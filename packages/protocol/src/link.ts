import { normalizePairingCode } from './code.js';

/**
 * A pairing link carries both halves a device needs to join: which hub to talk
 * to, and the code to redeem. Typing `ws://192.168.1.10:7741` on a phone
 * keyboard is the worst part of the flow, and this removes it.
 *
 * The custom scheme opens the app directly when it is installed. Rendered as a
 * QR code, scanning it is the whole pairing process.
 */
export const PAIR_SCHEME = 'notifyjs';

export interface PairingLink {
  hub: string;
  code: string;
}

export function buildPairingLink(hub: string, code: string): string {
  const params = new URLSearchParams({ hub, code });
  return `${PAIR_SCHEME}://pair?${params.toString()}`;
}

/**
 * Parses a scanned or deep-linked pairing URL.
 *
 * Returns undefined rather than throwing: the input is whatever a camera
 * happened to decode, so a malformed value is an expected outcome, not an
 * exceptional one.
 */
export function parsePairingLink(input: string): PairingLink | undefined {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== `${PAIR_SCHEME}:`) return undefined;

    const hub = url.searchParams.get('hub');
    const code = url.searchParams.get('code');
    if (!hub || !code) return undefined;

    // Only ever hand back a WebSocket URL: a scanned link must not be able to
    // point the app at some other protocol.
    const parsedHub = new URL(hub);
    if (parsedHub.protocol !== 'ws:' && parsedHub.protocol !== 'wss:') return undefined;

    return { hub, code: normalizePairingCode(code) };
  } catch {
    return undefined;
  }
}
