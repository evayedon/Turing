import { invoke, isTauri } from "@tauri-apps/api/core";
import type { WorkspaceCommands, WorkspaceError } from "@turing/contracts";

export const nativeWorkspaceAvailable = isTauri;

export function invokeWorkspace<Command extends keyof WorkspaceCommands>(
  command: Command,
  args: WorkspaceCommands[Command]["args"],
): Promise<WorkspaceCommands[Command]["result"]> {
  return invoke<WorkspaceCommands[Command]["result"]>(command, args);
}

const messages = {
  BUSY: "A folder picker is already open.",
  PERMISSION_DENIED: "The desktop app could not access this file or workspace.",
  OUTSIDE_WORKSPACE:
    "This path is outside the approved location or uses an unsupported link or name.",
  NOT_FOUND: "This file or folder no longer exists.",
  NOT_DIRECTORY: "This path is no longer a folder.",
  NOT_FILE: "This path is not a regular file.",
  INVALID_ENCODING: "This file is not UTF-8 text.",
  FILE_CONFLICT:
    "The file changed on disk. Save was blocked to protect newer content.",
  SAVE_RACE:
    "A concurrent change interrupted the save. Your draft is still open. A .turing-save-*.tmp or .original recovery file may be beside the document.",
  FILE_TOO_LARGE: "This file exceeds the 2 MiB read limit.",
  DIRECTORY_TOO_LARGE: "This folder exceeds the 10,000-entry listing limit.",
  IO_ERROR: "The desktop app could not complete the workspace operation.",
} satisfies Record<WorkspaceError, string>;

export function workspaceErrorMessage(error: unknown): string {
  if (typeof error === "string" && Object.hasOwn(messages, error)) {
    return messages[error as WorkspaceError];
  }
  return messages.IO_ERROR;
}
