import { useState } from "react";
import type { Problem, Severity } from "./problems";
import type { LanguageController } from "./use-language";

const groups: { severity: Severity; title: string }[] = [
  { severity: "error", title: "Errors" },
  { severity: "warning", title: "Warnings" },
  { severity: "info", title: "Information" },
];

export function ProblemsPanel({
  language,
  problems,
  native,
  workspaceId,
  open,
}: {
  language: LanguageController;
  problems: Problem[];
  native: boolean;
  workspaceId?: string;
  open: (problem: Problem) => void;
}) {
  const [filter, setFilter] = useState<string>("all");
  const filtered = groups
    .filter(({ severity }) => filter === "all" || severity === filter)
    .map((group) => ({
      ...group,
      items: problems.filter(({ severity }) => severity === group.severity),
    }));
  const status =
    language.message ??
    (language.status === "starting"
      ? "Starting clangd…"
      : language.status === "ready"
        ? "clangd is ready for open C/C++ workspace files."
        : !native
          ? "Live diagnostics require the desktop app."
          : !workspaceId
            ? "Open a workspace folder to enable C/C++ language intelligence."
            : "C/C++ language intelligence is off.");
  return (
    <div className="problems-panel">
      <div className="problems-toolbar">
        <p role="status">{status}</p>
        {native && workspaceId && (
          <button
            type="button"
            disabled={language.status === "starting"}
            onClick={() =>
              language.status === "ready"
                ? language.stop()
                : void language.start()
            }
          >
            {language.status === "ready"
              ? "Stop clangd"
              : language.status === "failed"
                ? "Retry clangd"
                : "Enable clangd"}
          </button>
        )}
        <label>
          Severity{" "}
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">All</option>
            {groups.map(({ severity, title }) => (
              <option key={severity} value={severity}>
                {title}
              </option>
            ))}
          </select>
        </label>
      </div>
      {filtered.every(({ items }) => items.length === 0) && (
        <p>No problems to show.</p>
      )}
      <div
        onKeyDown={(event) => {
          if (!(event.target instanceof HTMLButtonElement)) return;
          const buttons = Array.from(
            event.currentTarget.querySelectorAll("button"),
          );
          const index = buttons.indexOf(event.target);
          const next =
            event.key === "ArrowDown"
              ? index + 1
              : event.key === "ArrowUp"
                ? index - 1
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : undefined;
          if (next === undefined) return;
          event.preventDefault();
          buttons[Math.max(0, Math.min(next, buttons.length - 1))]?.focus();
        }}
      >
        {filtered.map(
          ({ severity, title, items }) =>
            !!items.length && (
              <section key={severity} aria-label={title}>
                <h3>
                  {title} ({items.length})
                </h3>
                <ul>
                  {items.map((problem) => (
                    <li key={problem.id}>
                      <button type="button" onClick={() => open(problem)}>
                        <span>{problem.message}</span>{" "}
                        <small>
                          {problem.filename}:{problem.start.line + 1}:
                          {problem.start.character + 1} · {problem.source}
                        </small>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ),
        )}
      </div>
    </div>
  );
}
