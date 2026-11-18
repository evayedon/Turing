import { Files, GitBranch, Orbit, Sparkles, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import { EditorWorkspace } from "../editor/EditorWorkspace";
import { useEditor } from "../editor/use-editor";
import { Explorer } from "../explorer/Explorer";
import { useExplorer } from "../explorer/use-explorer";
import { useLayout } from "../state/layout";
import { FileMenu } from "./FileMenu";

function Panel({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`} aria-label={title}>
      <h2 className="panel-title">{title}</h2>
      {children}
    </section>
  );
}

export function Workbench() {
  const explorer = useExplorer();
  const editor = useEditor(explorer.workspace?.id, explorer.native);
  const {
    sidebar,
    terminal,
    assistant,
    toggleSidebar,
    toggleTerminal,
    toggleAssistant,
  } = useLayout();

  return (
    <div className="workbench">
      <header className="titlebar">
        <div className="titlebar-brand">
          <h1>
            <Orbit size={20} aria-hidden="true" /> Turing Core
          </h1>
          <FileMenu
            editor={editor}
            native={explorer.native}
            folderBusy={!!explorer.busy}
            openFolder={() => editor.changeWorkspace(explorer.open)}
          />
        </div>
        <span>v0.1.0</span>
      </header>

      <div className="workspace">
        <nav className="activity" aria-label="Workbench panels">
          <button
            type="button"
            title="Explorer"
            aria-label="Explorer"
            aria-pressed={sidebar === "explorer"}
            onClick={() => toggleSidebar("explorer")}
          >
            <Files size={20} aria-hidden="true" />
          </button>
          <button
            type="button"
            title="Git"
            aria-label="Git"
            aria-pressed={sidebar === "git"}
            onClick={() => toggleSidebar("git")}
          >
            <GitBranch size={20} aria-hidden="true" />
          </button>
          <button
            type="button"
            title="Terminal"
            aria-label="Terminal"
            aria-pressed={terminal}
            onClick={toggleTerminal}
          >
            <Terminal size={20} aria-hidden="true" />
          </button>
          <button
            type="button"
            title="AI panel"
            aria-label="AI panel"
            aria-pressed={assistant}
            onClick={toggleAssistant}
          >
            <Sparkles size={20} aria-hidden="true" />
          </button>
        </nav>

        {sidebar === "explorer" && (
          <Panel title="Explorer" className="sidebar">
            <Explorer
              {...explorer}
              open={() => editor.changeWorkspace(explorer.open)}
              close={() => editor.changeWorkspace(explorer.close)}
              openFile={editor.open}
              editorBusy={editor.busy}
            />
          </Panel>
        )}
        {sidebar === "git" && (
          <Panel title="Git" className="sidebar">
            <p className="panel-message">No repository open.</p>
          </Panel>
        )}

        <main className="editing-area">
          <Panel title="Editor" className="editor">
            <EditorWorkspace {...editor} />
          </Panel>
          {terminal && (
            <Panel title="Terminal" className="terminal">
              <p className="panel-message">No terminal session.</p>
            </Panel>
          )}
        </main>

        {assistant && (
          <Panel title="AI panel" className="assistant">
            <p className="panel-message">
              AI features are unavailable in v0.1.
            </p>
          </Panel>
        )}
      </div>

      <footer className="statusbar">
        <span>{explorer.workspace?.name ?? "No workspace"}</span>
        <span>Turing Nebula</span>
      </footer>
    </div>
  );
}
