import { invoke } from "@tauri-apps/api/core";
import type {
  LanguageCapabilities,
  LanguageCommands,
  LanguageError,
  LanguageFeature,
  LanguagePosition,
} from "@turing/contracts";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { EditorTab } from "../editor/use-editor";
import { clangdProblems, record } from "./problems";
import type { Problem } from "./problems";
import { stampOf } from "./diagnostic-store";
import type { DiagnosticBatch } from "./diagnostic-store";

function ipc<K extends keyof LanguageCommands>(
  command: K,
  args: LanguageCommands[K][0],
) {
  return invoke<LanguageCommands[K][1]>(command, args);
}

export type LanguageStatus = "idle" | "starting" | "ready" | "failed";

type Tracked = {
  tab: EditorTab;
  version: number;
};

type Session = {
  workspaceId: string;
  sessionId: string;
  docs: Map<string, Tracked>;
  rejected: Map<string, EditorTab>;
  nextVersion: number;
  nextRequest: number;
  waiting: number;
  requests: Map<number, (result?: unknown, tabs?: EditorTab[]) => void>;
  capabilities: LanguageCapabilities | null;
};

type Diagnostics = { tracked: Tracked; problems: Problem[] };

const isError = (error: unknown, ...codes: LanguageError[]) =>
  typeof error === "string" && (codes as string[]).includes(error);

const failure = (error: unknown) =>
  isError(error, "UNAVAILABLE")
    ? "clangd was not found. Install LLVM clangd and try again."
    : isError(error, "DENIED")
      ? "The workspace or language session is no longer authorized."
      : isError(error, "INVALID_DOCUMENT")
        ? "This file cannot be sent to clangd. Check that it is a supported workspace text file."
        : "clangd could not start or stopped responding. Enable it again to retry.";

export function languagePath(tab: EditorTab, workspaceId?: string) {
  return tab.source.kind === "workspace" &&
    tab.source.workspaceId === workspaceId &&
    /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(tab.name)
    ? tab.source.relativePath
    : undefined;
}

function unchanged(previous: EditorTab, next: EditorTab) {
  return (
    previous.key === next.key &&
    previous.draft === next.draft &&
    previous.editRevision === next.editRevision &&
    previous.source.kind === "workspace" &&
    next.source.kind === "workspace" &&
    previous.source.version === next.source.version
  );
}

function dispose(session: Session) {
  for (const finish of session.requests.values()) finish();
  void ipc("language_stop", {
    workspaceId: session.workspaceId,
    sessionId: session.sessionId,
  }).catch(() => {});
}

