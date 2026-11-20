import { isLargeDocument } from "../editor/performance-budget";
import type { LanguagePosition } from "@turing/contracts";
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

export function compilerProblems(
  run: ReturnType<typeof useExecution>["run"],
  tabs: EditorTab[],
): Problem[] {
  if (!run || run.language !== "cpp" || run.cancelled) return [];
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
  const lines = tab.content.split(/\r?\n/);
  return run.output
    .filter((chunk) => chunk.stream === "buildStderr")
    .flatMap((chunk) => chunk.text.split(/\r?\n/))
    .flatMap((line, index): Problem[] => {
      const match =
        /^(.+?):(\d+):(\d+): (fatal error|error|warning|note): (.+)$/.exec(
          line,
        );
      if (!match) return [];
      const path = match[1].replaceAll("\\", "/").split("/");
      if (path.at(-1) !== tab.name || !path.at(-2)?.startsWith("turing-run-"))
        return [];
      const row = Number(match[2]) - 1;
      const column = Number(match[3]) - 1;
      // A line outside the compiled text cannot be converted; keep the
      // reported column and let the editor clamp it when revealing.
      const text = lines[row];
      const start = position({
        line: row,
        character: text === undefined ? column : utf16Column(text, column),
      });
      if (!start) return [];
      return [
        {
          id: `compiler:${tab.key}:${index}`,
          tabKey: tab.key,
          filename: tab.title,
          source: "compiler",
          severity:
            match[4] === "warning"
              ? "warning"
              : match[4] === "note"
                ? "info"
                : "error",
          message: match[5].slice(0, 2000),
          start,
          end: start,
        },
      ];
    })
    .slice(0, 200);
}
