import type { WorkspaceChanges } from "@turing/contracts";
import { invokeWorkspace } from "./workspace-ipc";

/** Kept in its own module so tests can hold the background poll. */
export function pollWorkspaceChanges(
  workspaceId: string,
): Promise<WorkspaceChanges> {
  return invokeWorkspace("workspace_watch_poll", { workspaceId });
}
