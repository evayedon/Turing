import { useEffect, useState } from "react";
import { invokeWorkspace } from "../explorer/workspace-ipc";

const folderLimit = 128;
const fileLimit = 12_000;
const excluded = new Set([".git", "node_modules", "target"]);

export function useQuickFiles(
  workspaceId: string | undefined,
  enabled: boolean,
) {
  const [result, setResult] = useState<{
    workspaceId: string;
    paths: string[];
    limited: boolean;
  }>();
  useEffect(() => {
    if (!enabled || !workspaceId) return;
    let cancelled = false;
    const id = workspaceId;
    async function index() {
      const directories = [""];
      const paths: string[] = [];
      let unreadable = false;
      let limited = false;
      for (
        let offset = 0;
        offset < directories.length && offset < folderLimit;
        offset++
      ) {
        if (cancelled) return;
        try {
          const entries = await invokeWorkspace("fs_list_directory", {
            workspaceId: id,
            relativePath: directories[offset],
          });
          if (cancelled) return;
          for (const entry of entries) {
            if (entry.kind === "file") {
              if (paths.length === fileLimit) {
                limited = true;
                break;
              }
              paths.push(entry.relativePath);
            } else if (!excluded.has(entry.name)) {
              if (directories.length >= folderLimit) limited = true;
              else directories.push(entry.relativePath);
            }
          }
          if (paths.length === fileLimit) break;
        } catch {
          unreadable = true;
        }
      }
      if (!cancelled)
        setResult({ workspaceId: id, paths, limited: limited || unreadable });
    }
    void index();
    return () => {
      cancelled = true;
    };
  }, [enabled, workspaceId]);
  return enabled && result?.workspaceId === workspaceId ? result : undefined;
}
