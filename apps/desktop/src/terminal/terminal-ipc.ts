import { invoke } from "@tauri-apps/api/core";
import type { TerminalCommands, TerminalError } from "@turing/contracts";

export function invokeTerminal<Command extends keyof TerminalCommands>(
  command: Command,
  args: TerminalCommands[Command]["args"],
): Promise<TerminalCommands[Command]["result"]> {
  return invoke<TerminalCommands[Command]["result"]>(command, args);
}

const messages = {
  PERMISSION_DENIED:
    "The terminal could not access the requested workspace or session.",
  SESSION_LIMIT: "Close a terminal session before opening another.",
  SESSION_CLOSED: "The terminal session has closed.",
  INVALID_LINK: "Only HTTP and HTTPS links without credentials are supported.",
  INVALID_SIZE: "The terminal could not use the requested dimensions.",
  INPUT_TOO_LARGE: "The terminal input is too large.",
  INPUT_BUSY: "The shell is still processing input.",
  SHELL_UNAVAILABLE: "No usable system shell could be started.",
  PTY_UNAVAILABLE: "The desktop app could not initialize a system terminal.",
  START_TIMEOUT:
    "The shell did not start in time. Retry or choose another profile.",
  IO_ERROR: "The desktop app could not communicate with the terminal.",
} satisfies Record<TerminalError, string>;

export function terminalErrorMessage(error: unknown): string {
  if (typeof error === "string" && Object.hasOwn(messages, error))
    return messages[error as TerminalError];
  return messages.IO_ERROR;
}
