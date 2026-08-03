import { beforeEach, describe, expect, it } from "vitest";
import {
  createVault,
  importDataKey,
  nobleAead,
  resumeWebVault,
  toVaultRecord,
  webCryptoRandomAsync,
  type VaultKeys,
} from "@alarmed/crypto";
import { fakeRandom, makeTask, TEST_KDF } from "@alarmed/crypto/src/testing";

import { exportSnapshot, importSnapshot, importSnapshotText } from "./fileSync";
import { RollbackRejectedError } from "./rollback";
import type { PortableSyncContext } from "./store";
import { memorySeqStore, memoryTaskStore } from "./testing";

/**
 * The Phase 3 gate (build plan §8): a snapshot written by one platform opens on
 * the other, and the rollback rule holds across the boundary.
 *
 * The two devices here differ in exactly the way the real ones do — one drives
 * `@noble/ciphers` over raw key bytes, the other a non-extractable WebCrypto
 * `CryptoKey` (§6.2) — while sharing nothing but the sealed file. Physical
 * devices still have to be checked by hand before the gate is signed off, but
 * everything below that layer is proven here on every run.
 */

const PASS = "correct horse battery staple";
const subtle = globalThis.crypto.subtle;

let vault: VaultKeys;

/** A phone: raw key bytes, noble. */
function mobileDevice(tasks = memoryTaskStore(), seq = memorySeqStore()) {
  return {
    record: toVaultRecord(vault),
    aead: nobleAead(vault.dataKey),
    local: tasks,
    seq,
    random: webCryptoRandomAsync,
  } satisfies PortableSyncContext & { local: typeof tasks; seq: typeof seq };
}

/** A browser: non-extractable CryptoKey, WebCrypto. */
async function webDevice(tasks = memoryTaskStore(), seq = memorySeqStore()) {
  const web = resumeWebVault(subtle, toVaultRecord(vault), await importDataKey(subtle, vault.dataKey));
  return {
    record: web.record,
    aead: web.aead,
    local: tasks,
    seq,
    random: webCryptoRandomAsync,
  } satisfies PortableSyncContext & { local: typeof tasks; seq: typeof seq };
}

beforeEach(() => {
  vault = createVault(PASS, { kdf: TEST_KDF, random: fakeRandom(1) });
});

describe("web ↔ mobile round trip", () => {
  it("carries a phone's tasks into a browser", async () => {
    const phone = mobileDevice(memoryTaskStore([makeTask({ id: "from-phone" })]));
    const snapshot = await exportSnapshot(phone);

    const browser = await webDevice();
    const result = await importSnapshotText(browser, snapshot.text);

    expect(result.applied).toBe(1);
    expect(browser.local.rows[0].id).toBe("from-phone");
  });

  it("carries a browser's tasks back to a phone", async () => {
    const browser = await webDevice(memoryTaskStore([makeTask({ id: "from-browser" })]));
    const snapshot = await exportSnapshot(browser);

    const phone = mobileDevice();
    await importSnapshotText(phone, snapshot.text);

    expect(phone.local.rows[0].id).toBe("from-browser");
  });

  it("converges both devices over a full there-and-back exchange", async () => {
    const phone = mobileDevice(memoryTaskStore([makeTask({ id: "phone-only" })]));
    const browser = await webDevice(memoryTaskStore([makeTask({ id: "browser-only" })]));

    // Phone exports, browser merges — the browser now holds both.
    await importSnapshot(browser, (await exportSnapshot(phone)).blob);
    expect(browser.local.rows.map((t) => t.id).sort()).toEqual(["browser-only", "phone-only"]);

    // Browser exports back, phone merges — both sides agree.
    await importSnapshot(phone, (await exportSnapshot(browser)).blob);
    expect(phone.local.rows.map((t) => t.id).sort()).toEqual(["browser-only", "phone-only"]);
  });

  it("propagates a soft delete across the boundary", async () => {
    const shared = makeTask({ id: "doomed" });
    const phone = mobileDevice(
      memoryTaskStore([{ ...shared, deletedAt: "2026-07-25T00:00:00.000Z", updatedAt: "2026-07-25T00:00:00.000Z" }])
    );
    const browser = await webDevice(memoryTaskStore([shared]));

    await importSnapshot(browser, (await exportSnapshot(phone)).blob);
    expect(browser.local.rows.find((t) => t.id === "doomed")?.deletedAt).toBe(
      "2026-07-25T00:00:00.000Z"
    );
  });

  it("refuses a rolled-back phone snapshot in the browser", async () => {
    const phone = mobileDevice(memoryTaskStore([makeTask()]));
    const stale = await exportSnapshot(phone);
    await exportSnapshot(phone);
    const current = await exportSnapshot(phone);

    const browser = await webDevice();
    await importSnapshot(browser, current.blob);

    await expect(importSnapshot(browser, stale.blob)).rejects.toBeInstanceOf(
      RollbackRejectedError
    );
  });

  it("refuses a rolled-back browser snapshot on the phone", async () => {
    const browser = await webDevice(memoryTaskStore([makeTask()]));
    const stale = await exportSnapshot(browser);
    await exportSnapshot(browser);
    const current = await exportSnapshot(browser);

    const phone = mobileDevice();
    await importSnapshot(phone, current.blob);

    await expect(importSnapshot(phone, stale.blob)).rejects.toBeInstanceOf(
      RollbackRejectedError
    );
  });
});
