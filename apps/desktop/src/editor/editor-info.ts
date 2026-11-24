export interface EditorInfo {
  key: string;
  language: string;
  line: number;
  column: number;
  eol: "LF" | "CRLF";
  /** Non-empty selection as 1-based inclusive lines. */
  selection?: { startLine: number; endLine: number };
}
