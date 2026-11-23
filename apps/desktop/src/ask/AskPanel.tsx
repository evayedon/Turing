import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { AskError, AskEvent, AskSource } from "@turing/contracts";
import { cancelAsk, localAskModel, runAsk } from "./ask-ipc";
import "./ask-panel.css";

type Completed = Extract<AskEvent, { kind: "completed" }>;

const messages = {
  WORKSPACE_DENIED: "This workspace is no longer available to Ask.",
  INVALID_QUESTION: "Enter a question up to 2,048 UTF-8 bytes.",
  BUSY: "An earlier request is finishing. Try again in a moment.",
  MODEL_UNAVAILABLE: "Start llama-server on 127.0.0.1:8080 and try again.",
  INDEX_UNAVAILABLE: "Ask could not read this workspace. Try again.",
  INFERENCE_FAILED: "The local model could not finish the answer. Try again.",
} satisfies Record<AskError, string>;

function askErrorMessage(error: unknown) {
  return typeof error === "string" && Object.hasOwn(messages, error)
    ? messages[error as AskError]
    : messages.INFERENCE_FAILED;
}

export function AskPanel({
  workspaceId,
  openSource,
}: {
  workspaceId: string;
  openSource: (source: AskSource) => Promise<boolean | undefined>;
}) {
  const questionField = useId();
  const modelField = useId();
  const active = useRef<string>(undefined);
  const [question, setQuestion] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<Completed>();
  const [phase, setPhase] = useState<
    "idle" | "running" | "stopping" | "completed" | "cancelled" | "failed"
  >("idle");
  const [error, setError] = useState("");
  const [sourceNotice, setSourceNotice] = useState<{
    result: Completed;
    message: string;
  }>();
  const busy = phase === "running" || phase === "stopping";
  const trimmedQuestion = question.trim();

  useEffect(() => {
    return () => {
      const id = active.current;
      active.current = undefined;
      if (id) void cancelAsk(id).catch(() => {});
    };
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmedQuestion || active.current) return;
    if (new TextEncoder().encode(trimmedQuestion).length > 2048) {
      setError(messages.INVALID_QUESTION);
      return;
    }

    const modelId = new FormData(event.currentTarget).get("model");
    if (typeof modelId !== "string") return;

    const id = crypto.randomUUID();
    active.current = id;
    setSubmitted(trimmedQuestion);
    setQuestion("");
    setAnswer("");
    setResult(undefined);
    setError("");
    setSourceNotice(undefined);
    setPhase("running");

    void runAsk(
      id,
      { workspaceId, modelId, question: trimmedQuestion },
      (message) => {
        if (active.current !== id) return;
        if (message.kind === "delta") {
          setAnswer((previous) => previous + message.text);
          return;
        }
        active.current = undefined;
        if (message.kind === "completed") setResult(message);
        setPhase(message.kind);
      },
    ).catch((cause: unknown) => {
      if (active.current !== id) return;
      active.current = undefined;
      setPhase("failed");
      setError(askErrorMessage(cause));
    });
  }

  function stop() {
    const id = active.current;
    if (!id || phase === "stopping") return;
    setPhase("stopping");
    void cancelAsk(id).catch(() => {
      if (active.current !== id) return;
      setPhase("running");
      setError("Could not stop the response. Try again.");
    });
  }

  const status = {
    idle: "",
    running: "Generating locally…",
    stopping: "Stopping…",
    completed: "Answer ready.",
    cancelled: "Response stopped.",
    failed: "",
  }[phase];

  return (
    <div className="ask-panel">
      <form className="ask-form" onSubmit={submit}>
        <div className="ask-model">
          <label htmlFor={modelField}>Model</label>
          <select
            id={modelField}
            name="model"
            disabled={busy}
            defaultValue={localAskModel.id}
          >
            <option value={localAskModel.id}>
              {localAskModel.label} (local)
            </option>
          </select>
        </div>
        <label htmlFor={questionField}>Ask about this workspace</label>
        <textarea
          id={questionField}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Where is workspace access checked?"
          rows={3}
        />
        <div className="ask-actions">
          <button type="submit" disabled={busy || !trimmedQuestion}>
            Ask
          </button>
          <button type="button" onClick={stop} disabled={phase !== "running"}>
            Stop
          </button>
        </div>
      </form>

      <div className="ask-feedback" role="status">
        {status}
      </div>
      {error && (
        <p className="ask-error" role="alert">
          {error}
        </p>
      )}
      {submitted && (
        <section className="ask-response" aria-label="Latest answer">
          <h3>{submitted}</h3>
          {answer && <p className="ask-answer">{answer}</p>}
        </section>
      )}
      {result && (
        <section className="ask-sources" aria-label="Workspace sources">
          <h3>Workspace sources</h3>
          {result.indexCoverage === "partial" && (
            <p>Only part of the workspace was scanned.</p>
          )}
          {result.indexFreshness === "stale" && (
            <p>Some source files changed during this answer.</p>
          )}
          {result.sources.length === 0 && (
            <p>No matching workspace passages.</p>
          )}
          <ol>
            {result.sources.map((source) => (
              <li key={`${source.relativePath}:${source.startLine}`}>
                <button
                  type="button"
                  onClick={async () => {
                    const opened = await openSource(source);
                    setSourceNotice({
                      result,
                      message: opened
                        ? ""
                        : opened === false
                          ? "The editor or saved file differs from the cited version."
                          : "Could not open this source. Try again.",
                    });
                  }}
                >
                  {source.relativePath}:{source.startLine}–{source.endLine}
                </button>
              </li>
            ))}
          </ol>
          <div role="status">
            {sourceNotice?.result === result ? sourceNotice.message : ""}
          </div>
        </section>
      )}
    </div>
  );
}
