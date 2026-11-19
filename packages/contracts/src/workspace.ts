export interface WorkspaceDescriptor {
  id: string;
  name: string;
  displayPath?: string;
}

export interface DirectoryEntry {
  name: string;
  relativePath: string;
  kind: "directory" | "file";
  identity?: string;
}

export interface TextFile {
  workspaceId: string;
  relativePath: string;
  content: string;
  encoding: "utf-8";
  version: string;
}

export interface SelectedFileVersion {
  fileId: string;
  name: string;
  displayPath: string;
  version: string;
}

export interface SelectedFileSnapshot extends SelectedFileVersion {
  content: string;
}

export interface SearchOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  filenameFilter?: string;
}

export interface SearchMatch {
  line: number;
  column: number;
  before: string;
  text: string;
  after: string;
}

export interface SearchResponse {
  files: { relativePath: string; matches: SearchMatch[] }[];
  truncated: boolean;
  skippedFiles: number;
}

export type WorkspaceError =
  | "BUSY"
  | "WINDOW_LIMIT"
  | "PERMISSION_DENIED"
  | "OUTSIDE_WORKSPACE"
  | "NOT_FOUND"
  | "NOT_DIRECTORY"
  | "NOT_FILE"
  | "INVALID_ENCODING"
  | "FILE_TOO_LARGE"
  | "FILE_CONFLICT"
  | "SAVE_RACE"
  | "INVALID_NAME"
  | "ENTRY_CHANGED"
  | "NAME_TAKEN"
  | "RENAME_RACE"
  | "DIRECTORY_TOO_LARGE"
  | "INVALID_SEARCH"
  | "SEARCH_BUSY"
  | "SEARCH_CANCELLED"
  | "IO_ERROR";

type WorkspacePath = {
  workspaceId: string;
  relativePath: string;
};

export interface WorkspaceCommands {
  window_new_workbench: { args: undefined; result: void };
  window_new_terminal: { args: undefined; result: void };
  workspace_open: {
    args: { recentPath: string } | undefined;
    result: WorkspaceDescriptor | null;
  };
  workspace_create_file: {
    args: { workspaceId: string; parent: string; name: string };
    result: TextFile;
  };
  workspace_rename_entry: {
    args: WorkspacePath & { name: string; expectedIdentity: string };
    result: string;
  };
  workspace_close: { args: { workspaceId: string }; result: void };
  fs_list_directory: { args: WorkspacePath; result: DirectoryEntry[] };
  fs_read_file: { args: WorkspacePath; result: TextFile };
  workspace_search_begin: {
    args: { workspaceId: string; options: SearchOptions };
    result: string;
  };
  workspace_search_run: {
    args: { workspaceId: string; searchId: string };
    result: SearchResponse;
  };
  workspace_search_cancel: {
    args: { workspaceId: string; searchId: string };
    result: void;
  };
  fs_write_file: {
    args: WorkspacePath & { content: string; expectedVersion: string };
    result: string;
  };
  file_open: {
    args: { recentPath: string } | undefined;
    result: SelectedFileSnapshot | null;
  };
  file_read: { args: { fileId: string }; result: SelectedFileSnapshot };
  file_write: {
    args: { fileId: string; expectedVersion: string; content: string };
    result: string;
  };
  file_close: { args: { fileId: string }; result: void };
  file_save_as: {
    args: { content: string; suggestedName?: string };
    result: SelectedFileVersion | null;
  };
  editor_confirm_discard: {
    args: { action: "tab" | "closeAll" | "reload" | "workspace" | "exit" };
    result: boolean;
  };
  editor_exit: { args: undefined; result: void };
}
