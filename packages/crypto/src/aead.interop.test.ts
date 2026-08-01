import { describe, expect, it } from "vitest";
import { importDataKey, nobleAead, webCryptoAead, zeroize } from "./aead";
import { createVault, openEnvelope, openEnvelopeWith, seal, sealWith } from "./envelope";
import { asAsyncRandom } from "./random";
import { createWebVault, resumeWebVault, unlockWebVault } from "./webVault";
import { fakeRandom, makeTask, TEST_KDF } from "./testing";

/**
 * Cross-implementation enforcement (build plan §9).
 *
 * The whole justification for web using WebCrypto while mobile uses noble
 * (§6.2) is that the two are byte-identical. That is an assertion, not an
 * assumption, so it runs on every commit: the moment one drifts, a vault
 * written on a phone stops opening in a browser.
 */

const PASS = "correct horse battery staple";
const subtle = globalThis.crypto.subtle;

const vaultFor = (seed = 1) => createVault(PASS, { kdf: TEST_KDF, random: fakeRandom(seed) });

describe("noble ↔ WebCrypto AEAD interop", () => {
  it("produces identical ciphertext for identical inputs", async () => {
    const key = fakeRandom(3)(32);
    const nonce = fakeRandom(4)(12);
    const aad = new TextEncoder().encode("header-ish bytes");
    const plaintext = new TextEncoder().encode("the quick brown fox");

    const fromNoble = await nobleAead(key).encrypt(nonce, aad, plaintext);
    const fromWeb = await webCryptoAead(subtle, await importDataKey(subtle, key, true)).encrypt(
      nonce,
      aad,
      plaintext
    );

    expect(Array.from(fromWeb)).toEqual(Array.from(fromNoble));
  });

  it("decrypts each other's output in both directions", async () => {
    const key = fakeRandom(5)(32);
    const nonce = fakeRandom(6)(12);
    const aad = new Uint8Array([1, 2, 3]);
    const plaintext = new TextEncoder().encode("bidirectional");

    const noble = nobleAead(key);
    const web = webCryptoAead(subtle, await importDataKey(subtle, key, true));

    expect(Array.from(await web.decrypt(nonce, aad, await noble.encrypt(nonce, aad, plaintext))))
      .toEqual(Array.from(plaintext));
    expect(Array.from(await noble.decrypt(nonce, aad, await web.encrypt(nonce, aad, plaintext))))
      .toEqual(Array.from(plaintext));
  });

  it("rejects a mismatched AAD on both sides", async () => {
    const key = fakeRandom(7)(32);
    const nonce = fakeRandom(8)(12);
    const good = new Uint8Array([9, 9, 9]);
    const bad = new Uint8Array([9, 9, 8]);
    const ct = await nobleAead(key).encrypt(nonce, good, new Uint8Array([42]));

    await expect(nobleAead(key).decrypt(nonce, bad, ct)).rejects.toThrow();
    await expect(
      webCryptoAead(subtle, await importDataKey(subtle, key, true)).decrypt(nonce, bad, ct)
    ).rejects.toThrow();
  });
});

describe("envelope interop", () => {
  it("seals on mobile and opens on web", async () => {
    const vault = vaultFor();
    const tasks = [makeTask({ id: "a" }), makeTask({ id: "b", title: "Water the plants" })];
    const blob = seal(vault, tasks, 4n, fakeRandom(9));

    const web = resumeWebVault(subtle, vault, await importDataKey(subtle, vault.dataKey));
    const opened = await openEnvelopeWith(web.aead, blob);

    expect(opened.tasks).toEqual(tasks);
    expect(opened.seq).toBe(4n);
  });

  it("seals on web and opens on mobile", async () => {
    const vault = vaultFor();
    const tasks = [makeTask({ id: "z" })];
    const key = await importDataKey(subtle, vault.dataKey);

    const blob = await sealWith(
      vault,
      webCryptoAead(subtle, key),
      tasks,
      7n,
      asAsyncRandom(fakeRandom(9))
    );

    expect(openEnvelope(vault, blob).tasks).toEqual(tasks);
    expect(openEnvelope(vault, blob).seq).toBe(7n);
  });

  it("sealWith is byte-identical to seal given the same nonce", async () => {
    const vault = vaultFor();
    const tasks = [makeTask()];
    const sync = seal(vault, tasks, 2n, fakeRandom(9));
    const async_ = await sealWith(
      vault,
      nobleAead(vault.dataKey),
      tasks,
      2n,
      asAsyncRandom(fakeRandom(9))
    );
    expect(Array.from(async_)).toEqual(Array.from(sync));
  });

  it("openEnvelopeWith refuses a tampered payload", async () => {
    const vault = vaultFor();
    const blob = seal(vault, [makeTask()], 1n, fakeRandom(9));
    blob[blob.length - 1] ^= 0x01;

    await expect(openEnvelopeWith(nobleAead(vault.dataKey), blob)).rejects.toThrow(
      /failed authentication/
    );
  });
});

describe("web vault key handling (§6.2)", () => {
  it("creates a vault whose key cannot be exported", async () => {
    const web = await createWebVault(subtle, PASS, { kdf: TEST_KDF, random: fakeRandom(1) });
    expect(web.key.extractable).toBe(false);
    // `key` is structurally typed (this package avoids the DOM lib), so hand it
    // back to the real WebCrypto signature to prove extraction genuinely fails
    // at runtime rather than just asserting the flag.
    await expect(subtle.exportKey("raw", web.key as never)).rejects.toThrow();
  });

  it("unlocks an existing envelope and reads it back", async () => {
    const vault = vaultFor();
    const tasks = [makeTask({ id: "unlocked" })];
    const blob = seal(vault, tasks, 3n, fakeRandom(9));

    const web = await unlockWebVault(subtle, PASS, blob);
    expect(web.key.extractable).toBe(false);
    expect((await openEnvelopeWith(web.aead, blob)).tasks).toEqual(tasks);
  });

  it("a web-created vault round-trips through its own seal/open", async () => {
    const web = await createWebVault(subtle, PASS, { kdf: TEST_KDF, random: fakeRandom(2) });
    const tasks = [makeTask({ id: "web-only" })];
    const blob = await sealWith(web.record, web.aead, tasks, 1n, asAsyncRandom(fakeRandom(9)));
    expect((await openEnvelopeWith(web.aead, blob)).tasks).toEqual(tasks);
  });

  it("zeroize actually clears the buffer", () => {
    const secret = fakeRandom(11)(32);
    expect(secret.some((b) => b !== 0)).toBe(true);
    zeroize(secret);
    expect(secret.every((b) => b === 0)).toBe(true);
  });
});
