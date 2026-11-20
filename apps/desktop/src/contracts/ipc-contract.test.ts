import type {
  BranchInfo,
  RecoveryDraft,
  RecoveryError,
  RecoveryReply,
  RecoveryRequest,
  RecoverySource,
  DirectoryEntry,
  ExecutionError,
  ExecutionLanguage,
  ExecutionPhase,
  ExecutionStarted,
  ExecutionStream,
  ExecutionUpdate,
  FileState,
  GitDiff,
  GitError,
  GitStatus,
  LanguageCapabilities,
  LanguageAction,
  LanguagePosition,
  RenamePreview,
  PrepareRename,
  WorkspaceEditFailure,
  WorkspaceFileEdit,
  WorkspaceTextEdit,
  LanguageError,
  LanguageEvent,
  LanguageUpdate,
  LanguageServer,
  LogEntry,
  SearchMatch,
  SearchResponse,
  SymbolsResponse,
  WorkspaceSymbol,
  WorkspaceSymbolKind,
  SelectedFileSnapshot,
  SelectedFileVersion,
  StatusEntry,
  TerminalError,
  TerminalOutput,
  TerminalStarted,
  TextFile,
  WorkspaceChanges,
  WorkspaceDescriptor,
  WorkspaceError,
} from "@turing/contracts";
import { describe, expect, it } from "vitest";
import fixture from "../../../../packages/contracts/fixtures/ipc-contract.json";

// Shared fixtures are checked natively by `contract_tests` in src-tauri.
// Here each contract gets a compile-checked description, so changing a
// TypeScript contract without updating the description fails typecheck,
// and a description that disagrees with the fixtures fails this test.

/** Requires `values` to list every member of `T` and nothing else. */
const every =
  <T extends string>() =>
  <const V extends readonly T[]>(
    values: V & ([T] extends [V[number]] ? unknown : never),
  ) =>
    values;

type PresenceKind = "required" | "optional" | "nullable" | "optional-nullable";
type Presence<V> = undefined extends V
  ? null extends V
    ? "optional-nullable"
    : "optional"
  : null extends V
    ? "nullable"
    : "required";

type Field =
  | PresenceKind
  | { array: Spec }
  | { object: Spec }
  | { values: readonly string[] };
type Spec = Record<string, Field>;

/** Keys must exactly match `T`; each key states its optionality. */
type Shape<T> = {
  [K in keyof T]-?:
    | Presence<T[K]>
    | { array: Spec }
    | { object: Spec }
    | { values: readonly string[] };
};

const shape =
  <T>() =>
  <const S extends Shape<T>>(
    spec: S & Record<Exclude<keyof S, keyof T>, never>,
  ) =>
    spec;

