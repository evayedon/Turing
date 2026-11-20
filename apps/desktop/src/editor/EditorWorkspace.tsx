import { ChevronRight, Columns2, X } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useState } from "react";
import type { ReactNode } from "react";
import type { EditorCommands } from "../shell/commands";
import type { LanguageController } from "../language/use-language";
import type { DiagnosticBatch } from "../language/diagnostic-store";
import type { Problem } from "../language/problems";
import type { EditorInfo } from "./editor-info";
import { openDocuments } from "./editor-groups";
import type { EditorGroup } from "./editor-groups";
import { EditorTabStrip } from "./EditorTabStrip";
import { ModelRegistry } from "./model-registry";
import type { TextModels } from "./MonacoHost";
import type { EditorTab, useEditor } from "./use-editor";

const MonacoHost = lazy(() => import("./MonacoHost"));

type EditorState = ReturnType<typeof useEditor>;

function Breadcrumbs({ tab, label }: { tab: EditorTab; label: string }) {
  return (
    <nav className="breadcrumbs" aria-label={label} title={tab.title}>
      {(tab.source.kind === "workspace"
        ? tab.source.relativePath.split("/")
        : [tab.name]
      ).map((part, index) => (
        <span key={index}>
          {index > 0 && <ChevronRight size={12} aria-hidden="true" />}
          {part}
        </span>
      ))}
    </nav>
  );
}

/**
 * The editor area: one or more side-by-side editor groups. Each group has
 * its own tabs and Monaco view; a document open in several groups shares
 * one text model, held in a registry that lives as long as this component.
 */
