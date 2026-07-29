import { gcm } from "@noble/ciphers/aes.js";
import { argon2id } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  FORMAT_VERSION,
  KEK_INFO,
  KEY_BYTES,
  SUITE_ARGON2ID,
  SUITE_SCRYPT,
  type KdfParams,
} from "./suite";

/**
 * Key hierarchy (build plan §3.1):
 *
 *   passphrase ──KDF──► masterKey ──HKDF──► KEK ──unwraps──► dataKey
 *
 * The passphrase and everything derived from it stay on the device. The KDF is
 * paid once per unlock, never per sync — which is the only reason a
 * deliberately expensive memory-hard function is affordable here.
 */

/**
 * Unicode-normalise before deriving. Without this, a passphrase containing
 * accented characters can derive different keys on different platforms
 * depending on how the keyboard composed them — an unlock failure that is
 * impossible to debug from the user's side.
 */
function passphraseBytes(passphrase: string): Uint8Array {
  return new TextEncoder().encode(passphrase.normalize("NFC"));
}

export function deriveMasterKey(
  passphrase: string,
  salt: Uint8Array,
  kdf: KdfParams
): Uint8Array {
  const pass = passphraseBytes(passphrase);
  if (kdf.suite === SUITE_ARGON2ID) {
    return argon2id(pass, salt, { m: kdf.m, t: kdf.t, p: kdf.p, dkLen: KEY_BYTES });
  }
  if (kdf.suite === SUITE_SCRYPT) {
    return scrypt(pass, salt, { N: 2 ** kdf.logN, r: kdf.r, p: kdf.p, dkLen: KEY_BYTES });
  }
  throw new Error("Unknown KDF suite");
}

export function deriveKek(masterKey: Uint8Array, salt: Uint8Array): Uint8Array {
  return hkdf(sha256, masterKey, salt, KEK_INFO, KEY_BYTES);
}

/**
 * Binds the wrapped data key to its vault and format version, so a wrapped key
 * lifted from one vault cannot be replayed into another.
 */
export function wrapAad(vaultId: Uint8Array): Uint8Array {
  const aad = new Uint8Array(vaultId.length + 1);
  aad.set(vaultId, 0);
  aad[vaultId.length] = FORMAT_VERSION;
  return aad;
}

export function wrapDataKey(
  kek: Uint8Array,
  wrapNonce: Uint8Array,
  dataKey: Uint8Array,
  vaultId: Uint8Array
): Uint8Array {
  return gcm(kek, wrapNonce, wrapAad(vaultId)).encrypt(dataKey);
}

export function unwrapDataKey(
  kek: Uint8Array,
  wrapNonce: Uint8Array,
  wrapped: Uint8Array,
  vaultId: Uint8Array
): Uint8Array {
  return gcm(kek, wrapNonce, wrapAad(vaultId)).decrypt(wrapped);
}