const errors = {
  recovery: every<RecoveryError>()([
    "PERMISSION_DENIED",
    "INVALID_DRAFT",
    "DRAFT_LIMIT",
    "JOURNAL_IO",
  ]),
  workspace: every<WorkspaceError>()([
    "BUSY",
    "WINDOW_LIMIT",
    "PERMISSION_DENIED",
    "OUTSIDE_WORKSPACE",
    "NOT_FOUND",
    "NOT_DIRECTORY",
    "NOT_FILE",
    "INVALID_ENCODING",
    "FILE_TOO_LARGE",
    "FILE_CONFLICT",
    "SAVE_RACE",
    "INVALID_NAME",
    "ENTRY_CHANGED",
    "NAME_TAKEN",
    "RENAME_RACE",
    "DIRECTORY_TOO_LARGE",
    "INVALID_SEARCH",
    "SEARCH_BUSY",
    "SEARCH_CANCELLED",
    "IO_ERROR",
  ]),
  terminal: every<TerminalError>()([
    "PERMISSION_DENIED",
    "SESSION_LIMIT",
    "SESSION_CLOSED",
    "INVALID_SIZE",
    "INVALID_LINK",
    "INPUT_TOO_LARGE",
    "INPUT_BUSY",
    "SHELL_UNAVAILABLE",
    "PTY_UNAVAILABLE",
    "IO_ERROR",
    "START_TIMEOUT",
  ]),
  git: every<GitError>()([
    "NO_GIT",
    "NOT_A_REPOSITORY",
    "WORKSPACE_NOT_OPEN",
    "INVALID_REF",
    "INVALID_PATH",
    "INVALID_MESSAGE",
    "NOTHING_TO_COMMIT",
    "IDENTITY_MISSING",
    "UNCOMMITTED_CHANGES",
    "OPERATION_FAILED",
    "IO_ERROR",
  ]),
  execution: every<ExecutionError>()([
    "PERMISSION_DENIED",
    "BUSY",
    "UNSUPPORTED_LANGUAGE",
    "SOURCE_CHANGED",
    "SOURCE_UNAVAILABLE",
    "PYTHON_UNAVAILABLE",
    "COMPILER_UNAVAILABLE",
    "C_COMPILER_UNAVAILABLE",
    "RUST_UNAVAILABLE",
    "GO_UNAVAILABLE",
    "JAVA_UNAVAILABLE",
    "NODE_UNAVAILABLE",
    "TYPESCRIPT_UNAVAILABLE",
    "DOTNET_UNAVAILABLE",
    "PROCESS_UNAVAILABLE",
    "TIMED_OUT",
    "INTERNAL",
  ]),
  language: every<LanguageError>()([
    "DENIED",
    "UNAVAILABLE",
    "START_FAILED",
    "INCOMPATIBLE",
    "SERVER_EXITED",
    "BUSY",
    "INVALID_DOCUMENT",
    "INVALID_WORKSPACE_EDIT",
    "NOT_READY",
    "INTERNAL",
  ]),
};

const enums = {
  LanguageServer: every<LanguageServer>()([
    "clangd",
    "typescript",
    "pyright",
    "rust-analyzer",
  ]),
  WorkspaceSymbolKind: every<WorkspaceSymbolKind>()([
    "class",
    "constant",
    "enum",
    "function",
    "interface",
    "macro",
    "module",
    "struct",
    "trait",
    "type",
    "variable",
  ]),
  EntryKind: every<DirectoryEntry["kind"]>()(["directory", "file"]),
  FileState: every<FileState>()([
    "untracked",
    "modified",
    "added",
    "deleted",
    "renamed",
    "copied",
    "unmerged",
  ]),
  ExecutionLanguage: every<ExecutionLanguage>()([
    "python",
    "cpp",
    "c",
    "rust",
    "go",
    "java",
    "javascript",
    "typescript",
    "csharp",
  ]),
  ExecutionPhase: every<ExecutionPhase>()([
    "preparing",
    "compiling",
    "running",
    "stopping",
    "completed",
    "failed",
  ]),
  ExecutionStream: every<ExecutionStream>()([
    "buildStdout",
    "buildStderr",
    "stdout",
    "stderr",
  ]),
};

const searchMatch = shape<SearchMatch>()({
  line: "required",
  column: "required",
  before: "required",
  text: "required",
  after: "required",
});
const statusEntry = shape<StatusEntry>()({
  path: "required",
  staged: "required",
  state: { values: enums.FileState },
  originalPath: "nullable",
});
const capabilities = shape<LanguageCapabilities>()({
  hover: "required",
  completion: "required",
  definition: "required",
  references: "optional",
  implementation: "optional",
  declaration: "optional",
  workspaceSymbol: "optional",
  prepareRename: "required",
  rename: "required",
});
const diagnosticsEvent = shape<
  Extract<LanguageEvent, { kind: "diagnostics" }>
>()({
  kind: { values: ["diagnostics"] },
  path: "required",
  version: "required",
  diagnostics: "required",
});
const responseEvent = shape<Extract<LanguageEvent, { kind: "response" }>>()({
  kind: { values: ["response"] },
  requestId: "required",
  value: "optional-nullable",
});

