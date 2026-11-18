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
  | "PERMISSION_DENIED"
  | "OUTSIDE_WORKSPACE"
  | "NOT_FOUND"
  | "NOT_DIRECTORY"
  | "NOT_FILE"
  | "INVALID_ENCODING"
  | "FILE_TOO_LARGE"
  | "FILE_CONFLICT"
  | "SAVE_RACE"
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
  workspace_open: { args: undefined; result: WorkspaceDescriptor | null };
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
  file_open: { args: undefined; result: SelectedFileSnapshot | null };
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
    args: { action: "tab" | "reload" | "workspace" | "exit" };
    result: boolean;
  };
  editor_exit: { args: undefined; result: void };
}
