import {
  Braces,
  CircleDot,
  Folder,
  GitBranch,
  Orbit,
  Search,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { EditorWorkspace } from "../editor/EditorWorkspace";
import type { EditorInfo } from "../editor/editor-info";
import { useEditor } from "../editor/use-editor";
import { Explorer } from "../explorer/Explorer";
import { useExplorer } from "../explorer/use-explorer";
import { SearchPanel } from "../search/SearchPanel";
import { useLayout } from "../state/layout";
import type { DockView } from "../state/dock-views";
import { ActivityBar } from "./ActivityBar";
import type { MenuAction } from "./ActionMenu";
import { BottomDock } from "./BottomDock";
import { CommandPalette } from "./CommandPalette";
import { fileActions, FileMenu } from "./FileMenu";
import { SettingsDialog } from "./SettingsDialog";
import { Splitter } from "./Splitter";
import { usePaneLayout } from "./use-pane-layout";

function Panel({
  title,
  id,
  children,
  className = "",
}: {
  title: string;
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`panel ${className}`} aria-label={title}>
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
  const sidebar = useLayout((state) => state.sidebar);
  const terminal = useLayout((state) => state.terminal);
  const assistant = useLayout((state) => state.assistant);
  const toggleSidebar = useLayout((state) => state.toggleSidebar);
  const toggleTerminal = useLayout((state) => state.toggleTerminal);
  const toggleAssistant = useLayout((state) => state.toggleAssistant);
  const layout = usePaneLayout(!!sidebar, assistant);
  const dockView = useLayout((state) => state.dockView);
  const setDockView = useLayout((state) => state.selectDockView);
  const [settings, setSettings] = useState(false);
  const [palette, setPalette] = useState(false);
  const [info, setInfo] = useState<EditorInfo>();
  const previousFocus = useRef<HTMLElement | null>(null);
  const modifier = /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl";
  const shortcut = `${modifier}+Shift+P`;

  function showPalette() {
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setPalette(true);
  }
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (
        settings ||
        (!event.metaKey && !event.ctrlKey) ||
        !event.shiftKey ||
        event.altKey ||
        event.key.toLowerCase() !== "p" ||
        event.repeat ||
        event.isComposing
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (!palette) showPalette();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [palette, settings]);

  function dismissPalette() {
    setPalette(false);
    if (previousFocus.current?.isConnected) previousFocus.current.focus();
  }

  function revealDock(view: DockView) {
    setDockView(view);
    if (!terminal) toggleTerminal();
  }

  const openFolder = () => editor.changeWorkspace(explorer.open);
  const files = fileActions(
    editor,
    explorer.native,
    !!explorer.busy,
    openFolder,
    modifier,
  );
  const commands: MenuAction[] = [
    ...files,
    {
      label: sidebar === "explorer" ? "Hide Explorer" : "Show Explorer",
      run: () => toggleSidebar("explorer"),
    },
    {
      label:
        terminal && dockView === "Terminal"
          ? "Hide Terminal panel"
          : "Show Terminal panel",
      run:
        terminal && dockView === "Terminal"
          ? toggleTerminal
          : () => revealDock("Terminal"),
    },
    {
      label: sidebar === "search" ? "Hide Search" : "Show Search",
      run: () => toggleSidebar("search"),
    },
    {
      label: sidebar === "git" ? "Hide Source Control" : "Show Source Control",
      run: () => toggleSidebar("git"),
    },
    {
      label: terminal ? "Hide Bottom Panel" : "Show Bottom Panel",
      run: toggleTerminal,
    },
    { label: "Open Settings", run: () => setSettings(true) },
    { label: "Show Problems", run: () => revealDock("Problems") },
    { label: "Show Output", run: () => revealDock("Output") },
    {
      label: assistant ? "Hide Turing AI" : "Show Turing AI",
      run: toggleAssistant,
    },
  ];
  const active = editor.active;
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
            Turing Core
          </h1>
          <FileMenu actions={files} native={explorer.native} />
        </div>
        <button
          type="button"
          className="command-trigger"
          onClick={showPalette}
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
          toggleBottom={toggleTerminal}
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
                  {...explorer}
                  open={openFolder}
                  close={() => editor.changeWorkspace(explorer.close)}
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
                <div className="pane-empty">
                  <GitBranch size={17} aria-hidden="true" />
                  <p>Git integration is unavailable in this build.</p>
                </div>
              </Panel>
            )}
            <Splitter {...layout.splitter("sidebar")} />
          </>
        )}
        <main
          className="editing-area"
          style={
            terminal
              ? {
                  gridTemplateRows: `minmax(0, 1fr) 6px ${layout.visible.terminal}px`,
                }
              : undefined
          }
        >
          <Panel
            title="Editor"
            className={active ? "editor has-document" : "editor"}
          >
            <EditorWorkspace
              {...editor}
              shortcut={shortcut}
              onCommands={showPalette}
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
          {terminal && (
            <>
              <Splitter {...layout.splitter("terminal")} />
              <BottomDock
                active={dockView}
                select={setDockView}
                close={() => {
                  toggleTerminal();
                  document.getElementById("toggle-bottom-panel")?.focus();
                }}
              />
            </>
          )}
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
              <span>
                <Braces size={12} aria-hidden="true" />
                {live.language}
              </span>
            </>
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
        />
      )}
      {palette && (
        <CommandPalette
          actions={commands}
          dismiss={dismissPalette}
          run={(action) => {
            dismissPalette();
            action.run();
          }}
        />
      )}
    </div>
  );
}