const languagePosition = shape<LanguagePosition>()({
  line: "required",
  character: "required",
});
const workspaceTextEdit = shape<WorkspaceTextEdit>()({
  start: "required",
  end: "required",
  position: { object: languagePosition },
  before: "required",
  after: "required",
});
const workspaceFileEdit = shape<WorkspaceFileEdit>()({
  path: "required",
  baseVersion: "required",
  documentVersion: "nullable",
  edits: { array: workspaceTextEdit },
});

type RecoveryPayload = "RecoveryRequest" | "RecoveryReply";

const recoveryWorkspace = shape<
  Extract<RecoverySource, { kind: "workspace" }>
>()({
  kind: { values: ["workspace"] },
  root: "required",
  relativePath: "required",
  version: "required",
  identity: "optional",
});
const recoveryCopy = shape<Extract<RecoverySource, { kind: "copy" }>>()({
  kind: { values: ["copy"] },
});
const recoveryDraft = shape<RecoveryDraft>()({
  id: "required",
  name: "required",
  title: "required",
  draft: "required",
  timestamp: "required",
  languageOverride: "optional",
  source: "required",
});
const recoveryRequests = {
  list: shape<Extract<RecoveryRequest, { action: "list" }>>()({
    action: { values: ["list"] },
  }),
  migrate: shape<Extract<RecoveryRequest, { action: "migrate" }>>()({
    action: { values: ["migrate"] },
    entry: { object: { ...recoveryDraft, source: { object: recoveryCopy } } },
  }),
  snapshot: shape<Extract<RecoveryRequest, { action: "snapshot" }>>()({
    action: { values: ["snapshot"] },
    uri: "required",
    workspaceId: "optional",
    replaces: "optional",
    entry: {
      object: { ...recoveryDraft, source: { object: recoveryWorkspace } },
    },
  }),
  resolve: shape<Extract<RecoveryRequest, { action: "resolve" }>>()({
    action: { values: ["resolve"] },
    id: "required",
  }),
  matches: shape<Extract<RecoveryRequest, { action: "matches" }>>()({
    action: { values: ["matches"] },
    id: "required",
    workspaceId: "required",
  }),
} satisfies Record<RecoveryRequest["action"], Spec>;
const recoveryReplies = {
  list: shape<Extract<RecoveryReply, { kind: "list" }>>()({
    kind: { values: ["list"] },
    skipped: "required",
    entries: {
      array: { ...recoveryDraft, source: { object: recoveryWorkspace } },
    },
  }),
  written: shape<Extract<RecoveryReply, { kind: "written" }>>()({
    kind: { values: ["written"] },
    id: "required",
  }),
  matches: shape<Extract<RecoveryReply, { kind: "matches" }>>()({
    kind: { values: ["matches"] },
    matches: "required",
  }),
  done: shape<Extract<RecoveryReply, { kind: "done" }>>()({
    kind: { values: ["done"] },
  }),
} satisfies Record<RecoveryReply["kind"], Spec>;

const {
  RecoveryRequest: recoveryRequestCases,
  RecoveryReply: recoveryReplyCases,
  ...ordinaryCases
} = fixture.payloads;

const payloads: Record<
  Exclude<keyof typeof fixture.payloads, RecoveryPayload>,
  Spec
