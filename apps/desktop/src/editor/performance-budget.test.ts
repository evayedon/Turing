import { expect, it } from "vitest";
import {
  applyTextChanges,
  isLargeDocument,
  languageEditPending,
  LARGE_DOCUMENT_LENGTH,
} from "./performance-budget";

it("degrades at the UTF-16 document limit", () => {
  expect(isLargeDocument("a".repeat(LARGE_DOCUMENT_LENGTH - 1))).toBe(false);
  expect(isLargeDocument("😀".repeat(LARGE_DOCUMENT_LENGTH / 2))).toBe(true);
});

it("waits for the latest edit to go quiet before language sync", () => {
  expect(languageEditPending(undefined, 300)).toBe(false);
  expect(languageEditPending(0, 249)).toBe(true);
  expect(languageEditPending(249, 250)).toBe(true);
  expect(languageEditPending(249, 499)).toBe(false);
});

it("applies ranges in Monaco order, retaining the BOM and CRLF", () => {
  expect(
    applyTextChanges("\uFEFFa\r\n😀b", 1, [
      { rangeOffset: 5, rangeLength: 1, text: "!" },
      { rangeOffset: 0, rangeLength: 1, text: "new" },
    ]),
  ).toBe("\uFEFFnew\r\n😀!");
});
