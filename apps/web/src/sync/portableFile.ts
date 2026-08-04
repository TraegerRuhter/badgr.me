import { dearmor, webCryptoRandomAsync } from "@alarmed/crypto";
import {
  exportSnapshot,
  importSnapshotText,
  snapshotFilename,
  type ImportResult,
  type PortableSyncContext,
} from "@alarmed/portable-sync";

import { localTaskStore } from "../db/database";
import {
  indexedDbSeqStore,
  loadVault,
  recoverDeviceVault,
  unlockDeviceVault,
} from "../crypto/keystore";

/**
 * Phase 3 on the web: the same sealed snapshot as mobile, moved by download and
 * file picker instead of a share sheet (build plan §8). No network, no server.
 */

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
    seq: indexedDbSeqStore,
    random: webCryptoRandomAsync,
  };
}

export interface ExportOutcome {
  readonly seq: bigint;
  readonly taskCount: number;
  readonly filename: string;
}

/** Seals the local store and hands the browser a download. */
export async function exportToDownload(): Promise<ExportOutcome> {
  const snapshot = await exportSnapshot(await context());
  const filename = snapshotFilename(snapshot.seq);

  const url = URL.createObjectURL(new Blob([snapshot.text], { type: "text/plain" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    // Revoking immediately is safe: the click has already handed the blob to
    // the download manager, and holding the URL open leaks the snapshot into
    // the document for as long as the tab lives.
    URL.revokeObjectURL(url);
  }

  return { seq: snapshot.seq, taskCount: snapshot.taskCount, filename };
}

/**
 * Merges a picked file.
 *
 * Errors propagate deliberately — a `RollbackRejectedError` has to reach the UI
 * as a security warning (§4.3), never a swallowed retry.
 */
export async function importFromFile(file: Blob): Promise<ImportResult> {
  return importSnapshotText(await context(), await file.text());
}

/** Second-device setup: unlock a snapshot from another device, then merge it. */
export async function joinVaultFromFile(
  passphrase: string,
  file: Blob
): Promise<ImportResult> {
  const text = await file.text();
  await unlockDeviceVault(passphrase, dearmor(text));
  return importSnapshotText(await context(), text);
}

/**
 * The passphrase is gone: recover using the sheet plus any snapshot from the
 * vault (plan §7). The snapshot is not optional — a recovery code carries no
 * proof of which vault it belongs to, so there has to be something to check it
 * against, and you would be importing one anyway.
 */
export async function recoverVaultFromFile(
  code: string,
  file: Blob
): Promise<ImportResult> {
  const text = await file.text();
  await recoverDeviceVault(code, dearmor(text));
  return importSnapshotText(await context(), text);
}
