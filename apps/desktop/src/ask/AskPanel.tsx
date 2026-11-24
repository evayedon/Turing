import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { AskEvent, AskSource } from "@turing/contracts";
import {
  ArrowUp,
  Cloud,
  FileCode2,
  HardDrive,
  Sparkles,
  Square,
} from "lucide-react";
import { cancelAsk, cloudAskModel, localAskModel, runAsk } from "./ask-ipc";
import { AskIndex } from "./AskIndex";
import { CloudCredential } from "./CloudCredential";
import { askErrorMessage } from "./ask-errors";
import "./ask-panel.css";

type Completed = Extract<AskEvent, { kind: "completed" }>;
type Phase =
  "running" | "approval" | "stopping" | "completed" | "cancelled" | "failed";
type Turn = {
  id: string;
  question: string;
  answer: string;
  phase: Phase;
  error?: string;
  result?: Completed;
  notice?: string;
};

const SUGGESTIONS = [
  "How is this project structured?",
  "Where are errors handled?",
  "What does the main entry point do?",
];

export function AskPanel({
  workspaceId,
  visible = true,
  openSource,
}: {
  workspaceId: string;
  visible?: boolean;
  openSource: (source: AskSource) => Promise<boolean | undefined>;
}) {
  const questionField = useId();
  const modelField = useId();
  const active = useRef<string>(undefined);
  const thread = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [modelId, setModelId] = useState(localAskModel.id);
  const cloud = modelId === cloudAskModel.id;
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [notice, setNotice] = useState("");
  const latest = turns.at(-1);
  const busy =
    latest?.phase === "running" ||
    latest?.phase === "approval" ||
    latest?.phase === "stopping";
  const trimmedQuestion = question.trim();

  useEffect(() => {
    return () => {
      const id = active.current;
      active.current = undefined;
      if (id) void cancelAsk(id).catch(() => {});
    };
  }, []);

  // shortcut: always follows the newest text, even if the reader scrolled up; add a "pinned to bottom" check if that annoys.
  useEffect(() => {
    const element = thread.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [latest?.answer, latest?.phase, turns.length]);

  function update(id: string, change: (turn: Turn) => Partial<Turn>) {
    setTurns((previous) =>
      previous.map((turn) =>
        turn.id === id ? { ...turn, ...change(turn) } : turn,
      ),
    );
  }

  function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!trimmedQuestion || active.current) return;
    if (new TextEncoder().encode(trimmedQuestion).length > 2048) {
      setNotice(askErrorMessage("INVALID_QUESTION"));
      return;
    }

    const id = crypto.randomUUID();
    active.current = id;
    setQuestion("");
    setNotice("");
    setTurns((previous) => [
      ...previous,
      { id, question: trimmedQuestion, answer: "", phase: "running" },
    ]);

    void runAsk(
      id,
      { workspaceId, modelId, question: trimmedQuestion },
      (message) => {
        if (active.current !== id) return;
        if (message.kind === "delta") {
          update(id, (turn) => ({ answer: turn.answer + message.text }));
          return;
        }
        if (
          message.kind === "awaitingCloudApproval" ||
          message.kind === "cloudApproved"
        ) {
          update(id, (turn) => ({
            phase:
              turn.phase === "stopping"
                ? turn.phase
                : message.kind === "awaitingCloudApproval"
                  ? "approval"
                  : "running",
          }));
          return;
        }
        active.current = undefined;
        update(id, () =>
          message.kind === "completed"
            ? { phase: "completed", result: message }
            : { phase: message.kind },
        );
      },
    ).catch((cause: unknown) => {
      if (active.current !== id) return;
      active.current = undefined;
      if (cause === "CLOUD_CONSENT_DECLINED") {
        setQuestion((current) => current || trimmedQuestion);
        setTurns((previous) => previous.filter((turn) => turn.id !== id));
        setNotice(askErrorMessage("CLOUD_CONSENT_DECLINED"));
        return;
      }
      if (
        cause === "CLOUD_KEY_REQUIRED" ||
        cause === "CLOUD_QUESTION_TOO_LONG"
      ) {
        setQuestion((current) => current || trimmedQuestion);
      }
      update(id, () => ({ phase: "failed", error: askErrorMessage(cause) }));
    });
  }

  function stop() {
    const id = active.current;
    if (!id || latest?.phase === "stopping") return;
    update(id, () => ({ phase: "stopping" }));
    void cancelAsk(id).catch(() => {
      if (active.current !== id) return;
      update(id, () => ({
        phase: "running",
        error: "Could not stop the response. Try again.",
      }));
    });
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  }

  const status = latest
    ? {
        running: cloud
          ? "Preparing or generating cloud answer…"
          : "Generating locally…",
        approval: "Review the request in the sharing dialog.",
        stopping: "Stopping…",
        completed: "Answer ready.",
        cancelled: "Response stopped.",
        failed: "",
      }[latest.phase]
    : "";

  return (
    <div className="ask-panel">
      <div className="ask-thread" ref={thread}>
        {turns.length === 0 ? (
          <div className="ask-empty">
            <span className="ask-empty-mark" aria-hidden="true">
              <Sparkles size={18} />
            </span>
            <h3>Ask about your code</h3>
            <p>
              Answers cite the workspace files they draw from. Turing AI reads
              files; it never edits them.
            </p>
            <ul aria-label="Suggested questions">
              {SUGGESTIONS.map((suggestion) => (
                <li key={suggestion}>
                  <button
                    type="button"
                    onClick={() => {
                      setQuestion(suggestion);
                      composer.current?.focus();
                    }}
                  >
                    {suggestion}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ol className="ask-turns" aria-label="Conversation">
            {turns.map((turn) => (
              <TurnView
                key={turn.id}
                turn={turn}
                latest={turn === latest}
                openSource={async (source) => {
                  const opened = await openSource(source);
                  update(turn.id, () => ({
                    notice: opened
                      ? ""
                      : opened === false
                        ? "The editor or saved file differs from the cited version."
                        : "Could not open this source. Try again.",
                  }));
                }}
              />
            ))}
          </ol>
        )}
      </div>

      <div className="ask-dock">
        {cloud && <CloudCredential disabled={busy} />}
        <AskIndex workspaceId={workspaceId} visible={visible} />
        <div className="ask-status" role="status">
          {notice || status}
        </div>
        <form className="ask-composer" onSubmit={submit}>
          <label htmlFor={questionField} className="visually-hidden">
            Ask about this workspace
          </label>
          <textarea
            id={questionField}
            ref={composer}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={keyDown}
            placeholder="Ask about this workspace…"
            rows={2}
          />
          <div className="ask-composer-bar">
            <div
              className="ask-model"
              data-location={cloud ? "cloud" : "local"}
            >
              {cloud ? (
                <Cloud size={14} aria-hidden="true" />
              ) : (
                <HardDrive size={14} aria-hidden="true" />
              )}
              <label htmlFor={modelField} className="visually-hidden">
                Model
              </label>
              <select
                id={modelField}
                name="model"
                disabled={busy}
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
              >
                <option value={localAskModel.id}>
                  {localAskModel.label} (local)
                </option>
                <option value={cloudAskModel.id}>
                  {cloudAskModel.label} (cloud)
                </option>
              </select>
            </div>
            {busy ? (
              <button
                type="button"
                className="ask-send"
                aria-label="Stop"
                title="Stop"
                onClick={stop}
                disabled={latest?.phase !== "running"}
              >
                <Square size={12} fill="currentColor" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="submit"
                className="ask-send"
                aria-label="Ask"
                title="Ask (Enter)"
                disabled={!trimmedQuestion}
              >
                <ArrowUp size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function TurnView({
  turn,
  latest,
  openSource,
}: {
  turn: Turn;
  latest: boolean;
  openSource: (source: AskSource) => Promise<void>;
}) {
  const { result } = turn;
  const pending =
    !turn.answer && (turn.phase === "running" || turn.phase === "approval");
  return (
    <li className="ask-turn">
      <p className="ask-question">{turn.question}</p>
      <div className="ask-reply">
        <span className="ask-reply-mark" aria-hidden="true">
          <Sparkles size={12} />
        </span>
        <div className="ask-reply-body">
          {pending && <span className="ask-typing" aria-hidden="true" />}
          {turn.answer && <Answer text={turn.answer} />}
          {turn.error && (
            <p className="ask-error" role={latest ? "alert" : undefined}>
              {turn.error}
            </p>
          )}
          {result && (
            <section className="ask-sources" aria-label="Workspace sources">
              {result.sources.length > 0 && (
                <ul>
                  {result.sources.map((source) => {
                    const label = `${source.relativePath}:${source.startLine}–${source.endLine}`;
                    return (
                      <li key={`${source.relativePath}:${source.startLine}`}>
                        <button
                          type="button"
                          title={label}
                          onClick={() => void openSource(source)}
                        >
                          <FileCode2 size={12} aria-hidden="true" />
                          <span>{label}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {result.sources.length === 0 && (
                <p>No matching workspace passages.</p>
              )}
              {result.indexCoverage === "partial" && (
                <p>Workspace context was limited.</p>
              )}
              {result.indexFreshness === "stale" && (
                <p>Some source files changed during this answer.</p>
              )}
              {result.usage && (
                <p className="ask-usage">
                  {result.usage.inputTokens} input tokens ·{" "}
                  {result.usage.outputTokens} output tokens
                </p>
              )}
              <div role="status" className="ask-source-notice">
                {turn.notice}
              </div>
            </section>
          )}
        </div>
      </div>
    </li>
  );
}

// shortcut: only ``` fences become code blocks; inline markdown stays literal. Swap in a markdown renderer if answers need more.
function Answer({ text }: { text: string }) {
  return (
    <div className="ask-answer">
      {text.split("```").map((part, index) =>
        index % 2 === 0 ? (
          part.trim() && <p key={index}>{part.trim()}</p>
        ) : (
          <pre key={index}>
            <code>{part.replace(/^[\w+-]*\n/, "")}</code>
          </pre>
        ),
      )}
    </div>
  );
}
