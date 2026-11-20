import { invoke } from "@tauri-apps/api/core";
import type {
  LanguageCapabilities,
  LanguageCommands,
  LanguageError,
  LanguageFeature,
  LanguagePosition,
  LanguageServer,
  WorkspaceSymbol,
  WorkspaceSymbolKind,
} from "@turing/contracts";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  isLargeDocument,
  languageEditPending,
} from "../editor/performance-budget";
import type { EditorTab } from "../editor/use-editor";
import { clangdProblems, range, record } from "./problems";
import type { Problem } from "./problems";
import { stampOf } from "./diagnostic-store";
import type { DiagnosticBatch } from "./diagnostic-store";

function ipc<K extends keyof LanguageCommands>(
  command: K,
  args: LanguageCommands[K][0],
) {
  return invoke<LanguageCommands[K][1]>(command, args);
}

export type LanguageStatus =
  "idle" | "starting" | "ready" | "failed" | "unavailable" | "stopped";

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

const labels: Record<LanguageServer, string> = {
  clangd: "clangd",
  typescript: "typescript-language-server",
  pyright: "pyright-langserver",
  "rust-analyzer": "rust-analyzer",
};

const failure = (error: unknown, server: LanguageServer) =>
  isError(error, "UNAVAILABLE")
    ? `${labels[server]} was not found. Check your installed tools and try again.`
    : isError(error, "INCOMPATIBLE")
      ? `${labels[server]} could not pass its version probe or has no compatible runtime.`
      : isError(error, "DENIED")
        ? "The workspace or language session is no longer authorized."
        : isError(error, "INVALID_DOCUMENT")
          ? `This workspace file cannot be sent to ${labels[server]}.`
          : `${labels[server]} stopped responding or could not start.`;

const extensions: Record<LanguageServer, RegExp> = {
  clangd: /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i,
  typescript: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i,
  pyright: /\.(py|pyi)$/i,
  "rust-analyzer": /\.rs$/i,
};

export const serverKinds = [
  "clangd",
  "typescript",
  "pyright",
  "rust-analyzer",
] as const;

export function languagePath(
  tab: EditorTab,
  workspaceId?: string,
  server?: LanguageServer,
) {
  return !isLargeDocument(tab.draft) &&
    tab.source.kind === "workspace" &&
    tab.source.workspaceId === workspaceId &&
    (server
      ? extensions[server].test(tab.name)
      : serverKinds.some((kind) => extensions[kind].test(tab.name)))
    ? tab.source.relativePath
    : undefined;
}

export function serverFor(tab: EditorTab, workspaceId?: string) {
  return serverKinds.find((server) => languagePath(tab, workspaceId, server));
}

