export type TerminalSize = { rows: number; cols: number };

export type TerminalProfile =
  "system" | "bash" | "zsh" | "sh" | "powershell" | "cmd";

export type TerminalStarted = {
  id: string;
  workspaceDirectory: boolean;
  shell: string;
};

export type TerminalOutput = {
  bytes: number[];
  finished: boolean;
  exitCode: number | null;
};

export type TerminalError =
  | "PERMISSION_DENIED"
  | "SESSION_LIMIT"
  | "SESSION_CLOSED"
  | "INVALID_SIZE"
  | "INVALID_LINK"
  | "INPUT_TOO_LARGE"
  | "INPUT_BUSY"
  | "SHELL_UNAVAILABLE"
  | "PTY_UNAVAILABLE"
  | "IO_ERROR"
  | "START_TIMEOUT";

export interface TerminalCommands {
  terminal_start: {
    args: TerminalSize & {
      workspaceId?: string;
      attempt?: string;
      profile?: TerminalProfile;
    };
    result: TerminalStarted;
  };
  terminal_cancel_start: { args: { attempt: string }; result: void };
  terminal_open_link: { args: { target: string }; result: void };
  terminal_read: { args: { id: string }; result: TerminalOutput };
  terminal_input: { args: { id: string; data: number[] }; result: void };
  terminal_resize: { args: TerminalSize & { id: string }; result: void };
  terminal_close: { args: { id: string }; result: void };
}
