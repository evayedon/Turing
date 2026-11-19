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
  TerminalProfile,
  TerminalSize,
  TerminalStarted,
} from "./terminal";

export type {
  ExecutionError,
  ExecutionLanguage,
  ExecutionPhase,
  ExecutionSource,
  ExecutionStarted,
  ExecutionStream,
  ExecutionUpdate,
} from "./execution";

export type {
  LanguageAction,
  LanguageCapabilities,
  LanguageCommands,
  LanguageEvent,
  LanguageFeature,
  LanguagePosition,
  LanguageUpdate,
} from "./language";
