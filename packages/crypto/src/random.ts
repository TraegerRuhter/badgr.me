/**
 * CSPRNG seam. Platforms inject their own source: web and Node pass
 * `webCryptoRandom`, React Native passes a wrapper over
 * `expo-crypto.getRandomBytes`.
 *
 * This is a seam rather than a direct call so that a platform without
 * `globalThis.crypto` fails at wiring time instead of silently at the first
 * nonce generation — a nonce from a weak source is a catastrophic, invisible
 * failure under AES-GCM.
 */
export type RandomSource = (byteLength: number) => Uint8Array;

export const webCryptoRandom: RandomSource = (byteLength) => {
  const out = new Uint8Array(byteLength);
  const c = globalThis.crypto;
  if (!c?.getRandomValues) {
    throw new Error("No WebCrypto CSPRNG available; inject a RandomSource explicitly");
  }
  c.getRandomValues(out);
  return out;
};
