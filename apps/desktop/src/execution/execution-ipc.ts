import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  ExecutionError,
  ExecutionPhase,
  ExecutionSource,
  ExecutionStarted,
  ExecutionUpdate,
} from "@turing/contracts";

export function startExecution(
  source: ExecutionSource,
  onPhase: (phase: ExecutionPhase) => void,
) {
  return invoke<ExecutionStarted>("execution_start", {
    source,
    events: new Channel<ExecutionPhase>(onPhase),
  });
}

export const readExecution = (id: string) =>
  invoke<ExecutionUpdate>("execution_read", { id });

export const stopExecution = (id: string) =>
  invoke<void>("execution_stop", { id });

const messages = {
  PERMISSION_DENIED: "This file or run is no longer authorized.",
  BUSY: "A run is already in progress.",
  UNSUPPORTED_LANGUAGE: "Run supports Python and C++ source files.",
  SOURCE_CHANGED: "This file changed on disk. Reload it before running.",
  SOURCE_UNAVAILABLE: "The saved source could not be read.",
  PYTHON_UNAVAILABLE:
    "Python was not found. Add python3 or python to Turing’s PATH.",
  COMPILER_UNAVAILABLE:
    "A C++ compiler was not found. Add clang++ or g++ to Turing’s PATH.",
  PROCESS_UNAVAILABLE: "Turing could not start the process.",
  TIMED_OUT: "The process exceeded the time limit and was stopped.",
  INTERNAL: "Turing could not complete this run.",
} satisfies Record<ExecutionError, string>;

export function executionErrorMessage(error: unknown) {
  return typeof error === "string" && Object.hasOwn(messages, error)
    ? messages[error as ExecutionError]
    : messages.INTERNAL;
}
