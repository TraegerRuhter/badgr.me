import { reconcileTasks, type Task } from "@alarmed/core";
import {
  armor,
  dearmor,
  decodeHeader,
  openEnvelopeWith,
  sealWith,
  webCryptoRandomAsync,
} from "@alarmed/crypto";

import { assertNotRollback } from "./rollback";
import type { PortableSyncContext } from "./store";

/**
 * Phase 3: offline file sync (build plan §8).
 *
 * A sealed snapshot moves between devices as a file — share sheet on mobile,
 * download/upload on web — with no network and no server anywhere in the path.
 * The reconciliation itself is `reconcileTasks` from `@alarmed/core`, used
 * unchanged: it is already pure, transport-agnostic, and converges soft
 * deletes, so this layer only has to add an envelope and the rollback rule
 * around code that already works (§4.2 step 4).
 */

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface ExportedSnapshot {
  /** The raw BDGR1 blob. */
  readonly blob: Uint8Array;
  /** Armored transport form (§3.3) — what actually gets written to a file. */
  readonly text: string;
  /** The sequence number this snapshot was sealed at. */
  readonly seq: bigint;
  /** How many rows it carries, soft-deleted ones included. */
  readonly taskCount: number;
}

/** Suggested filename. Sequence-stamped so a folder of exports sorts meaningfully. */
export function snapshotFilename(seq: bigint): string {
  return `badgr-vault-${seq.toString().padStart(6, "0")}.badgr`;
}

/**
 * Seals the whole local store — soft-deleted rows included, or deletes could
 * not propagate — at the next sequence number.
 *
 * The new `seq` is persisted **before** the caller ever sees the blob. A
 * cancelled share then merely burns a sequence number, which costs nothing
 * because only monotonicity matters, not density. Persisting afterwards would
 * risk the opposite and far worse failure: a crash between sealing and saving
 * leaves two different snapshots sharing one sequence number, which quietly
 * breaks the ordering the rollback defence depends on.
 */
export async function exportSnapshot(ctx: PortableSyncContext): Promise<ExportedSnapshot> {
  const [seqSeen, tasks] = await Promise.all([ctx.seq.getSeqSeen(), ctx.local.listAllForSync()]);
  const seq = seqSeen + 1n;

  const blob = await sealWith(ctx.record, ctx.aead, tasks, seq, ctx.random ?? webCryptoRandomAsync);
  await ctx.seq.setSeqSeen(seq);

  return { blob, text: armor(blob), seq, taskCount: tasks.length };
}

export interface ImportResult {
  /** Rows the incoming snapshot won, now written to the local store. */
  readonly applied: number;
  /**
   * Rows this device holds that the snapshot didn't have, or had staler. They
   * are untouched locally — the other device needs an export back to see them.
   */
  readonly localAhead: number;
  /** The authenticated sequence number of the imported snapshot. */
  readonly seq: bigint;
}

/**
 * Opens a snapshot and merges it into the local store.
 *
 * Order matters and follows §4.2: rollback check, then authenticate, then
 * reconcile. Nothing is written locally until decryption has succeeded, so a
 * tampered or truncated file leaves the device exactly as it was (I3).
 *
 * @throws RollbackRejectedError if the snapshot's sequence is below this
 * device's high-water mark. That is a security event — see `rollback.ts`.
 */
export async function importSnapshot(
  ctx: PortableSyncContext,
  blob: Uint8Array
): Promise<ImportResult> {
  const header = decodeHeader(blob);

  // A file from a different vault would fail authentication a moment later
  // anyway, but seqSeen is only meaningful within one vault — so say what is
  // actually wrong rather than blaming the passphrase.
  if (!sameBytes(header.vaultId, ctx.record.vaultId)) {
    throw new Error("That snapshot belongs to a different vault, not the one on this device");
  }

  const seqSeen = await ctx.seq.getSeqSeen();

  // Cheap pre-check on the cleartext header: rejects an obvious rollback before
  // paying for decryption.
  assertNotRollback(seqSeen, header.seq);

  const opened = await openEnvelopeWith(ctx.aead, blob);

  // Re-check against the authenticated sequence. The header read above is
  // unauthenticated by definition, so the value that decides anything must be
  // the one GCM has verified.
  assertNotRollback(seqSeen, opened.seq);

  const localTasks = await ctx.local.listAllForSync();
  const plan = reconcileTasks(localTasks, opened.tasks as Task[]);

  if (plan.toApplyLocal.length > 0) await ctx.local.upsertMany(plan.toApplyLocal);
  if (opened.seq > seqSeen) await ctx.seq.setSeqSeen(opened.seq);

  return {
    applied: plan.toApplyLocal.length,
    localAhead: plan.toPushUp.length,
    seq: opened.seq,
  };
}

/** `importSnapshot` for armored text, which is what a picked file contains. */
export async function importSnapshotText(
  ctx: PortableSyncContext,
  text: string
): Promise<ImportResult> {
  return importSnapshot(ctx, dearmor(text));
}
