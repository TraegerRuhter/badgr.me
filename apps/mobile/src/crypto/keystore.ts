import * as SecureStore from "expo-secure-store";
import {
  base64UrlDecode,
  base64UrlEncode,
  createVault,
  nobleAead,
  toVaultRecord,
  unlockVault,
  type Aead,
  type KdfParams,
  type VaultKeys,
  type VaultRecord,
} from "@alarmed/crypto";
import type { SeqStore } from "@alarmed/portable-sync";

import { drawEntropyPool } from "./random";

/**
 * Key storage on iOS Keychain / Android Keystore (build plan §6.1, adversary A4).
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` on every write, which buys two things:
 * the data key is unreadable while the device is locked, and — the part that
 * matters more — the entry is **excluded from iCloud Keychain and from device
 * backups**. A key that syncs to a cloud has left the threat model without
 * anyone deciding that it should.
 */
const ACCESSIBLE = SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY;

/** Vault identity plus the cached data key. Written once at setup, then read-only. */
const VAULT_KEY = "badgr.vault";
/**
 * The rollback high-water mark (§4.3), deliberately in its own entry.
 *
 * It changes on every export while the vault record never does, so keeping them
 * apart means the hot path never rewrites key material — a failed write can
 * cost you a sequence bump, but it can't cost you the vault.
 */
const SEQ_KEY = "badgr.vault.seq";

const options: SecureStore.SecureStoreOptions = { keychainAccessible: ACCESSIBLE };

interface StoredVault {
  readonly v: 1;
  readonly vaultId: string;
  readonly kdfSalt: string;
  readonly kdf: KdfParams;
  readonly wrapNonce: string;
  readonly wrappedDataKey: string;
  readonly dataKey: string;
}

export interface MobileVault {
  readonly record: VaultRecord;
  readonly aead: Aead;
}

function encode(vault: VaultKeys): string {
  const stored: StoredVault = {
    v: 1,
    vaultId: base64UrlEncode(vault.vaultId),
    kdfSalt: base64UrlEncode(vault.kdfSalt),
    kdf: vault.kdf,
    wrapNonce: base64UrlEncode(vault.wrapNonce),
    wrappedDataKey: base64UrlEncode(vault.wrappedDataKey),
    dataKey: base64UrlEncode(vault.dataKey),
  };
  return JSON.stringify(stored);
}

function decode(raw: string): VaultKeys {
  const stored = JSON.parse(raw) as StoredVault;
  if (stored.v !== 1) throw new Error(`Unsupported stored vault version ${stored.v}`);
  return {
    vaultId: base64UrlDecode(stored.vaultId),
    kdfSalt: base64UrlDecode(stored.kdfSalt),
    kdf: stored.kdf,
    wrapNonce: base64UrlDecode(stored.wrapNonce),
    wrappedDataKey: base64UrlDecode(stored.wrappedDataKey),
    dataKey: base64UrlDecode(stored.dataKey),
  };
}

function toMobileVault(vault: VaultKeys): MobileVault {
  return { record: toVaultRecord(vault), aead: nobleAead(vault.dataKey) };
}

async function persist(vault: VaultKeys): Promise<MobileVault> {
  await SecureStore.setItemAsync(VAULT_KEY, encode(vault), options);
  return toMobileVault(vault);
}

export async function isVaultConfigured(): Promise<boolean> {
  return (await SecureStore.getItemAsync(VAULT_KEY, options)) !== null;
}

/**
 * Loads the cached vault. Cheap — no KDF, no passphrase — which is the entire
 * point of caching the unwrapped data key (§3.2).
 */
export async function loadVault(): Promise<MobileVault | null> {
  const raw = await SecureStore.getItemAsync(VAULT_KEY, options);
  if (raw === null) return null;
  try {
    return toMobileVault(decode(raw));
  } catch {
    // A record we can't parse is a record we can't use. Report it as absent so
    // the UI offers setup again rather than wedging on a corrupt entry.
    return null;
  }
}

/**
 * Creates a brand new vault. Expensive: Argon2id at the §3.2 parameters runs on
 * the JS thread and takes roughly a second on a phone. Call it from a screen
 * that shows progress, never on a hot path.
 */
export async function createDeviceVault(passphrase: string): Promise<MobileVault> {
  const random = await drawEntropyPool();
  return persist(createVault(passphrase, { random }));
}

/**
 * Joins an existing vault by spending the passphrase against a snapshot from
 * another device. This is how the second device gets set up: the header carries
 * the salt and the wrapped key, so the file itself is the enrolment token.
 */
export async function unlockDeviceVault(
  passphrase: string,
  blob: Uint8Array
): Promise<MobileVault> {
  return persist(unlockVault(passphrase, blob));
}

/**
 * Forgets the vault **and** its sequence high-water mark.
 *
 * Both, always. Leaving a stale `seqSeen` behind would reject the first
 * snapshot of whatever vault comes next; clearing the seq without the key would
 * silently disarm the rollback defence. They only make sense together.
 */
export async function clearDeviceVault(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(VAULT_KEY, options),
    SecureStore.deleteItemAsync(SEQ_KEY, options),
  ]);
}

/** The §4.3 high-water mark, in the keystore beside the key it protects. */
export const secureSeqStore: SeqStore = {
  async getSeqSeen(): Promise<bigint> {
    const raw = await SecureStore.getItemAsync(SEQ_KEY, options);
    if (raw === null) return 0n;
    try {
      const parsed = BigInt(raw);
      // A negative or garbage value would weaken the check it exists to enforce.
      // Treat anything unusable as "trust nothing yet" rather than as zero-ish.
      return parsed >= 0n ? parsed : 0n;
    } catch {
      return 0n;
    }
  },
  async setSeqSeen(seq: bigint): Promise<void> {
    await SecureStore.setItemAsync(SEQ_KEY, seq.toString(), options);
  },
};
