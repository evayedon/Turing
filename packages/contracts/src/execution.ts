export type ExecutionSource = (
  | { kind: "workspace"; workspaceId: string; relativePath: string }
  | { kind: "selected"; fileId: string }
) & { version: string };

export type ExecutionLanguage = "python" | "cpp";
export type ExecutionPhase =
  "preparing" | "compiling" | "running" | "stopping" | "completed" | "failed";
export type ExecutionStream =
  "buildStdout" | "buildStderr" | "stdout" | "stderr";
export type ExecutionError =
  | "PERMISSION_DENIED"
  | "BUSY"
  | "UNSUPPORTED_LANGUAGE"
  | "SOURCE_CHANGED"
  | "SOURCE_UNAVAILABLE"
  | "PYTHON_UNAVAILABLE"
  | "COMPILER_UNAVAILABLE"
  | "PROCESS_UNAVAILABLE"
  | "TIMED_OUT"
  | "INTERNAL";
export type ExecutionStarted = {
  id: string;
  name: string;
  language: ExecutionLanguage;
};
export type ExecutionUpdate = {
  phase: ExecutionPhase;
  elapsedMs: number;
  exitCode: number | null;
  error: ExecutionError | null;
  cancelled: boolean;
  truncated: boolean;
  output: { stream: ExecutionStream; bytes: number[] }[];
};
