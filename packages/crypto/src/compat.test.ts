import { gcm } from "@noble/ciphers/aes.js";
import { gzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { canonicalNdjson, parseNdjson } from "./canonical";
import { createVault, encodeHeader, openEnvelope, seal } from "./envelope";
import { frame } from "./framing";
import { FORMAT_VERSION, NONCE_BYTES, OFF } from "./suite";
import { fakeRandom, makeTask, TEST_KDF } from "./testing";

/**
 * Backward compatibility for the canonical payload.
 *
 * This is the test that justifies growing `TASK_KEYS` instead of bumping
 * `FORMAT_VERSION`. The claim being made is specific: **a snapshot written
 * before a field existed still opens, and the field reads as unset.** If that
 * ever stops holding, the tolerant-read design has failed and the version bump
 * becomes the right answer after all — so this fails loudly rather than
 * degrading.
 */

const PASS = "correct horse battery staple";

/** The seventeen keys that existed when BDGR1 was frozen. */
const V1_KEYS = [
  "id",
  "title",
  "notes",
  "createdAt",
  "updatedAt",
  "fireAt",
  "nagIntervalSeconds",
  "nagMaxCount",
  "nagUntil",
  "escalationMode",
  "completedAt",
  "dismissedAt",
  "repeatRule",
  "priority",
  "deviceOrigin",
  "deletedAt",
  "snoozeCount",
] as const;

/** Re-emits canonical NDJSON with only the v1 keys — i.e. what the old code wrote. */
function v1Ndjson(tasks: ReturnType<typeof makeTask>[]): string {
  return canonicalNdjson(tasks)
    .split("\n")
    .map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      const trimmed: Record<string, unknown> = {};
      for (const key of V1_KEYS) trimmed[key] = row[key];
      return JSON.stringify(trimmed);
    })
    .join("\n");
}

describe("parseNdjson accepts pre-existing rows", () => {
  it("backfills a field added after the row was written", () => {
    const task = makeTask({ id: "old" });
    const parsed = parseNdjson(v1Ndjson([task]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("old");
    expect(parsed[0].leadTimeSeconds).toBeNull();
  });

  it("backfills to 'unset', never to a value the user never chose", () => {
    // A non-null default here would invent a pre-alarm and start firing
    // notifications nobody asked for.
    const parsed = parseNdjson(v1Ndjson([makeTask()]));
    expect(parsed[0].leadTimeSeconds).toBeNull();
  });

  it("still rejects a row missing an original field", () => {
    const row = JSON.parse(v1Ndjson([makeTask()])) as Record<string, unknown>;
    delete row.snoozeCount;
    expect(() => parseNdjson(JSON.stringify(row))).toThrow(/Missing field "snoozeCount"/);
  });

  it("round-trips a value once the field is present", () => {
    const task = makeTask({ id: "new", leadTimeSeconds: 900 });
    expect(parseNdjson(canonicalNdjson([task]))[0].leadTimeSeconds).toBe(900);
  });
});

describe("a vault sealed before the field existed still opens", () => {
  /**
   * Builds a genuine old-format envelope: same header and framing, but a
   * payload containing only the v1 keys. This is byte-for-byte what the
   * previous implementation produced, so opening it exercises the real
   * compatibility path rather than a simulation of it.
   */
  function sealV1(tasks: ReturnType<typeof makeTask>[], seq: bigint) {
    const vault = createVault(PASS, { kdf: TEST_KDF, random: fakeRandom(1) });
    const random = fakeRandom(9);
    const header = encodeHeader({
      version: FORMAT_VERSION,
      kdf: vault.kdf,
      vaultId: vault.vaultId,
      kdfSalt: vault.kdfSalt,
      wrapNonce: vault.wrapNonce,
      wrappedDataKey: vault.wrappedDataKey,
      seq,
      payloadNonce: random(NONCE_BYTES),
    });
    const nonce = header.slice(OFF.payloadNonce, OFF.payloadNonce + NONCE_BYTES);
    const gz = gzipSync(new TextEncoder().encode(v1Ndjson(tasks)), { mtime: 0 });
    const ciphertext = gcm(vault.dataKey, nonce, header).encrypt(frame(gz));

    const blob = new Uint8Array(header.length + ciphertext.length);
    blob.set(header, 0);
    blob.set(ciphertext, header.length);
    return { vault, blob };
  }

  it("opens and reads every original field", () => {
    const tasks = [makeTask({ id: "a" }), makeTask({ id: "b", title: "Water the plants" })];
    const { vault, blob } = sealV1(tasks, 7n);

    const opened = openEnvelope(vault, blob);
    expect(opened.seq).toBe(7n);
    expect(opened.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(opened.tasks[1].title).toBe("Water the plants");
  });

  it("reads the added field as unset", () => {
    const { vault, blob } = sealV1([makeTask({ id: "a" })], 1n);
    expect(openEnvelope(vault, blob).tasks[0].leadTimeSeconds).toBeNull();
  });

  it("re-sealing an old snapshot writes it forward without losing anything", () => {
    // The upgrade path: open an old vault, seal it again, and the result is a
    // current-format snapshot with identical task data.
    const tasks = [makeTask({ id: "a" }), makeTask({ id: "b" })];
    const { vault, blob } = sealV1(tasks, 3n);

    const opened = openEnvelope(vault, blob);
    const resealed = seal(vault, opened.tasks, 4n, fakeRandom(9));
    const reopened = openEnvelope(vault, resealed);

    expect(reopened.tasks).toEqual(opened.tasks);
    expect(reopened.seq).toBe(4n);
  });

  it("a new snapshot still refuses to open under a wrong key", () => {
    // Sanity: tolerance is about missing keys, not about weakened authentication.
    const { blob } = sealV1([makeTask()], 1n);
    const other = createVault(PASS, { kdf: TEST_KDF, random: fakeRandom(55) });
    expect(() => openEnvelope(other, blob)).toThrow(/failed authentication/);
  });
});
