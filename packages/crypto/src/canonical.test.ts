import { describe, expect, it } from "vitest";
import { canonicalNdjson, parseNdjson } from "./canonical";
import { makeTask } from "./testing";

describe("canonicalNdjson", () => {
  it("sorts rows by id regardless of input order", () => {
    const a = makeTask({ id: "aaa" });
    const b = makeTask({ id: "bbb" });
    expect(canonicalNdjson([b, a])).toBe(canonicalNdjson([a, b]));
  });

  it("emits keys in a fixed order regardless of object construction order", () => {
    const declared = makeTask();
    const shuffled = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(declared).reverse()))
    );
    expect(canonicalNdjson([shuffled])).toBe(canonicalNdjson([declared]));
  });

  it("round-trips through parseNdjson", () => {
    const tasks = [makeTask({ id: "a" }), makeTask({ id: "b", notes: "line1\nline2" })];
    expect(parseNdjson(canonicalNdjson(tasks))).toEqual(tasks);
  });

  it("handles an empty vault", () => {
    expect(canonicalNdjson([])).toBe("");
    expect(parseNdjson("")).toEqual([]);
  });

  it("preserves soft-deleted rows, which sync depends on", () => {
    const deleted = makeTask({ id: "gone", deletedAt: "2026-07-19T00:00:00.000Z" });
    expect(parseNdjson(canonicalNdjson([deleted]))[0].deletedAt).toBe("2026-07-19T00:00:00.000Z");
  });

  it("rejects a row missing a required field", () => {
    expect(() => parseNdjson('{"id":"a"}')).toThrow(/Missing field/);
  });

  it("rejects malformed JSON with the offending line number", () => {
    expect(() => parseNdjson("{not json}")).toThrow(/line 1/);
  });
});
