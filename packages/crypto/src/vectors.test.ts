import { describe, expect, it } from "vitest";
import { createVault, openEnvelope, seal } from "./envelope";
import { HEADER_BYTES, NONCE_BYTES, OFF } from "./suite";
import { fakeRandom, makeTask, TEST_KDF } from "./testing";

/**
 * Format lock (build plan §9).
 *
 * If a change to serialisation, key derivation, canonical ordering, framing, or
 * padding alters the output, this test fails — which is the point. A failure
 * here is not flaky. Treat it as "previously written vaults may no longer be
 * readable" until proven otherwise, and never paste in whatever the suite
 * currently produces.
 *
 * ## Regenerated once, 2026-08-03, when `leadTimeSeconds` was added
 *
 * Appending a key to the canonical payload changes the bytes of every *newly
 * written* vault, so `ciphertextHead` and `gcmTag` moved. The header and the
 * total length did not: the header carries no payload keys, and the 4 KiB
 * padding absorbs the extra bytes.
 *
 * ## Regenerated again, 2026-08-04, when Rounds' three fields were added
 *
 * Same shape of change, same reason: `roundsIntervalSeconds`,
 * `roundsMaxCount`, and `roundsDurationSeconds` appended to `LATER_KEYS`
 * (plan §3.4, §9.4) moved `ciphertextHead`/`gcmTag` again. `length` and
 * `header` held, for the same reason as last time — padding absorbs it.
 *
 * That is only acceptable because **old vaults still open**, which is not
 * assumed here — `compat.test.ts` seals a genuine v1-shaped envelope and reads
 * it back, proving the missing key is backfilled rather than rejected. If a
 * future change breaks these vectors *and* that compatibility suite, the
 * tolerant-read design has failed and a FORMAT_VERSION bump is the right answer
 * after all.
 *
 * So: regenerating these is legitimate only alongside a passing `compat.test.ts`
 * and a recorded reason. Regenerating them to make a red suite go green is how
 * you silently make someone's vault unreadable.
 */
const PASS = "correct horse battery staple";

function vectorBlob(): Uint8Array {
  const vault = createVault(PASS, { kdf: TEST_KDF, random: fakeRandom(1) });
  const tasks = [
    makeTask({ id: "a" }),
    makeTask({ id: "b", title: "Water the plants", notes: "north window" }),
  ];
  return seal(vault, tasks, 7n, fakeRandom(9));
}

const EXPECTED = {
  length: 4236,
  header:
    "424447520101000000400101419693218a3d453fad9389eb2596d877de36130b" +
    "f0396a988543e9532175c54ee80d2996db65d76ff1fe24bc8a92e728bb16908e" +
    "bd9e954aa7fd3ec65b32a7930e237a2570aa1d9b07cb2b30eed01aba35879c62" +
    "54a02530a48ab60000000000000000074fab18d33521508aeda5294e",
  ciphertextHead: "f80ea32c3f8683cb44b21cdf609c6701d10d8937a7b8f777443e7199089a20ca",
  gcmTag: "fbe4f7289ac31f3370b7f715efa9fe26",
} as const;

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("BDGR1 format lock", () => {
  const blob = vectorBlob();

  it("matches the frozen total length", () => {
    expect(blob.length).toBe(EXPECTED.length);
  });

  it("matches the frozen header bytes", () => {
    expect(hex(blob.slice(0, HEADER_BYTES))).toBe(EXPECTED.header);
  });

  it("matches the frozen ciphertext prefix", () => {
    expect(hex(blob.slice(HEADER_BYTES, HEADER_BYTES + 32))).toBe(EXPECTED.ciphertextHead);
  });

  it("matches the frozen GCM tag", () => {
    expect(hex(blob.slice(blob.length - 16))).toBe(EXPECTED.gcmTag);
  });

  it("seals identical bytes for identical inputs", () => {
    // Regression: fflate stamps Date.now() into the gzip MTIME field by
    // default, which made sealing non-deterministic and leaked the seal time
    // into the payload. seal() pins mtime to 0.
    expect(hex(vectorBlob())).toBe(hex(blob));
  });

  it("still decrypts to the original tasks", () => {
    const vault = createVault(PASS, { kdf: TEST_KDF, random: fakeRandom(1) });
    const opened = openEnvelope(vault, blob);
    expect(opened.seq).toBe(7n);
    expect(opened.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(opened.tasks[1].notes).toBe("north window");
  });
});

/**
 * Cross-implementation check (build plan §9).
 *
 * The web client uses native WebCrypto so it can hold a non-extractable
 * CryptoKey; mobile uses noble because React Native has no SubtleCrypto. That
 * split is only safe if both produce and accept identical bytes, so this asserts
 * it on every run rather than trusting the one-off spike.
 */
describe("noble ↔ WebCrypto interop", () => {
  it("lets WebCrypto decrypt an envelope sealed by noble", async () => {
    const vault = createVault(PASS, { kdf: TEST_KDF, random: fakeRandom(3) });
    const tasks = [makeTask({ id: "interop" })];
    const blob = seal(vault, tasks, 5n, fakeRandom(11));

    const header = blob.slice(0, HEADER_BYTES);
    const nonce = blob.slice(OFF.payloadNonce, OFF.payloadNonce + NONCE_BYTES);
    const ciphertext = blob.slice(HEADER_BYTES);

    // Copied into a fresh buffer rather than passed directly: WebCrypto's
    // BufferSource requires an ArrayBuffer-backed view, and a plain Uint8Array
    // is typed as possibly SharedArrayBuffer-backed. Deliberately not going
    // through this package's own importDataKey — the point of these vectors is
    // that a *third party* using stock WebCrypto can read what we write.
    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(vault.dataKey),
      "AES-GCM",
      false,
      ["decrypt"]
    );
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData: header },
        key,
        ciphertext
      )
    );

    // Framed payload: u32be length prefix, then gzip's 0x1f 0x8b magic.
    expect(plain.length % 4096).toBe(0);
    expect([plain[4], plain[5]]).toEqual([0x1f, 0x8b]);
  });

  it("rejects a tampered AAD under WebCrypto too", async () => {
    const vault = createVault(PASS, { kdf: TEST_KDF, random: fakeRandom(3) });
    const blob = seal(vault, [makeTask()], 5n, fakeRandom(11));

    const header = blob.slice(0, HEADER_BYTES);
    header[OFF.seq + 7] ^= 0x01;
    const nonce = blob.slice(OFF.payloadNonce, OFF.payloadNonce + NONCE_BYTES);

    // Copied into a fresh buffer rather than passed directly: WebCrypto's
    // BufferSource requires an ArrayBuffer-backed view, and a plain Uint8Array
    // is typed as possibly SharedArrayBuffer-backed. Deliberately not going
    // through this package's own importDataKey — the point of these vectors is
    // that a *third party* using stock WebCrypto can read what we write.
    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(vault.dataKey),
      "AES-GCM",
      false,
      ["decrypt"]
    );
    await expect(
      crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData: header },
        key,
        blob.slice(HEADER_BYTES)
      )
    ).rejects.toThrow();
  });
});
