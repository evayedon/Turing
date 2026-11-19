import { rememberRecent } from "../shell/recent";
import { useRef, useState } from "react";
import type { DirectoryEntry, WorkspaceDescriptor } from "@turing/contracts";
import {
  invokeWorkspace,
  nativeWorkspaceAvailable,
  workspaceErrorMessage,
} from "./workspace-ipc";

export function useExplorer() {
  const native = nativeWorkspaceAvailable();
  const currentWorkspace = useRef<string | undefined>(undefined);
  const [workspace, setWorkspace] = useState<WorkspaceDescriptor | null>(null);
  const [relativePath, setRelativePath] = useState("");
  const [folders, setFolders] = useState(
    () => new Map<string, DirectoryEntry[]>(),
  );
  const [busy, setBusy] = useState<
    "selecting folder" | "loading folder" | "closing workspace" | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  async function readDirectory(workspaceId: string, path: string) {
    setRelativePath(path);
    setBusy("loading folder");
    setError(null);
    try {
      const entries = await invokeWorkspace("fs_list_directory", {
        workspaceId,
        relativePath: path,
      });
      setFolders((previous) => new Map(previous).set(path, entries));
    } catch (cause) {
      setError(workspaceErrorMessage(cause));
    } finally {
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
        setWorkspace(selection);
        if (selection.displayPath)
          rememberRecent({
            kind: "workspace",
            name: selection.name,
            path: selection.displayPath,
          });
        setFolders(new Map());
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
      currentWorkspace.current = undefined;
      setWorkspace(null);
      setRelativePath("");
      setFolders(new Map());
      return true;
    } catch (cause) {
      setError(workspaceErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function refresh(path: string) {
    if (!workspace) return;
    const id = workspace.id;
    setError(null);
    try {
      const entries = await invokeWorkspace("fs_list_directory", {
        workspaceId: id,
        relativePath: path,
      });
      if (currentWorkspace.current === id)
        setFolders((previous) => new Map(previous).set(path, entries));
    } catch (cause) {
      if (currentWorkspace.current === id)
        setError(workspaceErrorMessage(cause));
    }
  }

  function renamed(old: string, next: string, name: string) {
    const move = (path: string) =>
      path === old || path.startsWith(`${old}/`)
        ? next + path.slice(old.length)
        : path;
    setRelativePath(move);
    setFolders(
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
    browse: (path: string) => workspace && readDirectory(workspace.id, path),
  };
}
