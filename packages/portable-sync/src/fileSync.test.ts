import { beforeEach, describe, expect, it } from "vitest";
import {
  armor,
  createVault,
  nobleAead,
  toVaultRecord,
  type VaultKeys,
} from "@alarmed/crypto";
import { asAsyncRandom } from "@alarmed/crypto";
import { fakeRandom, makeTask, TEST_KDF } from "@alarmed/crypto/src/testing";

import {
  exportSnapshot,
  importSnapshot,
  importSnapshotText,
  snapshotFilename,
} from "./fileSync";
import { isRollbackRejection, RollbackRejectedError } from "./rollback";
import type { PortableSyncContext } from "./store";
import { memorySeqStore, memoryTaskStore } from "./testing";

const PASS = "correct horse battery staple";
const random = asAsyncRandom(fakeRandom(9));

let vault: VaultKeys;

function contextFor(
  tasks = memoryTaskStore(),
  seq = memorySeqStore()
): PortableSyncContext & {
  local: ReturnType<typeof memoryTaskStore>;
  seq: ReturnType<typeof memorySeqStore>;
} {
  return {
    record: toVaultRecord(vault),
    aead: nobleAead(vault.dataKey),
    local: tasks,
    seq,
    random,
  };
}

beforeEach(() => {
  vault = createVault(PASS, { kdf: TEST_KDF, random: fakeRandom(1) });
});

describe("export", () => {
  it("seals the local store at the next sequence", async () => {
    const ctx = contextFor(memoryTaskStore([makeTask({ id: "a" })]));
    const snapshot = await exportSnapshot(ctx);

    expect(snapshot.seq).toBe(1n);
    expect(snapshot.taskCount).toBe(1);
    expect(snapshot.text.startsWith("badgr-sync/1\n")).toBe(true);
  });

  it("burns the sequence immediately, so a cancelled share can never reuse it", async () => {
    const ctx = contextFor(memoryTaskStore([makeTask()]));
    await exportSnapshot(ctx);
    expect(ctx.seq.value).toBe(1n);

    const second = await exportSnapshot(ctx);
    expect(second.seq).toBe(2n);
  });

  it("includes soft-deleted rows, or deletes could never propagate", async () => {
    const deleted = makeTask({ id: "gone", deletedAt: "2026-07-20T00:00:00.000Z" });
    const ctx = contextFor(memoryTaskStore([makeTask({ id: "live" }), deleted]));
    const snapshot = await exportSnapshot(ctx);

    const fresh = contextFor(memoryTaskStore());
    await importSnapshot(fresh, snapshot.blob);
    expect(fresh.local.rows.map((t) => t.id).sort()).toEqual(["gone", "live"]);
  });

  it("names the file after the sequence so a folder of exports sorts", () => {
    expect(snapshotFilename(12n)).toBe("badgr-vault-000012.badgr");
  });
});

describe("import merges through reconcileTasks", () => {
  it("applies rows the device has never seen", async () => {
    const source = contextFor(memoryTaskStore([makeTask({ id: "from-phone" })]));
    const snapshot = await exportSnapshot(source);

    const target = contextFor(memoryTaskStore());
    const result = await importSnapshot(target, snapshot.blob);

    expect(result.applied).toBe(1);
    expect(result.localAhead).toBe(0);
    expect(target.local.rows[0].id).toBe("from-phone");
  });

  it("keeps the newer side on both directions of a conflict", async () => {
    const shared = "2026-07-01T00:00:00.000Z";
    const source = contextFor(
      memoryTaskStore([
        makeTask({ id: "remote-wins", title: "newer remote", updatedAt: "2026-07-20T00:00:00.000Z" }),
        makeTask({ id: "local-wins", title: "older remote", updatedAt: shared }),
      ])
    );
    const snapshot = await exportSnapshot(source);

    const target = contextFor(
      memoryTaskStore([
        makeTask({ id: "remote-wins", title: "older local", updatedAt: shared }),
        makeTask({ id: "local-wins", title: "newer local", updatedAt: "2026-07-25T00:00:00.000Z" }),
      ])
    );
    const result = await importSnapshot(target, snapshot.blob);

    expect(result.applied).toBe(1);
    expect(result.localAhead).toBe(1);
    expect(target.local.rows.find((t) => t.id === "remote-wins")?.title).toBe("newer remote");
    expect(target.local.rows.find((t) => t.id === "local-wins")?.title).toBe("newer local");
  });

  it("reports rows the snapshot is missing so the user knows to export back", async () => {
    const source = contextFor(memoryTaskStore([makeTask({ id: "shared" })]));
    const snapshot = await exportSnapshot(source);

    const target = contextFor(
      memoryTaskStore([makeTask({ id: "shared" }), makeTask({ id: "only-here" })])
    );
    expect((await importSnapshot(target, snapshot.blob)).localAhead).toBe(1);
  });

  it("round-trips through the armored transport form", async () => {
    const source = contextFor(memoryTaskStore([makeTask({ id: "armored" })]));
    const snapshot = await exportSnapshot(source);

    const target = contextFor(memoryTaskStore());
    await importSnapshotText(target, snapshot.text);
    expect(target.local.rows[0].id).toBe("armored");
  });

  it("advances the high-water mark to the imported sequence", async () => {
    const source = contextFor(memoryTaskStore([makeTask()]), memorySeqStore(41n));
    const snapshot = await exportSnapshot(source);

    const target = contextFor(memoryTaskStore());
    await importSnapshot(target, snapshot.blob);
    expect(target.seq.value).toBe(42n);
  });
});

