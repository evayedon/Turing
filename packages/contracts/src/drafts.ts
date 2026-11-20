export type RecoverySource =
  | {
      kind: "workspace";
      root: string;
      relativePath: string;
      version: string;
      identity?: string;
    }
  | { kind: "copy" };

export interface RecoveryDraft {
  id: string;
  name: string;
  title: string;
  draft: string;
  source: RecoverySource;
  timestamp: number;
  languageOverride?: string;
}

export type RecoveryRequest =
  | { action: "list" }
  | { action: "migrate"; entry: RecoveryDraft }
  | {
      action: "snapshot";
      uri: string;
      entry: RecoveryDraft;
      workspaceId?: string;
      replaces?: string;
    }
  | { action: "resolve"; id: string }
  | { action: "matches"; id: string; workspaceId: string };

export type RecoveryReply =
  | { kind: "list"; entries: RecoveryDraft[]; skipped: boolean }
  | { kind: "written"; id: string }
  | { kind: "matches"; matches: boolean }
  | { kind: "done" };

export type RecoveryError =
  "PERMISSION_DENIED" | "INVALID_DRAFT" | "DRAFT_LIMIT" | "JOURNAL_IO";
