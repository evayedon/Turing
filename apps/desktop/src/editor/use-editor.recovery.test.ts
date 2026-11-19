// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DRAFT_SNAPSHOT_INTERVAL_MS, isDirty } from "./use-draft-recovery";
import { AUTO_SAVE_DELAY_MS, autoSaveKey, useEditor } from "./use-editor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
const ipc = vi.mocked(invoke);
let disk: { version: string; content: string };
let allowDiscard: boolean;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  disk = { version: "first", content: "on disk" };
  allowDiscard = true;
  ipc.mockReset();
  ipc.mockImplementation(async (command, args) => {
    if (command === "fs_read_file") {
      return {
        ...disk,
        workspaceId: args && "workspaceId" in args ? args.workspaceId : "",
        relativePath: "main.ts",
        encoding: "utf-8",
      };
    }
    if (command === "fs_write_file") {
      if (
        !args ||
        !("expectedVersion" in args) ||
        args.expectedVersion !== disk.version
      )
        throw "FILE_CONFLICT";
      if (typeof args.content !== "string") throw new Error("Missing text");
      disk = { version: "saved", content: args.content };
      return disk.version;
    }
    if (command === "editor_confirm_discard") return allowDiscard;
    throw new Error(`Unexpected command ${command}`);
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

async function writeSnapshot(draft = "unsaved") {
  const editor = renderHook(() => useEditor("original", true, "/project"));
  await act(async () => editor.result.current.open("main.ts"));
  act(() => editor.result.current.edit(editor.result.current.active!, draft));
  await act(async () =>
    vi.advanceTimersByTimeAsync(DRAFT_SNAPSHOT_INTERVAL_MS),
  );
  return editor;
}

it("restores a crash snapshot under a fresh workspace grant and waits for an explicit save", async () => {
  const original = await writeSnapshot();
  localStorage.setItem(autoSaveKey, "true");
  const { result } = renderHook(() => useEditor("new-grant", true, "/project"));
  expect(result.current.recoveryDrafts[0]?.draft).toBe("unsaved");
  original.unmount();
  await act(async () =>
    result.current.restoreDraft(result.current.recoveryDrafts[0]),
  );
  expect(result.current.active).toMatchObject({
    draft: "unsaved",
    recovered: true,
    changedOnDisk: false,
    source: { workspaceId: "new-grant", version: "first" },
  });
  await act(async () => vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS));
  expect(disk.content).toBe("on disk");
  await act(async () => result.current.save());
  expect(disk.content).toBe("unsaved");
  const restarted = renderHook(() => useEditor(undefined, true));
  expect(restarted.result.current.recoveryDrafts).toEqual([]);
});

it("retains the original version and leaves newer disk content intact", async () => {
  (await writeSnapshot()).unmount();
  disk = { version: "second", content: "external edit" };
  const { result } = renderHook(() => useEditor("new-grant", true, "/project"));
  await act(async () =>
    result.current.restoreDraft(result.current.recoveryDrafts[0]),
  );
  expect(result.current.active).toMatchObject({
    content: "external edit",
    draft: "unsaved",
    changedOnDisk: true,
    source: { version: "first" },
  });
  await act(async () => result.current.save());
  expect(ipc).toHaveBeenCalledWith(
    "fs_write_file",
    expect.objectContaining({ expectedVersion: "first" }),
  );
  expect(disk.content).toBe("external edit");
  expect(result.current.active?.draft).toBe("unsaved");
});

it("recovers an empty copy without reading an unapproved workspace", async () => {
  (await writeSnapshot("")).unmount();
  ipc.mockClear();
  const { result } = renderHook(() => useEditor("other", true, "/other"));
  await act(async () =>
    result.current.restoreDraft(result.current.recoveryDrafts[0]),
  );
  expect(ipc).not.toHaveBeenCalled();
  expect(result.current.active).toMatchObject({
    draft: "",
    source: { kind: "untitled" },
  });
  expect(isDirty(result.current.active!)).toBe(true);
  await act(async () => result.current.close(result.current.active!));
  expect(ipc).toHaveBeenCalledWith("editor_confirm_discard", { action: "tab" });
  const restarted = renderHook(() => useEditor(undefined, true));
  expect(restarted.result.current.recoveryDrafts).toEqual([]);
});

it("retains a draft when discard is cancelled and hides recovery in browser preview", async () => {
  (await writeSnapshot()).unmount();
  const preview = renderHook(() => useEditor(undefined, false));
  expect(preview.result.current.recoveryDrafts).toEqual([]);
  const { result } = renderHook(() => useEditor(undefined, true));
  allowDiscard = false;
  await act(async () =>
    result.current.discardDraft(result.current.recoveryDrafts[0]),
  );
  expect(result.current.recoveryDrafts).toHaveLength(1);
  allowDiscard = true;
  await act(async () =>
    result.current.discardDraft(result.current.recoveryDrafts[0]),
  );
  expect(result.current.recoveryDrafts).toHaveLength(0);
});

it("does not discard a snapshot another window edited after recovery opened", async () => {
  const original = await writeSnapshot();
  const { result } = renderHook(() => useEditor(undefined, true));
  const stale = result.current.recoveryDrafts[0];
  act(() =>
    original.result.current.edit(original.result.current.active!, "updated"),
  );
  await act(async () =>
    vi.advanceTimersByTimeAsync(DRAFT_SNAPSHOT_INTERVAL_MS),
  );
  await act(async () => result.current.discardDraft(stale));
  expect(result.current.recoveryDrafts[0]?.draft).toBe("updated");
});
