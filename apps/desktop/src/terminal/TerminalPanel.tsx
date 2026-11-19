import type { Ref } from "react";
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { TerminalProfile, TerminalSize } from "@turing/contracts";
import { invokeTerminal, terminalErrorMessage } from "./terminal-ipc";
import type { createTerminalView } from "./terminal-view";

let terminalViewModule: Promise<typeof import("./terminal-view")> | undefined;

function loadTerminalView() {
  terminalViewModule ??= import("./terminal-view").catch((error: unknown) => {
    terminalViewModule = undefined;
    throw error;
  });
  return terminalViewModule;
}

type View = ReturnType<typeof createTerminalView>;
type Session = {
  id?: string;
  focusFrom: Element | null;
  view?: View;
  attempt?: string;
  deadline?: ReturnType<typeof setTimeout>;
  poll?: ReturnType<typeof setTimeout>;
  observer?: ResizeObserver;
  pending: Uint8Array[];
  pendingBytes: number;
  writing: boolean;
  dimensions?: TerminalSize;
  sent?: TerminalSize;
  resizing: boolean;
};
type Status =
  | { phase: "idle" | "starting" | "closing" }
  | { phase: "running"; workspaceDirectory: boolean }
  | { phase: "exited"; exitCode: number | null };

export const terminalStartupDeadline = 12000;

function cancelStarting(session: Session) {
  if (session.attempt && !session.id)
    void invokeTerminal("terminal_cancel_start", {
      attempt: session.attempt,
    }).catch(() => {});
}

const inputChunk = 8192;
const inputLimit = 128 * 1024;

function canMoveFocus(host: HTMLElement, from: Element | null) {
  const { activeElement, body } = host.ownerDocument;
  return (
    !host.closest("[hidden]") &&
    (activeElement === from || (activeElement === body && !from?.isConnected))
  );
}

async function closeNative(id: string) {
  try {
    await invokeTerminal("terminal_close", { id });
  } catch (error) {
    if (error !== "SESSION_CLOSED") throw error;
  }
}

function stopWatching(session: Session) {
  clearTimeout(session.poll);
  clearTimeout(session.deadline);
  session.observer?.disconnect();
  session.view?.disableInput();
  session.pending = [];
  session.pendingBytes = 0;
}

export type TerminalActions = { close: () => void; clear: () => void };