> = {
  WorkspaceDescriptor: shape<WorkspaceDescriptor>()({
    id: "required",
    name: "required",
    displayPath: "optional",
  }),
  DirectoryEntry: shape<DirectoryEntry>()({
    name: "required",
    relativePath: "required",
    kind: { values: enums.EntryKind },
    identity: "optional",
  }),
  TextFile: shape<TextFile>()({
    workspaceId: "required",
    relativePath: "required",
    content: "required",
    encoding: { values: ["utf-8"] },
    version: "required",
  }),
  WorkspaceChanges: shape<WorkspaceChanges>()({
    paths: "required",
    rescan: "required",
  }),
  SymbolsResponse: shape<SymbolsResponse>()({
    generation: "required",
    complete: "required",
    truncated: "required",
    symbols: {
      array: shape<WorkspaceSymbol>()({
        name: "required",
        kind: { values: enums.WorkspaceSymbolKind },
        relativePath: "required",
        line: "required",
        character: "required",
      }),
    },
  }),
  SearchResponse: shape<SearchResponse>()({
    files: {
      array: shape<SearchResponse["files"][number]>()({
        relativePath: "required",
        matches: { array: searchMatch },
      }),
    },
    truncated: "required",
    skippedFiles: "required",
  }),
  SelectedFileVersion: shape<SelectedFileVersion>()({
    fileId: "required",
    name: "required",
    displayPath: "required",
    version: "required",
  }),
  SelectedFileSnapshot: shape<SelectedFileSnapshot>()({
    fileId: "required",
    name: "required",
    displayPath: "required",
    version: "required",
    content: "required",
  }),
  TerminalStarted: shape<TerminalStarted>()({
    id: "required",
    workspaceDirectory: "required",
    shell: "required",
  }),
  TerminalOutput: shape<TerminalOutput>()({
    bytes: "required",
    finished: "required",
    exitCode: "nullable",
  }),
  GitStatus: shape<GitStatus>()({
    branch: "nullable",
    entries: { array: statusEntry },
    ahead: "required",
    behind: "required",
  }),
  GitDiff: shape<GitDiff>()({ text: "required", truncated: "required" }),
  LogEntry: shape<LogEntry>()({
    hash: "required",
    shortHash: "required",
    subject: "required",
    authorName: "required",
    authorEmail: "required",
    date: "required",
  }),
  BranchInfo: shape<BranchInfo>()({
    name: "required",
    isHead: "required",
    isRemote: "required",
  }),
  ExecutionStarted: shape<ExecutionStarted>()({
    id: "required",
    name: "required",
    language: { values: enums.ExecutionLanguage },
  }),
  ExecutionUpdate: shape<ExecutionUpdate>()({
    phase: { values: enums.ExecutionPhase },
    elapsedMs: "required",
    exitCode: "nullable",
    error: "nullable",
    cancelled: "required",
    truncated: "required",
    output: {
      array: shape<ExecutionUpdate["output"][number]>()({
        stream: { values: enums.ExecutionStream },
        bytes: "required",
      }),
    },
  }),
  RenameAction: shape<Extract<LanguageAction, { kind: "request" }>>()({
    kind: { values: ["request"] },
    path: "required",
    version: "required",
    position: { object: languagePosition },
    feature: { values: ["prepareRename", "rename"] },
    requestId: "required",
    newName: "optional",
  }),
  PrepareRename: shape<PrepareRename>()({ placeholder: "required" }),
  WorkspaceEditFailure: shape<WorkspaceEditFailure>()({
    error: { values: ["INVALID_WORKSPACE_EDIT"] },
  }),
  RenamePreview: shape<RenamePreview>()({
    files: { array: workspaceFileEdit },
  }),
  LanguageUpdate: shape<LanguageUpdate>()({
    capabilities: "nullable",
    events: "required",
    stderr: "optional",
    error: "optional",
  }),
};

/** Returns a description of every way `value` disagrees with `spec`. */
function mismatches(value: unknown, spec: Spec, path: string): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return [`${path}: expected an object`];
  const record = value as Record<string, unknown>;
  const problems = Object.keys(record)
    .filter((key) => !Object.hasOwn(spec, key))
    .map((key) => `${path}.${key}: not in the TypeScript contract`);
  for (const [key, field] of Object.entries(spec)) {
    const at = `${path}.${key}`;
    const present = Object.hasOwn(record, key);
    const item = record[key];
    if (typeof field === "string") {
      if (!present && !field.startsWith("optional"))
        problems.push(`${at}: required but missing`);
      if (item === null && !field.endsWith("nullable"))
        problems.push(`${at}: null but the contract does not allow null`);
    } else if (!present) {
      problems.push(`${at}: required but missing`);
    } else if ("values" in field) {
      if (!field.values.includes(item as string))
        problems.push(
          `${at}: ${JSON.stringify(item)} is not one of ${field.values.join(", ")}`,
        );
    } else if ("array" in field) {
      if (!Array.isArray(item)) problems.push(`${at}: expected an array`);
      else
        item.forEach((entry, index) =>
          problems.push(...mismatches(entry, field.array, `${at}[${index}]`)),
        );
    } else {
      problems.push(...mismatches(item, field.object, at));
    }
  }
  return problems;
}

