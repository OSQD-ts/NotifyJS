/**
 * Whether this browser will let the dashboard mint a keypair at all.
 *
 * `crypto.subtle` exists only in a secure context: https, or an origin the
 * browser treats as local. A self-hosted hub reached over plain http at a LAN
 * address - which is what `publicUrl` documents, and what the hub's own
 * pairing link points at - is not one, so `subtle` is simply `undefined`
 * there.
 *
 * That failure is unguessable from the outside. Key generation throws a
 * TypeError from inside pairing, before a single byte reaches the hub, and all
 * the person sees is a button that stopped working. Naming the cause is the
 * whole value of this: the fix is a deployment change, not anything they can
 * do on the pairing screen.
 *
 * Separated from `app.ts` so it can be tested. That module is the entry point
 * and wires up the whole dashboard on import.
 */
export function cryptoUnavailable(): string | undefined {
  if (globalThis.crypto?.subtle) return undefined;
  return (
    'This browser will not allow a key to be generated over an insecure ' +
    'connection, so this device cannot pair from here. Open the dashboard over ' +
    'https, or from the machine running the hub at http://localhost:7741.'
  );
}
