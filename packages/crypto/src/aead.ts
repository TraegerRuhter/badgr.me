import { gcm } from "@noble/ciphers/aes.js";

/**
 * The AEAD seam (build plan §6.1 / §6.2).
 *
 * Payload encryption is abstracted behind this interface for one reason: web
 * and mobile must not share a key representation. Mobile holds raw key bytes
 * and drives `@noble/ciphers`; web holds a **non-extractable** WebCrypto
 * `CryptoKey`, whose bytes cannot be read back out even by script running in
 * the page (adversary A5). Both produce byte-identical AES-256-GCM output, and
 * `aead.interop.test.ts` asserts that on every run — which is what makes the
 * split safe rather than a fork.
 *
 * Async because WebCrypto is async. The mobile side is synchronous underneath
 * and simply resolves immediately.
 */
export interface Aead {
  encrypt(nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>;
  decrypt(nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array>;
}

/** AES-256-GCM over raw key bytes. The mobile/Node path. */
export function nobleAead(dataKey: Uint8Array): Aead {
  return {
    async encrypt(nonce, aad, plaintext) {
      return gcm(dataKey, nonce, aad).encrypt(plaintext);
    },
    async decrypt(nonce, aad, ciphertext) {
      return gcm(dataKey, nonce, aad).decrypt(ciphertext);
    },
  };
}

/**
 * Structural stand-ins for the two WebCrypto types this package touches.
 *
 * Declared by shape rather than imported from the DOM lib on purpose: this
 * package must typecheck and run under Hermes, where `lib.dom` is a lie. The
 * real `SubtleCrypto` and `CryptoKey` satisfy these, so callers just pass
 * `globalThis.crypto.subtle` and get full type checking at the call site.
 */
export interface CryptoKeyLike {
  readonly type: string;
  readonly extractable: boolean;
}

/**
 * WebCrypto's own signatures take `BufferSource`, which since TypeScript 5.7
 * means an array backed specifically by an `ArrayBuffer` rather than a possibly
 * shared one. Matching that here is what lets a real `SubtleCrypto` satisfy
 * this interface; the conversions live in the two wrappers below.
 */
type OwnedBytes = Uint8Array<ArrayBuffer>;

interface AesGcmParamsLike {
  name: string;
  iv: OwnedBytes;
  additionalData?: OwnedBytes;
  tagLength?: number;
}

export interface SubtleCryptoLike {
  encrypt(
    algorithm: AesGcmParamsLike,
    key: CryptoKeyLike,
    data: OwnedBytes
  ): Promise<ArrayBuffer>;
  decrypt(
    algorithm: AesGcmParamsLike,
    key: CryptoKeyLike,
    data: OwnedBytes
  ): Promise<ArrayBuffer>;
  importKey(
    format: "raw",
    keyData: OwnedBytes,
    algorithm: { name: string },
    extractable: boolean,
    keyUsages: readonly string[]
  ): Promise<CryptoKeyLike>;
}

/**
 * Hands a `Uint8Array` to WebCrypto as an owned-buffer view.
 *
 * A copy only when one is actually needed: a `SharedArrayBuffer`-backed view is
 * the case the type is guarding against, and WebCrypto genuinely rejects those,
 * so copying is the fix rather than a cast that defers the failure to runtime.
 */
function owned(bytes: Uint8Array): OwnedBytes {
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as OwnedBytes)
    : (Uint8Array.from(bytes) as OwnedBytes);
}

/** GCM tag length in bits. Fixed at the maximum; anything shorter weakens forgery resistance. */
const TAG_BITS = 128;

/**
 * AES-256-GCM over a WebCrypto key handle. The web path.
 *
 * WebCrypto appends the tag to the ciphertext exactly as noble does, so the
 * two produce identical bytes for identical inputs.
 */
export function webCryptoAead(subtle: SubtleCryptoLike, key: CryptoKeyLike): Aead {
  return {
    async encrypt(nonce, aad, plaintext) {
      const out = await subtle.encrypt(
        { name: "AES-GCM", iv: owned(nonce), additionalData: owned(aad), tagLength: TAG_BITS },
        key,
        owned(plaintext)
      );
      return new Uint8Array(out);
    },
    async decrypt(nonce, aad, ciphertext) {
      const out = await subtle.decrypt(
        { name: "AES-GCM", iv: owned(nonce), additionalData: owned(aad), tagLength: TAG_BITS },
        key,
        owned(ciphertext)
      );
      return new Uint8Array(out);
    },
  };
}

/**
 * Imports raw data-key bytes into a WebCrypto handle.
 *
 * `extractable: false` is the entire point on web (build plan §6.2): the
 * resulting key can be persisted in IndexedDB and used to seal and open
 * envelopes, but its bytes can never be read back out — so injected script
 * gets the use of the vault for one session rather than the key forever.
 *
 * The caller still holds `raw` in memory at this moment, which is unavoidable:
 * the bytes come out of Argon2id + an AES unwrap, and WebCrypto has no Argon2.
 * Zero `raw` as soon as this resolves — see `zeroize`.
 */
export async function importDataKey(
  subtle: SubtleCryptoLike,
  raw: Uint8Array,
  extractable = false
): Promise<CryptoKeyLike> {
  return subtle.importKey("raw", owned(raw), { name: "AES-GCM" }, extractable, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Overwrites key material in place.
 *
 * Best-effort by nature — a JS engine may have copied the buffer during GC and
 * we cannot reach those copies. It still shortens the window in which a heap
 * snapshot or a crash dump contains the data key, which is worth the one line.
 */
export function zeroize(secret: Uint8Array): void {
  secret.fill(0);
}
