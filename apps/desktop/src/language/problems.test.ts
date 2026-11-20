import { describe, expect, it } from "vitest";
import { LARGE_DOCUMENT_LENGTH } from "../editor/performance-budget";
import type { ExecutionLanguage, ExecutionStream } from "@turing/contracts";
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

function diagnostics(
  document: EditorTab,
  language: ExecutionLanguage,
  output: { stream: ExecutionStream; text: string }[],
) {
  return compilerProblems(
    {
      document: { key: tab.key, version: "a" },
      name: document.title,
      language,
      phase: "failed",
      elapsedMs: 0,
      exitCode: 1,
      cancelled: false,
      truncated: false,
      output,
    },
    [document],
  );
}

function buildFor(document: EditorTab, ...lines: string[]) {
  return diagnostics(document, "cpp", [
    { stream: "buildStderr", text: lines.join("\n") },
  ]);
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

describe("single-file language diagnostics", () => {
  it.each([
    [
      "c",
      "main.c",
      "buildStderr",
      "C error",
      "/tmp/turing-run-1/main.c:2:21: error: C error",
    ],
    [
      "rust",
      "main.rs",
      "buildStderr",
      "Rust error",
      "error[E0425]: Rust error\n --> /tmp/turing-run-1/main.rs:2:17",
    ],
    ["go", "main.go", "buildStderr", "Go error", "./main.go:2:21: Go error"],
    [
      "java",
      "Main.java",
      "buildStderr",
      "Java error",
      "/tmp/turing-run-1/Main.java:2: error: Java error\nsource\n                 ^",
    ],
    [
      "javascript",
      "main.mjs",
      "buildStderr",
      "JS error",
      "/tmp/turing-run-1/main.mjs:2\nsource\n                 ^\n\nSyntaxError: JS error",
    ],
    [
      "typescript",
      "main ü.mts",
      "stderr",
      "TS error",
      "file:///tmp/turing-run-1/main%20%C3%BC.mts:2\nsource\n                 ^\n\nSyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: TS error",
    ],
    [
      "typescript",
      "main.ts",
      "buildStderr",
      "TS1005: expected",
      "C:\\Temp\\turing-run-1\\main.ts(2,18): error TS1005: expected",
    ],
    [
      "csharp",
      "main.cs",
      "buildStdout",
      "CS1002: expected",
      "/tmp/turing-run-1/main.cs(2,18): error CS1002: expected [/tmp/turing-run-1/TuringRun.csproj]",
    ],
  ] as const)(
    "maps %s locations to UTF-16",
    (language, name, stream, message, output) => {
      const document = { ...tab, name, title: name };
      expect(
        diagnostics(document, language, [{ stream, text: output }]),
      ).toMatchObject([
        { start: { line: 1, character: 17 }, severity: "error", message },
      ]);
    },
  );

  it("reassembles build stderr across interleaved stdout and rejects another file", () => {
    const document = { ...tab, name: "main.rs", title: "main.rs" };
    expect(
      diagnostics(document, "rust", [
        { stream: "buildStderr", text: "warning: un" },
        { stream: "buildStdout", text: "other stream" },
        {
          stream: "buildStderr",
          text: "used\n --> /tmp/turing-run-1/main.rs:2:17\nerror: other file\n --> /project/main.rs:2:17",
        },
      ]),
    ).toMatchObject([{ severity: "warning", message: "unused" }]);
  });
});
