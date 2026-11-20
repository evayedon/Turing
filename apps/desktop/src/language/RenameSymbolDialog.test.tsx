// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { WorkspaceFileEdit } from "@turing/contracts";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyModelEdit } from "../editor/apply-model-edit";
import { EditorWorkspace } from "../editor/EditorWorkspace";
import { ModelRegistry } from "../editor/model-registry";
import { created, resetFakeMonaco } from "../editor/fake-monaco";
import type { TextModels } from "../editor/MonacoHost";
import {
  AUTO_SAVE_DELAY_MS,
  autoSaveKey,
  useEditor,
} from "../editor/use-editor";
import type { EditorTab } from "../editor/use-editor";
import type { WorkspaceEditTarget } from "../editor/workspace-edit";
import type { EditorCommands } from "../shell/commands";
import { RenameSymbolDialog } from "./RenameSymbolDialog";
import type { RenameOrigin } from "./RenameSymbolDialog";
import type { LanguageController } from "./use-language";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
vi.mock("monaco-editor", () => import("../editor/fake-monaco"));
const ipc = vi.mocked(invoke);
const workspaceId = "project";
const content = "int old;\n";
const disk = new Map<string, { content: string; version: string }>();
let race: string | undefined;

function file(
  path: string,
  documentVersion: number | null = null,
): WorkspaceFileEdit {
  return {
    path,
    baseVersion: "v1",
    documentVersion,
    edits: [
      {
        start: 4,
        end: 7,
        position: { line: 0, character: 4 },
        before: "old",
        after: "renamed",
      },
    ],
  };
}

beforeEach(() => {
  localStorage.clear();
  disk.clear();
  race = undefined;
  ipc.mockReset();
  ipc.mockImplementation(async (command, args) => {
    if (
      !args ||
      !("relativePath" in args) ||
      typeof args.relativePath !== "string"
    )
      throw new Error(`Unexpected IPC command ${command}`);
    const path = args.relativePath;
    const snapshot = disk.get(path) ?? { content, version: "v1" };
    if (command === "fs_read_file") {
      return {
        ...snapshot,
        workspaceId,
        relativePath: path,
        encoding: "utf-8",
      };
    }
    if (command === "fs_write_file") {
      if (path === race) {
        disk.set(path, { content: "changed while saving", version: "v3" });
        throw "SAVE_RACE";
      }
      if (
        !("expectedVersion" in args) ||
        args.expectedVersion !== snapshot.version
      )
        throw "FILE_CONFLICT";
      if (!("content" in args) || typeof args.content !== "string")
        throw new Error("Missing content");
      disk.set(path, { content: args.content, version: "v2" });
      return "v2";
    }
    throw new Error(`Unexpected IPC command ${command}`);
  });
});

afterEach(() => {
  cleanup();
  resetFakeMonaco();
  localStorage.clear();
  vi.useRealTimers();
});

function Harness() {
  const editor = useEditor(workspaceId, true, "/project");
  const [models] = useState<TextModels>(() => new ModelRegistry());
  const [commands, setCommands] = useState<EditorCommands>();
  const [origin, setOrigin] = useState<RenameOrigin>();
  const language: LanguageController = {
    status: "ready",
    message: undefined,
    capabilities: {
      rename: true,
      prepareRename: true,
      hover: false,
      completion: false,
      definition: false,
    },
    batches: [],
    start: async () => {},
    stop: () => {},
    request: async () => ({ placeholder: "old" }),
    rename: async (tab, _position, name) => ({
      value: {
        files: [
          file("main.cpp", 1),
          file("closed.hpp"),
          file("excluded.hpp"),
          file("changed.hpp"),
        ].map((file) => ({
          ...file,
          edits: file.edits.map((edit) => ({ ...edit, after: name })),
        })),
      },
      documents: new Map([["main.cpp", { tab, version: 1 }]]),
    }),
  };

  return (
    <>
      <button onClick={() => void editor.open("main.cpp")}>Open source</button>
      <button onClick={() => editor.splitEditor()}>Split</button>
      <button onClick={() => commands?.run("undo")}>Undo edit</button>
      <button
        onClick={() =>
          editor.active &&
          setOrigin({
            workspaceId,
            tab: editor.active,
            position: { line: 0, character: 4 },
            prepare: true,
          })
        }
      >
        Rename
      </button>
      <EditorWorkspace
        {...editor}
        sharedModels={models}
        onCommandsReady={setCommands}
        onInfo={() => {}}
        emptyContent={null}
      />
      {origin && (
        <RenameSymbolDialog
          origin={origin}
          language={language}
          close={() => setOrigin(undefined)}
          apply={(targets, included) =>
            editor.applyWorkspaceEdit(
              workspaceId,
              targets,
              included,
              (tab, edits, next) => applyModelEdit(models, tab, edits, next),
            )
          }
        />
      )}
    </>
  );
}

