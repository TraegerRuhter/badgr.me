import { describe, expect, it } from "vitest";
import { frame, unframe } from "./framing";
import { PAD_BLOCK } from "./suite";

describe("frame / unframe", () => {
  it("round-trips arbitrary payloads", () => {
    for (const size of [0, 1, 100, 4091, 4092, 4093, 8000]) {
      const payload = new Uint8Array(size).fill(0xab);
      expect(Buffer.from(unframe(frame(payload)))).toEqual(Buffer.from(payload));
    }
  });

  it("always pads to a whole number of blocks", () => {
    for (const size of [0, 1, 4091, 4092, 4093, 9000]) {
      expect(frame(new Uint8Array(size)).length % PAD_BLOCK).toBe(0);
    }
  });

  it("puts payloads of different sizes into the same block", () => {
    expect(frame(new Uint8Array(1)).length).toBe(frame(new Uint8Array(4000)).length);
  });

  it("crosses to a second block exactly when the length prefix no longer fits", () => {
    expect(frame(new Uint8Array(PAD_BLOCK - 4)).length).toBe(PAD_BLOCK);
    expect(frame(new Uint8Array(PAD_BLOCK - 3)).length).toBe(PAD_BLOCK * 2);
  });

  it("rejects a truncated frame rather than reading past the end", () => {
    expect(() => unframe(new Uint8Array(3))).toThrow(/truncated/);
  });

  it("rejects a declared length that overruns the buffer", () => {
    const bad = new Uint8Array(16);
    new DataView(bad.buffer).setUint32(0, 9999, false);
    expect(() => unframe(bad)).toThrow(/beyond its bounds/);
  });
});
