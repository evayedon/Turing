// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RecoveryDraft, RecoveryRequest } from "@turing/contracts";
import { LARGE_DOCUMENT_LENGTH } from "./performance-budget";

import { DRAFT_SNAPSHOT_INTERVAL_MS, isDirty } from "./use-draft-recovery";
import { AUTO_SAVE_DELAY_MS, autoSaveKey, useEditor } from "./use-editor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
const ipc = vi.mocked(invoke);
let disk: { version: string; content: string };
let allowDiscard: boolean;
let readError: string | undefined;
let writeError: boolean;
const journal = new Map<string, RecoveryDraft>();
let skipped: boolean;

async function relaunch(id?: string, root?: string, native = true) {
  const editor = renderHook(() => useEditor(id, native, root));
  await act(async () => {});
  return editor;
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  disk = { version: "first", content: "on disk" };
  allowDiscard = true;
  readError = undefined;
  writeError = false;
  skipped = false;
  journal.clear();
  ipc.mockReset();
  ipc.mockImplementation(async (command, args) => {
    if (command === "draft_recovery") {
      if (!args || !("request" in args)) throw new Error("Expected request");
      const request = args.request as RecoveryRequest;
      switch (request.action) {
        case "list":
          return { kind: "list", entries: [...journal.values()], skipped };
        case "matches":
          return { kind: "matches", matches: request.workspaceId !== "other" };
        case "resolve":
          journal.delete(request.id);
          return { kind: "done" };
        case "snapshot":
        case "migrate": {
          if (writeError) throw "JOURNAL_IO";
          const id =
            request.action === "snapshot" ? request.uri : request.entry.id;
          if (request.action === "snapshot" && request.replaces)
            journal.delete(request.replaces);
          journal.set(id, { ...request.entry, id });
          return { kind: "written", id };
        }
      }
    }
    if (command === "editor_exit") {
      journal.clear();
      return;
    }
    if (command === "fs_read_file") {
      if (readError) throw readError;
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
  const editor = await relaunch("original", "/project");
  await act(async () => editor.result.current.open("main.ts"));
  act(() => editor.result.current.edit(editor.result.current.active!, draft));
  await act(async () =>
    vi.advanceTimersByTimeAsync(DRAFT_SNAPSHOT_INTERVAL_MS),
  );
  return editor;
}

it("restores a crash snapshot under a fresh workspace grant and waits for an explicit save", async () => {
  (await writeSnapshot()).unmount();
  localStorage.setItem(autoSaveKey, "true");
  const { result } = await relaunch("new-grant", "/project");
  expect(result.current.recoveryDrafts[0]?.draft).toBe("unsaved");
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
  const restarted = await relaunch();
  expect(restarted.result.current.recoveryDrafts).toEqual([]);
});

it("retains the original version and leaves newer disk content intact", async () => {
  (await writeSnapshot()).unmount();
  disk = { version: "second", content: "external edit" };
  const { result } = await relaunch("new-grant", "/project");
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
  await act(async () => result.current.compareDisk(result.current.active!));
  expect(result.current.active?.diskComparison).toEqual(disk);
});

it("keeps a workspace draft pending until its original workspace is approved", async () => {
  (await writeSnapshot()).unmount();
  const { result, rerender } = renderHook(
    ({ id, root }) => useEditor(id, true, root),
    {
      initialProps: {
        id: undefined as string | undefined,
        root: undefined as string | undefined,
      },
    },
  );
  await act(async () => {});
  ipc.mockClear();
  await act(async () =>
    result.current.restoreDraft(result.current.recoveryDrafts[0]),
  );
  expect(ipc).not.toHaveBeenCalled();
  expect(result.current.active).toBeUndefined();
  expect(result.current.recoveryDrafts).toHaveLength(1);

  rerender({ id: "other", root: "/other" });
  await act(async () =>
    result.current.restoreDraft(result.current.recoveryDrafts[0]),
  );
  expect(ipc).not.toHaveBeenCalledWith("fs_read_file", expect.anything());
  expect(result.current.recoveryDrafts).toHaveLength(1);

  rerender({ id: "new-grant", root: "/project" });
  await act(async () =>
    result.current.restoreDraft(result.current.recoveryDrafts[0]),
  );
  expect(result.current.active?.draft).toBe("unsaved");
  expect(result.current.recoveryDrafts).toEqual([]);
});

it.each(["renamed", "deleted"])(
  "recovers an empty draft as an unsaved copy when the file was %s",
  async () => {
    (await writeSnapshot("")).unmount();
    readError = "NOT_FOUND";
    const { result } = await relaunch("new-grant", "/project");
    await act(async () =>
      result.current.restoreDraft(result.current.recoveryDrafts[0]),
    );
    expect(result.current.active).toMatchObject({
      draft: "",
      source: { kind: "untitled" },
      recoveryNote: expect.stringContaining("original file is missing"),
    });
    expect(isDirty(result.current.active!)).toBe(true);
    await act(async () => result.current.close(result.current.active!));
    expect(ipc).toHaveBeenCalledWith("editor_confirm_discard", {
      action: "tab",
    });
    expect((await relaunch()).result.current.recoveryDrafts).toEqual([]);
  },
);

it("restores an already open document as a copy without replacing its edits", async () => {
  (await writeSnapshot()).unmount();
  const { result } = await relaunch("new-grant", "/project");
  await act(async () => result.current.open("main.ts"));
  act(() => result.current.edit(result.current.active!, "current edits"));
  await act(async () =>
    result.current.restoreDraft(result.current.recoveryDrafts[0]),
  );
  expect(result.current.tabs.map(({ draft }) => draft)).toEqual([
    "current edits",
    "unsaved",
  ]);
  expect(result.current.active).toMatchObject({
    source: { kind: "untitled" },
    recoveryNote: expect.stringContaining("already open"),
  });
});

it("retains a draft when discard is cancelled and hides recovery in browser preview", async () => {
  (await writeSnapshot()).unmount();
  const preview = await relaunch(undefined, undefined, false);
  expect(preview.result.current.recoveryDrafts).toEqual([]);
  const { result } = await relaunch();
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

it("restores an empty draft into the active group and journals it until its last view is discarded", async () => {
  (await writeSnapshot("")).unmount();
  readError = "NOT_FOUND";
  const { result } = await relaunch("new-grant", "/project");
  act(() => result.current.newFile());
  act(() => result.current.splitEditor());
  const [left, right] = result.current.groups.groups;
  expect(result.current.groups.activeGroup).toBe(right.id);

  await act(async () =>
    result.current.restoreDraft(result.current.recoveryDrafts[0]),
  );
  const restored = result.current.active!;
  expect(restored).toMatchObject({ recovered: true, draft: "" });
  expect(result.current.groups.groups).toEqual([
    left,
    { ...right, keys: [...right.keys, restored.key], activeKey: restored.key },
  ]);

  act(() => result.current.splitEditor());
  const shared = result.current.groups.activeGroup;
  ipc.mockClear();
  await act(async () => result.current.closeGroup(shared));
  expect(ipc).not.toHaveBeenCalled();
  expect(result.current.active).toBe(restored);

  allowDiscard = false;
  await act(async () => result.current.closeGroup(right.id));
  expect(ipc).toHaveBeenCalledWith("editor_confirm_discard", { action: "tab" });
  expect(result.current.active).toBe(restored);
  const restarted = await relaunch();
  expect(restarted.result.current.recoveryDrafts[0]?.draft).toBe("");
  restarted.unmount();

  allowDiscard = true;
  await act(async () => result.current.closeGroup(right.id));
  expect(result.current.groups.groups).toEqual([left]);
  expect(result.current.tabs).not.toContain(restored);
  const afterDiscard = await relaunch();
  expect(afterDiscard.result.current.recoveryDrafts).toEqual([]);
});

it("throttles small edits and skips large edits even when the page is hidden", async () => {
  const { result } = await relaunch("original", "/project");
  await act(async () => result.current.open("main.ts"));
  const writes = () =>
    ipc.mock.calls.filter(
      ([command, args]) =>
        command === "draft_recovery" &&
        args &&
        "request" in args &&
        (args.request as RecoveryRequest).action === "snapshot",
    );
  act(() => result.current.edit(result.current.active!, "one"));
  await act(async () =>
    vi.advanceTimersByTimeAsync(DRAFT_SNAPSHOT_INTERVAL_MS - 1),
  );
  act(() => result.current.edit(result.current.active!, "two"));
  expect(writes()).toHaveLength(0);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(writes()).toHaveLength(1);
  expect(writes()[0][1]).toMatchObject({
    request: { entry: { draft: "two" } },
  });

  act(() =>
    result.current.edit(
      result.current.active!,
      "x".repeat(LARGE_DOCUMENT_LENGTH),
    ),
  );
  await act(async () =>
    vi.advanceTimersByTimeAsync(DRAFT_SNAPSHOT_INTERVAL_MS),
  );
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(writes()).toHaveLength(1);
  expect(result.current.recoveryError).toContain(
    "Recovery is unavailable for main.ts",
  );
});

it("keeps multiple documents, journals one snapshot for a split document, and clears after normal exit", async () => {
  const { result } = await writeSnapshot();
  act(() => result.current.splitEditor());
  act(() => result.current.newFile());
  act(() => result.current.edit(result.current.active!, "another draft"));
  await act(async () =>
    vi.advanceTimersByTimeAsync(DRAFT_SNAPSHOT_INTERVAL_MS),
  );
  expect([...journal.values()].map(({ draft }) => draft)).toEqual([
    "unsaved",
    "another draft",
  ]);
  await act(async () =>
    window.dispatchEvent(new Event("turing-close-requested")),
  );
  expect(ipc).toHaveBeenCalledWith("editor_exit", undefined);
  expect(journal.size).toBe(0);
});

it("reports write failure and keeps the draft dirty in memory", async () => {
  writeError = true;
  const { result } = await writeSnapshot();
  expect(result.current.recoveryError).toContain(
    "Recovery is unavailable for main.ts",
  );
  expect(result.current.active?.draft).toBe("unsaved");
  expect(isDirty(result.current.active!)).toBe(true);
  expect(journal.size).toBe(0);
});

it("reports skipped native records while retaining valid recovery entries", async () => {
  (await writeSnapshot()).unmount();
  skipped = true;
  const { result } = await relaunch();
  expect(result.current.recoveryError).toContain(
    "skipped damaged recovery drafts",
  );
  expect(result.current.recoveryDrafts).toHaveLength(1);
});

it("keeps legacy storage until Rust acknowledges import and lists the migrated draft once", async () => {
  const key = "turing:draft:v1:old";
  localStorage.setItem(
    key,
    JSON.stringify({
      id: "old",
      name: "legacy",
      title: "legacy",
      draft: "keep me",
      source: { kind: "copy" },
      timestamp: 1,
    }),
  );
  writeError = true;
  (await relaunch()).unmount();
  expect(localStorage.getItem(key)).not.toBeNull();
  writeError = false;
  const { result } = await relaunch();
  expect(localStorage.getItem(key)).toBeNull();
  expect(result.current.recoveryDrafts.map(({ draft }) => draft)).toEqual([
    "keep me",
  ]);
});
