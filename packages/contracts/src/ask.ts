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
}

export interface AskSource extends Pick<TextFile, "relativePath" | "version"> {
  /** Inclusive, one-based lines in the indexed file version. */
  startLine: number;
  endLine: number;
}

export type AskEvent =
  | { kind: "delta"; text: string }
  | {
      kind: "completed";
      sources: AskSource[];
      indexCoverage: "complete" | "partial";
      indexFreshness: "current" | "stale";
    }
  | { kind: "cancelled" };

/** Error codes returned by the native Ask commands. */
export type AskError =
  | "WORKSPACE_DENIED"
  | "INVALID_QUESTION"
  | "BUSY"
  | "MODEL_UNAVAILABLE"
  | "INDEX_UNAVAILABLE"
  | "INFERENCE_FAILED";