function unchanged(previous: EditorTab, next: EditorTab) {
  return (
    previous.key === next.key &&
    previous.revision === next.revision &&
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
  server: LanguageServer = "clangd",
) {
  const [owner, setOwner] = useState<string>();
  const [status, setStatus] = useState<LanguageStatus>("idle");
  const [message, setMessage] = useState<string>();
  const [logs, setLogs] = useState<string[]>([]);
  const [rustPermissions, setRustPermissions] = useState<string>();
  const rustBuildScripts = !!workspaceId && rustPermissions === workspaceId;
  const attempts = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
      clearTimeout(retry.current);
      attempts.current = 0;
      const old = current.current;
      current.current = undefined;
      if (old) dispose(old);
    },
    [workspaceId],
  );

  async function launch(restarting: boolean) {
    if (!native || !workspaceId || startToken.current || current.current)
      return;
    clearTimeout(retry.current);
    if (!restarting) {
      attempts.current = 0;
      setLogs([]);
    }
    const token = {};
    startToken.current = token;
    setOwner(workspaceId);
    setStatus("starting");
    setCapabilities(null);
    setMessage(undefined);
    setDiagnostics(new Map());
    try {
      const sessionId = await ipc("language_start", {
        workspaceId,
        ...(server === "clangd" ? {} : { server }),
        ...(server === "rust-analyzer" && rustBuildScripts
          ? { rustBuildScripts }
          : {}),
      });
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
        setStatus(
          server !== "clangd" && isError(error, "UNAVAILABLE")
            ? "unavailable"
            : "failed",
        );
        setMessage(failure(error, server));
      }
    } finally {
      if (startToken.current === token) startToken.current = undefined;
    }
  }

  const restart = useEffectEvent(() => void launch(true));

  async function start() {
    await launch(false);
  }

  function stop() {
    clearTimeout(retry.current);
    startToken.current = undefined;
    const previous = current.current;
    current.current = undefined;
    if (previous) dispose(previous);
    setSession(undefined);
    setCapabilities(null);
    setDiagnostics(new Map());
    setMessage(undefined);
    setStatus(server === "clangd" ? "idle" : "stopped");
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
        const stderr = update.stderr;
        if (stderr?.length)
          setLogs((previous) => [...previous, ...stderr].slice(-100));
        if (update.error) throw update.error;
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
            const path = languagePath(tab, address.workspaceId, server);
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
          const now = performance.now();
          for (const [path, tab] of next) {
            const previous = session.docs.get(path);
            const rejected = session.rejected.get(path);
            if (
              languageEditPending(tab.editedAt, now) ||
              (previous && unchanged(previous.tab, tab)) ||
              (rejected && unchanged(rejected, tab))
            )
              continue;
            if (budget-- === 0) break;
            const version = session.nextVersion++;
            const saved =
              previous?.tab.source.kind === "workspace" &&
              tab.source.kind === "workspace" &&
              previous.tab.source.version !== tab.source.version;
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
                  setMessage(failure("INVALID_DOCUMENT", server));
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
          setMessage(failure(error, server));
          if (
            server !== "clangd" &&
            isError(error, "SERVER_EXITED", "START_FAILED") &&
            attempts.current < 2
          ) {
            const delay = 500 * 2 ** attempts.current++;
            retry.current = setTimeout(restart, delay);
          }
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
  }, [session, workspaceId, server]);

  async function request(
    tab: EditorTab,
    feature: LanguageFeature,
    position: LanguagePosition,
    signal: AbortSignal,
    newName?: string,
    onTargets?: (targets: ReadonlyMap<string, Tracked>) => void,
  ): Promise<unknown> {
    const active = current.current;
    const path = languagePath(tab, workspaceId, server);
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
    const targets = [
      "definition",
      "references",
      "implementation",
      "declaration",
      "rename",
    ].includes(feature)
      ? new Map(active.docs)
      : undefined;
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
        if (
          [
            "definition",
            "references",
            "implementation",
            "declaration",
          ].includes(feature) &&
          targets &&
          Array.isArray(value) &&
          tabs
        ) {
          value = value.filter((entry: unknown) => {
            const path = record(entry)?.path;
            if (typeof path !== "string") return false;
            const original = targets.get(path);
            const target = tabs.find(
              (item) => languagePath(item, workspaceId) === path,
            );
            if (!original && !target) return server !== "clangd";
            return (
              original &&
              target &&
              !target.changedOnDisk &&
              unchanged(original.tab, target)
            );
          });
        }
        if (feature === "rename" && targets) onTargets?.(targets);
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
          newName,
        },
      });
      void submitted.catch(() => finish());
    });
  }

  async function rename(
    tab: EditorTab,
    position: LanguagePosition,
    newName: string,
    signal: AbortSignal,
  ) {
    let documents: ReadonlyMap<string, Tracked> = new Map();
    const value = await request(
      tab,
      "rename",
      position,
      signal,
      newName,
      (targets) => {
        documents = targets;
      },
    );
    return { value, documents };
  }

  // Each clangd result is stamped with the document state it was synced at;
  // the diagnostic store hides it once that document changes.
  const batches = useMemo(
    (): DiagnosticBatch[] =>
      owner === workspaceId
        ? [...diagnostics.values()].map(({ tracked, problems }) => ({
            producer: server,
            stamp: stampOf(tracked.tab),
            problems: problems.map(({ start, end, severity, message }) => ({
              start,
              end,
              severity,
              message,
            })),
          }))
        : [],
    [owner, workspaceId, diagnostics, server],
  );

  return {
    status: owner === workspaceId ? status : ("idle" as const),
    message: owner === workspaceId ? message : undefined,
    capabilities: owner === workspaceId ? capabilities : null,
    batches,
    logs: owner === workspaceId ? logs : [],
    rustBuildScripts,
    setRustBuildScripts: (allow: boolean) =>
      setRustPermissions(allow ? workspaceId : undefined),
    start,
    stop,
    request,
    rename,
  };
}

