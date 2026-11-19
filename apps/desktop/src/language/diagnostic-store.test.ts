import { describe, expect, it } from "vitest";
import type { EditorTab } from "../editor/use-editor";
import { currentProblems, stampOf } from "./diagnostic-store";
import type { DiagnosticBatch } from "./diagnostic-store";
import type { Problem } from "./problems";

function tab(key: string, patch: Partial<EditorTab> = {}): EditorTab {
  return {
    key,
    uri: `turing-workspace://w/${key}.cpp`,
    revision: 1,
    editRevision: 0,
    name: `${key}.cpp`,
    title: `${key}.cpp`,
    source: {
      kind: "workspace",
      workspaceId: "w",
      relativePath: `${key}.cpp`,
      version: "v1",
    },
    content: "",
    draft: "",
    changedOnDisk: false,
    ...patch,
  };
}

function problem(
  message: string,
  line: number,
  severity: Problem["severity"] = "error",
): Omit<Problem, "id" | "tabKey" | "filename" | "source"> {
  return {
    message,
    severity,
    start: { line, character: 0 },
    end: { line, character: 1 },
  };
}

function batch(
  producer: DiagnosticBatch["producer"],
  at: EditorTab,
  ...items: ReturnType<typeof problem>[]
): DiagnosticBatch {
  return { producer, stamp: stampOf(at), problems: items };
}

const messages = (problems: Problem[]) => problems.map((item) => item.message);

describe("diagnostic store", () => {
  it("shows a batch only while its document still has the stamped state", () => {
    const a = tab("a");
    const batches = [batch("clangd", a, problem("unused", 3))];
    expect(messages(currentProblems(batches, [a]))).toEqual(["unused"]);

    for (const changed of [
      { ...a, editRevision: 1 },
      { ...a, revision: 2 },
      { ...a, uri: "turing-workspace://w/renamed.cpp" },
      { ...a, changedOnDisk: true },
    ])
      expect(currentProblems(batches, [changed])).toEqual([]);
    // A closed document has no problems.
    expect(currentProblems(batches, [])).toEqual([]);
  });

  it("replaces a producer's earlier batch for a document but keeps other producers", () => {
    const a = tab("a");
    const problems = currentProblems(
      [
        batch("clangd", a, problem("old", 1)),
        batch("compiler", a, problem("compile", 2)),
        batch("clangd", a, problem("new", 5)),
      ],
      [a],
    );
    expect(messages(problems)).toEqual(["compile", "new"]);
    expect(problems.map((item) => item.source)).toEqual(["compiler", "clangd"]);
  });

  it("orders deterministically by tab, position, severity and producer with stable IDs", () => {
    const a = tab("a");
    const b = tab("b");
    const forward = [
      batch("compiler", b, problem("b-warning", 1, "warning")),
      batch(
        "clangd",
        a,
        problem("a-info", 4, "info"),
        problem("a-error", 4, "error"),
      ),
      batch("compiler", a, problem("a-compile", 4, "error")),
    ];
    const once = currentProblems(forward, [a, b]);
    const reversed = currentProblems([...forward].reverse(), [a, b]);
    expect(messages(once)).toEqual([
      "a-error",
      "a-compile",
      "a-info",
      "b-warning",
    ]);
    expect(reversed).toEqual(once);
    expect(once.map((item) => item.id)).toEqual([
      "clangd:a:4:0:0",
      "compiler:a:4:0:0",
      "clangd:a:4:0:1",
      "compiler:b:1:0:0",
    ]);
    expect(once[0]).toMatchObject({ tabKey: "a", filename: "a.cpp" });
  });
});
