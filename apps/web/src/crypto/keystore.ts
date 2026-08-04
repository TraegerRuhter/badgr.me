import {
  changeWebVaultPassphrase,
  createWebVault,
  recoverWebVault,
  resumeWebVault,
  revealRecoveryCode,
  unlockWebVault,
  type VaultRecord,
  type WebVault,
} from "@alarmed/crypto";
import type { SeqStore } from "@alarmed/portable-sync";

/**
 * Web key storage (build plan §6.2, adversary A5).
 *
 * The browser has no OS keystore, so IndexedDB is the closest equivalent — and
 * it happens to be the right one, because it can persist a WebCrypto
 * `CryptoKey` **as a key handle rather than as bytes**. The stored key is
 * non-extractable: script injected into the page can ask it to decrypt, but
 * cannot read it out and cannot carry it away. That containment is the entire
 * reason web runs WebCrypto while mobile runs `@noble/*`, and it is why these
 * two paths must not be collapsed into one.
 *
 * `seqSeen` lives here too. It is not as strong as the mobile Keychain — a user
 * (or a script) clearing site data resets it, which disarms the rollback check
 * on this device. That is an honest limitation of the platform, not something
 * to paper over: state the browser's weaker guarantee rather than implying
 * parity with the phone.
 */

const DB_NAME = "badgr-vault";
const DB_VERSION = 1;
const STORE = "vault";

/** Key material and vault identity. Written at setup, then read-only. */
const VAULT_ENTRY = "current";
/** The rollback high-water mark, kept separate so the hot path never rewrites the key. */
const SEQ_ENTRY = "seqSeen";

interface StoredVault {
  readonly v: 1;
  readonly vaultId: Uint8Array;
  readonly kdfSalt: Uint8Array;
  readonly kdf: VaultRecord["kdf"];
  readonly wrapNonce: Uint8Array;
  readonly wrappedDataKey: Uint8Array;
  /** Non-extractable. Structured-cloned by IndexedDB with no readable bytes behind it. */
  readonly key: CryptoKey;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the vault store"));
  });
}

async function read<T>(entry: string): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(entry);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error ?? new Error("Vault read failed"));
    });
  } finally {
    db.close();
  }
}

async function write(entry: string, value: unknown): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Vault write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("Vault write aborted"));
    });
  } finally {
    db.close();
  }
}

async function remove(...entries: string[]): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      for (const entry of entries) tx.objectStore(STORE).delete(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Vault delete failed"));
    });
  } finally {
    db.close();
  }
}

function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) {
    // Browsers expose WebCrypto only in secure contexts, so this is what a page
    // served over plain HTTP hits. Say that, rather than "undefined is not an object".
    throw new Error(
      "Encrypted snapshots need WebCrypto, which browsers only provide over HTTPS (or localhost)"
    );
  }
  return globalThis.crypto.subtle;
}

async function persist(vault: WebVault): Promise<WebVault> {
  const stored: StoredVault = {
    v: 1,
    vaultId: vault.record.vaultId,
    kdfSalt: vault.record.kdfSalt,
    kdf: vault.record.kdf,
    wrapNonce: vault.record.wrapNonce,
    wrappedDataKey: vault.record.wrappedDataKey,
    key: vault.key as CryptoKey,
  };
  await write(VAULT_ENTRY, stored);
  return vault;
}

export async function isVaultConfigured(): Promise<boolean> {
  return (await read<StoredVault>(VAULT_ENTRY)) !== undefined;
}

/** Rebuilds the vault from its stored key handle. No KDF, no passphrase, no raw bytes. */
export async function loadVault(): Promise<WebVault | null> {
  const stored = await read<StoredVault>(VAULT_ENTRY);
  if (!stored || stored.v !== 1) return null;
  return resumeWebVault(
    subtle(),
    {
      vaultId: stored.vaultId,
      kdfSalt: stored.kdfSalt,
      kdf: stored.kdf,
      wrapNonce: stored.wrapNonce,
      wrappedDataKey: stored.wrappedDataKey,
    },
    stored.key
  );
}

/**
 * Creates a vault. Expensive by design — Argon2id at the §3.2 parameters runs
 * on the main thread for roughly a second.
 */
export async function createDeviceVault(passphrase: string): Promise<WebVault> {
  return persist(await createWebVault(subtle(), passphrase));
}

/** Joins an existing vault using a snapshot exported from another device. */
export async function unlockDeviceVault(
  passphrase: string,
  blob: Uint8Array
): Promise<WebVault> {
  return persist(await unlockWebVault(subtle(), passphrase, blob));
}

/** Joins a vault using the recovery sheet instead of the passphrase (plan §7). */
export async function recoverDeviceVault(
  code: string,
  blob: Uint8Array
): Promise<WebVault> {
  return persist(await recoverWebVault(subtle(), blob, code));
}

/** Rotates the passphrase, using the record already in IndexedDB. No file needed. */
export async function changeDevicePassphrase(
  currentPassphrase: string,
  newPassphrase: string
): Promise<WebVault> {
  const vault = await loadVault();
  if (!vault) throw new Error("No vault on this device");
  return persist(
    await changeWebVaultPassphrase(subtle(), vault.record, currentPassphrase, newPassphrase)
  );
}

/** The recovery code, which costs a real unlock to see. */
export async function showRecoveryCode(passphrase: string): Promise<string> {
  const vault = await loadVault();
  if (!vault) throw new Error("No vault on this device");
  return revealRecoveryCode(passphrase, vault.record);
}

/** Forgets the key and the sequence mark together — see the mobile keystore for why. */
export async function clearDeviceVault(): Promise<void> {
  await remove(VAULT_ENTRY, SEQ_ENTRY);
}

export const indexedDbSeqStore: SeqStore = {
  async getSeqSeen(): Promise<bigint> {
    const stored = await read<bigint>(SEQ_ENTRY);
    return typeof stored === "bigint" && stored >= 0n ? stored : 0n;
  },
  async setSeqSeen(seq: bigint): Promise<void> {
    await write(SEQ_ENTRY, seq);
  },
};
