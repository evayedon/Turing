import { describe, expect, it } from "vitest";
import { LARGE_DOCUMENT_LENGTH } from "../editor/performance-budget";
import type { EditorTab } from "../editor/use-editor";
import { compilerProblems } from "./problems";

const source = `int main() {\n\tauto s = "é😀"; missing;\n}\n`;

const tab: EditorTab = {
  key: "main",
  uri: "turing-workspace://one/main.cpp",
  revision: 1,
  name: "main.cpp",
  title: "main.cpp",
  source: {
    kind: "workspace",
    workspaceId: "one",
    relativePath: "main.cpp",
    version: "a",
  },
  content: source,
  draft: source,
  changedOnDisk: false,
};

function buildFor(document: EditorTab, ...lines: string[]) {
  return compilerProblems(
    {
      document: { key: tab.key, version: "a" },
      name: tab.title,
      language: "cpp",
      phase: "failed",
      elapsedMs: 0,
      exitCode: 1,
      cancelled: false,
      truncated: false,
      output: [{ stream: "buildStderr", text: lines.join("\n") }],
    },
    [document],
  );
}

const build = (...lines: string[]) => buildFor(tab, ...lines);

describe("compilerProblems", () => {
  it("skips inline compiler diagnostics for a large saved file", () => {
    const text = source.padEnd(LARGE_DOCUMENT_LENGTH, " ");
    expect(
      buildFor(
        { ...tab, content: text, draft: text },
        "/tmp/turing-run-1/main.cpp:2:21: error: missing",
      ),
    ).toEqual([]);
  });
  it("converts compiler byte columns to editor UTF-16 columns", () => {
    // Line 2 bytes: tab(1) + `auto s = "`(10) + é(2) + 😀(4) + `"; `(3) = 20,
    // so `missing` is byte column 21. In UTF-16 units: 1 + 10 + 1 + 2 + 3 = 17.
    const [problem] = build(
      "/tmp/turing-run-1/main.cpp:2:21: error: use of undeclared identifier 'missing'",
    );
    expect(problem.start).toEqual({ line: 1, character: 17 });
  });

  it("never places a column inside a character or past the end of its line", () => {
    // 😀 spans bytes 13–16 of line 2 (after tab, `auto s = "`, é). Byte
    // column 15 points inside it, so the marker starts at the emoji:
    // UTF-16 offset 1 + 10 + 1 = 12. Line 2 is 25 UTF-16 units long.
    const [inside, beyond] = build(
      "/tmp/turing-run-1/main.cpp:2:15: error: inside a character",
      "/tmp/turing-run-1/main.cpp:2:99: error: past the line",
    );
    expect(inside.start).toEqual({ line: 1, character: 12 });
    expect(beyond.start).toEqual({ line: 1, character: 25 });
  });
});