it("previews each change, excludes files, and applies a shared undoable draft and a versioned save", async () => {
  localStorage.setItem(autoSaveKey, "true");
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Open source" }));
  const original = await screen.findByRole("textbox", { name: "File editor" });
  act(() => created.models[0].type(content + "// existing draft\n"));
  fireEvent.click(screen.getByRole("button", { name: "Split" }));
  await waitFor(() =>
    expect(
      screen.getAllByRole("textbox", { name: "File editor" }),
    ).toHaveLength(2),
  );
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  const dialog = screen.getByRole("dialog", { name: "Rename Symbol" });
  const ui = within(dialog);
  const name = ui.getByRole("textbox", { name: "New name" });
  await waitFor(() => expect(name).toHaveProperty("value", "old"));
  fireEvent.change(name, { target: { value: "renamed" } });
  fireEvent.click(ui.getByRole("button", { name: "Preview" }));
  expect(
    await ui.findByRole("heading", { name: "Changes to 4 files" }),
  ).toBeDefined();
  expect(
    ui.getAllByLabelText("Before").map((item) => item.textContent),
  ).toEqual(Array(4).fill("old"));
  expect(ui.getAllByLabelText("After").map((item) => item.textContent)).toEqual(
    Array(4).fill("renamed"),
  );
  fireEvent.click(ui.getByRole("checkbox", { name: "excluded.hpp" }));
  disk.set("changed.hpp", { content: "external change", version: "v2" });
  fireEvent.click(ui.getByRole("button", { name: "Apply" }));
  expect(await ui.findByRole("status")).toHaveProperty(
    "textContent",
    "Partially applied. 1 drafts, 1 saved, 1 excluded, 1 conflicts.",
  );
  expect(ui.getByText(/Disk version differs/i)).toBeDefined();
  expect(ipc).toHaveBeenCalledWith("fs_write_file", {
    workspaceId,
    relativePath: "closed.hpp",
    expectedVersion: "v1",
    content: "int renamed;\n",
  });
  expect(disk.get("changed.hpp")?.content).toBe("external change");
  expect(disk.has("excluded.hpp")).toBe(false);
  fireEvent.click(ui.getByRole("button", { name: "Close" }));
  for (const view of screen.getAllByRole("textbox", { name: "File editor" }))
    expect(view).toHaveProperty("value", "int renamed;\n// existing draft\n");
  await act(
    async () =>
      new Promise((resolve) => setTimeout(resolve, AUTO_SAVE_DELAY_MS + 50)),
  );
  expect(disk.has("main.cpp")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Undo edit" }));
  for (const view of screen.getAllByRole("textbox", { name: "File editor" }))
    expect(view).toHaveProperty("value", "int old;\n// existing draft\n");
  fireEvent.click(screen.getByRole("button", { name: "Undo edit" }));
  expect(original).toHaveProperty("value", content);
});

it("preserves drafts on edit, revision, watcher, recovered-draft and write-race conflicts", async () => {
  const restore = (path: string) => ({
    id: path,
    name: path,
    title: path,
    draft: "recovered text",
    timestamp: 1,
    source: {
      kind: "workspace",
      root: "/project",
      relativePath: path,
      version: "v1",
    },
  });
  for (const path of ["recovered.cpp", "journal.cpp"])
    localStorage.setItem(
      `turing:draft:v1:${path}`,
      JSON.stringify(restore(path)),
    );
  const { result } = renderHook(() => useEditor(workspaceId, true, "/project"));
  for (const path of ["modified.cpp", "reloaded.cpp", "watched.cpp"])
    await act(async () => result.current.open(path));
  await act(async () =>
    result.current.restoreDraft(
      result.current.recoveryDrafts.find(
        ({ name }) => name === "recovered.cpp",
      )!,
    ),
  );
  const snapshot = result.current.snapshotWorkspaceDocuments(workspaceId);
  function tab(path: string): EditorTab {
    const value = snapshot.get(path);
    if (!value) throw new Error(`No open document for ${path}`);
    return value;
  }
  const paths = [
    "modified.cpp",
    "reloaded.cpp",
    "watched.cpp",
    "recovered.cpp",
    "journal.cpp",
    "race.cpp",
  ];
  const targets: WorkspaceEditTarget[] = paths.map((path) => ({
    ...file(path),
    tab: snapshot.get(path),
    stale: false,
  }));
  act(() => {
    result.current.edit(tab("modified.cpp"), "existing editor changes");
    result.current.select(tab("reloaded.cpp").key);
  });
  await act(async () => result.current.reload());
  disk.set("watched.cpp", { content: "external change", version: "v2" });
  await act(async () =>
    result.current.applyDiskChanges(workspaceId, {
      paths: ["watched.cpp"],
      rescan: false,
    }),
  );
  race = "race.cpp";
  const apply = vi.fn(() => true);
  await act(async () => {
    const applied = await result.current.applyWorkspaceEdit(
      workspaceId,
      targets,
      new Set(paths),
      apply,
    );
    expect(
      applied?.map(({ path, outcome, reason }) => [path, outcome, reason]),
    ).toEqual([
      [
        "modified.cpp",
        "conflict",
        expect.stringMatching(/editor document changed/),
      ],
      [
        "reloaded.cpp",
        "conflict",
        expect.stringMatching(/editor document changed/),
      ],
      ["watched.cpp", "conflict", expect.stringMatching(/watcher flagged/)],
      ["recovered.cpp", "conflict", expect.stringMatching(/recovered draft/)],
      ["journal.cpp", "conflict", expect.stringMatching(/recovered draft/)],
      ["race.cpp", "conflict", expect.any(String)],
    ]);
  });
  expect(apply).not.toHaveBeenCalled();
  expect(
    result.current.snapshotWorkspaceDocuments(workspaceId).get("modified.cpp")
      ?.draft,
  ).toBe("existing editor changes");
  expect(
    result.current.snapshotWorkspaceDocuments(workspaceId).get("recovered.cpp")
      ?.draft,
  ).toBe("recovered text");
  expect(
    result.current.recoveryDrafts.some(({ name }) => name === "journal.cpp"),
  ).toBe(true);
  expect(disk.get("race.cpp")?.content).toBe("changed while saving");
  expect(
    ipc.mock.calls.filter(([command]) => command === "fs_write_file"),
  ).toEqual([
    [
      "fs_write_file",
      {
        workspaceId,
        relativePath: "race.cpp",
        expectedVersion: "v1",
        content: "int renamed;\n",
      },
    ],
  ]);
});
