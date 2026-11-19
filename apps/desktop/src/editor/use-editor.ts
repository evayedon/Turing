import type { NavigationTarget } from "./navigation";
import { rememberRecent } from "../shell/recent";
import { suggestedFilename } from "./languages";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  SelectedFileSnapshot,
  TextFile,
  WorkspaceCommands,
} from "@turing/contracts";
import {
  invokeWorkspace,
  workspaceErrorMessage,
} from "../explorer/workspace-ipc";

export interface EditorLocation {
  line: number;
  column: number;
}

type SavedSource = (
  | { kind: "workspace"; workspaceId: string; relativePath: string }
  | { kind: "selected"; fileId: string }
) & { version: string };

export interface EditorTab {
  key: string;
  /** Canonical identity of the document's current source. */
  uri: string;
  /**
   * Advances whenever the source identity or saved state changes (open, save,
   * reload, rename, Save As). Late replies apply only to the revision they
   * were issued for. Typing changes `editRevision`, not this.
   */
  revision: number;
  name: string;
  title: string;
  source: SavedSource | { kind: "untitled" };
  content: string;
  draft: string;
  editRevision?: number;
  savedVersion?: string;
  changedOnDisk: boolean;
  languageOverride?: string;
  saveError?: string;
}

type NewTab = Omit<EditorTab, "key" | "revision" | "uri">;

export function documentUri(source: EditorTab["source"], name: string) {
  return source.kind === "workspace"
    ? `turing-workspace://${source.workspaceId}/${source.relativePath}`
    : source.kind === "selected"
      ? `turing-file://${source.fileId}`
      : `untitled:${name}`;
}

function workspaceTab(file: TextFile): NewTab {
  return {
    name: file.relativePath.split("/").at(-1) ?? file.relativePath,
    title: file.relativePath,
    source: {
      kind: "workspace",
      workspaceId: file.workspaceId,
      relativePath: file.relativePath,
      version: file.version,
    },
    content: file.content,
    draft: file.content,
    changedOnDisk: false,
  };
}

function selectedTab(file: SelectedFileSnapshot): NewTab {
  return {
    name: file.name,
    title: file.displayPath,
    source: { kind: "selected", fileId: file.fileId, version: file.version },
    content: file.content,
    draft: file.content,
    changedOnDisk: false,
  };
}

function readFile(source: SavedSource) {
  if (source.kind === "selected")
    return invokeWorkspace("file_read", { fileId: source.fileId });
  return invokeWorkspace("fs_read_file", {
    workspaceId: source.workspaceId,
    relativePath: source.relativePath,
  });
}

function writeFile(source: SavedSource, content: string) {
  const expectedVersion = source.version;
  if (source.kind === "selected") {
    return invokeWorkspace("file_write", {
      fileId: source.fileId,
      content,
      expectedVersion,
    });
  }
  return invokeWorkspace("fs_write_file", {
    workspaceId: source.workspaceId,
    relativePath: source.relativePath,
    content,
    expectedVersion,
  });
}

export const AUTO_SAVE_DELAY_MS = 1000;
export const autoSaveKey = "turing:auto-save:v1";

function loadAutoSave() {
  try {
    return window.localStorage.getItem(autoSaveKey) === "true";
  } catch {
    return false;
  }
}
type Operation = "foreground" | "automatic";

type DiscardAction =
  WorkspaceCommands["editor_confirm_discard"]["args"]["action"];

