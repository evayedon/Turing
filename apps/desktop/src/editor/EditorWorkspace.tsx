import { CodeXml } from "lucide-react";
import { lazy, Suspense } from "react";
import type { useEditor } from "./use-editor";

const MonacoHost = lazy(() => import("./MonacoHost"));

export function EditorWorkspace({
  tabs,
  active,
  busy,
  readOnly,
  error,
  canSave,
  select,
  close,
  edit,
  save,
  reload,
}: ReturnType<typeof useEditor>) {
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
                    onClick={() => select(tab.key)}
                  >
                    {name}
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
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            disabled={busy || !canSave}
            onClick={() => void save()}
          >
            Save
          </button>
        </div>
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
            tabs={tabs}
            readOnly={readOnly}
            onChange={edit}
          />
        </Suspense>
      ) : (
        <div className="editor-empty">
          <CodeXml size={36} aria-hidden="true" />
          <p>{busy ? "Working…" : "No file open"}</p>
          <span>Use the File menu to open or create a document.</span>
        </div>
      )}
    </>
  );
}
