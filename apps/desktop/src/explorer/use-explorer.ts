import { rememberRecent } from "../shell/recent";
import { useRef, useState } from "react";
import type {
  DirectoryEntry,
  WorkspaceChanges,
  WorkspaceDescriptor,
} from "@turing/contracts";
import { foldersToRefresh } from "./use-workspace-watcher";
import {
  invokeWorkspace,
  nativeWorkspaceAvailable,
  workspaceErrorMessage,
} from "./workspace-ipc";

export function useExplorer() {
  const native = nativeWorkspaceAvailable();
  const currentWorkspace = useRef<string | undefined>(undefined);
  const listings = useRef(new Map<string, symbol>());
  const browsing = useRef<symbol | undefined>(undefined);
  const [workspace, setWorkspace] = useState<WorkspaceDescriptor | null>(null);
  const [relativePath, setRelativePath] = useState("");
  const loadedFolders = useRef(new Map<string, DirectoryEntry[]>());
  const [folders, setFolders] = useState(
    () => new Map<string, DirectoryEntry[]>(),
  );

  const [busy, setBusy] = useState<
    "selecting folder" | "loading folder" | "closing workspace" | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  function updateFolders(
    update: (
      previous: Map<string, DirectoryEntry[]>,
    ) => Map<string, DirectoryEntry[]>,
  ) {
    loadedFolders.current = update(loadedFolders.current);
    setFolders(loadedFolders.current);
  }

  async function listDirectory(id: string, path: string, watcher = false) {
    if (currentWorkspace.current !== id) return;
    const request = Symbol();
    listings.current.set(path, request);
    const isCurrent = () =>
      currentWorkspace.current === id && listings.current.get(path) === request;
    try {
      const entries = await invokeWorkspace("fs_list_directory", {
        workspaceId: id,
        relativePath: path,
      });
      if (isCurrent())
        updateFolders((previous) => new Map(previous).set(path, entries));
    } catch (cause) {
      if (!isCurrent()) return;
      if (
        watcher &&
        path &&
        ["NOT_FOUND", "NOT_DIRECTORY", "OUTSIDE_WORKSPACE"].includes(
          String(cause),
        )
      )
        forget(path);
      else if (!watcher || !path) setError(workspaceErrorMessage(cause));
    } finally {
      if (isCurrent()) listings.current.delete(path);
    }
  }

  async function readDirectory(id: string, path: string) {
    if (currentWorkspace.current !== id) return;
    const request = Symbol();
    browsing.current = request;
    setRelativePath(path);
    setBusy("loading folder");
    setError(null);
    try {
      await listDirectory(id, path);
    } finally {
      if (currentWorkspace.current === id && browsing.current === request)
        setBusy(null);
    }
  }

  async function open(recentPath?: string) {
    setBusy("selecting folder");
    setError(null);
    try {
      const selection = await invokeWorkspace(
        "workspace_open",
        recentPath ? { recentPath } : undefined,
      );
      if (selection) {
        currentWorkspace.current = selection.id;
        listings.current.clear();
        setWorkspace(selection);
        if (selection.displayPath)
          rememberRecent({
            kind: "workspace",
            name: selection.name,
            path: selection.displayPath,
          });
        updateFolders(() => new Map());
        await readDirectory(selection.id, "");
        return true;
      }
    } catch (cause) {
      setError(workspaceErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function close() {
    if (!workspace) return;
    setBusy("closing workspace");
    setError(null);
    try {
      await invokeWorkspace("workspace_close", { workspaceId: workspace.id });
      if (currentWorkspace.current !== workspace.id) return;
      currentWorkspace.current = undefined;
      listings.current.clear();
      setWorkspace(null);
      setRelativePath("");
      updateFolders(() => new Map());
      return true;
    } catch (cause) {
      setError(workspaceErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function refresh(path: string) {
    if (!workspace || currentWorkspace.current !== workspace.id) return;
    setError(null);
    await listDirectory(workspace.id, path);
  }

  /** Drops a folder that vanished, and everything loaded below it. */
  function forget(path: string) {
    const within = (item: string) =>
      item === path || item.startsWith(`${path}/`);
    for (const pending of listings.current.keys()) {
      if (within(pending)) listings.current.delete(pending);
    }
    updateFolders(
      (previous) =>
        new Map([...previous].filter(([folder]) => !within(folder))),
    );
    setRelativePath((current) =>
      within(current)
        ? path.slice(0, Math.max(0, path.lastIndexOf("/")))
        : current,
    );
  }

  /** Re-lists loaded folders and folders whose first listing is still pending. */
  async function applyChanges(id: string, changes: WorkspaceChanges) {
    if (currentWorkspace.current !== id) return;
    const paths = new Set([
      ...loadedFolders.current.keys(),
      ...listings.current.keys(),
    ]);
    await Promise.all(
      foldersToRefresh(changes, paths).map((path) =>
        listDirectory(id, path, true),
      ),
    );
  }

  function renamed(old: string, next: string, name: string) {
    const move = (path: string) =>
      path === old || path.startsWith(`${old}/`)
        ? next + path.slice(old.length)
        : path;
    for (const path of listings.current.keys()) {
      if (move(path) !== path) listings.current.delete(path);
    }
    setRelativePath(move);
    updateFolders(
      (previous) =>
        new Map(
          [...previous].map(([path, entries]) => [
            move(path),
            entries.map((entry) => ({
              ...entry,
              name: entry.relativePath === old ? name : entry.name,
              relativePath: move(entry.relativePath),
            })),
          ]),
        ),
    );
    void refresh(old.slice(0, Math.max(0, old.lastIndexOf("/"))));
  }

  return {
    native,
    workspace,
    relativePath,
    folders,
    busy,
    error,
    open,
    close,
    refresh,
    renamed,
    applyChanges,
    browse: (path: string) => workspace && readDirectory(workspace.id, path),
  };
}
