import { describe, expect, it } from "vitest";

import {
  appendChecklistItem,
  checklistProgress,
  hasChecklist,
  parseChecklist,
  toggleChecklistItem,
} from "./checklist";

describe("parseChecklist / hasChecklist", () => {
  it("returns nothing for null, empty, or plain-prose notes", () => {
    expect(parseChecklist(null)).toEqual([]);
    expect(parseChecklist("")).toEqual([]);
    expect(parseChecklist("just a regular note, no checkboxes here")).toEqual([]);
    expect(hasChecklist("plain text")).toBe(false);
  });

  it("parses mixed checked/unchecked items and reports their line index", () => {
    const notes = "- [ ] milk\n- [x] eggs\n- [X] bread";
    const items = parseChecklist(notes);
    expect(items).toEqual([
      { lineIndex: 0, text: "milk", checked: false },
      { lineIndex: 1, text: "eggs", checked: true },
      { lineIndex: 2, text: "bread", checked: true },
    ]);
    expect(hasChecklist(notes)).toBe(true);
  });

  it("supports the * bullet and skips non-checklist lines in a mixed note", () => {
    const notes = "Grocery run:\n* [ ] apples\nnot a checklist line\n* [x] pears";
    const items = parseChecklist(notes);
    expect(items).toEqual([
      { lineIndex: 1, text: "apples", checked: false },
      { lineIndex: 3, text: "pears", checked: true },
    ]);
  });
});

describe("checklistProgress", () => {
  it("counts done vs total", () => {
    expect(checklistProgress("- [ ] a\n- [x] b\n- [x] c")).toEqual({
      done: 2,
      total: 3,
    });
    expect(checklistProgress("no items")).toEqual({ done: 0, total: 0 });
  });
});

describe("toggleChecklistItem", () => {
  it("flips unchecked to checked and back, touching only that line", () => {
    const notes = "- [ ] milk\n- [ ] eggs";
    const afterFirst = toggleChecklistItem(notes, 0);
    expect(afterFirst).toBe("- [x] milk\n- [ ] eggs");
    const afterSecond = toggleChecklistItem(afterFirst, 0);
    expect(afterSecond).toBe(notes);
  });

  it("preserves surrounding prose lines untouched", () => {
    const notes = "Reminders:\n- [ ] task one\nsome extra context\n- [ ] task two";
    const toggled = toggleChecklistItem(notes, 3);
    expect(toggled).toBe(
      "Reminders:\n- [ ] task one\nsome extra context\n- [x] task two"
    );
  });

  it("is a no-op on an out-of-range or non-checklist line", () => {
    const notes = "- [ ] only item";
    expect(toggleChecklistItem(notes, 5)).toBe(notes);
    expect(toggleChecklistItem("plain text line", 0)).toBe("plain text line");
  });
});

describe("appendChecklistItem", () => {
  it("adds the first item to empty notes with no leading blank line", () => {
    expect(appendChecklistItem(null, "milk")).toBe("- [ ] milk");
    expect(appendChecklistItem("", "milk")).toBe("- [ ] milk");
  });

  it("appends after existing content, trimming trailing blank lines first", () => {
    expect(appendChecklistItem("- [x] milk\n\n", "eggs")).toBe(
      "- [x] milk\n- [ ] eggs"
    );
  });
});
