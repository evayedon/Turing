import { problemGroups, type Problem } from "./problems";

export function ProblemsPanel({
  problems,
  filter,
  open,
}: {
  problems: Problem[];
  filter: string;
  open: (problem: Problem) => void;
}) {
  const filtered = problemGroups
    .filter(({ severity }) => filter === "all" || severity === filter)
    .map((group) => ({
      ...group,
      items: problems.filter(({ severity }) => severity === group.severity),
    }));
  return (
    <div className="problems-panel">
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
