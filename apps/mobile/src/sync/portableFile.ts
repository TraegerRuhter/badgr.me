import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { dearmor } from "@alarmed/crypto";
import {
  exportSnapshot,
  importSnapshotText,
  snapshotFilename,
  type ImportResult,
  type PortableSyncContext,
} from "@alarmed/portable-sync";

import { localTaskStore } from "../db/database";
import { loadVault, secureSeqStore, unlockDeviceVault } from "../crypto/keystore";
import { expoRandomAsync } from "../crypto/random";

/**
 * Phase 3 on mobile: a sealed snapshot leaves and enters the app through the OS
 * share sheet and document picker (build plan §8). No network, no server — the
 * user carries their own data between devices via AirDrop, Files, email, or
 * whatever else the share sheet offers.
 */

const MIME = "text/plain";
/** iOS needs a UTI as well as a MIME type, or some share targets refuse the file. */
const UTI = "public.plain-text";

export class VaultNotConfiguredError extends Error {
  readonly name = "VaultNotConfiguredError";
  constructor() {
    super("Set up an encrypted vault before exporting or importing snapshots");
  }
}

async function context(): Promise<PortableSyncContext> {
  const vault = await loadVault();
  if (!vault) throw new VaultNotConfiguredError();
  return {
    record: vault.record,
    aead: vault.aead,
    local: localTaskStore,
    seq: secureSeqStore,
    random: expoRandomAsync,
  };
}

export interface ExportOutcome {
  readonly seq: bigint;
  readonly taskCount: number;
  /** False when the platform has no share sheet; the file is still on disk. */
  readonly shared: boolean;
  readonly uri: string;
}

/**
 * Seals the local store and hands it to the share sheet.
 *
 * The file goes to the cache directory, not documents: it is ciphertext and
 * therefore safe at rest, but it is also a transient artefact, and letting the
 * OS reclaim it is better than accumulating snapshots the user never asked to
 * keep.
 */
export async function exportToShareSheet(): Promise<ExportOutcome> {
  const snapshot = await exportSnapshot(await context());

  const file = new File(Paths.cache, snapshotFilename(snapshot.seq));
  if (file.exists) file.delete();
  file.create();
  file.write(snapshot.text);

  const shared = await Sharing.isAvailableAsync();
  if (shared) {
    await Sharing.shareAsync(file.uri, {
      mimeType: MIME,
      UTI,
      dialogTitle: "Send your encrypted badgr snapshot",
    });
  }

  return { seq: snapshot.seq, taskCount: snapshot.taskCount, shared, uri: file.uri };
}

export type ImportOutcome =
  | { readonly status: "cancelled" }
  | ({ readonly status: "merged" } & ImportResult);

/**
 * Picks a snapshot and merges it in.
 *
 * Errors are deliberately not swallowed. A `RollbackRejectedError` in
 * particular must reach the UI as a security warning (§4.3) — catching it here
 * to "try the next thing" would be exactly the silent retry the rollback
 * defence exists to prevent.
 */
export async function importFromDocumentPicker(): Promise<ImportOutcome> {
  const picked = await DocumentPicker.getDocumentAsync({
    // Some providers hand back `application/octet-stream` for an unknown
    // extension, so filtering by type here mostly just hides valid files.
    type: "*/*",
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (picked.canceled || picked.assets.length === 0) return { status: "cancelled" };

  const text = await new File(picked.assets[0].uri).text();
  return { status: "merged", ...(await importSnapshotText(await context(), text)) };
}

/**
 * Second-device setup: pick a snapshot exported elsewhere and unlock it with the
 * vault passphrase. The envelope header carries the salt and the wrapped data
 * key, so the file itself is the enrolment token — nothing else is transmitted.
 */
export async function joinVaultFromFile(passphrase: string): Promise<ImportOutcome> {
  const picked = await DocumentPicker.getDocumentAsync({
    type: "*/*",
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (picked.canceled || picked.assets.length === 0) return { status: "cancelled" };

  const text = await new File(picked.assets[0].uri).text();
  await unlockDeviceVault(passphrase, dearmor(text));

  return { status: "merged", ...(await importSnapshotText(await context(), text)) };
}
