import { ChevronRight, FileCode2, X } from "lucide-react";
import { lazy, Suspense } from "react";
import type { ReactNode } from "react";
import type { EditorCommands } from "../shell/commands";
import type { LanguageController } from "../language/use-language";
import type { Problem } from "../language/problems";
import type { EditorInfo } from "./editor-info";
import type { useEditor } from "./use-editor";

const MonacoHost = lazy(() => import("./MonacoHost"));

export function EditorWorkspace({
  runControls,
  onCommandsReady,
  workspaceId,
  navigate,
  onSaveCommand,
  tabs,
  active,
  reveal,
  busy,
  readOnly,
  error,
  canSave,
  select,
  close,
  edit,
  save,
  saveAs,
  reload,
  onInfo,
  emptyContent,
  language,
  problems,
}: ReturnType<typeof useEditor> & {
  runControls?: ReactNode;
  language?: LanguageController;
  problems?: Problem[];
  workspaceId?: string;
  onCommandsReady?: (commands: EditorCommands | undefined) => void;
  onSaveCommand?: () => void;
  onInfo: (info: EditorInfo) => void;
  emptyContent: ReactNode;
}) {
  return (
    <>
      {tabs.length > 0 && (
        <div className="editor-toolbar">
          <div className="editor-tabs" role="tablist" aria-label="Open files">
            {tabs.map((tab) => {
              const { name } = tab;
              const dirty = tab.draft !== tab.content;
              return (
                <div className="editor-tab" key={tab.key}>
                  <button
                    type="button"
                    role="tab"
                    title={tab.title}
                    aria-selected={active === tab}
                    aria-label={dirty ? `${name} (unsaved)` : name}
                    disabled={busy}
                    tabIndex={active === tab ? 0 : -1}
                    onClick={() => select(tab.key)}
                    onKeyDown={(event) => {
                      const index = tabs.findIndex(
                        (item) => item.key === tab.key,
                      );
                      const next =
                        event.key === "ArrowLeft"
                          ? (index + tabs.length - 1) % tabs.length
                          : event.key === "ArrowRight"
                            ? (index + 1) % tabs.length
                            : event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? tabs.length - 1
                                : undefined;
                      if (next === undefined) return;
                      event.preventDefault();
                      const tablist =
                        event.currentTarget.closest('[role="tablist"]');
                      const buttons =
                        tablist?.querySelectorAll<HTMLButtonElement>(
                          '[role="tab"]',
                        );
                      buttons?.[next]?.focus();
                      select(tabs[next].key);
                    }}
                  >
                    <FileCode2 size={14} aria-hidden="true" />
                    <span>{name}</span>
                    {dirty && (
                      <span className="editor-dirty" aria-hidden="true">
                        {" "}
                        ●
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Close ${name}`}
                    onClick={() => void close(tab)}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            disabled={busy || !canSave}
            onClick={() =>
              onSaveCommand
                ? onSaveCommand()
                : void (active?.source.kind === "untitled" ? saveAs() : save())
            }
          >
            {active?.source.kind === "untitled" ? "Save As…" : "Save"}
          </button>
          {runControls}
        </div>
      )}
      {active && (
        <nav
          className="breadcrumbs"
          aria-label="Active file path"
          title={active.title}
        >
          {(active.source.kind === "workspace"
            ? active.source.relativePath.split("/")
            : [active.name]
          ).map((part, index) => (
            <span key={index}>
              {index > 0 && <ChevronRight size={12} aria-hidden="true" />}
              {part}
            </span>
          ))}
        </nav>
      )}
      {error && (
        <p className="editor-notice" role="alert">
          {error}
        </p>
      )}
      {active?.changedOnDisk && (
        <div className="editor-notice">
          <span>This file changed on disk.</span>
          <button type="button" disabled={busy} onClick={() => void reload()}>
            Reload from disk
          </button>
        </div>
      )}
      {active ? (
        <Suspense
          fallback={
            <p className="panel-message" role="status">
              Loading editor…
            </p>
          }
        >
          <MonacoHost
            active={active}
            reveal={reveal}
            tabs={tabs}
            readOnly={readOnly}
            onChange={edit}
            onInfo={onInfo}
            onCommandsReady={onCommandsReady}
            workspaceId={workspaceId}
            onNavigate={navigate}
            language={language}
            problems={problems}
          />
        </Suspense>
      ) : busy ? (
        <p className="panel-message" role="status">
          Working…
        </p>
      ) : (
        emptyContent
      )}
    </>
  );
}
