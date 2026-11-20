import type { WorkspaceTextEdit } from "@turing/contracts";
import type { TextModels } from "./MonacoHost";
import type { EditorTab } from "./use-editor";

export function applyModelEdit(
  models: TextModels,
  tab: EditorTab,
  edits: readonly WorkspaceTextEdit[],
  next: string,
) {
  const model = models.get(tab.key);
  if (!model || model.getValue(undefined, true) !== tab.draft) return false;
  if (next === tab.draft) return true;

  const eol = model.getEOL();
  // Monaco normalizes inserted line endings to the model's EOL.
  if (edits.some(({ after }) => after.replace(/\r\n|\r|\n/g, eol) !== after))
    return false;

  const bom = Number(tab.draft.charCodeAt(0) === 0xfeff);
  if (edits.some(({ start }) => start < bom)) return false;

  const operations = edits.map(({ start, end, after }) => {
    const from = model.getPositionAt(start - bom);
    const to = model.getPositionAt(end - bom);
    return {
      range: {
        startLineNumber: from.lineNumber,
        startColumn: from.column,
        endLineNumber: to.lineNumber,
        endColumn: to.column,
      },
      text: after,
    };
  });
  models.sync(() => {
    model.pushStackElement();
    model.pushEditOperations(null, operations, () => null);
    model.pushStackElement();
  });
  // The caller commits the rename draft while model notifications are suppressed.
  models.remember(tab.key, next, next, bom);
  return true;
}
