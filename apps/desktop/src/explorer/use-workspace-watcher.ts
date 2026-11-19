import { useEffect, useEffectEvent } from "react";
import type { WorkspaceChanges } from "@turing/contracts";
import { pollWorkspaceChanges } from "./watch-ipc";

export const WATCH_POLL_MS = 500;
/** Back-off after a transient poll failure. */
export const WATCH_RETRY_MS = 2_000;

const parentOf = (path: string) =>
  path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** Whether `path` (or something below it) may have changed. */
export function touches(changes: WorkspaceChanges, path: string) {
  return (
    changes.rescan ||
    changes.paths.some(
      (changed) => path === changed || path.startsWith(`${changed}/`),
    )
  );
}

/**
 * The loaded folders whose listing may be stale: a folder containing a
 * changed entry, or a changed folder and everything loaded below it.
 */
export function foldersToRefresh(
  changes: WorkspaceChanges,
  loaded: Iterable<string>,
) {
  const parents = new Set(changes.paths.map(parentOf));
  return [...loaded].filter(
    (folder) => parents.has(folder) || touches(changes, folder),
  );
}

/**
 * Polls the native watcher of the active workspace and hands non-empty
 * change sets to `onChanges`. Replies for a workspace that is no longer
 * current are dropped, and a revoked registration stops the poll.
 */
export function useWorkspaceWatcher(
  workspaceId: string | undefined,
  native: boolean,
  onChanges: (workspaceId: string, changes: WorkspaceChanges) => void,
) {
  const deliver = useEffectEvent(onChanges);

  useEffect(() => {
    if (!native || !workspaceId) return;
    const id = workspaceId;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function cycle() {
      let delay = WATCH_POLL_MS;
      if (!document.hidden) {
        try {
          const changes = await pollWorkspaceChanges(id);
          if (!live) return;
          if (changes.rescan || changes.paths.length) deliver(id, changes);
        } catch (cause) {
          if (!live || cause === "PERMISSION_DENIED") return;
          delay = WATCH_RETRY_MS;
        }
      }
      if (live) timer = setTimeout(() => void cycle(), delay);
    }
    void cycle();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [native, workspaceId]);
}
