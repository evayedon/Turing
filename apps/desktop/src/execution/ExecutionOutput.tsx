import { useLayoutEffect, useRef } from "react";
import { languageLabels } from "./use-execution";
import type { useExecution } from "./use-execution";

const streamLabels = {
  stdout: "stdout",
  stderr: "stderr",
  buildStdout: "compiler stdout",
  buildStderr: "compiler stderr",
};

export function ExecutionOutput({
  execution,
  native,
}: {
  execution: ReturnType<typeof useExecution>;
  native: boolean;
}) {
  const { run, busy, stop } = execution;
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    if (follow.current && log.current)
      log.current.scrollTop = log.current.scrollHeight;
  }, [run?.output]);

  if (!run)
    return (
      <p className="panel-message">
        {native
          ? "Run a Python or C++ file to see its output. Use Terminal for interactive input."
          : "Task output is unavailable in browser preview."}
      </p>
    );

  const status =
    run.phase === "completed" && run.cancelled ? "Stopped" : run.phase;
  return (
    <div className="execution-output">
      <div className="execution-summary">
        <strong title={run.name}>{run.name}</strong>
        <span>{languageLabels[run.language]}</span>
        <span role="status">
          {status}
          {run.exitCode !== null ? ` · Exit code ${run.exitCode}` : ""}
        </span>
        <span>{(run.elapsedMs / 1000).toFixed(1)} s</span>
        {busy && (
          <button
            type="button"
            className="quiet-button"
            disabled={run.phase === "stopping"}
            onClick={() => void stop()}
          >
            Stop
          </button>
        )}
      </div>
      {run.error && (
        <p role="alert" className="editor-notice">
          {run.error}
        </p>
      )}
      {run.truncated && (
        <p className="panel-message">
          Output limit reached. Further output was discarded.
        </p>
      )}
      <div
        ref={log}
        tabIndex={0}
        aria-label="Program output"
        role="region"
        className="execution-log"
        onScroll={({ currentTarget }) => {
          follow.current =
            currentTarget.scrollHeight -
              currentTarget.scrollTop -
              currentTarget.clientHeight <
            12;
        }}
      >
        {run.output.map(({ stream, text }, index) => (
          <div className={`execution-chunk ${stream}`} key={index}>
            <span>{streamLabels[stream]}</span>
            <pre>{text}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}