export function useEditor(workspaceId: string | undefined, native: boolean) {
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  // Always the latest tabs, so work resumed after an await never acts on, or
  // writes back, a stale snapshot. Every change goes through `commitTabs`.
  const latest = useRef<EditorTab[]>([]);
  const currentWorkspace = useRef(workspaceId);
  const revisions = useRef(0);
  const inflight = useRef<Promise<unknown> | null>(null);
  const [activeKey, setActiveKey] = useState<string>();
  const [reveal, setReveal] = useState<EditorLocation & { key: string }>();
  const [operation, setOperation] = useState<Operation | null>(null);
  const [autoSavePreference, setAutoSave] = useState(loadAutoSave);
  const autoSave = native && autoSavePreference;
  const [exitPending, setExitPending] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef<Operation | null>(null);
  const busy = operation !== null;
  const untitledCount = useRef(0);
  const tabSequence = useRef(0);
  const active = tabs.find((tab) => tab.key === activeKey);
  const dirty = tabs.some((tab) => tab.draft !== tab.content);
  const canSave =
    native &&
    !!active &&
    (active.source.kind === "untitled" || active.draft !== active.content);

  useLayoutEffect(() => {
    currentWorkspace.current = workspaceId;
  }, [workspaceId]);

  function commitTabs(next: (previous: EditorTab[]) => EditorTab[]) {
    latest.current = next(latest.current);
    setTabs(latest.current);
  }

  const find = (key: string) => latest.current.find((tab) => tab.key === key);

  const autoSaveCandidate =
    autoSave && native
      ? tabs.find(
          (tab) =>
            tab.source.kind !== "untitled" &&
            tab.draft !== tab.content &&
            !tab.changedOnDisk &&
            !tab.saveError,
        )
      : undefined;

  /** Applies `patch` only if `tab` still has the revision it was read at. */
  function update(tab: EditorTab, patch: Partial<EditorTab>) {
    commitTabs((previous) =>
      previous.map((item) => {
        if (item.key !== tab.key || item.revision !== tab.revision) return item;
        const next = { ...item, ...patch };
        return patch.source
          ? {
              ...next,
              uri: documentUri(next.source, next.name),
              revision: ++revisions.current,
            }
          : next;
      }),
    );
  }

  async function perform<T>(
    action: () => Promise<T>,
    mode: Operation = "foreground",
  ) {
    // A user action requested while Auto Save writes runs after it instead
    // of being dropped; it then reads the latest tabs.
    while (mode === "foreground" && pending.current === "automatic")
      await inflight.current?.catch(() => {});
    if (pending.current) return;
    pending.current = mode;
    setOperation(mode);
    if (mode === "foreground") setError(undefined);
    const run = (async () => {
      try {
        return await action();
      } catch (cause) {
        setError(workspaceErrorMessage(cause));
      } finally {
        pending.current = null;
        setOperation(null);
      }
    })();
    inflight.current = run;
    return run;
  }

  function confirmDiscard(action: DiscardAction) {
    if (!native) return window.confirm("Discard the unsaved changes?");
    return invokeWorkspace("editor_confirm_discard", { action });
  }

  function select(key: string) {
    if (pending.current) return;
    setActiveKey(key);
    setError(undefined);
  }

  function navigate(target: NavigationTarget, location: EditorLocation) {
    if (pending.current) return;
    if ("tab" in target) {
      select(target.tab.key);
      setReveal({ key: target.tab.key, ...location });
    } else {
      void open(target.relativePath, location);
    }
  }

  function addTab(tab: NewTab) {
    const key = String(++tabSequence.current);
    commitTabs((previous) => [
      ...previous,
      {
        ...tab,
        key,
        uri: documentUri(tab.source, tab.name),
        revision: ++revisions.current,
      },
    ]);
    setActiveKey(key);
    return key;
  }

  function open(relativePath: string, location?: EditorLocation) {
    if (!workspaceId || pending.current) return;
    const existing = tabs.find(
      (tab) =>
        tab.source.kind === "workspace" &&
        tab.source.workspaceId === workspaceId &&
        tab.source.relativePath === relativePath,
    );
    if (existing) {
      select(existing.key);
      if (location) setReveal({ key: existing.key, ...location });
      return;
    }
    return perform(async () => {
      const file = await invokeWorkspace("fs_read_file", {
        workspaceId,
        relativePath,
      });
      // The workspace was closed or replaced while reading: drop the reply.
      if (currentWorkspace.current !== workspaceId) return;
      const key = addTab(workspaceTab(file));
      if (location) setReveal({ key, ...location });
    });
  }

  function openFile(recentPath?: string) {
    if (!native) return;
    return perform(async () => {
      const file = await invokeWorkspace(
        "file_open",
        recentPath ? { recentPath } : undefined,
      );
      if (!file) return;
      rememberRecent({ kind: "file", name: file.name, path: file.displayPath });
      const existing = latest.current.find(
        (tab) =>
          tab.source.kind === "selected" && tab.source.fileId === file.fileId,
      );
      if (existing) {
        setActiveKey(existing.key);
      } else {
        addTab(selectedTab(file));
      }
    });
  }

  function newFile() {
    if (pending.current) return;
    const name = `Untitled-${++untitledCount.current}`;
    addTab({
      name,
      title: name,
      source: { kind: "untitled" },
      content: "",
      draft: "",
      changedOnDisk: false,
    });
    setError(undefined);
  }

  function createWorkspaceFile(parent: string, name: string) {
    if (!workspaceId) return;
    return perform(async () => {
      const target = parent ? `${parent}/${name}` : name;
      if (
        latest.current.some(
          ({ source }) =>
            source.kind === "workspace" &&
            source.workspaceId === workspaceId &&
            source.relativePath === target,
        )
      )
        throw "NAME_TAKEN";
      const file = await invokeWorkspace("workspace_create_file", {
        workspaceId,
        parent,
        name,
      });
      if (currentWorkspace.current !== workspaceId) return file.relativePath;
      addTab(workspaceTab(file));
      return file.relativePath;
    });
  }

  function renameWorkspaceEntry(
    relativePath: string,
    name: string,
    expectedIdentity: string,
  ) {
    if (!workspaceId) return;
    const slash = relativePath.lastIndexOf("/");
    const target = `${relativePath.slice(0, slash + 1)}${name}`;
    const belongs = (path: string, base: string) =>
      path === base || path.startsWith(`${base}/`);
    return perform(async () => {
      if (
        latest.current.some(
          ({ source }) =>
            source.kind === "workspace" &&
            source.workspaceId === workspaceId &&
            belongs(source.relativePath, target) &&
            !belongs(source.relativePath, relativePath),
        )
      )
        throw "NAME_TAKEN";
      const next = await invokeWorkspace("workspace_rename_entry", {
        workspaceId,
        relativePath,
        name,
        expectedIdentity,
      });
      commitTabs((previous) =>
        previous.map((item) => {
          const { source } = item;
          if (
            source.kind !== "workspace" ||
            source.workspaceId !== workspaceId ||
            !belongs(source.relativePath, relativePath)
          )
            return item;
          const newPath = next + source.relativePath.slice(relativePath.length);
          const renamed = { ...source, relativePath: newPath };
          return {
            ...item,
            title: newPath,
            name: newPath.split("/").at(-1) ?? item.name,
            source: renamed,
            uri: documentUri(renamed, item.name),
            revision: ++revisions.current,
          };
        }),
      );
      return next;
    });
  }

  async function releaseFile(tab: EditorTab, otherTabs: EditorTab[]) {
    if (tab.source.kind !== "selected") return;
    const fileId = tab.source.fileId;
    if (
      otherTabs.some(
        (other) =>
          other.key !== tab.key &&
          other.source.kind === "selected" &&
          other.source.fileId === fileId,
      )
    )
      return;
    await invokeWorkspace("file_close", { fileId });
  }

  function close({ key }: EditorTab) {
    return perform(async () => {
      const tab = find(key);
      if (!tab) return;
      if (tab.draft !== tab.content && !(await confirmDiscard("tab"))) return;
      await releaseFile(tab, latest.current);
      const index = latest.current.findIndex((item) => item.key === key);
      commitTabs((previous) => previous.filter((item) => item.key !== key));
      const remaining = latest.current;
      setActiveKey((current) =>
        current === key
          ? remaining[Math.min(index, remaining.length - 1)]?.key
          : current,
      );
    });
  }

  function closeAll() {
    return perform(async () => {
      if (
        latest.current.some((tab) => tab.draft !== tab.content) &&
        !(await confirmDiscard("closeAll"))
      )
        return;
      const remaining = [...latest.current];
      try {
        while (remaining.length) {
          await releaseFile(remaining[0], remaining);
          remaining.shift();
        }
      } finally {
        const kept = new Set(remaining.map(({ key }) => key));
        commitTabs((previous) => previous.filter(({ key }) => kept.has(key)));
        const left = latest.current;
        setActiveKey((current) =>
          left.some(({ key }) => key === current) ? current : left[0]?.key,
        );
      }
    });
  }

  function edit(tab: EditorTab, draft: string) {
    if (pending.current === "foreground") return;
    // An older draft can finish saving before Monaco delivers its next edit.
    // Apply the edit to the current tab without replacing its saved version.
    commitTabs((previous) =>
      previous.map((item) =>
        item.key === tab.key
          ? {
              ...item,
              draft,
              editRevision: (item.editRevision ?? 0) + 1,
              saveError: undefined,
            }
          : item,
      ),
    );
  }

  function setLanguage(languageOverride: string | undefined) {
    if (!active) return;
    update(active, { languageOverride });
  }

  function saveAs() {
    if (!active || !native) return;
    const { key } = active;
    return perform(async () => {
      const active = find(key);
      if (!active) return;
      const file = await invokeWorkspace("file_save_as", {
        content: active.draft,
        suggestedName: suggestedFilename(active),
      });
      if (!file) return;
      rememberRecent({ kind: "file", name: file.name, path: file.displayPath });
      update(active, {
        ...selectedTab({ ...file, content: active.draft }),
        saveError: undefined,
      });
      if (
        active.source.kind === "selected" &&
        active.source.fileId !== file.fileId
      ) {
        await releaseFile(active, latest.current);
      }
    });
  }

  function saveTab({ key }: EditorTab, mode: Operation = "foreground") {
    return perform(async () => {
      // Save what the tab holds now, which may postdate the request.
      const tab = find(key);
      if (!tab || tab.source.kind === "untitled") return;
      const { source, draft } = tab;
      try {
        const version = await writeFile(source, draft);
        update(tab, {
          content: draft,
          savedVersion: version,
          source: { ...source, version },
          changedOnDisk: false,
          saveError: undefined,
        });
      } catch (cause) {
        const conflict = cause === "FILE_CONFLICT" || cause === "SAVE_RACE";
        const message = workspaceErrorMessage(cause);
        update(tab, {
          saveError:
            mode === "automatic" ? `Auto Save failed. ${message}` : message,
          ...(conflict ? { changedOnDisk: true } : {}),
        });
      }
    }, mode);
  }

  function save() {
    if (!active || !canSave) return;
    return active.source.kind === "untitled" ? saveAs() : saveTab(active);
  }

  function toggleAutoSave() {
    if (!native) return;
    if (!autoSave) {
      commitTabs((previous) =>
        previous.map((tab) =>
          tab.saveError ? { ...tab, saveError: undefined } : tab,
        ),
      );
    }
    setAutoSave(!autoSave);
    try {
      window.localStorage.setItem(autoSaveKey, String(!autoSave));
    } catch {
      // The preference still applies for this session.
    }
  }

  const runAutoSave = useEffectEvent((tab: EditorTab) => {
    if (autoSaveCandidate === tab) void saveTab(tab, "automatic");
  });

  useEffect(() => {
    if (busy || !autoSaveCandidate) return;
    const timeout = window.setTimeout(
      () => runAutoSave(autoSaveCandidate),
      AUTO_SAVE_DELAY_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [autoSaveCandidate, busy]);

  function reload() {
    if (!active || active.source.kind === "untitled") return;
    const { key } = active;
    return perform(async () => {
      const active = find(key);
      if (!active || active.source.kind === "untitled") return;
      const source = active.source;
      if (active.draft !== active.content && !(await confirmDiscard("reload")))
        return;
      const file = await readFile(source);
      update(active, {
        content: file.content,
        draft: file.content,
        source: { ...source, version: file.version },
        changedOnDisk: false,
        saveError: undefined,
      });
    });
  }

  function changeWorkspace(action: () => Promise<boolean | undefined>) {
    return perform(async () => {
      const workspaceTabs = latest.current.filter(
        (tab) => tab.source.kind === "workspace",
      );
      if (
        workspaceTabs.some((tab) => tab.draft !== tab.content) &&
        !(await confirmDiscard("workspace"))
      )
        return;
      if (await action()) {
        const closing = new Set(workspaceTabs.map(({ key }) => key));
        commitTabs((previous) =>
          previous.filter((tab) => tab.source.kind !== "workspace"),
        );
        const remaining = latest.current;
        setActiveKey((current) =>
          current && closing.has(current) ? remaining.at(-1)?.key : current,
        );
      }
    });
  }

  const onNativeClose = useEffectEvent(() => {
    if (pending.current === "automatic") {
      setExitPending(true);
      return;
    }
    setExitPending(false);
    void perform(async () => {
      if (!dirty || (await confirmDiscard("exit"))) {
        await invokeWorkspace("editor_exit", undefined);
      }
    });
  });

  useEffect(() => {
    if (!exitPending || busy) return;
    const timeout = window.setTimeout(() => onNativeClose(), 0);
    return () => window.clearTimeout(timeout);
  }, [exitPending, busy]);

  useEffect(() => {
    function onUnload(event: BeforeUnloadEvent) {
      if (dirty) {
        event.preventDefault();
        event.returnValue = true;
      }
    }
    function onClose() {
      onNativeClose();
    }
    if (native) window.addEventListener("turing-close-requested", onClose);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("turing-close-requested", onClose);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [dirty, native]);

  const checkActive = useEffectEvent(async () => {
    const tab = active;
    if (!tab || tab.source.kind === "untitled" || pending.current) return;
    let changed: boolean;
    try {
      const latest = await readFile(tab.source);
      changed = latest.version !== tab.source.version;
    } catch (cause) {
      if (
        ![
          "FILE_CONFLICT",
          "NOT_FOUND",
          "NOT_FILE",
          "OUTSIDE_WORKSPACE",
          "INVALID_ENCODING",
          "FILE_TOO_LARGE",
        ].includes(String(cause))
      )
        return;
      changed = true;
    }
    if (!pending.current && changed !== tab.changedOnDisk)
      update(tab, { changedOnDisk: changed });
  });

  useEffect(() => {
    if (!activeKey || !native) return;
    function check() {
      if (!document.hidden) void checkActive();
    }
    const interval = window.setInterval(check, 4_000);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", check);
    };
  }, [activeKey, native]);

  return {
    tabs,
    active,
    reveal,
    busy,
    error: error ?? active?.saveError,
    readOnly: operation === "foreground",
    canSave,
    autoSave,
    toggleAutoSave,
    select,
    navigate,
    open,
    openFile,
    newFile,
    createWorkspaceFile,
    renameWorkspaceEntry,
    close,
    closeAll,
    edit,
    save,
    saveAs,
    setLanguage,
    reload,
    changeWorkspace,
  };
}
