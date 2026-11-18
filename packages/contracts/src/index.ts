export type SidebarView = "explorer" | "search" | "git";

export type {
  DirectoryEntry,
  SelectedFileSnapshot,
  SearchMatch,
  SearchOptions,
  SearchResponse,
  TextFile,
  WorkspaceCommands,
  WorkspaceDescriptor,
  WorkspaceError,
} from "./workspace";

export type {
  TerminalCommands,
  TerminalError,
  TerminalOutput,
  TerminalSize,
  TerminalStarted,
} from "./terminal";
