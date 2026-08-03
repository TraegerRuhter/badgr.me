import type { Aead, VaultRecord } from "@alarmed/crypto";
import type { AsyncRandomSource } from "@alarmed/crypto";
import type { LocalTaskStore } from "@alarmed/core";

/**
 * The device's rollback high-water mark (build plan §4.3).
 *
 * **This must be backed by secure storage** — the iOS Keychain / Android
 * Keystore on mobile, and on web the same IndexedDB record that holds the
 * non-extractable key. Not app preferences, not a JSON file, not localStorage.
 * The rollback defence is exactly as strong as an attacker's inability to reset
 * this number, so storing it somewhere clearable downgrades it to decoration.
 */
export interface SeqStore {
  /** Highest sequence this device has accepted. `0n` when the vault is new. */
  getSeqSeen(): Promise<bigint>;
  /** Persist a new high-water mark. Must be durable before it returns. */
  setSeqSeen(seq: bigint): Promise<void>;
}

/**
 * Everything a file-sync operation needs, with each platform-specific piece
 * injected. Nothing here does I/O of its own, which is what keeps the rollback
 * rule unit-testable without a device.
 */
export interface PortableSyncContext {
  /** Non-secret vault identity; supplies the header fields. */
  readonly record: VaultRecord;
  /** The cipher. Raw-key noble on mobile, non-extractable CryptoKey on web. */
  readonly aead: Aead;
  /** The on-device task store — the same one Supabase sync already drives. */
  readonly local: LocalTaskStore;
  /** Rollback state. See the warning on `SeqStore`. */
  readonly seq: SeqStore;
  /** CSPRNG for payload nonces. Mobile passes expo-crypto; web passes WebCrypto. */
  readonly random?: AsyncRandomSource;
}
