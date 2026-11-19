import { useCallback, useEffect, useRef, useState } from "react";
import type { BranchInfo, GitError, GitStatus } from "@turing/contracts";
import { gitErrorMessage, invokeGit, isGitError } from "./git-ipc";

const POLL_MS = 4000;

export type GitBusy =
  "staging" | "unstaging" | "committing" | "switching branch" | null;

export interface GitState {
  available: boolean;
  status: GitStatus | null;
  /** Error that makes the repository unusable (no git, not a repo). */
  unavailable: GitError | null;
  /** Error from the most recent action; cleared by the next action. */
  error: string | null;
  notice: string | null;
  busy: GitBusy;
  refresh: () => Promise<void>;
  stage: (path: string) => Promise<void>;
  unstage: (path: string) => Promise<void>;
  commit: (message: string) => Promise<boolean>;
  branches: () => Promise<BranchInfo[]>;
  checkout: (branch: string, create: boolean) => Promise<boolean>;
}

/**
 * Source-control state for the active workspace. Lives at the workbench level
 * so the sidebar and the status bar share one poller.
 */
export function useGit(
  workspaceId: string | undefined,
  native: boolean,
): GitState {
  const available = native && !!workspaceId;
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [unavailable, setUnavailable] = useState<GitError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<GitBusy>(null);
  // Responses for a previous workspace must never land in the current one.
  const current = useRef(workspaceId);
  current.current = workspaceId;

  const refresh = useCallback(async () => {
    if (!available || !workspaceId) return;
    try {
      const next = await invokeGit("git_status", { workspaceId });
      if (current.current !== workspaceId) return;
      setStatus(next);
      setUnavailable(null);
    } catch (cause) {
      if (current.current !== workspaceId) return;
      setStatus(null);
      setUnavailable(isGitError(cause) ? cause : "IO_ERROR");
    }
  }, [available, workspaceId]);

  useEffect(() => {
    setStatus(null);
    setUnavailable(null);
    setError(null);
    setNotice(null);
    if (!available) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [available, refresh]);

  async function run<T>(
    label: Exclude<GitBusy, null>,
    action: (id: string) => Promise<T>,
  ): Promise<T | undefined> {
    if (!workspaceId || busy) return undefined;
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      return await action(workspaceId);
    } catch (cause) {
      if (current.current === workspaceId) setError(gitErrorMessage(cause));
      return undefined;
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  return {
    available,
    status,
    unavailable,
    error,
    notice,
    busy,
    refresh,
    stage: async (relativePath) => {
      await run("staging", (id) =>
        invokeGit("git_stage", { workspaceId: id, relativePath }),
      );
    },
    unstage: async (relativePath) => {
      await run("unstaging", (id) =>
        invokeGit("git_unstage", { workspaceId: id, relativePath }),
      );
    },
    commit: async (message) => {
      const hash = await run("committing", (id) =>
        invokeGit("git_commit", { workspaceId: id, message }),
      );
      if (hash) setNotice(`Committed ${hash}.`);
      return !!hash;
    },
    branches: async () => {
      if (!workspaceId) return [];
      try {
        return await invokeGit("git_branches", { workspaceId });
      } catch (cause) {
        setError(gitErrorMessage(cause));
        return [];
      }
    },
    checkout: async (branchName, create) => {
      const done = await run("switching branch", async (id) => {
        await invokeGit("git_checkout", {
          workspaceId: id,
          branchName,
          create,
        });
        return true;
      });
      if (done) setNotice(`Switched to ${branchName}.`);
      return !!done;
    },
  };
}
