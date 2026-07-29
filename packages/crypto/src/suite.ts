/**
 * Format constants for the BDGR1 envelope (docs/plans/portable-sync-build-plan.md §3.3).
 *
 * Everything here is part of the on-disk contract. Changing a value without
 * bumping FORMAT_VERSION silently breaks every previously written blob, so the
 * committed test vectors in vectors.test.ts exist to make that impossible to do
 * by accident.
 */

/** "BDGR" — identifies the envelope before anything else is trusted. */
export const MAGIC = Uint8Array.from([0x42, 0x44, 0x47, 0x52]);

export const FORMAT_VERSION = 0x01;

/** Argon2id + HKDF-SHA256 + AES-256-GCM. The default. */
export const SUITE_ARGON2ID = 0x01;
/** scrypt + HKDF-SHA256 + AES-256-GCM. Alternate, for constrained devices. */
export const SUITE_SCRYPT = 0x02;

export const VAULT_ID_BYTES = 16;
export const SALT_BYTES = 16;
export const NONCE_BYTES = 12;
export const KEY_BYTES = 32;
/** 32-byte key sealed under AES-GCM: 32 ciphertext + 16 tag. */
export const WRAPPED_KEY_BYTES = 48;

export const HEADER_BYTES = 124;

/** Plaintext is padded to a multiple of this so length leaks only a bucket. */
export const PAD_BLOCK = 4096;

/** Byte offsets within the header. The header is cleartext and is the GCM AAD. */
export const OFF = {
  magic: 0,
  version: 4,
  suite: 5,
  kdfParams: 6,
  vaultId: 12,
  kdfSalt: 28,
  wrapNonce: 44,
  wrappedDataKey: 56,
  seq: 104,
  payloadNonce: 112,
} as const;

export const KDF_PARAM_BYTES = 6;

export type KdfParams =
  | {
      readonly suite: typeof SUITE_ARGON2ID;
      /** Memory cost in KiB. */
      readonly m: number;
      /** Time cost (iterations). */
      readonly t: number;
      /** Parallelism. */
      readonly p: number;
    }
  | {
      readonly suite: typeof SUITE_SCRYPT;
      readonly logN: number;
      readonly r: number;
      readonly p: number;
    };

/**
 * Argon2id at OWASP's minimum (19 MiB, t=2, p=1).
 *
 * Chosen over scrypt on measurement, not convention: at OWASP's recommended
 * scrypt parameters (N=2^17) the pure-JS derivation peaked at ~132 MB RSS,
 * which risks OOM on low-end Android. Argon2id at these settings costs ~23 MB
 * for comparable time, and is OWASP's first-choice algorithm rather than its
 * fallback.
 */
export const DEFAULT_KDF: KdfParams = {
  suite: SUITE_ARGON2ID,
  m: 19456,
  t: 2,
  p: 1,
};

/** HKDF domain separation. Any change here invalidates existing vaults. */
export const KEK_INFO = new TextEncoder().encode("badgr/v1/kek");
