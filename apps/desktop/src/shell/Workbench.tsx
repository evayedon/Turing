import {
  CircleDot,
  FilePlus,
  FolderOpen,
  ChevronsLeftRight,
  Folder,
  GitBranch,
  Orbit,
  Search,
  Sparkles,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DirectoryEntry, SidebarView } from "@turing/contracts";
import type { ReactNode } from "react";
import { LanguagePicker } from "../editor/LanguagePicker";
import { EditorWorkspace } from "../editor/EditorWorkspace";
import type { EditorInfo } from "../editor/editor-info";
import { useEditor } from "../editor/use-editor";
import type { ExplorerActions } from "../explorer/Explorer";
import type {
  TerminalSessionControls,
  TerminalSessionLayout,
} from "../terminal/TerminalSessions";
import { Explorer } from "../explorer/Explorer";
import {
  invokeWorkspace,
  workspaceErrorMessage,
} from "../explorer/workspace-ipc";
import { clearRecents, useRecents } from "./recent";
import type { Recent } from "./recent";
import { useExplorer } from "../explorer/use-explorer";
import { GitPanel } from "../git/GitPanel";
import { useGit } from "../git/use-git";
import {
  executionLanguage,
  languageLabels,
  runDisabledReason,
  useExecution,
} from "../execution/use-execution";
import { SearchPanel } from "../search/SearchPanel";
import { useLayout } from "../state/layout";
import type { DockView } from "../state/dock-views";
import { ActivityBar } from "./ActivityBar";
import {
  commandIds,
  dispatch,
  editorCommands,
  matchesShortcut,
  shortcutLabel,
} from "./commands";
import type {
  Command,
  CommandId,
  CommandMetadata,
  CommandHandlers,
  EditorCommands,
  MonacoCommand,
} from "./commands";
import { MenuBar } from "./MenuBar";
import { WorkbenchDialog } from "./WorkbenchDialog";
import { ProblemsPanel } from "../language/ProblemsPanel";
import { compilerProblems } from "../language/problems";
import type { Problem } from "../language/problems";
import { adjacentProblem, orderProblems } from "../language/problem-navigation";
import { useLanguage } from "../language/use-language";
import { BottomDock } from "./BottomDock";
import { CommandPalette } from "./CommandPalette";
import { SettingsDialog } from "./SettingsDialog";
import { Splitter } from "./Splitter";
import { useQuickFiles } from "./use-quick-files";
import { usePaneLayout } from "./use-pane-layout";

function Panel({
  title,
  id,
  children,
  className = "",
  hidden,
}: {
  title: string;
  id?: string;
  children: ReactNode;
  className?: string;
  hidden?: boolean;
}) {
  return (
    <section
      id={id}
      className={`panel ${className}`}
      aria-label={title}
      hidden={hidden}
    >
      <header className="panel-heading">
        <h2>{title}</h2>
      </header>
      {children}
    </section>
  );
}

