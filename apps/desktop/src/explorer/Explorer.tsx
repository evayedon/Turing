import {
  ArrowUp,
  ChevronRight,
  FileCode2,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderSync,
  RotateCw,
  X,
} from "lucide-react";
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Ref } from "react";
import type { DirectoryEntry } from "@turing/contracts";
import type { useExplorer } from "./use-explorer";

export type ExplorerActions = {
  create: () => void;
  rename: (entry: DirectoryEntry) => void;
};

type Props = Omit<
  ReturnType<typeof useExplorer>,
  "open" | "close" | "refresh" | "renamed"
> & {
  open: () => void;
  close: () => void;
  openFile: (path: string) => void;
  editorBusy: boolean;
  activeFile?: string;
  actionsRef?: Ref<ExplorerActions>;
  onSelectEntry?: (entry: DirectoryEntry) => void;
  createFile?: (parent: string, name: string) => Promise<string | undefined>;
  renameEntry?: (
    entry: DirectoryEntry,
    name: string,
  ) => Promise<string | undefined>;
};

export function Explorer({
  native,
  workspace,
  relativePath,
  folders,
  busy,
  error,
  open,
  close,
  browse,
  openFile,
  editorBusy,
  activeFile,
  createFile,
  actionsRef,
  onSelectEntry,
  renameEntry,
}: Props) {
  const [naming, setNaming] = useState<{
    entry?: DirectoryEntry;
    value: string;
  }>();
  const [context, setContext] = useState<string>();
  const focusPath = useRef<string | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const submitInProgress = useRef(false);
  const createButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!focusPath.current || editorBusy) return;
    const row = [
      ...(root.current?.querySelectorAll<HTMLButtonElement>(".tree-row") ?? []),
    ].find((button) => button.dataset.path === focusPath.current);
    if (row) {
      row.focus();
      focusPath.current = undefined;
    }
  }, [naming, context, folders, editorBusy]);

  function startRename(entry: DirectoryEntry) {
    if (!renameEntry || !entry.identity || editorBusy || busy) return;
    setContext(undefined);
    setNaming({ entry, value: entry.name });
  }

  function startCreate() {
    if (!createFile || editorBusy || busy) return;
    setContext(undefined);
    setNaming({ value: "" });
  }

  useImperativeHandle(actionsRef, () => ({
    create: startCreate,
    rename: startRename,
  }));

  const entry = naming?.entry;
  const value = naming?.value ?? "";
  const nameInput = naming ? (
    <form
      className="tree-name-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (submitInProgress.current || !value || editorBusy || busy) return;
        submitInProgress.current = true;
        try {
          const next = entry
            ? await renameEntry?.(entry, value)
            : await createFile?.(relativePath, value);
          if (next) {
            setNaming(undefined);
            if (entry) focusPath.current = next;
          }
        } finally {
          submitInProgress.current = false;
        }
      }}
    >
      <input
        autoFocus
        aria-label={entry ? "Rename entry" : "New filename"}
        placeholder={!entry ? "Filename with extension" : undefined}
        value={value}
        readOnly={editorBusy}
        maxLength={255}
        required
        onFocus={(event) => event.target.select()}
        onChange={(event) => setNaming({ entry, value: event.target.value })}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || submitInProgress.current) return;
          event.preventDefault();
          event.stopPropagation();
          setNaming(undefined);
          if (entry) focusPath.current = entry.relativePath;
          else createButton.current?.focus();
        }}
      />
      {!entry && (
        <button
          className="quiet-button"
          disabled={!value || editorBusy}
          type="submit"
        >
          Create
        </button>
      )}
    </form>
  ) : null;

  const parent = relativePath.slice(
    0,
    Math.max(0, relativePath.lastIndexOf("/")),
  );
  const disabled = !!busy || editorBusy;

  if (!native)
    return (
      <div className="pane-empty">
        <Folder size={21} aria-hidden="true" />
        <p>Native workspace access is unavailable.</p>
        <span>Open the desktop app to browse folders.</span>
      </div>
    );

  function branch(path: string, depth: number) {
    return (
      <ul
        className="explorer-entries"
        aria-label={depth === 0 ? "Directory entries" : undefined}
      >
        {(folders.get(path) ?? []).map((entry) => {
          const { relativePath: entryPath, name } = entry;
          const folder = entry.kind === "directory";
          const expanded =
            folder &&
            (relativePath === entryPath ||
              relativePath.startsWith(`${entryPath}/`));
          const selected = !folder && activeFile === entryPath;
          const Icon = folder
            ? expanded
              ? FolderOpen
              : Folder
            : /\.(md|txt)$/i.test(name)
              ? FileText
              : FileCode2;
          return (
            <li key={entryPath}>
              <div className="tree-line">
                {naming?.entry?.relativePath === entryPath ? (
                  nameInput
                ) : (
                  <button
                    type="button"
                    className="tree-row"
                    title={entryPath}
                    aria-expanded={folder ? expanded : undefined}
                    aria-current={selected ? "true" : undefined}
                    aria-label={folder ? `${name}/` : name}
                    disabled={editorBusy}
                    data-parent={path}
                    data-path={entryPath}
                    style={{ paddingInlineStart: 8 + depth * 13 }}
                    onFocus={() => onSelectEntry?.(entry)}
                    onContextMenu={(event) => {
                      if (!renameEntry || !entry.identity || disabled) return;
                      event.preventDefault();
                      onSelectEntry?.(entry);
                      setContext(entryPath);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "F2") {
                        event.preventDefault();
                        startRename(entry);
                      }
                    }}
                    onClick={() => {
                      if (busy) return;
                      if (folder) void browse(expanded ? path : entryPath);
                      else openFile(entryPath);
                    }}
                  >
                    {folder ? (
                      <ChevronRight
                        className="tree-chevron"
                        size={12}
                        aria-hidden="true"
                      />
                    ) : (
                      <span className="tree-spacer" />
                    )}
                    <Icon
                      size={15}
                      aria-hidden="true"
                      className={folder ? "folder-icon" : "file-icon"}
                    />
                    <span>{name}</span>
                  </button>
                )}
                {context === entryPath && (
                  <button
                    type="button"
                    className="quiet-button tree-context-rename"
                    autoFocus
                    onClick={() => startRename(entry)}
                    onBlur={() => setContext(undefined)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setContext(undefined);
                        focusPath.current = entryPath;
                      }
                    }}
                  >
                    Rename
                  </button>
                )}
                {expanded && relativePath === entryPath && (
                  <button
                    type="button"
                    className="icon-button tree-action"
                    title={`Refresh ${name}`}
                    aria-label={`Refresh ${name}`}
                    disabled={disabled}
                    onClick={() => void browse(entryPath)}
                  >
                    <RotateCw size={13} aria-hidden="true" />
                  </button>
                )}
              </div>
              {expanded &&
                folders.has(entryPath) &&
                branch(entryPath, depth + 1)}
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <div className="explorer-content" ref={root}>
      {workspace ? (
        <>
          <div className="explorer-actions">
            <p
              className="explorer-path"
              title={`${workspace.name}/${relativePath}`}
            >
              {workspace.name}
              {relativePath && `/${relativePath}`}
            </p>
            {createFile && (
              <button
                ref={createButton}
                type="button"
                className="icon-button"
                aria-label="New workspace file"
                title="New workspace file"
                disabled={disabled}
                onClick={startCreate}
              >
                <FilePlus size={15} aria-hidden="true" />
              </button>
            )}
            {relativePath && (
              <button
                type="button"
                className="icon-button"
                aria-label="Up"
                title="Go to parent folder"
                disabled={disabled}
                onClick={() => void browse(parent)}
              >
                <ArrowUp size={15} />
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh folder"
              title="Refresh folder"
              disabled={disabled}
              onClick={() => {
                setNaming(undefined);
                setContext(undefined);
                void browse(relativePath);
              }}
            >
              <RotateCw size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Switch folder"
              title="Switch folder"
              disabled={disabled}
              onClick={open}
            >
              <FolderSync size={15} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Close workspace"
              title="Close workspace"
              disabled={disabled}
              onClick={close}
            >
              <X size={14} />
            </button>
          </div>
          {naming && !naming.entry && nameInput}
          {folders.has("") && (
            <div
              className="explorer-tree"
              aria-busy={busy === "loading folder"}
              onKeyDown={(event) => {
                if (
                  !(event.target instanceof HTMLButtonElement) ||
                  !event.target.matches(".tree-row")
                )
                  return;
                const rows = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    ".tree-row:not(:disabled)",
                  ),
                ];
                const target = event.target;
                const index = rows.indexOf(target);
                const next =
                  event.key === "ArrowDown"
                    ? rows[index + 1]
                    : event.key === "ArrowUp"
                      ? rows[index - 1]
                      : event.key === "Home"
                        ? rows[0]
                        : event.key === "End"
                          ? rows.at(-1)
                          : undefined;
                if (next) {
                  event.preventDefault();
                  next.focus();
                }
                if (event.key === "ArrowRight") {
                  const expanded = target.getAttribute("aria-expanded");
                  if (expanded === "false") {
                    event.preventDefault();
                    target.click();
                  } else if (
                    expanded === "true" &&
                    rows[index + 1]?.dataset.parent === target.dataset.path
                  ) {
                    event.preventDefault();
                    rows[index + 1].focus();
                  }
                }
                if (event.key === "ArrowLeft") {
                  if (event.target.getAttribute("aria-expanded") === "true") {
                    event.preventDefault();
                    event.target.click();
                  } else {
                    const parentRow = rows.find(
                      (row) => row.dataset.path === target.dataset.parent,
                    );
                    if (parentRow) {
                      event.preventDefault();
                      parentRow.focus();
                    }
                  }
                }
              }}
            >
              {branch("", 0)}
            </div>
          )}
        </>
      ) : (
        <div className="pane-empty">
          <Folder size={21} aria-hidden="true" />
          <p>No folder open.</p>
          <button
            type="button"
            className="quiet-button"
            disabled={disabled}
            onClick={open}
          >
            <FolderOpen size={14} /> Open folder
          </button>
        </div>
      )}
      {busy && (
        <p className="panel-message" role="status">
          {busy === "selecting folder"
            ? "Waiting for folder selection…"
            : busy === "closing workspace"
              ? "Closing workspace…"
              : "Loading folder…"}
        </p>
      )}
      {error && (
        <div className="explorer-error">
          <p className="panel-message" role="alert">
            {error}
          </p>
          {workspace && (
            <button
              type="button"
              className="quiet-button"
              disabled={disabled}
              onClick={() => void browse(relativePath)}
            >
              <RotateCw size={13} /> Reload folder
            </button>
          )}
        </div>
      )}
      {workspace &&
        !busy &&
        !error &&
        folders.get(relativePath)?.length === 0 && (
          <p className="panel-message">This folder is empty.</p>
        )}
    </div>
  );
}
