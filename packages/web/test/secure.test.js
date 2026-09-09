import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cryptoUnavailable } from '../dist/secure.js';

/** Runs `fn` with `globalThis.crypto` replaced, then puts it back. */
function withCrypto(value, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else delete globalThis.crypto;
  }
}

test('a secure context is not complained about', () => {
  assert.equal(withCrypto({ subtle: {} }, cryptoUnavailable), undefined);
});

test('an insecure context is named, with what to do about it', () => {
  // `crypto.subtle` is undefined over plain http at a LAN address, which is
  // the deployment `publicUrl` documents and the hub's own pairing link points
  // at. Pairing throws a TypeError from inside key generation, before a byte
  // reaches the hub, so without this the only symptom is a dead button.
  const message = withCrypto({ getRandomValues: () => {} }, cryptoUnavailable);
  assert.ok(message, 'the condition is reported');
  assert.match(message, /https/, 'says to use https');
  assert.match(message, /localhost/, 'and names the other way out');
});

test('a browser with no crypto object at all is handled', () => {
  assert.ok(withCrypto(undefined, cryptoUnavailable));
});
