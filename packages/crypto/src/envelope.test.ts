import { describe, expect, it } from "vitest";
import {
  createVault,
  decodeHeader,
  openEnvelope,
  peekSeq,
  seal,
  unlockVault,
} from "./envelope";
import { DEFAULT_KDF, HEADER_BYTES, OFF, PAD_BLOCK, SUITE_ARGON2ID } from "./suite";
import { fakeRandom, makeTask, TEST_KDF } from "./testing";

const PASS = "correct horse battery staple";
const vaultFor = (seed = 1) => createVault(PASS, { kdf: TEST_KDF, random: fakeRandom(seed) });

describe("seal / openEnvelope", () => {
  it("round-trips a snapshot", () => {
    const vault = vaultFor();
    const tasks = [makeTask({ id: "a" }), makeTask({ id: "b", title: "Water the plants" })];
    const blob = seal(vault, tasks, 1n, fakeRandom(9));
    const opened = openEnvelope(vault, blob);
    expect(opened.tasks).toEqual(tasks);
    expect(opened.seq).toBe(1n);
  });

  it("round-trips an empty vault", () => {
    const vault = vaultFor();
    const blob = seal(vault, [], 1n, fakeRandom(9));
    expect(openEnvelope(vault, blob).tasks).toEqual([]);
  });

  it("recovers the data key from the envelope with the right passphrase", () => {
    const vault = vaultFor();
    const tasks = [makeTask()];
    const blob = seal(vault, tasks, 1n, fakeRandom(9));

    const reopened = unlockVault(PASS, blob);
    expect(openEnvelope(reopened, blob).tasks).toEqual(tasks);
  });

  it("rejects the wrong passphrase without leaking plaintext (I3)", () => {
    const blob = seal(vaultFor(), [makeTask()], 1n, fakeRandom(9));
    expect(() => unlockVault("wrong passphrase", blob)).toThrow(/Wrong passphrase/);
  });

  it("produces different ciphertext for identical state (nonce is fresh)", () => {
    const vault = vaultFor();
    const tasks = [makeTask()];
    const a = seal(vault, tasks, 1n, fakeRandom(9));
    const b = seal(vault, tasks, 1n, fakeRandom(77));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe("tamper resistance (I3)", () => {
  it("fails on a flipped bit anywhere in the envelope", () => {
    const vault = vaultFor();
    const blob = seal(vault, [makeTask()], 1n, fakeRandom(9));

    let checked = 0;
    for (let i = 0; i < blob.length; i++) {
      const mutated = Uint8Array.from(blob);
      mutated[i] ^= 0x01;
      expect(() => openEnvelope(vault, mutated)).toThrow();
      checked++;
    }
    expect(checked).toBe(blob.length);
  });

  it("fails when the sequence number is edited, because seq is inside the AAD", () => {
    const vault = vaultFor();
    const blob = seal(vault, [makeTask()], 1n, fakeRandom(9));
    const mutated = Uint8Array.from(blob);
    new DataView(mutated.buffer).setBigUint64(OFF.seq, 999n, false);
    expect(() => openEnvelope(vault, mutated)).toThrow(/failed authentication/);
  });

  it("fails when KDF parameters are downgraded (I7)", () => {
    const vault = vaultFor();
    const blob = seal(vault, [makeTask()], 1n, fakeRandom(9));
    const mutated = Uint8Array.from(blob);
    mutated[OFF.kdfParams + 4] = 1;
    mutated[OFF.kdfParams + 5] = 1;
    new DataView(mutated.buffer).setUint32(OFF.kdfParams, 8, false);
    expect(() => openEnvelope(vault, mutated)).toThrow();
  });

  it("fails on truncation", () => {
    const vault = vaultFor();
    const blob = seal(vault, [makeTask()], 1n, fakeRandom(9));
    expect(() => openEnvelope(vault, blob.slice(0, blob.length - 1))).toThrow();
  });

  it("cannot be opened by a different vault's key", () => {
    const blob = seal(vaultFor(1), [makeTask()], 1n, fakeRandom(9));
    expect(() => openEnvelope(vaultFor(2), blob)).toThrow(/failed authentication/);
  });
});

describe("length hiding (I5)", () => {
  it("pads to a 4 KiB boundary so size reveals only a bucket", () => {
    const vault = vaultFor();
    const one = seal(vault, [makeTask({ id: "a" })], 1n, fakeRandom(9));
    const many = seal(
      vault,
      Array.from({ length: 40 }, (_, i) => makeTask({ id: `task-${i}` })),
      1n,
      fakeRandom(9)
    );
    expect(one.length).toBe(many.length);
    // header + one padded block + GCM tag
    expect(one.length).toBe(HEADER_BYTES + PAD_BLOCK + 16);
  });

  it("carries no plaintext length field in the cleartext header", () => {
    const vault = vaultFor();
    const short = seal(vault, [makeTask({ id: "a", title: "x" })], 1n, fakeRandom(9));
    const long = seal(
      vault,
      [makeTask({ id: "a", title: "x".repeat(500) })],
      1n,
      fakeRandom(9)
    );
    expect(Buffer.from(short.slice(0, HEADER_BYTES))).toEqual(
      Buffer.from(long.slice(0, HEADER_BYTES))
    );
  });
});

describe("header parsing fails closed", () => {
  it("rejects a foreign magic", () => {
    expect(() => decodeHeader(new Uint8Array(HEADER_BYTES))).toThrow(/Not a badgr/);
  });

  it("rejects a short buffer instead of reading out of bounds", () => {
    expect(() => decodeHeader(new Uint8Array(4))).toThrow(/shorter than its header/);
  });

  it("rejects an unknown format version", () => {
    const blob = seal(vaultFor(), [makeTask()], 1n, fakeRandom(9));
    const mutated = Uint8Array.from(blob);
    mutated[OFF.version] = 0x99;
    expect(() => decodeHeader(mutated)).toThrow(/Unsupported envelope version/);
  });

  it("rejects an unknown cipher suite", () => {
    const blob = seal(vaultFor(), [makeTask()], 1n, fakeRandom(9));
    const mutated = Uint8Array.from(blob);
    mutated[OFF.suite] = 0x7f;
    expect(() => decodeHeader(mutated)).toThrow(/Unsupported cipher suite/);
  });
});

describe("rollback support (I4)", () => {
  it("exposes seq without decrypting so callers can reject stale blobs cheaply", () => {
    const vault = vaultFor();
    expect(peekSeq(seal(vault, [makeTask()], 42n, fakeRandom(9)))).toBe(42n);
  });

  it("preserves large sequence numbers across the u64 boundary", () => {
    const vault = vaultFor();
    const big = 2n ** 63n + 7n;
    const blob = seal(vault, [makeTask()], big, fakeRandom(9));
    expect(openEnvelope(vault, blob).seq).toBe(big);
  });
});

describe("production parameters", () => {
  it("defaults to Argon2id at OWASP's minimum, and says so loudly if changed", () => {
    expect(DEFAULT_KDF).toEqual({ suite: SUITE_ARGON2ID, m: 19456, t: 2, p: 1 });
  });
});
