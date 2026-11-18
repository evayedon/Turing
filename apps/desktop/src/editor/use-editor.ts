import { useEffect, useEffectEvent, useRef, useState } from "react";
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
  name: string;
  title: string;
  source: SavedSource | { kind: "untitled" };
  content: string;
  draft: string;
  changedOnDisk: boolean;
  saveError?: string;
}

function workspaceTab(file: TextFile): Omit<EditorTab, "key"> {
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

function selectedTab(file: SelectedFileSnapshot): Omit<EditorTab, "key"> {
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

  function update(tab: EditorTab, patch: Partial<EditorTab>) {
    setTabs((previous) =>
      previous.map((item) =>
        item.key === tab.key && item.source === tab.source
          ? { ...item, ...patch }
          : item,
      ),
    );
  }

  async function perform(
    action: () => Promise<void>,
    mode: Operation = "foreground",
  ) {
    if (pending.current) return;
    pending.current = mode;
    setOperation(mode);
    if (mode === "foreground") setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(workspaceErrorMessage(cause));
    } finally {
      pending.current = null;
      setOperation(null);
    }
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

  function addTab(tab: Omit<EditorTab, "key">) {
    const key = String(++tabSequence.current);
    setTabs((previous) => [...previous, { ...tab, key }]);
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
      const key = addTab(workspaceTab(file));
      if (location) setReveal({ key, ...location });
    });
  }

  function openFile() {
    if (!native) return;
    return perform(async () => {
      const file = await invokeWorkspace("file_open", undefined);
      if (!file) return;
      const existing = tabs.find(
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

  function close(tab: EditorTab) {
    return perform(async () => {
      if (tab.draft !== tab.content && !(await confirmDiscard("tab"))) return;
      await releaseFile(tab, tabs);
      const index = tabs.findIndex((item) => item.key === tab.key);
      const remaining = tabs.filter((item) => item.key !== tab.key);
      setTabs(remaining);
      if (activeKey === tab.key) {
        setActiveKey(remaining[Math.min(index, remaining.length - 1)]?.key);
      }
    });
  }

  function edit(tab: EditorTab, draft: string) {
    if (pending.current === "foreground") return;
    // An older draft can finish saving before Monaco delivers its next edit.
    // Apply the edit to the current tab without replacing its saved version.
    setTabs((previous) =>
      previous.map((item) =>
        item.key === tab.key ? { ...item, draft, saveError: undefined } : item,
      ),
    );
  }

  function saveAs() {
    if (!active || !native) return;
    return perform(async () => {
      const file = await invokeWorkspace("file_save_as", {
        content: active.draft,
        suggestedName:
          active.source.kind === "untitled" ? undefined : active.name,
      });
      if (!file) return;
      update(active, {
        ...selectedTab({ ...file, content: active.draft }),
        saveError: undefined,
      });
      if (
        active.source.kind === "selected" &&
        active.source.fileId !== file.fileId
      ) {
        await releaseFile(active, tabs);
      }
    });
  }

  function saveTab(tab: EditorTab, mode: Operation = "foreground") {
    const { source, draft } = tab;
    if (source.kind === "untitled") return;
    return perform(async () => {
      try {
        const version = await writeFile(source, draft);
        update(tab, {
          content: draft,
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
      setTabs((previous) =>
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
    const source = active.source;
    return perform(async () => {
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
      const workspaceTabs = tabs.filter(
        (tab) => tab.source.kind === "workspace",
      );
      if (
        workspaceTabs.some((tab) => tab.draft !== tab.content) &&
        !(await confirmDiscard("workspace"))
      )
        return;
      if (await action()) {
        const remaining = tabs.filter((tab) => tab.source.kind !== "workspace");
        setTabs(remaining);
        if (active?.source.kind === "workspace")
          setActiveKey(remaining.at(-1)?.key);
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

  const onSaveShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (
      native &&
      !(
        event.target instanceof Element &&
        event.target.closest(".terminal-screen")
      ) &&
      !document.querySelector("dialog[open]") &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      event.key.toLowerCase() === "s"
    ) {
      event.preventDefault();
      if (event.shiftKey) void saveAs();
      else void save();
    }
  });

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
    function onKey(event: KeyboardEvent) {
      onSaveShortcut(event);
    }
    if (native) window.addEventListener("turing-close-requested", onClose);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("turing-close-requested", onClose);
      window.removeEventListener("keydown", onKey, true);
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
    open,
    openFile,
    newFile,
    close,
    edit,
    save,
    saveAs,
    reload,
    changeWorkspace,
  };
}
