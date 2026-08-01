/**
 * Rollback defence (build plan §4.3).
 *
 * Encryption alone does not stop a malicious storage provider from serving a
 * **genuine, correctly-authenticated, older** blob to silently revert your
 * changes. Every cryptographic check passes — the data really is yours, just
 * stale. Two mechanisms are needed and neither is optional:
 *
 *  1. `seq` sits inside the GCM AAD, so an attacker cannot lift old ciphertext
 *     and staple a higher sequence number onto it. That is the crypto's job and
 *     `packages/crypto` already does it.
 *  2. The client remembers the highest `seq` it has ever accepted and refuses
 *     anything lower. That is this file's job, and it is the part that actually
 *     stops the attack — which is why `seqSeen` must live in secure storage
 *     next to the key, not in a file the app can be tricked into resetting.
 */

/**
 * Thrown when a vault offers a sequence number below the high-water mark.
 *
 * This is a **security event, not a sync error** (§4.3). Callers must surface
 * it as an explicit warning that names the possibility of a compromised or
 * misbehaving provider. Never retry it, never auto-resolve it, and never fold
 * it into a generic "sync failed" toast — a silent retry against a hostile
 * provider is exactly the outcome the whole mechanism exists to prevent.
 */
export class RollbackRejectedError extends Error {
  /** Marks this as belonging on the security surface, not the error surface. */
  readonly securityEvent = true;
  readonly name = "RollbackRejectedError";

  /** The highest sequence this device has already accepted. */
  readonly seqSeen: bigint;
  /** The lower sequence the incoming envelope claimed. */
  readonly offeredSeq: bigint;

  // Fields assigned explicitly rather than via constructor parameter
  // properties: the web app compiles with `erasableSyntaxOnly`, which rejects
  // any TypeScript that needs real emit to work.
  constructor(seqSeen: bigint, offeredSeq: bigint) {
    super(
      `Rejected a vault at sequence ${offeredSeq}: this device has already accepted ${seqSeen}. ` +
        `Someone served an older copy of your data. If this file came from a storage provider, ` +
        `treat that provider as untrusted until you can explain the rollback.`
    );
    this.seqSeen = seqSeen;
    this.offeredSeq = offeredSeq;
  }
}

export function isRollbackRejection(err: unknown): err is RollbackRejectedError {
  return err instanceof RollbackRejectedError;
}

/**
 * The I4 gate: never accept a vault state older than the newest already seen.
 *
 * Equal sequences are accepted deliberately — re-importing the same file, or
 * two devices converging on one snapshot, is ordinary and harmless. Only a
 * strictly lower sequence indicates rewound history.
 */
export function assertNotRollback(seqSeen: bigint, offeredSeq: bigint): void {
  if (offeredSeq < seqSeen) throw new RollbackRejectedError(seqSeen, offeredSeq);
}
