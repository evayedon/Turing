export type LanguageError =
  | "DENIED"
  | "UNAVAILABLE"
  | "START_FAILED"
  | "SERVER_EXITED"
  | "BUSY"
  | "INVALID_DOCUMENT"
  | "INVALID_WORKSPACE_EDIT"
  | "NOT_READY"
  | "INTERNAL";
export type LanguageFeature =
  "hover" | "completion" | "definition" | "prepareRename" | "rename";
export type LanguageCapabilities = Record<LanguageFeature, boolean>;
export type LanguagePosition = { line: number; character: number };
export type LanguageAction =
  | {
      kind: "sync";
      path: string;
      version: number;
      text: string;
      saved: boolean;
    }
  | { kind: "close"; path: string }
  | {
      kind: "request";
      path: string;
      version: number;
      position: LanguagePosition;
      feature: LanguageFeature;
      requestId: number;
      newName?: string;
    }
  | { kind: "cancel"; requestId: number };
export type LanguageEvent =
  | {
      kind: "diagnostics";
      path: string;
      version: number;
      diagnostics: unknown[];
    }
  | { kind: "response"; requestId: number; value: unknown };
export type LanguageUpdate = {
  capabilities: LanguageCapabilities | null;
  events: LanguageEvent[];
};

type Session = { workspaceId: string; sessionId: string };
export type LanguageCommands = {
  language_start: [{ workspaceId: string }, string | null];
  language_apply: [Session & { action: LanguageAction }, void];
  language_poll: [Session, LanguageUpdate];
  language_stop: [Session, void];
};

/** Offsets are zero-based UTF-16 code units into the exact source snapshot. */
export type WorkspaceTextEdit = {
  start: number;
  end: number;
  position: LanguagePosition;
  before: string;
  after: string;
};
export type WorkspaceFileEdit = {
  path: string;
  baseVersion: string;
  documentVersion: number | null;
  edits: WorkspaceTextEdit[];
};
export type RenamePreview = { files: WorkspaceFileEdit[] };
export type PrepareRename = { placeholder: string };
export type WorkspaceEditFailure = { error: "INVALID_WORKSPACE_EDIT" };
