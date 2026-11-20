import type { LanguageController } from "./use-language";
import { problemGroups, type Problem } from "./problems";

export function ProblemsPanel({
  problems,
  filter,
  open,
  servers,
}: {
  problems: Problem[];
  filter: string;
  open: (problem: Problem) => void;
  servers?: LanguageController["servers"];
}) {
  const filtered = problemGroups
    .filter(({ severity }) => filter === "all" || severity === filter)
    .map((group) => ({
      ...group,
      items: problems.filter(({ severity }) => severity === group.severity),
    }));
  return (
    <div className="problems-panel">
      {servers && (
        <div role="group" aria-label="Language servers">
          {Object.entries(servers).map(([kind, server]) => (
            <div key={kind}>
              <span>
                {kind} · {server.status === "idle" ? "Off" : server.status}
              </span>{" "}
              <button
                type="button"
                className="quiet-button"
                disabled={server.status === "starting"}
                onClick={() =>
                  server.status === "ready"
                    ? server.stop()
                    : void server.start()
                }
              >
                {server.status === "ready"
                  ? "Stop"
                  : server.status === "failed" ||
                      server.status === "unavailable"
                    ? "Retry"
                    : "Enable"}{" "}
                {kind}
              </button>
              {kind === "rust-analyzer" && (
                <label>
                  <input
                    type="checkbox"
                    checked={server.rustBuildScripts}
                    disabled={
                      server.status === "starting" || server.status === "ready"
                    }
                    onChange={(event) =>
                      server.setRustBuildScripts(event.target.checked)
                    }
                  />
                  Allow Cargo build scripts and procedural macros
                </label>
              )}
              {server.message && <small role="status">{server.message}</small>}
            </div>
          ))}
        </div>
      )}
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
                          {problem.start.character + 1} ·{" "}
                          {problem.source === "monaco"
                            ? "Monaco"
                            : problem.source}
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