export function Workbench() {
  const explorer = useExplorer();
  const editor = useEditor(explorer.workspace?.id, explorer.native);
  const git = useGit(explorer.workspace?.id, explorer.native);
  const execution = useExecution();
  const language = useLanguage(
    explorer.workspace?.id,
    explorer.native,
    editor.tabs,
  );
  const problems = useMemo(
    () => [
      ...language.problems,
      ...compilerProblems(execution.run, editor.tabs),
    ],
    [language.problems, execution.run, editor.tabs],
  );
  const tabOrder = editor.tabs.map(({ key }) => key);
  const navigable = orderProblems(problems, tabOrder);
  const lastProblem = useRef<string>(undefined);
  const [problemAnnouncement, setProblemAnnouncement] = useState("");
  function revealProblem(problem: Problem) {
    const tab = editor.tabs.find(({ key }) => key === problem.tabKey);
    if (!tab) return;
    lastProblem.current = problem.id;
    const line = problem.start.line + 1;
    const column = problem.start.character + 1;
    editor.navigate({ tab }, { line, column });
    const order = navigable.findIndex(({ id }) => id === problem.id);
    const severity =
      problem.severity === "error"
        ? "Error"
        : problem.severity === "warning"
          ? "Warning"
          : "Info";
    setProblemAnnouncement(
      `${severity} ${order + 1} of ${navigable.length}: ${problem.message} (${problem.filename}:${line}:${column})`,
    );
  }
  function goToProblem(direction: 1 | -1) {
    const position = active && editorCommandsReady?.position();
    const cursor =
      active && position
        ? {
            tabKey: active.key,
            line: position.line - 1,
            character: position.column - 1,
          }
        : undefined;
    const target = adjacentProblem(
      problems,
      tabOrder,
      cursor,
      direction,
      lastProblem.current,
    );
    if (target) revealProblem(target);
  }
  const sidebar = useLayout((state) => state.sidebar);
  const terminal = useLayout((state) => state.terminal);
  const assistant = useLayout((state) => state.assistant);
  const toggleSidebar = useLayout((state) => state.toggleSidebar);
  const toggleTerminal = useLayout((state) => state.toggleTerminal);
  const toggleAssistant = useLayout((state) => state.toggleAssistant);
  const layout = usePaneLayout(!!sidebar, assistant);
  const dockView = useLayout((state) => state.dockView);
  const setDockView = useLayout((state) => state.selectDockView);
  const [terminalActivation, setTerminalActivation] = useState(0);
  const [settings, setSettings] = useState(false);
  const [dockMaximized, setDockMaximized] = useState(false);
  const [problemSeverity, setProblemSeverity] = useState("all");
  const [popup, setPopup] = useState<
    "commands" | "files" | "line" | "shortcuts" | "about" | "recent"
  >();
  const [lineInput, setLineInput] = useState("");
  const [editorCommandsReady, setEditorCommands] = useState<EditorCommands>();
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [terminalLayout, setTerminalLayout] = useState<TerminalSessionLayout>({
    count: 1,
    split: false,
  });
  const [windowError, setWindowError] = useState<string>();
  const recents = useRecents();
  const [focusedEntry, setFocusedEntry] = useState<{
    workspaceId?: string;
    entry: DirectoryEntry;
  }>();
  const explorerActions = useRef<ExplorerActions>(null);
  const terminalActions = useRef<TerminalSessionControls>(null);
  const lastSidebar = useRef<SidebarView>("explorer");
  const pendingCreate = useRef(false);
  const [info, setInfo] = useState<EditorInfo>();
  const previousFocus = useRef<HTMLElement | null>(null);
  const modifier = /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl";
  const shortcut = `${modifier}+Shift+P`;

  const openPopup = useCallback((kind: NonNullable<typeof popup>) => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setPopup(kind);
  }, []);

  function dismissPopup() {
    setPopup(undefined);
    if (previousFocus.current?.isConnected) previousFocus.current.focus();
  }

  function selectSidebar(view: NonNullable<typeof sidebar>) {
    if (sidebar !== view) toggleSidebar(view);
  }

  useEffect(() => {
    if (sidebar) lastSidebar.current = sidebar;
    if (sidebar === "explorer" && pendingCreate.current) {
      pendingCreate.current = false;
      explorerActions.current?.create();
    }
  }, [sidebar]);

  function selectDock(view: DockView) {
    setDockView(view);
    if (view === "Terminal") setTerminalActivation((previous) => previous + 1);
  }

  function showDock(view: DockView) {
    setDockView(view);
    if (!terminal) toggleTerminal();
  }

  function revealDock(view: DockView) {
    showDock(view);
    if (view === "Terminal") setTerminalActivation((previous) => previous + 1);
  }

  function toggleBottomFromControl() {
    if (terminal) toggleTerminal();
    else revealDock(dockView);
  }

  const active = editor.active;
  const runLanguage = active && executionLanguage(active.name);
  const cannotRun = active && runDisabledReason(active, explorer.native);
  const openFolder = () => editor.changeWorkspace(explorer.open);
  const terminalSelected = terminal && dockView === "Terminal";
  const native = explorer.native;
  const workspaceBusy = !!explorer.busy || editor.busy;
  const focused =
    focusedEntry && focusedEntry.workspaceId === explorer.workspace?.id
      ? focusedEntry.entry
      : undefined;
  const selectedEntry =
    focused &&
    [...explorer.folders.values()]
      .flat()
      .find(
        (entry) =>
          entry.relativePath === focused.relativePath &&
          entry.identity === focused.identity,
      );
  const createWorkspaceFromMenu = useCallback(() => {
    if (sidebar === "explorer") explorerActions.current?.create();
    else {
      pendingCreate.current = true;
      toggleSidebar("explorer");
    }
  }, [sidebar, toggleSidebar]);
  const renameFromMenu = useCallback(() => {
    if (selectedEntry) explorerActions.current?.rename(selectedEntry);
  }, [selectedEntry]);
  const toggleSidebarFromMenu = useCallback(
    () => toggleSidebar(sidebar ?? lastSidebar.current),
    [sidebar, toggleSidebar],
  );
  const closeTerminalFromMenu = useCallback(
    () => terminalActions.current?.close(),
    [],
  );
  const clearTerminalFromMenu = useCallback(
    () => terminalActions.current?.clear(),
    [],
  );
  async function newWindow(
    kind: "window_new_workbench" | "window_new_terminal",
  ) {
    setWindowError(undefined);
    try {
      await invokeWorkspace(kind, undefined);
    } catch (error) {
      setWindowError(workspaceErrorMessage(error));
    }
  }

  function reopen(entry: Recent) {
    if (!native || workspaceBusy) return;
    if (entry.kind === "workspace")
      void editor.changeWorkspace(() => explorer.open(entry.path));
    else void editor.openFile(entry.path);
  }

  const createTerminalSession = useCallback(
    (split: boolean) => {
      setDockView("Terminal");
      if (!terminal) toggleTerminal();
      terminalActions.current?.create(split);
    },
    [setDockView, terminal, toggleTerminal],
  );

  const editorOnly: Record<
    MonacoCommand,
    Omit<Command, "run">
  > = Object.fromEntries(
    (Object.keys(editorCommands) as MonacoCommand[]).map((id) => {
      const { label, edit, hint } = editorCommands[id];
      return [
        id,
        {
          label,
          hint: hint?.(modifier),
          hidden: id === "symbol" && !editorCommandsReady?.supports(id),
          shortcut:
            id === "definition" || id === "references"
              ? { key: "F12", shift: id === "references" }
              : undefined,
          disabled:
            !active ||
            !editorCommandsReady?.supports(id) ||
            (!!edit && editor.readOnly),
        },
      ];
    }),
  ) as Record<MonacoCommand, Omit<Command, "run">>;
  const editorHandlers = Object.fromEntries(
    (Object.keys(editorCommands) as MonacoCommand[]).map((id) => [
      id,
      () => editorCommandsReady?.run(id),
    ]),
  ) as Record<MonacoCommand, () => void>;
  const commands: CommandMetadata = {
    ...editorOnly,
    newWindow: {
      label: "New Window",
      disabled: !native,
      shortcut: { key: "n", primary: true, shift: true },
    },
    openRecent: { label: "Open Recent…", disabled: !native || workspaceBusy },
    clearRecent: {
      label: "Clear Recent History",
      disabled: recents.length === 0,
    },
    newTerminal: {
      label: "New Terminal",
      disabled: !native || terminalLayout.count >= 4,
      shortcut: { key: "`", code: "Backquote", ctrl: true, shift: true },
    },
    splitTerminal: {
      label: "Split Terminal",
      disabled: !native || terminalLayout.split || terminalLayout.count >= 4,
    },
    terminalWindow: { label: "New Terminal Window", disabled: !native },
    newText: {
      label: "New Text File",
      disabled: editor.busy,
    },
    newWorkspace: {
      label: "New Workspace File",
      disabled: !explorer.workspace || workspaceBusy,
    },
    openFile: {
      label: "Open File",
      disabled: !native || editor.busy,
    },
    openFolder: {
      label: "Open Folder",
      disabled: !native || workspaceBusy,
    },
    save: {
      label: "Save",
      disabled: !editor.canSave || editor.busy,
      shortcut: { key: "s", primary: true },
    },
    saveAs: {
      label: "Save As",
      disabled: !native || !active || editor.busy,
      shortcut: { key: "s", primary: true, shift: true },
    },
    autoSave: {
      label: "Auto Save",
      disabled: !native,
      pressed: editor.autoSave,
    },
    rename: {
      label: "Rename Explorer Item",
      disabled:
        sidebar !== "explorer" || !selectedEntry?.identity || workspaceBusy,
      hint: "F2",
    },
    closeEditor: {
      label: "Close Editor",
      disabled: !active || editor.busy,
    },
    closeAll: {
      label: "Close All Editors",
      disabled: !editor.tabs.length || editor.busy,
    },
    explorer: { label: "Show Explorer" },
    search: { label: "Show Search" },
    sidebar: {
      label: "Toggle Sidebar",
    },
    dock: {
      label: terminal ? "Hide Bottom Panel" : "Show Bottom Panel",
    },
    showTerminal: { label: "Show Terminal" },
    output: { label: "Show Output" },
    problems: { label: "Show Problems" },
    palette: {
      label: "Command Palette",
      shortcut: { key: "p", primary: true, shift: true },
    },
    settings: { label: "Open Settings" },
    sourceControl: {
      label: sidebar === "git" ? "Hide Source Control" : "Show Source Control",
    },
    assistant: {
      label: assistant ? "Hide Turing AI" : "Show Turing AI",
    },
    goFile: {
      label: "Go to File…",
      disabled: editor.busy || (!native && !editor.tabs.length),
      shortcut: { key: "p", primary: true },
    },
    goLine: {
      label: "Go to Line/Column…",
      disabled: !active || !editorCommandsReady,
    },
    nextProblem: {
      label: "Next Problem",
      shortcut: { key: "F8" },
      disabled: !navigable.length,
    },
    previousProblem: {
      label: "Previous Problem",
      shortcut: { key: "F8", shift: true },
      disabled: !navigable.length,
    },
    run: {
      label: "Run Without Debugging",
      shortcut: { key: "F5" },
      disabled: !active || editor.busy || execution.busy || !!cannotRun,
    },
    stop: {
      label: "Stop Execution",
      disabled: !execution.busy || execution.run?.phase === "stopping",
    },
    openTerminal: {
      label: "Open Terminal",
      disabled: !native,
      shortcut: { key: "`", ctrl: true },
    },
    closeTerminal: {
      label: "Close Terminal",
      disabled: !terminalRunning,
    },
    clearTerminal: {
      label: "Clear Terminal",
      disabled: !terminalRunning,
    },
    hideTerminal: {
      label: "Hide Terminal panel",
      disabled: !terminalSelected,
    },
    shortcuts: {
      label: "Keyboard Shortcuts",
    },
    about: { label: "About Turing" },
  };
  const handlers: CommandHandlers = {
    ...editorHandlers,
    newWindow: () => void newWindow("window_new_workbench"),
    openRecent: () => openPopup("recent"),
    clearRecent: clearRecents,
    newTerminal: () => createTerminalSession(false),
    splitTerminal: () => createTerminalSession(true),
    terminalWindow: () => void newWindow("window_new_terminal"),
    newText: editor.newFile,
    newWorkspace: createWorkspaceFromMenu,
    openFile: editor.openFile,
    openFolder: openFolder,
    save: editor.save,
    saveAs: editor.saveAs,
    autoSave: editor.toggleAutoSave,
    rename: renameFromMenu,
    closeEditor: () => {
      if (active) void editor.close(active);
    },
    closeAll: editor.closeAll,
    explorer: () => selectSidebar("explorer"),
    search: () => selectSidebar("search"),
    sidebar: toggleSidebarFromMenu,
    dock: toggleBottomFromControl,
    showTerminal: () => showDock("Terminal"),
    output: () => showDock("Output"),
    problems: () => showDock("Problems"),
    palette: () => openPopup("commands"),
    settings: () => setSettings(true),
    sourceControl: () => toggleSidebar("git"),
    assistant: toggleAssistant,
    goFile: () => openPopup("files"),
    goLine: () => {
      setLineInput("");
      openPopup("line");
    },
    nextProblem: () => goToProblem(1),
    previousProblem: () => goToProblem(-1),
    run: () => {
      if (active)
        void execution.start(active, native, () => showDock("Output"));
    },
    stop: execution.stop,
    openTerminal: () => revealDock("Terminal"),
    closeTerminal: closeTerminalFromMenu,
    clearTerminal: clearTerminalFromMenu,
    hideTerminal: toggleTerminal,
    shortcuts: () => openPopup("shortcuts"),
    about: () => openPopup("about"),
  };
  const runCommand = (id: CommandId) => dispatch(commands, handlers, id);

  const paletteActions: (Omit<Command, "run"> & { id: CommandId })[] = [];
  for (const id of commandIds) {
    const { label, disabled, hidden, hint, shortcut } = commands[id];
    paletteActions.push({
      id,
      label,
      disabled,
      hidden,
      shortcut,
      hint: shortcut ? shortcutLabel(shortcut, modifier) : hint,
    });
  }
  const quickFiles = useQuickFiles(
    popup === "files" ? explorer.workspace?.id : undefined,
    popup === "files",
  );
  const fileActions: {
    label: string;
    key?: string;
    path?: string;
    disabled?: boolean;
  }[] = [];
  if (popup === "files") {
    const openPaths = new Set(
      editor.tabs.flatMap((tab) =>
        tab.source.kind === "workspace" ? [tab.source.relativePath] : [],
      ),
    );
    fileActions.push(
      ...editor.tabs.map(({ title, key }) => ({
        label: title,
        key,
      })),
    );
    const cached = [...explorer.folders.values()]
      .flat()
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.relativePath);
    for (const path of new Set([...cached, ...(quickFiles?.paths ?? [])])) {
      if (!openPaths.has(path)) fileActions.push({ label: path, path });
    }
    if (native)
      fileActions.push({
        label: "Browse for a file…",
        disabled: !native || editor.busy,
      });
  }

  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (
      popup ||
      settings ||
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      document.querySelector("dialog[open]")
    )
      return;
    const binding = paletteActions.find(
      (command) => command.shortcut && matchesShortcut(event, command.shortcut),
    );
    if (!binding) return;
    const { id, disabled } = binding;
    const inTerminal =
      event.target instanceof Element &&
      event.target.closest(".terminal-screen");
    if (
      inTerminal &&
      id !== "openTerminal" &&
      id !== "newTerminal" &&
      id !== "palette"
    )
      return;
    if (!native && id === "run") return;
    if (disabled && id !== "run") return;
    event.preventDefault();
    event.stopPropagation();
    runCommand(id);
  });

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => onShortcut(event);
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, []);

  const live = active && info?.key === active.key ? info : undefined;
  const changed = active && active.draft !== active.content;
  const source = active?.source;
  const saveState = editor.busy
    ? "Working…"
    : active?.changedOnDisk
      ? "Disk changed"
      : active?.saveError
        ? "Save failed"
        : changed
          ? "Unsaved"
          : source?.kind === "untitled"
            ? "Untitled"
            : active
              ? "Saved"
              : null;

  return (
    <div className="workbench">
      <header className="titlebar">
        <div className="titlebar-brand">
          <h1>
            <span className="brand-mark">
              <Orbit size={17} aria-hidden="true" />
            </span>
            <span className="brand-name">Turing Core</span>
          </h1>
          <MenuBar commands={commands} modifier={modifier} onRun={runCommand} />
        </div>
        <button
          type="button"
          className="command-trigger"
          onClick={() => runCommand("palette")}
          title={`Command palette (${shortcut})`}
          aria-label="Open command palette"
        >
          <Search size={15} />
          <span>Commands</span>
          <kbd>{shortcut}</kbd>
        </button>
        <span className="version">v0.1.0</span>
      </header>
      <div
        className="workspace"
        style={{
          gridTemplateColumns: `46px ${sidebar ? `${layout.visible.sidebar}px 6px ` : ""}minmax(0, 1fr)${assistant ? ` 6px ${layout.visible.assistant}px` : ""}`,
        }}
      >
        <ActivityBar
          sidebar={sidebar}
          assistant={assistant}
          bottom={terminal}
          toggleSidebar={toggleSidebar}
          toggleAssistant={toggleAssistant}
          toggleBottom={toggleBottomFromControl}
          openSettings={() => setSettings(true)}
        />
        {sidebar && (
          <>
            {sidebar === "explorer" ? (
              <Panel
                id="workbench-sidebar"
                title="Explorer"
                className="sidebar"
              >
                <Explorer
                  key={explorer.workspace?.id}
                  {...explorer}
                  actionsRef={explorerActions}
                  onSelectEntry={(entry) =>
                    setFocusedEntry({
                      workspaceId: explorer.workspace?.id,
                      entry,
                    })
                  }
                  open={openFolder}
                  close={() => editor.changeWorkspace(explorer.close)}
                  createFile={async (parent, name) => {
                    const path = await editor.createWorkspaceFile(parent, name);
                    if (path) await explorer.refresh(parent);
                    return path;
                  }}
                  renameEntry={async (entry, name) => {
                    if (!entry.identity) return;
                    const path = await editor.renameWorkspaceEntry(
                      entry.relativePath,
                      name,
                      entry.identity,
                    );
                    if (path) explorer.renamed(entry.relativePath, path, name);
                    return path;
                  }}
                  openFile={editor.open}
                  editorBusy={editor.busy}
                  activeFile={
                    source?.kind === "workspace"
                      ? source.relativePath
                      : undefined
                  }
                />
              </Panel>
            ) : sidebar === "search" ? (
              <Panel id="workbench-sidebar" title="Search" className="sidebar">
                <SearchPanel
                  native={explorer.native}
                  workspaceId={explorer.workspace?.id}
                  editorBusy={editor.busy}
                  open={editor.open}
                />
              </Panel>
            ) : (
              <Panel
                id="workbench-sidebar"
                title="Source Control"
                className="sidebar"
              >
                <GitPanel
                  git={git}
                  editorBusy={editor.busy}
                  openFile={editor.open}
                />
              </Panel>
            )}
            <Splitter {...layout.splitter("sidebar")} />
          </>
        )}
        <main
          className="editing-area"
          style={
            terminal && !dockMaximized
              ? {
                  gridTemplateRows: `minmax(0, 1fr) 6px ${layout.visible.terminal}px`,
                }
              : undefined
          }
        >
          <Panel
            title="Editor"
            hidden={terminal && dockMaximized}
            className={active ? "editor has-document" : "editor"}
          >
            {windowError && (
              <p role="alert" className="editor-notice">
                {windowError}
              </p>
            )}
            <EditorWorkspace
              {...editor}
              language={language}
              problems={problems}
              workspaceId={explorer.workspace?.id}
              onCommandsReady={setEditorCommands}
              onSaveCommand={() => runCommand("save")}
              runControls={
                active && (
                  <div className="editor-run" title={cannotRun || undefined}>
                    {runLanguage && <span>{languageLabels[runLanguage]}</span>}
                    {execution.busy ? (
                      <>
                        <span>{execution.run?.phase}</span>
                        <button
                          type="button"
                          disabled={commands.stop.disabled}
                          onClick={() => runCommand("stop")}
                        >
                          Stop
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        aria-keyshortcuts="F5"
                        aria-description={cannotRun || undefined}
                        title={cannotRun || "Run File (F5)"}
                        disabled={commands.run.disabled}
                        onClick={() => runCommand("run")}
                      >
                        Run File
                      </button>
                    )}
                  </div>
                )
              }
              emptyContent={
                <div className="editor-empty">
                  <section aria-label="Start">
                    <h3>Start</h3>
                    <button
                      type="button"
                      disabled={commands.newText.disabled}
                      onClick={() => runCommand("newText")}
                    >
                      <FilePlus size={16} aria-hidden="true" /> New File…
                    </button>
                    <button
                      type="button"
                      disabled={commands.openFolder.disabled}
                      onClick={() => runCommand("openFolder")}
                    >
                      <FolderOpen size={16} aria-hidden="true" /> Open…
                    </button>
                    <button
                      type="button"
                      disabled
                      title="Cloning repositories is unavailable"
                    >
                      <GitBranch size={16} aria-hidden="true" /> Clone Git
                      Repository…
                    </button>
                    <button
                      type="button"
                      disabled
                      title="Remote connections are unavailable"
                    >
                      <ChevronsLeftRight size={16} aria-hidden="true" /> Connect
                      to…
                    </button>
                  </section>
                  <section aria-label="Recent">
                    <h3>Recent</h3>
                    {recents.slice(0, 5).map((entry) => (
                      <button
                        type="button"
                        key={`${entry.kind}:${entry.path}`}
                        disabled={commands.openRecent.disabled}
                        onClick={() => reopen(entry)}
                        title={entry.path}
                      >
                        <span>{entry.name}</span>
                        <small>{entry.path}</small>
                      </button>
                    ))}
                    {!recents.length && <p>No recent files or folders.</p>}
                    {recents.length > 0 && (
                      <button
                        type="button"
                        disabled={commands.openRecent.disabled}
                        onClick={() => runCommand("openRecent")}
                      >
                        More…
                      </button>
                    )}
                  </section>
                </div>
              }
              onInfo={(next) => {
                setInfo((old) =>
                  old?.key === next.key &&
                  old.language === next.language &&
                  old.line === next.line &&
                  old.column === next.column &&
                  old.eol === next.eol
                    ? old
                    : next,
                );
              }}
            />
          </Panel>
          {terminal && !dockMaximized && (
            <Splitter {...layout.splitter("terminal")} />
          )}
          <BottomDock
            execution={execution}
            problems={
              <ProblemsPanel
                problems={problems}
                filter={problemSeverity}
                open={revealProblem}
              />
            }
            visible={terminal}
            active={dockView}
            native={explorer.native}
            workspaceId={explorer.workspace?.id}
            terminalActivation={terminalActivation}
            terminalActions={terminalActions}
            onTerminalRunning={setTerminalRunning}
            onTerminalLayout={setTerminalLayout}
            select={selectDock}
            maximized={dockMaximized}
            toggleMaximized={() => setDockMaximized((value) => !value)}
            close={() => {
              setDockMaximized(false);
              toggleTerminal();
              document.getElementById("toggle-bottom-panel")?.focus();
            }}
          />
        </main>
        {assistant && (
          <>
            <Splitter {...layout.splitter("assistant")} />
            <Panel id="turing-ai-panel" title="Turing AI" className="assistant">
              <div className="pane-empty">
                <Sparkles size={20} aria-hidden="true" />
                <p>AI features are unavailable in v0.1.</p>
              </div>
            </Panel>
          </>
        )}
      </div>
      <footer className="statusbar" aria-label="Workbench status">
        <div className="status-main">
          <span title={explorer.workspace?.name}>
            <Folder size={13} aria-hidden="true" />
            {explorer.workspace?.name ?? "No workspace"}
          </span>
          {git.status && (
            <span
              className="status-branch"
              title={
                git.status.branch
                  ? `Branch ${git.status.branch}`
                  : "Detached HEAD"
              }
            >
              <GitBranch size={13} aria-hidden="true" />
              {git.status.branch ?? "detached"}
              {git.status.entries.length > 0 && "*"}
            </span>
          )}
          {active && <span title={active.title}>{active.name}</span>}
          {saveState && (
            <span className={changed ? "status-dirty" : ""}>
              <CircleDot size={11} aria-hidden="true" />
              {saveState}
            </span>
          )}
        </div>
        <div className="status-detail">
          {editor.autoSave && <span>Auto Save</span>}
          {live && (
            <>
              <span>
                Ln {live.line}, Col {live.column}
              </span>
              <span>{live.eol}</span>
            </>
          )}
          {active && (
            <LanguagePicker
              key={active.key}
              tab={active}
              select={editor.setLanguage}
            />
          )}
        </div>
      </footer>
      {settings && (
        <SettingsDialog
          close={() => setSettings(false)}
          native={explorer.native}
          autoSave={editor.autoSave}
          toggleAutoSave={editor.toggleAutoSave}
          bottom={terminal}
          assistant={assistant}
          toggleBottom={toggleTerminal}
          toggleAssistant={toggleAssistant}
          resetSizes={layout.resetSizes}
          language={language}
          workspaceId={explorer.workspace?.id}
          severity={problemSeverity}
          setSeverity={setProblemSeverity}
        />
      )}
      {popup === "commands" && (
        <CommandPalette
          actions={paletteActions}
          dismiss={dismissPopup}
          run={(action) => {
            dismissPopup();
            runCommand(action.id);
          }}
        />
      )}
      {popup === "files" && (
        <CommandPalette
          actions={fileActions}
          title="Go to File"
          inputLabel="Search files"
          placeholder="Search workspace files and open editors…"
          notice={
            explorer.workspace
              ? quickFiles?.limited
                ? "Some folders were not indexed. Browse for a file to access it."
                : quickFiles
                  ? undefined
                  : "Indexing workspace files…"
              : undefined
          }
          dismiss={dismissPopup}
          run={(action) => {
            dismissPopup();
            if (action.disabled) return;
            if (action.key) editor.select(action.key);
            else if (action.path) void editor.open(action.path);
            else runCommand("openFile");
          }}
        />
      )}
      {popup === "recent" && (
        <CommandPalette
          actions={[
            ...recents.map((entry) => ({
              label: `${entry.name} · ${entry.path}`,
              entry,
            })),
            {
              label: "Clear Recent History",
              entry: undefined,
              disabled: !recents.length,
            },
          ]}
          title="Open Recent"
          inputLabel="Search recent files and workspaces"
          placeholder="Search recent files and workspaces…"
          notice={
            recents.length
              ? "Choose an entry to open its native picker."
              : "Recent files and workspaces appear here after you open or save them."
          }
          dismiss={dismissPopup}
          run={(action) => {
            dismissPopup();
            if (action.entry) reopen(action.entry);
            else runCommand("clearRecent");
          }}
        />
      )}
      {popup === "line" && (
        <WorkbenchDialog title="Go to Line/Column" close={dismissPopup}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const match = /^([1-9]\d*)(?::([1-9]\d*))?$/.exec(
                lineInput.trim(),
              );
              if (!match) return;
              const line = Number(match[1]);
              const column = Number(match[2] ?? 1);
              if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column))
                return;
              event.currentTarget.closest("dialog")?.close?.();
              dismissPopup();
              editorCommandsReady?.reveal(line, column);
            }}
          >
            <input
              data-initial-focus
              aria-label="Line and column"
              placeholder="Line or line:column"
              pattern="[1-9][0-9]*(:[1-9][0-9]*)?"
              required
              value={lineInput}
              onChange={(event) => setLineInput(event.target.value)}
            />
            <button type="submit" className="quiet-button">
              Go
            </button>
          </form>
        </WorkbenchDialog>
      )}
      {popup === "shortcuts" && (
        <WorkbenchDialog title="Keyboard Shortcuts" close={dismissPopup}>
          <dl className="shortcut-list">
            {paletteActions
              .filter((command) => command.hint)
              .map(({ id, label, hint }) => (
                <div key={id}>
                  <dt>{label}</dt>
                  <dd>
                    <kbd>{hint}</kbd>
                  </dd>
                </div>
              ))}
          </dl>
        </WorkbenchDialog>
      )}
      {popup === "about" && (
        <WorkbenchDialog title="About Turing" close={dismissPopup}>
          <p>Turing Core v0.1.0</p>
          <p>
            Desktop code editor with workspace search, an integrated terminal,
            and Python and C++ Run &amp; Build.
          </p>
        </WorkbenchDialog>
      )}
      <p
        className="visually-hidden"
        role="status"
        aria-label="Problem navigation"
      >
        {problemAnnouncement}
      </p>
    </div>
  );
}
