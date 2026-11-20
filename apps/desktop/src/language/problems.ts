import { isLargeDocument } from "../editor/performance-budget";
import type { ExecutionLanguage, LanguagePosition } from "@turing/contracts";
import type { EditorTab } from "../editor/use-editor";
import type { useExecution } from "../execution/use-execution";
import { stampOf } from "./diagnostic-store";
import type { DiagnosticBatch } from "./diagnostic-store";

export type Severity = "error" | "warning" | "info";

export const problemGroups: { severity: Severity; title: string }[] = [
  { severity: "error", title: "Errors" },
  { severity: "warning", title: "Warnings" },
  { severity: "info", title: "Information" },
];

export type Problem = {
  id: string;
  tabKey: string;
  filename: string;
  severity: Severity;
  source: "clangd" | "compiler" | "monaco";
  message: string;
  start: LanguagePosition;
  end: LanguagePosition;
};

export function record(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value))
    return Object.fromEntries(Object.entries(value));
}

export function position(value: unknown): LanguagePosition | undefined {
  const item = record(value);
  const line = item?.line;
  const character = item?.character;
  if (
    typeof line === "number" &&
    Number.isSafeInteger(line) &&
    line >= 0 &&
    line < 2147483647 &&
    typeof character === "number" &&
    Number.isSafeInteger(character) &&
    character >= 0 &&
    character < 2147483647
  )
    return { line, character };
}

export function range(value: unknown) {
  const item = record(value);
  const start = position(item?.start);
  const end = position(item?.end);
  if (
    start &&
    end &&
    (end.line > start.line ||
      (end.line === start.line && end.character >= start.character))
  )
    return { start, end };
}

export function clangdProblems(
  diagnostics: unknown[],
  tab: EditorTab,
): Problem[] {
  return diagnostics.flatMap((value, index) => {
    const item = record(value);
    const location = range(item?.range);
    if (!location || typeof item?.message !== "string") return [];
    return [
      {
        ...location,
        id: `clangd:${tab.key}:${index}`,
        tabKey: tab.key,
        filename: tab.title,
        source: "clangd",
        severity:
          item.severity === 1
            ? "error"
            : item.severity === 2
              ? "warning"
              : "info",
        message: item.message.slice(0, 2000),
      },
    ];
  });
}

/** Converts a 0-based UTF-8 byte offset in `line` to UTF-16 code units. */
function utf16Column(line: string, byteOffset: number) {
  const bytes = new TextEncoder().encode(line);
  let end = Math.min(byteOffset, bytes.length);
  // Never split a multi-byte character: back up to its first byte.
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end)).length;
}

/**
 * The compiler's diagnostics for the current run as a store batch. It is
 * present only while the tab still holds the exact saved source that was
 * compiled, and is stamped with that tab's current state.
 */
export function compilerBatches(
  run: ReturnType<typeof useExecution>["run"],
  tabs: EditorTab[],
): DiagnosticBatch[] {
  const problems = compilerProblems(run, tabs);
  const tab = run && tabs.find(({ key }) => key === run.document.key);
  if (!tab || !problems.length) return [];
  return [
    {
      producer: "compiler",
      stamp: stampOf(tab),
      problems: problems.map(({ start, end, severity, message }) => ({
        start,
        end,
        severity,
        message,
      })),
    },
  ];
}

type BuildDiagnostic = {
  path: string;
  row: number;
  column: number;
  unit: "byte" | "scalar" | "utf16";
  severity: Severity;
  message: string;
};

