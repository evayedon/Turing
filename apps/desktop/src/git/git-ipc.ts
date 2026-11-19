import { invoke } from "@tauri-apps/api/core";
import type { GitCommands, GitError } from "@turing/contracts";

export function invokeGit<Command extends keyof GitCommands>(
  command: Command,
  args: GitCommands[Command]["args"],
): Promise<GitCommands[Command]["result"]> {
  return invoke<GitCommands[Command]["result"]>(command, { ...args });
}

const messages = {
  NO_GIT:
    "Git is not installed or not on your PATH. Install Git, then reopen the folder.",
  NOT_A_REPOSITORY: "This folder is not a Git repository.",
  WORKSPACE_NOT_OPEN: "Open a folder to use source control.",
  INVALID_REF:
    "That branch name is not allowed. Use letters, numbers, and - _ . / only.",
  INVALID_PATH: "This file path cannot be used with Git.",
  INVALID_MESSAGE: "Enter a commit message (up to 64 KiB).",
  NOTHING_TO_COMMIT: "Stage at least one change before committing.",
  IDENTITY_MISSING:
    "Git does not know who you are. Set user.name and user.email in your Git config, then commit again.",
  UNCOMMITTED_CHANGES:
    "Switching branches would overwrite local changes. Commit or stash them first.",
  OPERATION_FAILED: "Git could not complete that operation.",
  IO_ERROR: "The desktop app could not run Git.",
} satisfies Record<GitError, string>;

export function isGitError(error: unknown): error is GitError {
  return typeof error === "string" && Object.hasOwn(messages, error);
}

export function gitErrorMessage(error: unknown): string {
  return isGitError(error) ? messages[error] : messages.IO_ERROR;
}
