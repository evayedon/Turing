import type { useExplorer } from "./use-explorer";

export function Explorer({
  native,
  workspace,
  relativePath,
  entries,
  busy,
  error,
  open,
  close,
  browse,
}: ReturnType<typeof useExplorer>) {
  if (!native) {
    return (
      <p className="panel-message">
        Native workspace access is unavailable in the browser preview. Open
        Turing Core on the desktop to browse files.
      </p>
    );
  }

  const parent = relativePath.includes("/")
    ? relativePath.slice(0, relativePath.lastIndexOf("/"))
    : "";

  return (
    <div className="explorer-content">
      {workspace ? (
        <>
          <div className="explorer-actions">
            {relativePath && (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => browse(parent)}
              >
                Up
              </button>
            )}
            <button type="button" disabled={!!busy} onClick={close}>
              Close workspace
            </button>
          </div>
          <p className="explorer-path">
            {workspace.name}
            {relativePath && `/${relativePath}`}
          </p>
        </>
      ) : (
        <button type="button" disabled={!!busy} onClick={open}>
          Open folder
        </button>
      )}

      {busy && (
        <p role="status">
          {" "}
          {busy === "selecting folder"
            ? "Waiting for folder selection…"
            : busy === "closing workspace"
              ? "Closing workspace…"
              : "Loading folder…"}
        </p>
      )}
      {error && (
        <>
          <p role="alert">{error}</p>
          {workspace && (
            <button type="button" onClick={() => browse(relativePath)}>
              Reload folder
            </button>
          )}
        </>
      )}
      {workspace && !busy && !error && entries.length === 0 && (
        <p>This folder is empty.</p>
      )}
      {workspace && !busy && !error && entries.length > 0 && (
        <ul className="explorer-entries" aria-label="Directory entries">
          {entries.map((entry) => (
            <li key={entry.relativePath}>
              {entry.kind === "directory" ? (
                <button
                  type="button"
                  onClick={() => browse(entry.relativePath)}
                >
                  {entry.name}/
                </button>
              ) : (
                entry.name
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
