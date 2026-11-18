import {
  CodeXml,
  Files,
  GitBranch,
  Orbit,
  Sparkles,
  Terminal,
} from "lucide-react";
import type { ReactNode } from "react";
import { useLayout } from "../state/layout";

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
        <h1>
          <Orbit size={20} aria-hidden="true" /> Turing Core
        </h1>
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
            <p className="panel-message">No folder open.</p>
          </Panel>
        )}
        {sidebar === "git" && (
          <Panel title="Git" className="sidebar">
            <p className="panel-message">No repository open.</p>
          </Panel>
        )}

        <main className="editing-area">
          <Panel title="Editor" className="editor">
            <div className="editor-empty">
              <CodeXml size={36} aria-hidden="true" />
              <p>No file open</p>
              <span>Monaco editor placeholder</span>
            </div>
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
        <span>No workspace</span>
        <span>Turing Nebula</span>
      </footer>
    </div>
  );
}
