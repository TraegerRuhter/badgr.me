import { beforeEach, describe, expect, it } from "vitest";
import {
  changePassphrase,
  createVault,
  openEnvelope,
  recoveryCodeFor,
  seal,
  unlockVault,
  unlockWithRecoveryCode,
  type VaultKeys,
} from "./envelope";
import { formatRecoveryCode } from "./recovery";
import { fakeRandom, makeTask, TEST_KDF } from "./testing";

/**
 * The recovery paths (build plan §7). These are the tests that decide whether a
 * user who forgets their passphrase loses everything, so they cover the boring
 * cases as well as the exciting ones.
 */

const PASS = "correct horse battery staple";
const NEW_PASS = "a different passphrase entirely";
const TASKS = [makeTask({ id: "a" }), makeTask({ id: "b", title: "Water the plants" })];

let vault: VaultKeys;
let blob: Uint8Array;

beforeEach(() => {
  vault = createVault(PASS, { kdf: TEST_KDF, random: fakeRandom(1) });
  blob = seal(vault, TASKS, 1n, fakeRandom(9));
});

describe("unlocking with a recovery code", () => {
  it("opens the vault without the passphrase", () => {
    const recovered = unlockWithRecoveryCode(blob, recoveryCodeFor(vault));
    expect(openEnvelope(recovered, blob).tasks).toEqual(TASKS);
  });

  it("recovers the same data key the passphrase would have", () => {
    const recovered = unlockWithRecoveryCode(blob, recoveryCodeFor(vault));
    expect(Array.from(recovered.dataKey)).toEqual(Array.from(vault.dataKey));
  });

  it("still works after the passphrase has been changed", () => {
    // The sheet is printed once and must stay valid forever. Rotating the
    // passphrase re-wraps the key but never replaces it, so the code holds.
    const rotated = changePassphrase(vault, NEW_PASS, fakeRandom(30));
    const rotatedBlob = seal(rotated, TASKS, 2n, fakeRandom(9));
    const recovered = unlockWithRecoveryCode(rotatedBlob, recoveryCodeFor(vault));
    expect(openEnvelope(recovered, rotatedBlob).tasks).toEqual(TASKS);
  });

  it("rejects a well-formed code from a different vault, before it confuses anyone", () => {
    const other = createVault(PASS, { kdf: TEST_KDF, random: fakeRandom(77) });
    expect(() => unlockWithRecoveryCode(blob, recoveryCodeFor(other))).toThrow(
      /doesn't open this vault/
    );
  });

  it("rejects a mistyped code as a typo, not as a wrong vault", () => {
    const code = recoveryCodeFor(vault).replace(/-/g, "").split("");
    code[5] = code[5] === "7" ? "8" : "7";
    expect(() => unlockWithRecoveryCode(blob, code.join(""))).toThrow(/typo/);
  });

  it("accepts a code typed back in lower case with odd spacing", () => {
    const messy = recoveryCodeFor(vault).toLowerCase().replace(/-/g, "  ");
    expect(openEnvelope(unlockWithRecoveryCode(blob, messy), blob).tasks).toEqual(TASKS);
  });

  it("refuses a truncated envelope rather than reading past it", () => {
    expect(() => unlockWithRecoveryCode(blob.slice(0, 60), recoveryCodeFor(vault))).toThrow(
      /shorter than its header/
    );
  });
});

describe("changing the passphrase", () => {
  it("opens with the new passphrase", () => {
    const rotated = changePassphrase(vault, NEW_PASS, fakeRandom(30));
    const rotatedBlob = seal(rotated, TASKS, 2n, fakeRandom(9));
    expect(openEnvelope(unlockVault(NEW_PASS, rotatedBlob), rotatedBlob).tasks).toEqual(TASKS);
  });

  it("refuses the old passphrase on a snapshot written afterwards", () => {
    const rotated = changePassphrase(vault, NEW_PASS, fakeRandom(30));
    const rotatedBlob = seal(rotated, TASKS, 2n, fakeRandom(9));
    expect(() => unlockVault(PASS, rotatedBlob)).toThrow(/Wrong passphrase/);
  });

  it("leaves the data key alone, so existing snapshots stay readable", () => {
    const rotated = changePassphrase(vault, NEW_PASS, fakeRandom(30));
    expect(Array.from(rotated.dataKey)).toEqual(Array.from(vault.dataKey));
    expect(openEnvelope(rotated, blob).tasks).toEqual(TASKS);
  });

  it("does NOT retro-fit old snapshots — they keep needing the old passphrase", () => {
    // The trap worth knowing about: `unlockVault` reads the header of whatever
    // blob it is handed, and an already-exported file still carries the old
    // wrapped key. Export a fresh snapshot after rotating, or the old file is
    // only openable with the old passphrase (or the recovery code).
    const rotated = changePassphrase(vault, NEW_PASS, fakeRandom(30));
    expect(rotated).toBeDefined();
    expect(() => unlockVault(NEW_PASS, blob)).toThrow(/Wrong passphrase/);
    expect(openEnvelope(unlockVault(PASS, blob), blob).tasks).toEqual(TASKS);
  });

  it("gives the new passphrase its own salt and nonce", () => {
    const rotated = changePassphrase(vault, NEW_PASS, fakeRandom(30));
    expect(Array.from(rotated.kdfSalt)).not.toEqual(Array.from(vault.kdfSalt));
    expect(Array.from(rotated.wrapNonce)).not.toEqual(Array.from(vault.wrapNonce));
    expect(Array.from(rotated.wrappedDataKey)).not.toEqual(Array.from(vault.wrappedDataKey));
  });

  it("keeps the vault's identity, so it is the same vault afterwards", () => {
    const rotated = changePassphrase(vault, NEW_PASS, fakeRandom(30));
    expect(Array.from(rotated.vaultId)).toEqual(Array.from(vault.vaultId));
    expect(rotated.kdf).toEqual(vault.kdf);
  });

  it("survives being rotated repeatedly", () => {
    let current = vault;
    for (let i = 0; i < 3; i++) {
      current = changePassphrase(current, `passphrase number ${i}`, fakeRandom(40 + i));
    }
    const finalBlob = seal(current, TASKS, 5n, fakeRandom(9));
    expect(openEnvelope(unlockVault("passphrase number 2", finalBlob), finalBlob).tasks).toEqual(
      TASKS
    );
    // And the original sheet still works after all of it.
    expect(
      openEnvelope(unlockWithRecoveryCode(finalBlob, recoveryCodeFor(vault)), finalBlob).tasks
    ).toEqual(TASKS);
  });

  it("rotating to the same passphrase still produces a different wrap", () => {
    // Fresh salt each time, so re-entering the same passphrase is not a no-op
    // and cannot be detected by comparing headers.
    const again = changePassphrase(vault, PASS, fakeRandom(31));
    expect(Array.from(again.wrappedDataKey)).not.toEqual(Array.from(vault.wrappedDataKey));
    const againBlob = seal(again, TASKS, 2n, fakeRandom(9));
    expect(openEnvelope(unlockVault(PASS, againBlob), againBlob).tasks).toEqual(TASKS);
  });
});

describe("recoveryCodeFor", () => {
  it("matches the standalone formatter", () => {
    expect(recoveryCodeFor(vault)).toBe(formatRecoveryCode(vault.dataKey));
  });

  it("is stable for a given vault", () => {
    expect(recoveryCodeFor(vault)).toBe(recoveryCodeFor(vault));
  });
});