describe("rollback defence (§4.3, §9)", () => {
  it("rejects a snapshot older than the newest already accepted", async () => {
    const source = contextFor(memoryTaskStore([makeTask({ id: "old" })]));
    const stale = await exportSnapshot(source); // seq 1
    await exportSnapshot(source); // seq 2
    const current = await exportSnapshot(source); // seq 3

    const target = contextFor(memoryTaskStore());
    await importSnapshot(target, current.blob);
    expect(target.seq.value).toBe(3n);

    await expect(importSnapshot(target, stale.blob)).rejects.toBeInstanceOf(
      RollbackRejectedError
    );
  });

  it("names the sequences and the possibility of a compromised provider", async () => {
    const source = contextFor(memoryTaskStore([makeTask()]));
    const stale = await exportSnapshot(source);
    await exportSnapshot(source);
    const current = await exportSnapshot(source);

    const target = contextFor(memoryTaskStore());
    await importSnapshot(target, current.blob);

    const err = await importSnapshot(target, stale.blob).catch((e: unknown) => e);
    expect(isRollbackRejection(err)).toBe(true);
    const rollback = err as RollbackRejectedError;
    expect(rollback.securityEvent).toBe(true);
    expect(rollback.seqSeen).toBe(3n);
    expect(rollback.offeredSeq).toBe(1n);
    expect(rollback.message).toMatch(/untrusted/);
  });

  it("changes nothing locally when it rejects", async () => {
    const source = contextFor(memoryTaskStore([makeTask({ id: "old-row" })]));
    const stale = await exportSnapshot(source);
    await exportSnapshot(source);
    const current = await exportSnapshot(
      contextFor(memoryTaskStore([makeTask({ id: "new-row" })]), memorySeqStore(2n))
    );

    const target = contextFor(memoryTaskStore());
    await importSnapshot(target, current.blob);
    const before = target.local.rows.map((t) => t.id).sort();

    await expect(importSnapshot(target, stale.blob)).rejects.toThrow();
    expect(target.local.rows.map((t) => t.id).sort()).toEqual(before);
    expect(target.seq.value).toBe(3n);
  });

  it("accepts an equal sequence — re-importing the same file is not an attack", async () => {
    const source = contextFor(memoryTaskStore([makeTask({ id: "same" })]));
    const snapshot = await exportSnapshot(source);

    const target = contextFor(memoryTaskStore());
    await importSnapshot(target, snapshot.blob);
    await expect(importSnapshot(target, snapshot.blob)).resolves.toMatchObject({ seq: 1n });
  });

  it("cannot be bypassed by stapling a higher seq onto old ciphertext", async () => {
    const source = contextFor(memoryTaskStore([makeTask()]));
    const stale = await exportSnapshot(source);
    await exportSnapshot(source);
    const current = await exportSnapshot(source);

    const target = contextFor(memoryTaskStore());
    await importSnapshot(target, current.blob);

    // Rewrite the cleartext seq field (offset 104, u64be) to 9 — the pre-check
    // now passes, and GCM must catch it because seq is inside the AAD.
    const forged = Uint8Array.from(stale.blob);
    new DataView(forged.buffer).setBigUint64(104, 9n, false);

    await expect(importSnapshot(target, forged)).rejects.toThrow(/failed authentication/);
    expect(target.seq.value).toBe(3n);
  });
});

describe("failing closed", () => {
  it("refuses a snapshot from a different vault by name", async () => {
    const other = createVault("another passphrase", {
      kdf: TEST_KDF,
      random: fakeRandom(77),
    });
    const foreign = await exportSnapshot({
      record: toVaultRecord(other),
      aead: nobleAead(other.dataKey),
      local: memoryTaskStore([makeTask()]),
      seq: memorySeqStore(),
      random,
    });

    await expect(importSnapshot(contextFor(), foreign.blob)).rejects.toThrow(
      /different vault/
    );
  });

  it("writes nothing when the payload has been tampered with", async () => {
    const source = contextFor(memoryTaskStore([makeTask({ id: "tampered" })]));
    const snapshot = await exportSnapshot(source);
    const corrupted = Uint8Array.from(snapshot.blob);
    corrupted[corrupted.length - 1] ^= 0x01;

    const target = contextFor(memoryTaskStore());
    await expect(importSnapshot(target, corrupted)).rejects.toThrow(/failed authentication/);
    expect(target.local.rows).toEqual([]);
    expect(target.seq.value).toBe(0n);
  });

  it("rejects a truncated file without reading out of bounds", async () => {
    const source = contextFor(memoryTaskStore([makeTask()]));
    const snapshot = await exportSnapshot(source);

    const target = contextFor(memoryTaskStore());
    await expect(importSnapshot(target, snapshot.blob.slice(0, 60))).rejects.toThrow(
      /shorter than its header/
    );
  });

  it("rejects a file that isn't a badgr envelope at all", async () => {
    const target = contextFor(memoryTaskStore());
    await expect(importSnapshotText(target, "my shopping list\n- eggs")).rejects.toThrow(
      /Not a badgr sync file/
    );
  });

  it("rejects armored text whose body was mangled in transport", async () => {
    const source = contextFor(memoryTaskStore([makeTask()]));
    const snapshot = await exportSnapshot(source);
    const lines = armor(snapshot.blob).split("\n");
    lines[2] = `${lines[2][0] === "A" ? "B" : "A"}${lines[2].slice(1)}`;

    const target = contextFor(memoryTaskStore());
    await expect(importSnapshotText(target, lines.join("\n"))).rejects.toThrow();
    expect(target.local.rows).toEqual([]);
  });
});
