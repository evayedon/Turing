// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_SAVE_DELAY_MS, useEditor } from "./use-editor";

vi.mock("./draft-ipc", () => import("../test/mock-draft-ipc"));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));

const ipc = vi.mocked(invoke);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const file = (workspaceId: string, relativePath: string) => ({
  workspaceId,
  relativePath,
  content: "saved",
  encoding: "utf-8",
  version: "v1",
});

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.useFakeTimers();
  ipc.mockReset();
  ipc.mockImplementation(async (command, args) => {
    const input = (args ?? {}) as Record<string, string>;
    if (command === "fs_read_file")
      return file(input.workspaceId, input.relativePath);
    if (command === "fs_write_file") return "v2";
    if (command === "workspace_rename_entry") {
      // Native returns the entry's new workspace-relative path.
      const slash = input.relativePath.lastIndexOf("/");
      return `${input.relativePath.slice(0, slash + 1)}${input.name}`;
    }
    throw new Error(`Unexpected command ${command}`);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function advance(ms = AUTO_SAVE_DELAY_MS) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

function setup(workspaceId = "workspace") {
  const hook = renderHook(({ id }) => useEditor(id, true), {
    initialProps: { id: workspaceId },
  });
  const { result } = hook;
  const edit = (draft: string) => {
    const active = result.current.active;
    if (!active) throw new Error("Expected an open editor");
    act(() => result.current.edit(active, draft));
  };
  return { ...hook, edit };
}

/** Starts an Auto Save of `draft` that stays in flight until resolved. */
async function pendingAutoSave(
  editor: ReturnType<typeof setup>,
  draft: string,
) {
  act(() => editor.result.current.toggleAutoSave());
  editor.edit(draft);
  const save = deferred<string>();
  ipc.mockReturnValueOnce(save.promise);
  await advance();
  expect(ipc).toHaveBeenLastCalledWith(
    "fs_write_file",
    expect.objectContaining({ content: draft }),
  );
  return save;
}

describe("document identity", () => {
  it("names each document by a canonical URI and advances its revision when the source changes", async () => {
    const editor = setup();
    await act(async () => editor.result.current.open("src/main.ts"));
    const opened = editor.result.current.active!;
    expect(opened.uri).toBe("turing-workspace://workspace/src/main.ts");

    editor.edit("changed");
    expect(editor.result.current.active!.revision).toBe(opened.revision);
    await act(async () => editor.result.current.save());
    const saved = editor.result.current.active!;
    expect(saved.revision).toBeGreaterThan(opened.revision);

    await act(async () =>
      editor.result.current.renameWorkspaceEntry("src/main.ts", "app.ts", "id"),
    );
    const renamed = editor.result.current.active!;
    expect(renamed.uri).toBe("turing-workspace://workspace/src/app.ts");
    expect(renamed.revision).toBeGreaterThan(saved.revision);
    expect(renamed.key).toBe(opened.key);
  });

  it("closes a tab requested during Auto Save once the save lands, without reviving it", async () => {
    const editor = setup();
    await act(async () => editor.result.current.open("sample.ts"));
    const save = await pendingAutoSave(editor, "first draft");

    const closing = act(async () =>
      editor.result.current.close(editor.result.current.active!),
    );
    expect(editor.result.current.tabs).toHaveLength(1);
    await act(async () => save.resolve("v2"));
    await closing;
    expect(editor.result.current.tabs).toHaveLength(0);
    expect(ipc).not.toHaveBeenCalledWith(
      "editor_confirm_discard",
      expect.anything(),
    );
  });

  it("renames a file while Auto Save writes it, keeping typing and the saved version", async () => {
    const editor = setup();
    await act(async () => editor.result.current.open("sample.ts"));
    const save = await pendingAutoSave(editor, "first draft");

    const renaming = act(async () =>
      editor.result.current.renameWorkspaceEntry(
        "sample.ts",
        "renamed.ts",
        "id",
      ),
    );
    editor.edit("typed during save");
    await act(async () => save.resolve("v2"));
    await renaming;

    expect(editor.result.current.active).toMatchObject({
      uri: "turing-workspace://workspace/renamed.ts",
      title: "renamed.ts",
      content: "first draft",
      draft: "typed during save",
      source: { relativePath: "renamed.ts", version: "v2" },
    });
  });

  it("drops a file read that finishes after the workspace was replaced", async () => {
    const editor = setup("first");
    const read = deferred<ReturnType<typeof file>>();
    ipc.mockReturnValueOnce(read.promise);
    let opening: Promise<unknown> | undefined;
    act(() => {
      opening = editor.result.current.open("old.ts");
    });
    editor.rerender({ id: "second" });
    await act(async () => {
      read.resolve(file("first", "old.ts"));
      await opening;
    });
    expect(editor.result.current.tabs).toEqual([]);
    expect(editor.result.current.error).toBeUndefined();
  });
});