type ServerController = ReturnType<typeof useLanguage>;
export type LanguageController = Omit<
  ServerController,
  "logs" | "rustBuildScripts" | "setRustBuildScripts"
> & {
  servers?: Record<LanguageServer, ServerController>;
  forTab?: (tab: EditorTab) => ServerController | undefined;
  symbols?: (query: string, signal: AbortSignal) => Promise<WorkspaceSymbol[]>;
};

export function useManagedLanguage(
  workspaceId: string | undefined,
  native: boolean,
  tabs: EditorTab[],
): LanguageController {
  const clangd = useLanguage(workspaceId, native, tabs, "clangd");
  const typescript = useLanguage(workspaceId, native, tabs, "typescript");
  const pyright = useLanguage(workspaceId, native, tabs, "pyright");
  const rust = useLanguage(workspaceId, native, tabs, "rust-analyzer");
  const servers = { clangd, typescript, pyright, "rust-analyzer": rust };
  const batches = useMemo(
    () => [
      ...clangd.batches,
      ...typescript.batches,
      ...pyright.batches,
      ...rust.batches,
    ],
    [clangd.batches, typescript.batches, pyright.batches, rust.batches],
  );
  function forTab(tab: EditorTab) {
    const kind = serverFor(tab, workspaceId);
    return kind ? servers[kind] : undefined;
  }
  const kinds: Partial<Record<number, WorkspaceSymbolKind>> = {
    2: "module",
    5: "class",
    10: "enum",
    11: "interface",
    12: "function",
    13: "variable",
    14: "constant",
    23: "struct",
  };
  async function symbols(query: string, signal: AbortSignal) {
    const results = await Promise.all(
      serverKinds.map(async (kind) => {
        const server = servers[kind];
        const tab = tabs.find(
          (tab) => !tab.changedOnDisk && languagePath(tab, workspaceId, kind),
        );
        if (!tab || !server.capabilities?.workspaceSymbol) return [];
        const entries = await server.request(
          tab,
          "workspaceSymbol",
          { line: 0, character: 0 },
          signal,
          query,
        );
        if (!Array.isArray(entries)) return [];
        return entries.flatMap((item: unknown): WorkspaceSymbol[] => {
          const entry = record(item);
          const location = range(entry?.range);
          if (
            typeof entry?.path !== "string" ||
            typeof entry.name !== "string" ||
            !location
          )
            return [];
          return [
            {
              name: entry.name,
              relativePath: entry.path,
              kind:
                typeof entry.kind === "number"
                  ? (kinds[entry.kind] ?? "variable")
                  : "variable",
              line: location.start.line,
              character: location.start.character,
            },
          ];
        });
      }),
    );
    return results.flat();
  }
  return {
    ...clangd,
    servers,
    symbols,
    forTab,
    batches,
    request: (tab, ...args) =>
      forTab(tab)?.request(tab, ...args) ?? Promise.resolve(undefined),
    rename: (tab, ...args) =>
      forTab(tab)?.rename(tab, ...args) ??
      Promise.resolve({ value: undefined, documents: new Map() }),
  };
}
