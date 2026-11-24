import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { AskEvent, AskLocalStatus, AskSource } from "@turing/contracts";
import {
  ArrowUp,
  Cloud,
  FileCode2,
  HardDrive,
  Sparkles,
  Route,
  Square,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import {
  autoAskModel,
  cancelAsk,
  cloudAskModel,
  localAskModel,
  localAskStatus,
  runAsk,
} from "./ask-ipc";
import { AskLocalServer, AskProjectPreferences } from "./AskPreferences";
import {
  loadLocalServer,
  loadProjectAsk,
  mergeTurns,
  saveLocalServer,
  updateProjectAsk,
} from "./ask-history";
import type {
  AskFeedback,
  AskPreferences,
  LocalServer,
  SavedTurn,
} from "./ask-history";
import { AskIndex } from "./AskIndex";
import { AskMarkdown } from "./AskMarkdown";
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
  feedback?: AskFeedback;
  route?: "local" | "cloud";
  sharing?: AskSource[];
};

const SUGGESTIONS = [
  "How is this project structured?",
  "Where are errors handled?",
  "What does the main entry point do?",
];

export function AskPanel({
  workspaceId,
  workspacePath,
  visible = true,
  openSource,
  attachment,
  clearAttachment,
  focusRequest = 0,
}: {
  workspaceId: string;
  workspacePath?: string;
  visible?: boolean;
  openSource: (source: AskSource) => Promise<boolean | undefined>;
  /** Saved editor lines sent as a reference; the native host reads the text. */
  attachment?: AskSource;
  clearAttachment?: () => void;
  /** Focuses the composer whenever it changes. */
  focusRequest?: number;
}) {
  const questionField = useId();
  const modelField = useId();
  const active = useRef<string>(undefined);
  const thread = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [project] = useState(() => loadProjectAsk(workspacePath));
  const [preferences, setPreferences] = useState(project.preferences);
  const [retain, setRetain] = useState(project.retain);
  const [modelId, setModelId] = useState(project.preferences.modelId);
  const [localServer, setLocalServer] = useState(loadLocalServer);
  const localUrl = `http://${localServer.address}`;
  const auto = modelId === autoAskModel.id;
  const cloud = modelId === cloudAskModel.id;
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>(() =>
    project.turns.map((turn) => ({ ...turn, phase: "completed" })),
  );
  const [notice, setNotice] = useState("");
  const [localStatus, setLocalStatus] = useState<AskLocalStatus>();
  const [keySaved, setKeySaved] = useState<boolean>();
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

  function probeLocal() {
    void localAskStatus(localUrl).then(setLocalStatus, () =>
      setLocalStatus(undefined),
    );
  }

  useEffect(() => {
    if (focusRequest) composer.current?.focus();
  }, [focusRequest]);

  useEffect(() => {
    if (!visible) return;
    // Ignore a probe that finishes after the address changed.
    let current = true;
    void localAskStatus(localUrl).then(
      (status) => {
        if (current) setLocalStatus(status);
      },
      () => {
        if (current) setLocalStatus(undefined);
      },
    );
    return () => {
      current = false;
    };
  }, [visible, localUrl]);

  // Follow streaming text only while the reader is at the bottom of the thread.
  useEffect(() => {
    const element = thread.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [latest?.answer, latest?.phase, turns.length]);

  function update(id: string, change: (turn: Turn) => Partial<Turn>) {
    setTurns((previous) =>
      previous.map((turn) =>
        turn.id === id ? { ...turn, ...change(turn) } : turn,
      ),
    );
  }

  function persist(change: Parameters<typeof updateProjectAsk>[1]) {
    if (!workspacePath) return false;
    try {
      updateProjectAsk(workspacePath, change);
      return true;
    } catch {
      setNotice("Could not update local Ask storage.");
      return false;
    }
  }

  function remember(next: boolean) {
    const completed = turns.flatMap((turn): SavedTurn[] =>
      turn.result
        ? [
            {
              id: turn.id,
              question: turn.question,
              answer: turn.answer,
              result: turn.result,
              feedback: turn.feedback,
            },
          ]
        : [],
    );
    if (
      persist((current) => ({
        ...current,
        retain: next,
        turns: next ? mergeTurns(current.turns, completed) : [],
      }))
    ) {
      setRetain(next);
      setNotice(
        next
          ? "Conversation retention enabled for this folder."
          : "Saved conversation removed.",
      );
    }
  }

  function savePreferences(next: AskPreferences) {
    if (persist((current) => ({ ...current, preferences: next }))) {
      setPreferences(next);
      setNotice("Conventions saved.");
    }
  }

  function chooseModel(next: string) {
    setModelId(next);
    persist((current) => ({
      ...current,
      preferences: { ...current.preferences, modelId: next },
    }));
  }

  function saveLocal(next: LocalServer) {
    try {
      saveLocalServer(next);
    } catch {
      setNotice("Could not update local Ask storage.");
      return;
    }
    setLocalServer(next);
  }

  function vote(turn: Turn, feedback: AskFeedback) {
    update(turn.id, () => ({ feedback }));
    if (retain)
      persist((current) => ({
        ...current,
        turns: current.turns.map((entry) =>
          entry.id === turn.id ? { ...entry, feedback } : entry,
        ),
      }));
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
    clearAttachment?.();
    following.current = true;
    setTurns((previous) => [
      ...previous,
      {
        id,
        question: trimmedQuestion,
        answer: "",
        phase: "running",
        ...(auto ? {} : { route: cloud ? "cloud" : "local" }),
      },
    ]);

    let answer = "";
    void runAsk(
      id,
      {
        workspaceId,
        modelId,
        question: trimmedQuestion,
        localServer: localUrl,
        ...(localServer.model ? { localModel: localServer.model } : {}),
        ...(preferences.conventions
          ? { conventions: preferences.conventions }
          : {}),
        ...(attachment ? { selection: attachment } : {}),
      },
      (message) => {
        if (active.current !== id) return;
        if (message.kind === "delta") {
          answer += message.text;
          const streamed = answer;
          update(id, () => ({ answer: streamed }));
          return;
        }
        if (message.kind === "routed") {
          update(id, () => ({ route: message.location }));
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
            sharing:
              message.kind === "awaitingCloudApproval"
                ? message.sources
                : undefined,
          }));
          return;
        }
        active.current = undefined;
        if (message.kind === "completed" && retain) {
          persist((current) =>
            current.retain
              ? {
                  ...current,
                  turns: mergeTurns(current.turns, [
                    { id, question: trimmedQuestion, answer, result: message },
                  ]),
                }
              : current,
          );
        }
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
      if (cause === "MODEL_UNAVAILABLE") probeLocal();
      update(id, () => ({
        phase: "failed",
        error: askErrorMessage(cause, localServer.address),
      }));
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
        running:
          latest.route === "cloud"
            ? "Preparing or generating cloud answer…"
            : latest.route === "local"
              ? "Generating locally…"
              : "Choosing a model…",
        approval: "Review the request in the sharing dialog.",
        stopping: "Stopping…",
        completed: "Answer ready.",
        cancelled: "Response stopped.",
        failed: "",
      }[latest.phase]
    : "";
  const localDown = localStatus === "offline" || localStatus === "loading";
  const availability = cloud
    ? keySaved === false
      ? "Save an OpenRouter API key to use this model."
      : ""
    : auto
      ? !localDown
        ? ""
        : keySaved === false
          ? `No local server is ready on ${localServer.address} and no OpenRouter key is saved.`
          : `No local server is ready on ${localServer.address}, so Auto will ask before using the cloud.`
      : localStatus === "offline"
        ? `No local server is running on ${localServer.address}.`
        : localStatus === "loading"
          ? `The local server on ${localServer.address} is still loading its model.`
          : "";
  const localState =
    localStatus === "offline" || localStatus === "loading"
      ? ` · ${localStatus}`
      : "";

  return (
    <div className="ask-panel">
      <div
        className="ask-thread"
        ref={thread}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            48;
        }}
      >
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
                vote={(feedback) => vote(turn, feedback)}
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
        {(cloud || (auto && localDown)) && (
          <CloudCredential disabled={busy} onStatus={setKeySaved} />
        )}
        {!cloud && (
          <AskLocalServer
            server={localServer}
            disabled={busy}
            save={saveLocal}
          />
        )}
        <AskIndex workspaceId={workspaceId} visible={visible} />
        {workspacePath && (
          <AskProjectPreferences
            modelId={modelId}
            preferences={preferences}
            retain={retain}
            disabled={busy}
            save={savePreferences}
            setRetention={remember}
            clear={() => {
              if (persist((current) => ({ ...current, turns: [] }))) {
                setTurns([]);
                setNotice("Conversation cleared.");
              }
            }}
          />
        )}
        <div className="ask-status" role="status">
          {notice || status || availability}
        </div>
        <form className="ask-composer" onSubmit={submit}>
          {attachment && (
            <AttachmentChip
              source={attachment}
              remove={() => {
                clearAttachment?.();
                composer.current?.focus();
              }}
            />
          )}
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
              data-location={auto ? "auto" : cloud ? "cloud" : "local"}
              data-unavailable={
                availability && !(auto && keySaved !== false) ? "" : undefined
              }
            >
              {auto ? (
                <Route size={14} aria-hidden="true" />
              ) : cloud ? (
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
                onChange={(event) => chooseModel(event.target.value)}
                onFocus={probeLocal}
              >
                <option value={autoAskModel.id}>{autoAskModel.label}</option>
                <option value={localAskModel.id}>
                  {localAskModel.label} (local{localState})
                </option>
                <option value={cloudAskModel.id}>
                  {cloudAskModel.label} (cloud
                  {keySaved === false ? " · key needed" : ""})
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
  vote,
  openSource,
}: {
  turn: Turn;
  latest: boolean;
  vote: (feedback: AskFeedback) => void;
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
          {turn.phase === "approval" && turn.sharing && (
            <section className="ask-sources" aria-label="Lines to share">
              <p>
                {turn.sharing.length === 0
                  ? "Only your question will be shared."
                  : `Approve in the dialog to share these ${turn.sharing.length} workspace excerpts:`}
              </p>
              {turn.sharing.length > 0 && (
                <SourceChips sources={turn.sharing} open={openSource} />
              )}
            </section>
          )}
          {turn.answer && (
            <AskMarkdown
              text={turn.answer}
              sources={result?.sources}
              open={(source) => void openSource(source)}
            />
          )}
          {turn.error && (
            <p className="ask-error" role={latest ? "alert" : undefined}>
              {turn.error}
            </p>
          )}
          {result && (
            <section className="ask-sources" aria-label="Workspace sources">
              {result.sources.length > 0 && (
                <SourceChips sources={result.sources} open={openSource} />
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
              {turn.route && (
                <p className="ask-route">
                  Answered by{" "}
                  {turn.route === "cloud"
                    ? `${cloudAskModel.label} (cloud)`
                    : `${localAskModel.label} (local)`}
                </p>
              )}
              {result.usage && (
                <p className="ask-usage">
                  {result.usage.inputTokens} input tokens ·{" "}
                  {result.usage.outputTokens} output tokens
                </p>
              )}
              <div className="ask-actions" aria-label="Answer feedback">
                <button
                  type="button"
                  aria-label="Helpful"
                  aria-pressed={turn.feedback === "helpful"}
                  onClick={() => vote("helpful")}
                >
                  <ThumbsUp size={12} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="Unhelpful"
                  aria-pressed={turn.feedback === "unhelpful"}
                  onClick={() => vote("unhelpful")}
                >
                  <ThumbsDown size={12} aria-hidden="true" />
                </button>
              </div>
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

function AttachmentChip({
  source,
  remove,
}: {
  source: AskSource;
  remove: () => void;
}) {
  const label = `${source.relativePath}:${source.startLine}–${source.endLine}`;
  return (
    <div
      className="ask-attachment"
      role="group"
      aria-label="Attached selection"
    >
      <FileCode2 size={12} aria-hidden="true" />
      <span title={label}>{label}</span>
      <button
        type="button"
        aria-label={`Remove selection ${label}`}
        title="Remove selection"
        onClick={remove}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

function SourceChips({
  sources,
  open,
}: {
  sources: AskSource[];
  open: (source: AskSource) => Promise<void>;
}) {
  return (
    <ul>
      {sources.map((source) => {
        const label = `${source.relativePath}:${source.startLine}–${source.endLine}`;
        return (
          <li key={`${source.relativePath}:${source.startLine}`}>
            <button
              type="button"
              title={label}
              onClick={() => void open(source)}
            >
              <FileCode2 size={12} aria-hidden="true" />
              <span>{label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
