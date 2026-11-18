export interface WorkspaceDescriptor {
  id: string;
  name: string;
}

export interface DirectoryEntry {
  name: string;
  relativePath: string;
  kind: "directory" | "file";
}

export interface TextFile {
  workspaceId: string;
  relativePath: string;
  content: string;
  encoding: "utf-8";
  version: string;
}

export type WorkspaceError =
  | "BUSY"
  | "PERMISSION_DENIED"
  | "OUTSIDE_WORKSPACE"
  | "NOT_FOUND"
  | "NOT_DIRECTORY"
  | "NOT_FILE"
  | "INVALID_ENCODING"
  | "FILE_TOO_LARGE"
  | "DIRECTORY_TOO_LARGE"
  | "IO_ERROR";

type WorkspacePath = {
  workspaceId: string;
  relativePath: string;
};

export interface WorkspaceCommands {
  workspace_open: { args: undefined; result: WorkspaceDescriptor | null };
  workspace_close: { args: { workspaceId: string }; result: void };
  fs_list_directory: { args: WorkspacePath; result: DirectoryEntry[] };
  fs_read_file: { args: WorkspacePath; result: TextFile };
}
