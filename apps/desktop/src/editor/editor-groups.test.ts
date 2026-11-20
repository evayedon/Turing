import { describe, expect, it } from "vitest";
import {
  activeDocument,
  closeDocumentInGroup,
  closeGroup,
  createGroups,
  documentsOnlyIn,
  focusAdjacentGroup,
  focusGroup,
  moveDocumentToNextGroup,
  openDocument,
  openDocuments,
  removeDocuments,
  splitGroup,
  viewCount,
} from "./editor-groups";
import type { EditorGroups } from "./editor-groups";

function withTabs(...keys: string[]) {
  return keys.reduce<EditorGroups>(
    (state, key) => openDocument(state, key),
    createGroups(),
  );
}

const layout = (state: EditorGroups) =>
  state.groups.map(({ id, keys, activeKey }) => ({ id, keys, activeKey }));

describe("editor groups", () => {
  it("opens documents in the active group in order and shows the latest", () => {
    const state = withTabs("a", "b");
    expect(layout(state)).toEqual([
      { id: "1", keys: ["a", "b"], activeKey: "b" },
    ]);
    expect(activeDocument(state)).toBe("b");
    const reselected = openDocument(state, "a");
    expect(reselected.groups[0].keys).toEqual(["a", "b"]);
    expect(activeDocument(reselected)).toBe("a");
    expect(openDocument(reselected, "a")).toBe(reselected);
  });

  it("splits the shown document into a new group to the right", () => {
    const state = splitGroup(withTabs("a", "b"));
    expect(layout(state)).toEqual([
      { id: "1", keys: ["a", "b"], activeKey: "b" },
      { id: "2", keys: ["b"], activeKey: "b" },
    ]);
    expect(state.activeGroup).toBe("2");
    expect(viewCount(state, "b")).toBe(2);
    expect(viewCount(state, "a")).toBe(1);
    const again = splitGroup(focusGroup(state, "1"));
    expect(again.groups.map(({ id }) => id)).toEqual(["1", "3", "2"]);
    expect(splitGroup(createGroups())).toEqual(createGroups());
  });

  it("closes one view without touching the document's other views", () => {
    const split = splitGroup(withTabs("a", "b"));
    const closed = closeDocumentInGroup(split, "b", "1");
    expect(layout(closed)).toEqual([
      { id: "1", keys: ["a"], activeKey: "a" },
      { id: "2", keys: ["b"], activeKey: "b" },
    ]);
    expect(openDocuments(closed)).toEqual(new Set(["a", "b"]));
    expect(closeDocumentInGroup(closed, "missing", "1")).toBe(closed);
  });

  it("closes a group emptied of its last tab and focuses its neighbour", () => {
    const split = splitGroup(withTabs("a"));
    const closed = closeDocumentInGroup(split, "a", "2");
    expect(layout(closed)).toEqual([{ id: "1", keys: ["a"], activeKey: "a" }]);
    expect(closed.activeGroup).toBe("1");
    const last = closeDocumentInGroup(closed, "a", "1");
    expect(layout(last)).toEqual([{ id: "1", keys: [], activeKey: undefined }]);
  });

  it("shows the next tab after closing the shown one", () => {
    const state = openDocument(withTabs("a", "b", "c"), "b");
    expect(activeDocument(closeDocumentInGroup(state, "b", "1"))).toBe("c");
    const end = closeDocumentInGroup(withTabs("a", "b"), "b", "1");
    expect(activeDocument(end)).toBe("a");
    const background = closeDocumentInGroup(withTabs("a", "b"), "a", "1");
    expect(activeDocument(background)).toBe("b");
  });

  it("removes closed documents from every group", () => {
    const state = splitGroup(withTabs("a", "b"));
    const removed = removeDocuments(state, new Set(["b"]));
    expect(layout(removed)).toEqual([{ id: "1", keys: ["a"], activeKey: "a" }]);
    expect(removed.activeGroup).toBe("1");
    expect(layout(removeDocuments(removed, new Set(["a"])))).toEqual([
      { id: "1", keys: [], activeKey: undefined },
    ]);
  });

  it("moves a document into the next group, creating one at the right edge", () => {
    const moved = moveDocumentToNextGroup(withTabs("a", "b"), "b");
    expect(layout(moved)).toEqual([
      { id: "1", keys: ["a"], activeKey: "a" },
      { id: "2", keys: ["b"], activeKey: "b" },
    ]);
    expect(moved.activeGroup).toBe("2");
    expect(moveDocumentToNextGroup(moved, "b")).toBe(moved);
    const back = moveDocumentToNextGroup(focusGroup(moved, "1"), "a");
    expect(layout(back)).toEqual([
      { id: "2", keys: ["b", "a"], activeKey: "a" },
    ]);
    expect(back.activeGroup).toBe("2");
    const single = withTabs("a");
    expect(moveDocumentToNextGroup(single, "a")).toBe(single);
  });

  it("does not duplicate a moved document the target already shows", () => {
    const split = splitGroup(withTabs("a", "b"));
    const moved = moveDocumentToNextGroup(split, "b", "1");
    expect(layout(moved)).toEqual([
      { id: "1", keys: ["a"], activeKey: "a" },
      { id: "2", keys: ["b"], activeKey: "b" },
    ]);
  });

  it("cycles focus between groups in both directions", () => {
    const state = splitGroup(splitGroup(withTabs("a")));
    expect(state.groups.map(({ id }) => id)).toEqual(["1", "2", "3"]);
    expect(focusAdjacentGroup(state, 1).activeGroup).toBe("1");
    expect(focusAdjacentGroup(state, -1).activeGroup).toBe("2");
    const single = withTabs("a");
    expect(focusAdjacentGroup(single, 1)).toBe(single);
    expect(focusGroup(state, "missing")).toBe(state);
  });

  it("closes a group and reports the documents only it was showing", () => {
    const state = splitGroup(withTabs("a", "b"));
    const withC = openDocument(state, "c");
    expect(documentsOnlyIn(withC, "2")).toEqual(["c"]);
    expect(documentsOnlyIn(withC, "1")).toEqual(["a"]);
    const closed = closeGroup(withC, "2");
    expect(layout(closed)).toEqual([
      { id: "1", keys: ["a", "b"], activeKey: "b" },
    ]);
    expect(closed.activeGroup).toBe("1");
    expect(closeGroup(closed, "1")).toBe(closed);
    expect(documentsOnlyIn(closed, "missing")).toEqual([]);
  });
});
