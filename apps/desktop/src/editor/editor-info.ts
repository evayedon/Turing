export interface EditorInfo {
  key: string;
  language: string;
  line: number;
  column: number;
  eol: "LF" | "CRLF";
}
