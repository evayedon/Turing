// UTF-16 code units match the editor's offsets and can be checked in O(1).
export const LARGE_DOCUMENT_LENGTH = 128 * 1024;
export const LANGUAGE_EDIT_QUIET_MS = 250;

export function isLargeDocument(text: string) {
  return text.length >= LARGE_DOCUMENT_LENGTH;
}

export function languageEditPending(editedAt: number | undefined, now: number) {
  return editedAt !== undefined && now - editedAt < LANGUAGE_EDIT_QUIET_MS;
}

export function applyTextChanges(
  text: string,
  bom: number,
  changes: readonly {
    rangeOffset: number;
    rangeLength: number;
    text: string;
  }[],
) {
  // Monaco delivers changes from the end of the document toward the start.
  // Its offsets exclude the BOM, which the workbench preserves on save.
  for (const change of changes) {
    const offset = change.rangeOffset + bom;
    text =
      text.slice(0, offset) +
      change.text +
      text.slice(offset + change.rangeLength);
  }
  return text;
}
