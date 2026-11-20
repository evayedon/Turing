import type {
  RenamePreview,
  WorkspaceFileEdit,
  WorkspaceTextEdit,
} from "@turing/contracts";
import type { EditorTab } from "./use-editor";

export type WorkspaceEditTarget = WorkspaceFileEdit & {
  tab?: EditorTab;
  stale: boolean;
};

export type WorkspaceEditResult = {
  path: string;
  outcome: "draft" | "saved" | "excluded" | "conflict";
  reason?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isOffset = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function isTextEdit(value: unknown): value is WorkspaceTextEdit {
  return (
    isRecord(value) &&
    isOffset(value.start) &&
    isOffset(value.end) &&
    value.start <= value.end &&
    isRecord(value.position) &&
    isOffset(value.position.line) &&
    isOffset(value.position.character) &&
    typeof value.before === "string" &&
    value.before.length === value.end - value.start &&
    typeof value.after === "string"
  );
}

function isFileEdit(value: unknown): value is WorkspaceFileEdit {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.baseVersion === "string" &&
    (value.documentVersion === null || isOffset(value.documentVersion)) &&
    Array.isArray(value.edits) &&
    value.edits.length > 0 &&
    value.edits.every(isTextEdit)
  );
}

export function isRenamePreview(value: unknown): value is RenamePreview {
  return (
    isRecord(value) &&
    Array.isArray(value.files) &&
    value.files.every(isFileEdit)
  );
}

export function editedText(text: string, edits: readonly WorkspaceTextEdit[]) {
  let end = 0;
  let previousStart = -1;
  let result = "";
  for (const edit of edits) {
    if (
      edit.start < end ||
      edit.start === previousStart ||
      edit.end > text.length ||
      text.slice(edit.start, edit.end) !== edit.before
    )
      return;
    result += text.slice(end, edit.start) + edit.after;
    end = edit.end;
    previousStart = edit.start;
  }
  return result + text.slice(end);
}
