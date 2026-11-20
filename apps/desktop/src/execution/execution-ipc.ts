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

const unavailableTools = new Set<unknown>([
  "PYTHON_UNAVAILABLE",
  "COMPILER_UNAVAILABLE",
  "C_COMPILER_UNAVAILABLE",
  "RUST_UNAVAILABLE",
  "GO_UNAVAILABLE",
  "JAVA_UNAVAILABLE",
  "NODE_UNAVAILABLE",
  "TYPESCRIPT_UNAVAILABLE",
  "DOTNET_UNAVAILABLE",
]);

export function toolUnavailableMessage(error: unknown) {
  if (unavailableTools.has(error)) return executionErrorMessage(error);
}

const messages = {
  PERMISSION_DENIED: "This file or run is no longer authorized.",
  BUSY: "A run is already in progress.",
  UNSUPPORTED_LANGUAGE:
    "Run supports Python, C, C++, Rust, Go, Java, JavaScript, TypeScript, and C# source files.",
  SOURCE_CHANGED: "This file changed on disk. Reload it before running.",
  SOURCE_UNAVAILABLE: "The saved source could not be read.",
  PYTHON_UNAVAILABLE:
    "Python was not found. Add python3 or python to Turing’s PATH.",
  COMPILER_UNAVAILABLE:
    "A C++ compiler was not found. Add clang++ or g++ to Turing’s PATH.",
  C_COMPILER_UNAVAILABLE:
    "C compiler unavailable. Install Clang or GCC and add clang or gcc to Turing’s PATH.",
  RUST_UNAVAILABLE:
    "Rust compiler unavailable. Install Rust with a configured toolchain and add rustc to Turing’s PATH.",
  GO_UNAVAILABLE:
    "Go toolchain unavailable. Install Go and add go to Turing’s PATH.",
  JAVA_UNAVAILABLE:
    "Java toolchain unavailable. Install a JDK (11 or newer recommended) and add java and javac to Turing’s PATH.",
  NODE_UNAVAILABLE:
    "JavaScript runtime unavailable. Install Node.js and add node to Turing’s PATH.",
  TYPESCRIPT_UNAVAILABLE:
    "TypeScript runtime unavailable. Add a Node.js version that supports --experimental-strip-types to Turing’s PATH.",
  DOTNET_UNAVAILABLE:
    "C# toolchain unavailable. Install a .NET 6 or newer SDK with its local targeting packs and add dotnet to Turing’s PATH.",
  PROCESS_UNAVAILABLE: "Turing could not start the process.",
  TIMED_OUT: "The process exceeded the time limit and was stopped.",
  INTERNAL: "Turing could not complete this run.",
} satisfies Record<ExecutionError, string>;

export function executionErrorMessage(error: unknown) {
  return typeof error === "string" && Object.hasOwn(messages, error)
    ? messages[error as ExecutionError]
    : messages.INTERNAL;
}
