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

/**
 * The async form of the same seam.
 *
 * React Native's CSPRNG (`expo-crypto.getRandomBytesAsync`) is asynchronous,
 * and the async sealing path exists anyway for WebCrypto, so the two fit
 * together rather than forcing a blocking shim. Prefer this on mobile:
 * `getRandomBytes` (the sync sibling) can fall back to a weaker source on some
 * platforms, and a weak nonce under AES-GCM fails silently and catastrophically.
 */
export type AsyncRandomSource = (byteLength: number) => Promise<Uint8Array>;

/** Lifts a synchronous source into the async seam. */
export function asAsyncRandom(source: RandomSource): AsyncRandomSource {
  return async (byteLength) => source(byteLength);
}

export const webCryptoRandomAsync: AsyncRandomSource = asAsyncRandom(webCryptoRandom);