export function TerminalPanel({
  native,
  workspaceId,
  activation = 0,
  focusOnStart = true,
  actionsRef,
  onRunningChange,
  profile = "system",
  onShell,
}: {
  native: boolean;
  workspaceId?: string;
  profile?: TerminalProfile;
  onShell?: (shell: string) => void;
  activation?: number;
  focusOnStart?: boolean;
  actionsRef?: Ref<TerminalActions>;
  onRunningChange?: (running: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef<Session | null>(null);
  const lastView = useRef<View | undefined>(undefined);
  const startButton = useRef<HTMLButtonElement>(null);
  const handledActivation = useRef(0);
  const restoreFocus = useRef<Element | null | undefined>(undefined);
  const [status, setStatus] = useState<Status>({ phase: "idle" });
  const [error, setError] = useState("");
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [noMatch, setNoMatch] = useState(false);

  const activateTerminal = useEffectEvent(() => {
    if (!host.current || host.current.closest("[hidden]")) return;
    const session = current.current;
    if (session?.id) {
      session.view?.focus();
    } else if (session) {
      session.focusFrom = host.current.ownerDocument.activeElement;
    } else {
      void start();
    }
  });

  useEffect(() => {
    if (
      activation === 0 ||
      handledActivation.current === activation ||
      status.phase === "closing"
    )
      return;
    handledActivation.current = activation;
    activateTerminal();
  }, [activation, status.phase]);

  useEffect(
    () => () => {
      const session = current.current;
      current.current = null;
      if (session) {
        stopWatching(session);
        cancelStarting(session);
        if (session.id) void closeNative(session.id).catch(() => {});
      }
      lastView.current?.dispose();
      lastView.current = undefined;
    },
    [],
  );

  useEffect(() => {
    if (
      (status.phase === "idle" || status.phase === "exited") &&
      restoreFocus.current !== undefined
    ) {
      const from = restoreFocus.current;
      restoreFocus.current = undefined;
      if (host.current && canMoveFocus(host.current, from))
        startButton.current?.focus();
    }
  }, [status.phase]);

  async function end(
    session: Session,
    message = "",
    exitCode: number | null = null,
    finished = false,
  ) {
    if (current.current !== session) return;
    current.current = null;
    stopWatching(session);
    setStatus({ phase: "closing" });
    let failure = message;
    if (session.id && !finished) {
      try {
        await closeNative(session.id);
      } catch (cause) {
        failure ||= terminalErrorMessage(cause);
      }
    }
    setError(failure);
    setStatus({ phase: "exited", exitCode });
  }

  function closeSession(from: Element | null) {
    if (!current.current) return;
    cancelStarting(current.current);
    restoreFocus.current = from;
    void end(current.current);
  }

  useImperativeHandle(actionsRef, () => ({
    close: () =>
      closeSession(host.current?.ownerDocument.activeElement ?? null),
    clear: () => current.current?.view?.clear(),
  }));

  useEffect(
    () => onRunningChange?.(status.phase === "running"),
    [onRunningChange, status.phase],
  );

  async function sendInput(session: Session) {
    const id = session.id;
    if (!id || session.writing) return;
    session.writing = true;
    try {
      while (current.current === session && session.pending.length) {
        const bytes = session.pending[0];
        try {
          await invokeTerminal("terminal_input", {
            id,
            data: Array.from(bytes),
          });
        } catch (cause) {
          if (cause !== "INPUT_BUSY") throw cause;
          await new Promise<void>((resolve) => setTimeout(resolve, 24));
          continue;
        }
        if (current.current !== session) break;
        session.pending.shift();
        session.pendingBytes -= bytes.length;
      }
    } catch (cause) {
      if (cause === "SESSION_CLOSED") {
        session.pending = [];
        session.pendingBytes = 0;
      } else {
        await end(session, terminalErrorMessage(cause));
      }
    } finally {
      session.writing = false;
    }
  }

  function receiveInput(session: Session, bytes: Uint8Array) {
    if (current.current !== session || !session.id || !bytes.length) return;
    if (session.pendingBytes + bytes.length > inputLimit) {
      setError(
        "Terminal input buffer is full. Wait for the shell and try again.",
      );
      return;
    }
    for (let i = 0; i < bytes.length; i += inputChunk) {
      session.pending.push(bytes.subarray(i, i + inputChunk));
    }
    session.pendingBytes += bytes.length;
    void sendInput(session);
  }

  async function resize(session: Session) {
    const id = session.id;
    if (!id || session.resizing) return;
    session.resizing = true;
    try {
      while (current.current === session && session.dimensions) {
        const { rows, cols } = session.dimensions;
        if (rows === session.sent?.rows && cols === session.sent.cols) break;
        await invokeTerminal("terminal_resize", { id, rows, cols });
        session.sent = { rows, cols };
      }
    } catch (cause) {
      if (current.current === session && cause !== "SESSION_CLOSED")
        setError(terminalErrorMessage(cause));
    } finally {
      session.resizing = false;
    }
  }

  async function read(session: Session) {
    if (current.current !== session || !session.id) return;
    try {
      const output = await invokeTerminal("terminal_read", { id: session.id });
      if (current.current !== session) return;
      if (output.bytes.length) await session.view?.write(output.bytes);
      if (current.current !== session) return;
      if (output.finished) {
        const active = host.current?.ownerDocument.activeElement;
        if (active && host.current?.contains(active))
          restoreFocus.current = active;
        await end(session, "", output.exitCode, true);
      } else {
        session.poll = setTimeout(
          () => void read(session),
          output.bytes.length ? 0 : 48,
        );
      }
    } catch (cause) {
      await end(session, terminalErrorMessage(cause));
    }
  }

  async function start() {
    const element = host.current;
    if (!native || !element || current.current || status.phase === "closing")
      return;
    const session: Session = {
      focusFrom: focusOnStart ? element.ownerDocument.activeElement : null,
      pending: [],
      pendingBytes: 0,
      writing: false,
      resizing: false,
    };
    current.current = session;
    restoreFocus.current = undefined;
    setError("");
    setStatus({ phase: "starting" });
    session.deadline = setTimeout(() => {
      if (current.current !== session) return;
      restoreFocus.current = session.focusFrom;
      cancelStarting(session);
      void end(session, terminalErrorMessage("START_TIMEOUT"));
    }, terminalStartupDeadline);
    try {
      const { createTerminalView } = await loadTerminalView();
      if (current.current !== session) return;
      lastView.current?.dispose();
      const view = createTerminalView(
        element,
        (bytes) => receiveInput(session, bytes),
        (target) => {
          void invokeTerminal("terminal_open_link", { target }).catch(
            (cause: unknown) => {
              if (host.current === element)
                setError(terminalErrorMessage(cause));
            },
          );
        },
      );
      lastView.current = session.view = view;
      const measure = () => {
        if (current.current !== session) return;
        session.dimensions = view.size() ?? session.dimensions;
        void resize(session);
      };
      session.observer = new ResizeObserver(measure);
      session.observer.observe(element);
      measure();
      const size = session.dimensions ?? { rows: 24, cols: 80 };
      session.attempt = Array.from(
        crypto.getRandomValues(new Uint8Array(16)),
        (byte) => byte.toString(16).padStart(2, "0"),
      )
        .join("")
        .replace(
          /^(........)(....)(....)(....)(............)$/,
          "$1-$2-$3-$4-$5",
        );
      const started = await invokeTerminal("terminal_start", {
        ...size,
        workspaceId,
        attempt: session.attempt,
        profile,
      });
      if (current.current !== session) {
        await closeNative(started.id).catch(() => {});
        return;
      }
      clearTimeout(session.deadline);
      session.id = started.id;
      if (started.shell) onShell?.(started.shell);
      session.sent = size;
      setStatus({
        phase: "running",
        workspaceDirectory: started.workspaceDirectory,
      });
      void resize(session);
      if (
        focusOnStart &&
        (canMoveFocus(element, session.focusFrom) ||
          (session.focusFrom === startButton.current &&
            element.ownerDocument.activeElement ===
              element.ownerDocument.body &&
            !element.closest("[hidden]")))
      )
        view.focus();
      void read(session);
    } catch (cause) {
      if (current.current === session) restoreFocus.current = session.focusFrom;
      await end(session, terminalErrorMessage(cause));
    }
  }

  if (!native)
    return <p className="panel-message">Terminal requires the desktop app.</p>;

  return (
    <div
      className="terminal-panel"
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "f" &&
          lastView.current
        ) {
          event.preventDefault();
          event.stopPropagation();
          setSearch(true);
        }
      }}
    >
      <div className="terminal-toolbar">
        {status.phase === "running" ? (
          <button
            type="button"
            onClick={(event) => closeSession(event.currentTarget)}
          >
            Close terminal
          </button>
        ) : (
          <button
            type="button"
            ref={startButton}
            className="terminal-start"
            disabled={status.phase === "starting" || status.phase === "closing"}
            onClick={() => void start()}
          >
            {status.phase === "starting"
              ? "Starting terminal…"
              : status.phase === "closing"
                ? "Closing terminal…"
                : status.phase === "exited"
                  ? error
                    ? "Retry terminal"
                    : "Restart terminal"
                  : "Start terminal"}
          </button>
        )}
        {status.phase === "starting" && (
          <button
            type="button"
            onClick={(event) => closeSession(event.currentTarget)}
          >
            Cancel
          </button>
        )}
        {(status.phase === "running" || status.phase === "exited") &&
          lastView.current && (
            <>
              <button type="button" onClick={() => setSearch(!search)}>
                Find
              </button>
              <button
                type="button"
                onClick={() => {
                  void lastView.current
                    ?.copy?.()
                    .catch(() =>
                      setError("Could not copy terminal selection."),
                    );
                }}
              >
                Copy
              </button>
              {status.phase === "running" && (
                <button
                  type="button"
                  onClick={() => {
                    void lastView.current
                      ?.paste?.()
                      .catch(() =>
                        setError(
                          "Could not read the clipboard. Try the keyboard shortcut.",
                        ),
                      );
                  }}
                >
                  Paste
                </button>
              )}
              <button type="button" onClick={() => lastView.current?.clear()}>
                Clear
              </button>
            </>
          )}
        {status.phase === "idle" && <span>No terminal session running.</span>}
        {status.phase === "running" &&
          workspaceId &&
          !status.workspaceDirectory && (
            <span>Started outside the workspace</span>
          )}
        {status.phase === "exited" && status.exitCode !== null && (
          <span role="status">Shell exited with code {status.exitCode}.</span>
        )}
      </div>
      {search && (
        <form
          className="terminal-find"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            setNoMatch(!!query && !lastView.current?.find?.(query));
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setSearch(false);
              lastView.current?.focus();
            }
          }}
        >
          <input
            aria-label="Find in terminal"
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setNoMatch(false);
            }}
          />
          {noMatch && <span role="status">No matches</span>}
          <button type="submit">Next match</button>
          <button
            type="button"
            onClick={() =>
              setNoMatch(!!query && !lastView.current?.find?.(query, true))
            }
          >
            Previous match
          </button>
          <button
            type="button"
            aria-label="Close terminal search"
            onClick={() => {
              setSearch(false);
              lastView.current?.focus();
            }}
          >
            ×
          </button>
        </form>
      )}
      {error && (
        <p className="terminal-error" role="alert">
          {error}
        </p>
      )}
      <div ref={host} className="terminal-screen" />
    </div>
  );
}
