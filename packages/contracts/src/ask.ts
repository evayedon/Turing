import type { TextFile, WorkspaceDescriptor } from "./workspace";

export interface AskModel {
  id: string;
  label: string;
  location: "local" | "cloud";
}

/** The workspace ID is a selector. The native host must authorize access. */
export interface AskRequest {
  workspaceId: WorkspaceDescriptor["id"];
  modelId: AskModel["id"];
  question: string;
  conventions?: string;
}

export interface AskSource extends Pick<TextFile, "relativePath" | "version"> {
  /** Inclusive, one-based lines in the indexed file version. */
  startLine: number;
  endLine: number;
}

export type AskEvent =
  | { kind: "awaitingCloudApproval" }
  | { kind: "cloudApproved" }
  | { kind: "delta"; text: string }
  | {
      kind: "completed";
      sources: AskSource[];
      indexCoverage: "complete" | "partial";
      indexFreshness: "current" | "stale";
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { kind: "cancelled" };

/** Error codes returned by the native Ask commands. */
export type AskError =
  | "WORKSPACE_DENIED"
  | "INVALID_QUESTION"
  | "BUSY"
  | "MODEL_UNAVAILABLE"
  | "INDEX_UNAVAILABLE"
  | "INFERENCE_FAILED"
  | "CLOUD_CONSENT_DECLINED"
  | "CLOUD_QUESTION_TOO_LONG"
  | "CLOUD_KEY_REQUIRED"
  | "INVALID_CLOUD_KEY"
  | "CREDENTIAL_STORE"
  | "PROVIDER_UNAUTHORIZED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE";

export type AskCredentialAction =
  { kind: "status" } | { kind: "save"; key: string } | { kind: "remove" };

export type AskIndexAction =
  "status" | "pause" | "resume" | "rebuild" | "disable";

export interface AskIndexStatus {
  phase: "indexing" | "ready" | "paused" | "disabled" | "unavailable";
  files: number;
  partial: boolean;
}
