export type TerminalSize = { rows: number; cols: number };

export type TerminalStarted = { id: string; workspaceDirectory: boolean };

export type TerminalOutput = {
  bytes: number[];
  finished: boolean;
  exitCode: number | null;
};

export type TerminalError =
  | "PERMISSION_DENIED"
  | "ALREADY_RUNNING"
  | "SESSION_CLOSED"
  | "INVALID_SIZE"
  | "INPUT_TOO_LARGE"
  | "INPUT_BUSY"
  | "SHELL_UNAVAILABLE"
  | "PTY_UNAVAILABLE"
  | "IO_ERROR";

export interface TerminalCommands {
  terminal_start: {
    args: TerminalSize & { workspaceId?: string };
    result: TerminalStarted;
  };
  terminal_read: { args: { id: string }; result: TerminalOutput };
  terminal_input: { args: { id: string; data: number[] }; result: void };
  terminal_resize: { args: TerminalSize & { id: string }; result: void };
  terminal_close: { args: { id: string }; result: void };
}
