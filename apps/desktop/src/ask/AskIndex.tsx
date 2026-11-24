import { useEffect, useState } from "react";
import type { AskIndexAction, AskIndexStatus } from "@turing/contracts";
import { manageAskIndex } from "./ask-ipc";
import { askErrorMessage } from "./ask-errors";

export function AskIndex({
  workspaceId,
  visible,
}: {
  workspaceId: string;
  visible: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AskIndexStatus>();
  const [operation, setOperation] = useState<AskIndexAction>();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible || !open || operation) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function update() {
      try {
        const next = await manageAskIndex(workspaceId, "status");
        if (active) setStatus(next);
      } catch (cause) {
        if (active) setError(askErrorMessage(cause));
      }
      if (active) timer = setTimeout(() => void update(), 1000);
    }
    void update();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [open, operation, visible, workspaceId]);

  async function run(action: AskIndexAction) {
    setOperation(action);
    setError("");
    try {
      setStatus(await manageAskIndex(workspaceId, action));
    } catch (cause) {
      setError(askErrorMessage(cause));
    } finally {
      setOperation(undefined);
    }
  }

  const phase = status?.phase;
  const inactive = phase === "paused" || phase === "disabled";
  const labels = {
    indexing: "Indexing",
    ready: "Ready",
    paused: "Paused",
    disabled: "Disabled",
    unavailable: "File watching unavailable",
  };

  return (
    <details
      className="ask-credentials"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Workspace index</summary>
      {open && (
        <>
          <p role="status">
            {status
              ? `${labels[status.phase]} · ${status.files} files`
              : "Checking index…"}
            {status?.partial && " · Limited coverage"}
          </p>
          {error && (
            <p role="alert" className="ask-error">
              {error}
            </p>
          )}
          <div className="ask-actions">
            <button
              type="button"
              disabled={!phase || !!operation || phase === "unavailable"}
              onClick={() => void run(inactive ? "resume" : "pause")}
            >
              {phase === "disabled" ? "Enable" : inactive ? "Resume" : "Pause"}
            </button>
            <button
              type="button"
              disabled={!phase || !!operation || phase === "unavailable"}
              onClick={() => void run("rebuild")}
            >
              Rebuild
            </button>
            <button
              type="button"
              disabled={
                !phase ||
                !!operation ||
                phase === "disabled" ||
                phase === "unavailable"
              }
              onClick={() => void run("disable")}
            >
              Disable
            </button>
          </div>
        </>
      )}
    </details>
  );
}