const sorted = (values: readonly string[]) => [...values].sort();

describe("IPC contract fixtures", () => {
  it.each(Object.entries(errors))(
    "%s error codes match native and client-only codes",
    (domain, codes) => {
      const expected = fixture.errors[domain as keyof typeof errors];
      const clientOnly: readonly string[] = expected.clientOnly;
      expect(sorted(codes)).toEqual(
        sorted([...expected.native, ...clientOnly]),
      );
      expect(
        expected.native.filter((code) => clientOnly.includes(code)),
      ).toEqual([]);
    },
  );

  it.each(Object.entries(enums))("%s values match", (name, values) => {
    expect(sorted(values)).toEqual(
      sorted(fixture.enums[name as keyof typeof enums]),
    );
  });

  it("describes every fixture payload and nothing extra", () => {
    expect(sorted(Object.keys(payloads))).toEqual(
      sorted(Object.keys(ordinaryCases)),
    );
  });

  it.each(Object.entries(ordinaryCases))(
    "%s cases satisfy the TypeScript contract",
    (name, cases) => {
      const spec = payloads[name as keyof typeof payloads];
      expect(cases.length).toBeGreaterThan(0);
      const problems = (cases as unknown[]).flatMap((value, index) =>
        mismatches(value, spec, `${name}[${index}]`),
      );
      expect(problems).toEqual([]);
    },
  );

  it("draft journal requests and replies satisfy each variant contract", () => {
    expect(sorted(recoveryRequestCases.map(({ action }) => action))).toEqual(
      sorted(Object.keys(recoveryRequests)),
    );
    expect(sorted(recoveryReplyCases.map(({ kind }) => kind))).toEqual(
      sorted(Object.keys(recoveryReplies)),
    );
    for (const value of recoveryRequestCases) {
      expect(
        mismatches(
          value,
          recoveryRequests[value.action as keyof typeof recoveryRequests],
          value.action,
        ),
      ).toEqual([]);
    }
    for (const value of recoveryReplyCases) {
      expect(
        mismatches(
          value,
          recoveryReplies[value.kind as keyof typeof recoveryReplies],
          value.kind,
        ),
      ).toEqual([]);
    }
  });

  it("language events and capabilities satisfy their variant contracts", () => {
    const problems = fixture.payloads.LanguageUpdate.flatMap(
      (update, index) => [
        ...(update.capabilities === null
          ? []
          : mismatches(
              update.capabilities,
              capabilities,
              `LanguageUpdate[${index}].capabilities`,
            )),
        ...update.events.flatMap((event, at) =>
          mismatches(
            event,
            event.kind === "diagnostics" ? diagnosticsEvent : responseEvent,
            `LanguageUpdate[${index}].events[${at}]`,
          ),
        ),
      ],
    );
    expect(problems).toEqual([]);
  });

  it("reports drift precisely", () => {
    expect(
      mismatches(
        { path: "a", staged: true, state: "edited", extra: 1 },
        statusEntry,
        "entry",
      ),
    ).toEqual([
      "entry.extra: not in the TypeScript contract",
      'entry.state: "edited" is not one of untracked, modified, added, deleted, renamed, copied, unmerged',
      "entry.originalPath: required but missing",
    ]);
    expect(
      mismatches({ id: "1", name: null }, payloads.WorkspaceDescriptor, "ws"),
    ).toEqual(["ws.name: null but the contract does not allow null"]);
  });
});
