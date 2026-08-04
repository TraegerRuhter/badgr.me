import { describe, expect, it } from "vitest";
import {
  formatRecoveryCode,
  looksLikeRecoveryCode,
  parseRecoveryCode,
  RecoveryCodeError,
} from "./recovery";
import { KEY_BYTES } from "./suite";
import { fakeRandom } from "./testing";

const key = (seed = 1) => fakeRandom(seed)(KEY_BYTES);

describe("recovery code round trip", () => {
  it("recovers the exact key", () => {
    const original = key();
    expect(Array.from(parseRecoveryCode(formatRecoveryCode(original)))).toEqual(
      Array.from(original)
    );
  });

  it("round-trips every key it is given", () => {
    for (let seed = 1; seed < 40; seed++) {
      const original = key(seed);
      expect(Array.from(parseRecoveryCode(formatRecoveryCode(original)))).toEqual(
        Array.from(original)
      );
    }
  });

  it("round-trips an all-zero and an all-ones key", () => {
    for (const fill of [0x00, 0xff]) {
      const original = new Uint8Array(KEY_BYTES).fill(fill);
      expect(Array.from(parseRecoveryCode(formatRecoveryCode(original)))).toEqual(
        Array.from(original)
      );
    }
  });

  it("is grouped in fours and carries a checksum", () => {
    const code = formatRecoveryCode(key());
    expect(code.split("-")).toHaveLength(14);
    for (const group of code.split("-")) expect(group).toHaveLength(4);
  });

  it("refuses to encode anything that isn't a data key", () => {
    expect(() => formatRecoveryCode(new Uint8Array(16))).toThrow(/32-byte/);
  });
});

describe("written down by a human, typed back by a human", () => {
  const code = formatRecoveryCode(key(7));
  const expected = Array.from(key(7));

  it("ignores case", () => {
    expect(Array.from(parseRecoveryCode(code.toLowerCase()))).toEqual(expected);
  });

  it("ignores the grouping, and however they spaced it", () => {
    expect(Array.from(parseRecoveryCode(code.replace(/-/g, "")))).toEqual(expected);
    expect(Array.from(parseRecoveryCode(code.replace(/-/g, " ")))).toEqual(expected);
    expect(Array.from(parseRecoveryCode(code.replace(/-/g, "\n")))).toEqual(expected);
  });

  it("survives the dash a word processor turned into an en dash", () => {
    expect(Array.from(parseRecoveryCode(code.replace(/-/g, "–")))).toEqual(expected);
  });

  it("accepts the letters people write instead of digits", () => {
    // Crockford's whole point: someone reading handwriting sees O for 0 and
    // l for 1. Those should recover the same key, not fail.
    const withLetters = code.replace(/0/g, "O").replace(/1/g, "I");
    expect(Array.from(parseRecoveryCode(withLetters))).toEqual(expected);
  });

  it("alphabet contains none of the confusable characters", () => {
    const body = formatRecoveryCode(key(3)).replace(/-/g, "");
    expect(body).not.toMatch(/[ILOU]/);
  });
});

describe("a wrong code fails loudly (the point of the checksum)", () => {
  const good = formatRecoveryCode(key(11));

  it("rejects a single mistyped character rather than returning a wrong key", () => {
    const chars = good.replace(/-/g, "").split("");
    // Change one body character to a different valid one.
    chars[10] = chars[10] === "7" ? "8" : "7";
    expect(() => parseRecoveryCode(chars.join(""))).toThrow(RecoveryCodeError);
    expect(() => parseRecoveryCode(chars.join(""))).toThrow(/typo/);
  });

  it("catches a typo almost every time it is asked", () => {
    // Walk every body position, flip it to another valid character, and count
    // the escapes. 20 check bits should let through roughly one in a million.
    const body = good.replace(/-/g, "");
    let escaped = 0;
    let tried = 0;
    for (let i = 0; i < 52; i++) {
      for (const replacement of "0123456789ABCDEFGHJKMNPQRSTVWXYZ") {
        if (body[i] === replacement) continue;
        tried++;
        const mutated = body.slice(0, i) + replacement + body.slice(i + 1);
        try {
          parseRecoveryCode(mutated);
          escaped++;
        } catch {
          /* caught, as intended */
        }
      }
    }
    expect(tried).toBeGreaterThan(1500);
    expect(escaped).toBe(0);
  });

  it("catches two adjacent characters being swapped", () => {
    const body = good.replace(/-/g, "").split("");
    let swapIndex = -1;
    for (let i = 0; i < 51; i++) {
      if (body[i] !== body[i + 1]) {
        swapIndex = i;
        break;
      }
    }
    expect(swapIndex).toBeGreaterThanOrEqual(0);
    [body[swapIndex], body[swapIndex + 1]] = [body[swapIndex + 1], body[swapIndex]];
    expect(() => parseRecoveryCode(body.join(""))).toThrow(/typo/);
  });

  it("says the length is wrong when characters are missing", () => {
    expect(() => parseRecoveryCode(good.slice(0, 20))).toThrow(/characters/);
  });

  it("names the offending character rather than failing vaguely", () => {
    const body = good.replace(/-/g, "");
    const withU = `U${body.slice(1)}`;
    expect(() => parseRecoveryCode(withU)).toThrow(/"U" isn't a character/);
  });

  it("rejects an empty string without throwing something unhelpful", () => {
    expect(() => parseRecoveryCode("")).toThrow(RecoveryCodeError);
  });
});

describe("looksLikeRecoveryCode", () => {
  it("recognises a code regardless of formatting", () => {
    const code = formatRecoveryCode(key(5));
    expect(looksLikeRecoveryCode(code)).toBe(true);
    expect(looksLikeRecoveryCode(code.replace(/-/g, " "))).toBe(true);
  });

  it("does not mistake a passphrase for one", () => {
    expect(looksLikeRecoveryCode("correct horse battery staple")).toBe(false);
    expect(looksLikeRecoveryCode("")).toBe(false);
  });
});
