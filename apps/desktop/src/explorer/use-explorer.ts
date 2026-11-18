import { useState } from "react";
import type { DirectoryEntry, WorkspaceDescriptor } from "@turing/contracts";
import {
  invokeWorkspace,
  nativeWorkspaceAvailable,
  workspaceErrorMessage,
} from "./workspace-ipc";

export function useExplorer() {
  const native = nativeWorkspaceAvailable();
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

  async function open() {
    setBusy("selecting folder");
    setError(null);
    try {
      const selection = await invokeWorkspace("workspace_open", undefined);
      if (selection) {
        setWorkspace(selection);
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

  return {
    native,
    workspace,
    relativePath,
    folders,
    busy,
    error,
    open,
    close,
    browse: (path: string) => workspace && readDirectory(workspace.id, path),
  };
}