function buildDiagnostic(
  language: ExecutionLanguage,
  lines: string[],
  index: number,
): BuildDiagnostic | undefined {
  const line = lines[index];
  const located =
    /^(.+?):(\d+):(\d+): (fatal error|error|warning|note): (.+)$/.exec(line);
  if (located && (language === "c" || language === "cpp"))
    return {
      path: located[1],
      row: Number(located[2]),
      column: Number(located[3]),
      unit: "byte",
      severity:
        located[4] === "warning"
          ? "warning"
          : located[4] === "note"
            ? "info"
            : "error",
      message: located[5],
    };

  if (language === "rust") {
    const header = /^(error|warning)(?:\[[^\]]+\])?: (.+)$/.exec(line);
    const span = /^\s*--> (.+):(\d+):(\d+)$/.exec(lines[index + 1] ?? "");
    if (header && span)
      return {
        path: span[1],
        row: Number(span[2]),
        column: Number(span[3]),
        unit: "scalar",
        severity: header[1] === "warning" ? "warning" : "error",
        message: header[2],
      };
  }

  if (language === "go") {
    const match = /^(.+?):(\d+):(?:(\d+):)? (.+)$/.exec(line);
    if (match)
      return {
        path: match[1],
        row: Number(match[2]),
        column: Number(match[3] ?? 1),
        unit: "byte",
        severity: "error",
        message: match[4],
      };
  }

  if (language === "typescript" || language === "csharp") {
    const match =
      /^(.+?)\((\d+),(\d+)\): (error|warning) ((?:TS|CS)\d+: .+)$/.exec(line);
    if (match)
      return {
        path: match[1],
        row: Number(match[2]),
        column: Number(match[3]),
        unit: "utf16",
        severity: match[4] === "warning" ? "warning" : "error",
        message: match[5].replace(/ \[.*\.csproj\]$/, ""),
      };
  }

  const caret = /^([ \t]*)\^/.exec(lines[index + 2] ?? "");
  if (language === "java") {
    const match = /^(.+?\.java):(\d+): (error|warning): (.+)$/i.exec(line);
    if (match)
      return {
        path: match[1],
        row: Number(match[2]),
        column: (caret?.[1].length ?? 0) + 1,
        unit: "utf16",
        severity: match[3] === "warning" ? "warning" : "error",
        message: match[4],
      };
  }

  if (language === "javascript" || language === "typescript") {
    const match = /^(.+):(\d+)$/.exec(line);
    const message =
      lines[index + 3] === "" ? lines[index + 4] : lines[index + 3];
    const syntax = /^SyntaxError(?: \[[^\]]+\])?: (.+)$/.exec(message ?? "");
    if (match && caret && syntax)
      return {
        path: match[1],
        row: Number(match[2]),
        column: caret[1].length + 1,
        unit: "utf16",
        severity: "error",
        message: syntax[1],
      };
  }
}

function isStagedSource(
  path: string,
  name: string,
  language: ExecutionLanguage,
) {
  if (path.startsWith("file://")) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      return false;
    }
  }
  const segments = path.replaceAll("\\", "/").split("/");
  const dot = name.lastIndexOf(".");
  const stagedName = name.slice(0, dot) + name.slice(dot).toLowerCase();
  return (
    (segments.at(-1) === name || segments.at(-1) === stagedName) &&
    (segments.at(-2)?.startsWith("turing-run-") ||
      (language === "go" && segments.length === 2 && segments[0] === "."))
  );
}

export function compilerProblems(
  run: ReturnType<typeof useExecution>["run"],
  tabs: EditorTab[],
): Problem[] {
  if (!run || run.language === "python" || run.cancelled) return [];
  const tab = tabs.find(
    (tab) =>
      tab.key === run.document.key &&
      tab.title === run.name &&
      !isLargeDocument(tab.draft) &&
      tab.draft === tab.content &&
      !tab.changedOnDisk &&
      tab.source.kind !== "untitled" &&
      tab.source.version === run.document.version,
  );
  if (!tab) return [];
  const source = tab.content.split(/\r?\n/);
  const streams =
    run.language === "csharp"
      ? ["buildStdout", "buildStderr"]
      : run.language === "typescript" || run.language === "java"
        ? ["buildStderr", "stderr"]
        : ["buildStderr"];
  const problems: Problem[] = [];
  const seen = new Set<string>();
  for (const stream of streams) {
    const lines = run.output
      .filter((chunk) => chunk.stream === stream)
      .map(({ text }) => text)
      .join("")
      .split(/\r?\n/);
    for (const [index] of lines.entries()) {
      const item = buildDiagnostic(run.language, lines, index);
      if (!item || !isStagedSource(item.path, tab.name, run.language)) continue;
      const line = item.row - 1;
      const rawColumn = item.column - 1;
      const text = source[line];
      let character = rawColumn;
      if (text !== undefined && rawColumn >= 0) {
        if (item.unit === "byte") character = utf16Column(text, rawColumn);
        else if (item.unit === "scalar")
          character = Array.from(text).slice(0, rawColumn).join("").length;
        else character = Math.min(rawColumn, text.length);
      }
      const start = position({ line, character });
      const key = JSON.stringify([
        line,
        character,
        item.severity,
        item.message,
      ]);
      if (!start || seen.has(key)) continue;
      seen.add(key);
      problems.push({
        id: `compiler:${tab.key}:${stream}:${index}`,
        tabKey: tab.key,
        filename: tab.title,
        source: "compiler",
        severity: item.severity,
        message: item.message.slice(0, 2000),
        start,
        end: start,
      });
      if (problems.length === 200) return problems;
    }
  }
  return problems;
}