export function useLanguage(
  workspaceId: string | undefined,
  native: boolean,
  tabs: EditorTab[],
) {
  const [owner, setOwner] = useState<string>();
  const [status, setStatus] = useState<LanguageStatus>("idle");
  const [message, setMessage] = useState<string>();
  const [session, setSession] = useState<Session>();
  const [capabilities, setCapabilities] = useState<LanguageCapabilities | null>(
    null,
  );
  const [diagnostics, setDiagnostics] = useState<Map<string, Diagnostics>>(
    () => new Map(),
  );
  const startToken = useRef<object | undefined>(undefined);
  const current = useRef<Session | undefined>(undefined);
  const latestTabs = useEffectEvent(() => tabs);

  useEffect(
    () => () => {
      startToken.current = undefined;
      const old = current.current;
      current.current = undefined;
      if (old) dispose(old);
    },
    [workspaceId],
  );

  async function start() {
    if (!native || !workspaceId || startToken.current || current.current)
      return;
    const token = {};
    startToken.current = token;
    setOwner(workspaceId);
    setStatus("starting");
    setCapabilities(null);
    setMessage(undefined);
    setDiagnostics(new Map());
    try {
      const sessionId = await ipc("language_start", { workspaceId });
      if (startToken.current !== token) {
        if (sessionId)
          void ipc("language_stop", { workspaceId, sessionId }).catch(() => {});
        return;
      }
      if (!sessionId) {
        setStatus("idle");
        return;
      }
      const next: Session = {
        sessionId,
        workspaceId,
        docs: new Map(),
        rejected: new Map(),
        nextVersion: 1,
        nextRequest: 3,
        waiting: 0,
        requests: new Map(),
        capabilities: null,
      };
      current.current = next;
      setSession(next);
    } catch (error) {
      if (startToken.current === token) {
        setStatus("failed");
        setMessage(failure(error));
      }
    } finally {
      if (startToken.current === token) startToken.current = undefined;
    }
  }

  function stop() {
    const previous = current.current;
    current.current = undefined;
    if (previous) dispose(previous);
    setSession(undefined);
    setCapabilities(null);
    setDiagnostics(new Map());
    setMessage(undefined);
    setStatus("idle");
  }

  useEffect(() => {
    if (!session || session.workspaceId !== workspaceId) return;
    const address = {
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
    };
    const live = () => current.current === session && !cancelled;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function cycle() {
      if (!live() || !session) return;
      try {
        const update = await ipc("language_poll", address);
        if (!live()) return;
        if (!session.capabilities && update.capabilities) {
          session.capabilities = update.capabilities;
          setCapabilities(update.capabilities);
          setStatus("ready");
        }
        const changes = new Map<string, Diagnostics>();
        for (const event of update.events) {
          if (event.kind === "response") {
            session.requests.get(event.requestId)?.(event.value, latestTabs());
          } else {
            const tracked = session.docs.get(event.path);
            if (tracked?.version === event.version)
              changes.set(event.path, {
                tracked,
                problems: clangdProblems(event.diagnostics, tracked.tab),
              });
          }
        }
        if (changes.size)
          setDiagnostics((previous) => new Map([...previous, ...changes]));
        if (session.capabilities) {
          const next = new Map<string, EditorTab>();
          for (const tab of latestTabs()) {
            const path = languagePath(tab, address.workspaceId);
            if (path && !tab.changedOnDisk && next.size < 24)
              next.set(path, tab);
          }
          for (const path of session.rejected.keys()) {
            if (!next.has(path)) session.rejected.delete(path);
          }
          for (const [path, document] of session.docs) {
            if (next.get(path)?.key === document.tab.key) continue;
            await ipc("language_apply", {
              ...address,
              action: { kind: "close", path },
            });
            if (!live()) return;
            session.docs.delete(path);
            setDiagnostics((previous) => {
              const copy = new Map(previous);
              copy.delete(path);
              return copy;
            });
          }
          let budget = 3;
          for (const [path, tab] of next) {
            const previous = session.docs.get(path);
            const rejected = session.rejected.get(path);
            if (
              (previous && unchanged(previous.tab, tab)) ||
              (rejected && unchanged(rejected, tab))
            )
              continue;
            if (budget-- === 0) break;
            const version = session.nextVersion++;
            const saved =
              previous?.tab.source.kind === "workspace" &&
              tab.source.kind === "workspace" &&
              previous.tab.source.version !== tab.source.version &&
              tab.savedVersion === tab.source.version;
            try {
              await ipc("language_apply", {
                ...address,
                action: {
                  kind: "sync",
                  path,
                  version,
                  text: tab.draft,
                  saved,
                },
              });
            } catch (error) {
              if (isError(error, "INVALID_DOCUMENT", "DENIED")) {
                if (live()) {
                  session.rejected.set(path, tab);
                  setMessage(failure("INVALID_DOCUMENT"));
                }
                continue;
              }
              throw error;
            }
            if (!live()) return;
            session.docs.set(path, { tab, version });
            session.rejected.delete(path);
            if (!session.rejected.size) setMessage(undefined);
          }
        }
      } catch (error) {
        if (!live()) return;
        if (!isError(error, "BUSY")) {
          current.current = undefined;
          dispose(session);
          setSession(undefined);
          setCapabilities(null);
          setDiagnostics(new Map());
          setStatus("failed");
          setMessage(failure(error));
          return;
        }
      }
      if (live()) timer = setTimeout(() => void cycle(), 120);
    }
    void cycle();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [session, workspaceId]);

  async function request(
    tab: EditorTab,
    feature: LanguageFeature,
    position: LanguagePosition,
    signal: AbortSignal,
  ): Promise<unknown> {
    const active = current.current;
    const path = languagePath(tab, workspaceId);
    if (
      tab.changedOnDisk ||
      !active ||
      active.workspaceId !== workspaceId ||
      !path ||
      !active.capabilities?.[feature] ||
      signal.aborted ||
      active.requests.size + active.waiting >= 16
    )
      return;

    // A completion triggered by typing may arrive before the next sync pass.
    // Wait for this exact draft rather than querying the previous revision.
    let tracked = active.docs.get(path);
    active.waiting++;
    try {
      const deadline = performance.now() + 650;
      while (!tracked || !unchanged(tracked.tab, tab)) {
        if (
          signal.aborted ||
          current.current !== active ||
          performance.now() >= deadline
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 30));
        tracked = active.docs.get(path);
      }
    } finally {
      active.waiting--;
    }
    if (signal.aborted || current.current !== active) return;
    const version = tracked.version;
    const requestId = active.nextRequest++;
    const address = {
      workspaceId: active.workspaceId,
      sessionId: active.sessionId,
    };
    const targets = feature === "definition" ? new Map(active.docs) : undefined;
    return new Promise((resolve) => {
      function finish(value?: unknown, tabs?: EditorTab[]) {
        active?.requests.delete(requestId);
        signal.removeEventListener("abort", cancel);
        clearTimeout(timer);
        const latest = tabs?.find(
          (item) => languagePath(item, workspaceId) === path,
        );
        if (!latest || latest.changedOnDisk || !unchanged(tab, latest)) {
          resolve(undefined);
          return;
        }
        if (targets && Array.isArray(value) && tabs) {
          value = value.filter((entry: unknown) => {
            const path = record(entry)?.path;
            if (typeof path !== "string") return false;
            const original = targets.get(path);
            const target = tabs.find(
              (item) => languagePath(item, workspaceId) === path,
            );
            return (
              original &&
              target &&
              !target.changedOnDisk &&
              unchanged(original.tab, target)
            );
          });
        }
        resolve(value);
      }
      function cancel() {
        finish();
        void submitted
          .then(() =>
            ipc("language_apply", {
              ...address,
              action: { kind: "cancel", requestId },
            }),
          )
          .catch(() => {});
      }
      const timer = setTimeout(cancel, 4000);
      active.requests.set(requestId, finish);
      signal.addEventListener("abort", cancel, { once: true });
      const submitted = ipc("language_apply", {
        ...address,
        action: {
          kind: "request",
          feature,
          path,
          position,
          requestId,
          version,
        },
      });
      void submitted.catch(() => finish());
    });
  }

  // Each clangd result is stamped with the document state it was synced at;
  // the diagnostic store hides it once that document changes.
  const batches = useMemo(
    (): DiagnosticBatch[] =>
      owner === workspaceId
        ? [...diagnostics.values()].map(({ tracked, problems }) => ({
            producer: "clangd",
            stamp: stampOf(tracked.tab),
            problems: problems.map(({ start, end, severity, message }) => ({
              start,
              end,
              severity,
              message,
            })),
          }))
        : [],
    [owner, workspaceId, diagnostics],
  );

  return {
    status: owner === workspaceId ? status : ("idle" as const),
    message: owner === workspaceId ? message : undefined,
    capabilities: owner === workspaceId ? capabilities : null,
    batches,
    start,
    stop,
    request,
  };
}

export type LanguageController = ReturnType<typeof useLanguage>;
