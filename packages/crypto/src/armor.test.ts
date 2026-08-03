import { describe, expect, it } from "vitest";
import { armor, ARMOR_LABEL, base64UrlDecode, base64UrlEncode, dearmor, isArmored } from "./armor";
import { createVault, openEnvelope, seal } from "./envelope";
import { fakeRandom, makeTask, TEST_KDF } from "./testing";

describe("base64url", () => {
  it("round-trips every byte value", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(Array.from(base64UrlDecode(base64UrlEncode(all)))).toEqual(Array.from(all));
  });

  it("round-trips every length remainder", () => {
    for (let n = 0; n < 9; n++) {
      const bytes = fakeRandom(n + 1)(n);
      expect(Array.from(base64UrlDecode(base64UrlEncode(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it("uses the URL-safe alphabet and no padding", () => {
    const encoded = base64UrlEncode(new Uint8Array([0xff, 0xef, 0xfe]));
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe("armor / dearmor", () => {
  const blobFor = () => {
    const vault = createVault("pass", { kdf: TEST_KDF, random: fakeRandom(1) });
    return seal(vault, [makeTask()], 1n, fakeRandom(9));
  };

  it("round-trips a sealed envelope", () => {
    const blob = blobFor();
    expect(Array.from(dearmor(armor(blob)))).toEqual(Array.from(blob));
  });

  it("survives the wrapping, re-indentation and CRLF that transports add", () => {
    const blob = blobFor();
    const mangled = armor(blob).replace(/\n/g, "\r\n  ");
    expect(Array.from(dearmor(mangled))).toEqual(Array.from(blob));
  });

  it("wraps the body so no line is unreasonably long", () => {
    const lines = armor(blobFor()).trimEnd().split("\n");
    expect(lines[0]).toBe(ARMOR_LABEL);
    for (const line of lines.slice(1)) expect(line.length).toBeLessThanOrEqual(76);
  });

  it("still authenticates after a transport round-trip", () => {
    const vault = createVault("pass", { kdf: TEST_KDF, random: fakeRandom(1) });
    const tasks = [makeTask({ id: "armored" })];
    const blob = seal(vault, tasks, 5n, fakeRandom(9));
    expect(openEnvelope(vault, dearmor(armor(blob))).tasks).toEqual(tasks);
  });

  it("recognises armored text without decoding it", () => {
    expect(isArmored(armor(blobFor()))).toBe(true);
    expect(isArmored("just some notes")).toBe(false);
  });
});

describe("dearmor fails closed on junk (§9 parser fuzzing)", () => {
  it("rejects a file that isn't ours", () => {
    expect(() => dearmor("hello world")).toThrow(/Not a badgr sync file/);
  });

  it("rejects a header with no body", () => {
    expect(() => dearmor(ARMOR_LABEL)).toThrow(/no body/);
  });

  it("rejects a wrong version label", () => {
    expect(() => dearmor("badgr-sync/2\nAAAA")).toThrow(/Not a badgr sync file/);
  });

  it("rejects non-alphabet characters rather than skipping them", () => {
    expect(() => dearmor(`${ARMOR_LABEL}\nAAA*AAAA`)).toThrow(/non-base64url/);
  });

  it("rejects a truncated final group", () => {
    expect(() => dearmor(`${ARMOR_LABEL}\nAAAAA`)).toThrow(/truncated/);
  });

  it("never throws something other than an Error on random input", () => {
    for (let seed = 1; seed < 40; seed++) {
      const junk = String.fromCharCode(...fakeRandom(seed)(24));
      expect(() => {
        try {
          dearmor(junk);
        } catch (err) {
          if (!(err instanceof Error)) throw new TypeError("non-Error thrown");
          return;
        }
      }).not.toThrow();
    }
  });

  it("a corrupted armor body fails authentication rather than yielding plaintext", () => {
    const vault = createVault("pass", { kdf: TEST_KDF, random: fakeRandom(1) });
    const text = armor(seal(vault, [makeTask()], 1n, fakeRandom(9)));
    // Flip one character deep in the body — decodes fine, must not authenticate.
    const body = text.split("\n");
    const line = body[2];
    body[2] = `${line[0] === "A" ? "B" : "A"}${line.slice(1)}`;

    expect(() => openEnvelope(vault, dearmor(body.join("\n")))).toThrow(/failed authentication/);
  });
});