export function EditorWorkspace({
  runControls,
  sharedModels,
  onCommandsReady,
  workspaceId,
  navigate,
  onSaveCommand,
  tabs,
  groups,
  active,
  reveal,
  recoveryDrafts,
  recoveryError,
  restoreDraft,
  discardDraft,
  busy,
  readOnly,
  error,
  canSave,
  select,
  close,
  closeGroup,
  focusGroup,
  splitEditor,
  edit,
  save,
  saveAs,
  reload,
  compareDisk,
  keepDraft,
  onInfo,
  emptyContent,
  language,
  problems,
  onMonacoDiagnostics,
}: EditorState & {
  runControls?: ReactNode;
  sharedModels?: TextModels;
  language?: LanguageController;
  problems?: Problem[];
  onMonacoDiagnostics?: (batches: DiagnosticBatch[]) => void;
  workspaceId?: string;
  onCommandsReady?: (commands: EditorCommands | undefined) => void;
  onSaveCommand?: () => void;
  onInfo: (info: EditorInfo) => void;
  emptyContent: ReactNode;
}) {
  const [models] = useState<TextModels>(
    () => sharedModels ?? new ModelRegistry(),
  );
  // Runs after every group's view has switched models, so a model is
  // disposed only once no group lists its document.
  useLayoutEffect(() => {
    models.retain(openDocuments(groups));
  }, [models, groups]);
  useEffect(
    () => () => {
      models.clear();
    },
    [models],
  );
  const multiple = groups.groups.length > 1;

  function pane(group: EditorGroup, index: number) {
    const isActive = group.id === groups.activeGroup;
    const shown = tabs.find(({ key }) => key === group.activeKey);
    const groupTabs = group.keys.flatMap(
      (key) => tabs.find((tab) => tab.key === key) ?? [],
    );
    const number = index + 1;
    return (
      <section
        key={group.id}
        className="editor-group"
        data-editor-group={group.id}
        data-inactive={multiple && !isActive ? "" : undefined}
        aria-label={multiple ? `Editor group ${number}` : undefined}
        onFocus={() => {
          if (!isActive) focusGroup(group.id);
        }}
      >
        {groupTabs.length > 0 && (
          <div className="editor-toolbar">
            <EditorTabStrip
              label={multiple ? `Open files, group ${number}` : "Open files"}
              panelId={`editor-document-${group.id}`}
              tabs={groupTabs}
              active={shown}
              busy={busy}
              select={(key) => select(key, group.id)}
              close={(tab) => close(tab, group.id)}
            />
            <div className="editor-actions">
              <button
                type="button"
                className="editor-icon-button"
                disabled={busy || !shown}
                aria-label="Split Editor Right"
                title="Split Editor Right"
                onClick={() => splitEditor(group.id)}
              >
                <Columns2 size={14} aria-hidden="true" />
              </button>
              {multiple && (
                <button
                  type="button"
                  className="editor-icon-button"
                  disabled={busy}
                  aria-label={`Close editor group ${number}`}
                  title="Close Editor Group"
                  onClick={() => void closeGroup(group.id)}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
              {isActive && (
                <>
                  <button
                    type="button"
                    disabled={busy || !canSave}
                    onClick={() =>
                      onSaveCommand
                        ? onSaveCommand()
                        : void (active?.source.kind === "untitled"
                            ? saveAs()
                            : save())
                    }
                  >
                    {active?.source.kind === "untitled" ? "Save As…" : "Save"}
                  </button>
                  {runControls}
                </>
              )}
            </div>
          </div>
        )}
        {shown && (
          <Breadcrumbs
            tab={shown}
            label={isActive ? "Active file path" : `File path, group ${number}`}
          />
        )}
        {isActive && error && (
          <p className="editor-notice" role="alert">
            {error}
          </p>
        )}
        {shown?.recovered && (
          <p className="editor-notice" role="status">
            {shown.changedOnDisk
              ? "The file on disk changed since this draft was saved. Use Save As to keep a separate copy."
              : shown.source.kind === "untitled"
                ? (shown.recoveryNote ??
                  "Recovered copy. Use Save As to choose where to save it.")
                : "Recovered draft. Save when you are ready to write it to disk."}
          </p>
        )}
        {shown?.changedOnDisk && (
          <>
            <div className="editor-notice editor-conflict">
              <span role="status">
                {shown.deletedOnDisk
                  ? shown.source.kind === "workspace"
                    ? "Deleted on disk. Save can recreate this file after confirmation."
                    : "Deleted on disk. Use Save As to keep a copy."
                  : shown.draft !== shown.content
                    ? shown.keptDraft
                      ? "Draft kept. The disk conflict is still unresolved."
                      : "This file changed on disk. Keep your draft, compare it with disk, or reload and discard your edits."
                    : "This file changed on disk."}
              </span>
              {!shown.deletedOnDisk && (
                <>
                  {shown.draft !== shown.content && !shown.keptDraft && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => keepDraft(shown)}
                    >
                      Keep mine
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void reload(shown)}
                  >
                    Reload from disk
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void compareDisk(shown)}
                  >
                    {shown.diskComparison
                      ? "Close comparison"
                      : "Compare with disk"}
                  </button>
                </>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void saveAs(shown)}
              >
                Save As a copy…
              </button>
            </div>
            {!shown.deletedOnDisk && shown.diskComparison !== undefined && (
              <div
                className="editor-disk-comparison"
                aria-label="Disk comparison"
                role="region"
              >
                <section aria-label="Editor text">
                  <strong>Editor text</strong>
                  <pre tabIndex={0}>{shown.draft}</pre>
                </section>
                <section aria-label="Disk text">
                  <strong>Disk text</strong>
                  <pre tabIndex={0}>{shown.diskComparison.content}</pre>
                </section>
              </div>
            )}
          </>
        )}
        {shown ? (
          <div
            id={`editor-document-${group.id}`}
            role="tabpanel"
            aria-label={shown.name}
            className="editor-document"
          >
            <Suspense
              fallback={
                <p className="panel-message" role="status">
                  Loading editor…
                </p>
              }
            >
              <MonacoHost
                models={models}
                group={group.id}
                primary={index === 0}
                focused={isActive}
                active={shown}
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
                onMonacoDiagnostics={onMonacoDiagnostics}
              />
            </Suspense>
          </div>
        ) : busy ? (
          <p className="panel-message" role="status">
            Working…
          </p>
        ) : (
          emptyContent
        )}
      </section>
    );
  }

  return (
    <>
      {recoveryError && (
        <p className="editor-notice" role="alert">
          {recoveryError}
        </p>
      )}
      {recoveryDrafts.length > 0 && (
        <details className="editor-recovery">
          <summary>Recover unsaved drafts ({recoveryDrafts.length})</summary>
          {recoveryDrafts.some(({ source }) => source.kind === "workspace") && (
            <p>Open the original workspace to restore a draft to its file.</p>
          )}
          <ul>
            {recoveryDrafts.map((entry) => (
              <li key={entry.id}>
                <span
                  title={
                    entry.source.kind === "workspace"
                      ? `${entry.source.root}/${entry.title}`
                      : entry.title
                  }
                >
                  {entry.name}
                  {entry.source.kind === "workspace" && (
                    <small>{entry.source.root}</small>
                  )}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void restoreDraft(entry)}
                >
                  Restore <span className="visually-hidden">{entry.name}</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void discardDraft(entry)}
                >
                  Discard <span className="visually-hidden">{entry.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="editor-groups">{groups.groups.map(pane)}</div>
    </>
  );
}
