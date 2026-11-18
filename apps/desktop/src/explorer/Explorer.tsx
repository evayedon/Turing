import {
  ArrowUp,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  FolderSync,
  RotateCw,
  X,
} from "lucide-react";
import type { useExplorer } from "./use-explorer";

type Props = Omit<ReturnType<typeof useExplorer>, "open" | "close"> & {
  open: () => void;
  close: () => void;
  openFile: (path: string) => void;
  editorBusy: boolean;
  activeFile?: string;
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
}: Props) {
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
    <div className="explorer-content">
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
