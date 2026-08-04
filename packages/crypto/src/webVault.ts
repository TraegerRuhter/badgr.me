import {
  importDataKey,
  webCryptoAead,
  zeroize,
  type Aead,
  type CryptoKeyLike,
  type SubtleCryptoLike,
} from "./aead";
import {
  changePassphrase,
  createVault,
  toVaultRecord,
  unlockVault,
  unlockVaultRecord,
  unlockWithRecoveryCode,
  type CreateVaultOptions,
  type VaultRecord,
} from "./envelope";

/**
 * The web unlock path (build plan §6.2).
 *
 * Argon2id has no WebCrypto equivalent, so key derivation runs in `@noble/*`
 * on every platform and the raw data key necessarily exists in JS memory for
 * the moment between unwrapping it and importing it. What web does differently
 * is what survives that moment: the imported `CryptoKey` is **non-extractable**
 * and the raw bytes are zeroed, so the copy that gets persisted to IndexedDB
 * has no readable key material behind it.
 *
 * Be precise about the guarantee: script injected into the page can still ask
 * this key to decrypt (adversary A5 is contained, not defeated), and it can
 * read the plaintext of anything decrypted while it runs. What it cannot do is
 * walk away with the key and open every future envelope offline. That is the
 * whole of the claim, and it is worth the split from the mobile path.
 */
export interface WebVault {
  /** Non-secret header material — safe to persist as ordinary structured data. */
  readonly record: VaultRecord;
  /** Non-extractable handle. Persist it directly; it has no serialisable secret. */
  readonly key: CryptoKeyLike;
  readonly aead: Aead;
}

function assemble(subtle: SubtleCryptoLike, record: VaultRecord, key: CryptoKeyLike): WebVault {
  return { record, key, aead: webCryptoAead(subtle, key) };
}

/** Creates a new vault whose data key can never be read back out of the browser. */
export async function createWebVault(
  subtle: SubtleCryptoLike,
  passphrase: string,
  opts: CreateVaultOptions = {}
): Promise<WebVault> {
  const vault = createVault(passphrase, opts);
  try {
    const key = await importDataKey(subtle, vault.dataKey);
    return assemble(subtle, toVaultRecord(vault), key);
  } finally {
    zeroize(vault.dataKey);
  }
}

/** Spends the passphrase against an existing envelope. Expensive — once per unlock. */
export async function unlockWebVault(
  subtle: SubtleCryptoLike,
  passphrase: string,
  blob: Uint8Array
): Promise<WebVault> {
  const vault = unlockVault(passphrase, blob);
  try {
    const key = await importDataKey(subtle, vault.dataKey);
    return assemble(subtle, toVaultRecord(vault), key);
  } finally {
    zeroize(vault.dataKey);
  }
}

/**
 * Recovers a vault on the web from its recovery sheet (build plan §7).
 *
 * Same containment as every other web path: the raw key exists only long
 * enough to be imported, then it is zeroed and what survives is a
 * non-extractable handle.
 */
export async function recoverWebVault(
  subtle: SubtleCryptoLike,
  blob: Uint8Array,
  code: string
): Promise<WebVault> {
  const vault = unlockWithRecoveryCode(blob, code);
  try {
    const key = await importDataKey(subtle, vault.dataKey);
    return assemble(subtle, toVaultRecord(vault), key);
  } finally {
    zeroize(vault.dataKey);
  }
}

/**
 * Changes the passphrase on the web.
 *
 * Takes the current passphrase and the stored vault record, not the live
 * `WebVault`, and that is not an oversight. The stored web key is deliberately
 * non-extractable, so its bytes cannot be read back to re-wrap them — the data
 * key has to be re-derived from the passphrase. Which is the right shape
 * anyway: rotating a passphrase should require proving you know the old one,
 * not merely holding an unlocked session.
 */
export async function changeWebVaultPassphrase(
  subtle: SubtleCryptoLike,
  record: VaultRecord,
  currentPassphrase: string,
  newPassphrase: string
): Promise<WebVault> {
  const current = unlockVaultRecord(currentPassphrase, record);
  const rotated = changePassphrase(current, newPassphrase);
  try {
    const key = await importDataKey(subtle, rotated.dataKey);
    return assemble(subtle, toVaultRecord(rotated), key);
  } finally {
    zeroize(current.dataKey);
  }
}

/** Rebuilds the AEAD from a key handle already recovered from storage — no KDF, no passphrase. */
export function resumeWebVault(
  subtle: SubtleCryptoLike,
  record: VaultRecord,
  key: CryptoKeyLike
): WebVault {
  return assemble(subtle, record, key);
}
