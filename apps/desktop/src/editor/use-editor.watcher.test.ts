// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEditor } from "./use-editor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));

const ipc = vi.mocked(invoke);
/** Version on disk per relative path; a missing path reads as NOT_FOUND. */
let disk: Map<string, string>;

beforeEach(() => {
  disk = new Map([
    ["src/a.ts", "v1"],
    ["src/b.ts", "v1"],
    ["README.md", "v1"],
  ]);
  ipc.mockReset();
  ipc.mockImplementation(async (command, args) => {
    const path = (args as { relativePath: string }).relativePath;
    if (command === "fs_read_file") {
      const version = disk.get(path);
      if (!version) throw "NOT_FOUND";
      return {
        workspaceId: "workspace",
        relativePath: path,
        content: `contents of ${path}`,
        encoding: "utf-8",
        version,
      };
    }
    if (command === "fs_write_file") {
      disk.set(path, "saved");
      return "saved";
    }
    throw new Error(`Unexpected command ${command}`);
  });
});

afterEach(() => {
  cleanup();
});

async function openAll() {
  const { result } = renderHook(() => useEditor("workspace", true));
  for (const path of ["src/a.ts", "src/b.ts", "README.md"])
    await act(async () => result.current.open(path));
  const flags = () =>
    Object.fromEntries(
      result.current.tabs.map((tab) => [tab.title, tab.changedOnDisk]),
    );
  return { result, flags };
}

const reads = () =>
  ipc.mock.calls
    .filter(([command]) => command === "fs_read_file")
    .map(([, args]) => (args as { relativePath: string }).relativePath);

describe("editor watcher reconciliation", () => {
  it("checks a shared document once and exposes the same flag in both groups", async () => {
    const { result } = renderHook(() => useEditor("workspace", true));
    await act(async () => result.current.open("src/a.ts"));
    act(() => result.current.splitEditor());
    const [left, right] = result.current.groups.groups;
    const key = left.activeKey;
    expect(right.activeKey).toBe(key);
    act(() => result.current.edit(result.current.active!, "unsaved edit"));

    ipc.mockClear();
    disk.set("src/a.ts", "external");
    await act(async () =>
      result.current.applyDiskChanges("workspace", {
        paths: ["src/a.ts"],
        rescan: false,
      }),
    );
    expect(reads()).toEqual(["src/a.ts"]);
    expect(result.current.tabs).toHaveLength(1);
    const flagged = result.current.tabs[0];
    expect(flagged).toMatchObject({
      key,
      changedOnDisk: true,
      draft: "unsaved edit",
    });
    expect(result.current.active).toBe(flagged);
    act(() => result.current.focusGroup(left.id));
    expect(result.current.active).toBe(flagged);
  });

  it("checks only touched tabs and flags external edits and removals", async () => {
    const { result, flags } = await openAll();
    ipc.mockClear();
    disk.set("src/a.ts", "external");
    disk.set("README.md", "external");
    await act(async () =>
      result.current.applyDiskChanges("workspace", {
        paths: ["src/a.ts"],
        rescan: false,
      }),
    );
    expect(reads()).toEqual(["src/a.ts"]);
    expect(flags()).toEqual({
      "src/a.ts": true,
      "src/b.ts": false,
      "README.md": false,
    });

    // A renamed folder stands for its subtree: both tabs are revalidated.
    disk.delete("src/a.ts");
    disk.delete("src/b.ts");
    ipc.mockClear();
    await act(async () =>
      result.current.applyDiskChanges("workspace", {
        paths: ["src"],
        rescan: false,
      }),
    );
    expect(reads().sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(flags()).toMatchObject({ "src/a.ts": true, "src/b.ts": true });
    // Drafts are never replaced by a watcher event.
    expect(result.current.tabs.map((tab) => tab.draft)).toEqual([
      "contents of src/a.ts",
      "contents of src/b.ts",
      "contents of README.md",
    ]);
  });

  it("revalidates every workspace tab on rescan and clears restored files", async () => {
    const { result, flags } = await openAll();
    disk.set("README.md", "external");
    await act(async () =>
      result.current.applyDiskChanges("workspace", { paths: [], rescan: true }),
    );
    expect(flags()).toEqual({
      "src/a.ts": false,
      "src/b.ts": false,
      "README.md": true,
    });
    disk.set("README.md", "v1");
    await act(async () =>
      result.current.applyDiskChanges("workspace", { paths: [], rescan: true }),
    );
    expect(flags()["README.md"]).toBe(false);
  });

  it("does not flag the event caused by its own save", async () => {
    const { result, flags } = await openAll();
    const tab = result.current.tabs[0];
    act(() => result.current.edit(tab, "mine"));
    act(() => result.current.select(tab.key));
    await act(async () => result.current.save());
    await act(async () =>
      result.current.applyDiskChanges("workspace", {
        paths: ["src/a.ts"],
        rescan: false,
      }),
    );
    expect(flags()["src/a.ts"]).toBe(false);
  });

  it("drops a check that finishes after the tab was renamed or for another workspace", async () => {
    const { result, flags } = await openAll();
    let finishRead!: () => void;
    ipc.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          finishRead = () => reject("NOT_FOUND");
        }),
    );
    let check!: Promise<void>;
    act(() => {
      check = result.current.applyDiskChanges("workspace", {
        paths: ["src/a.ts"],
        rescan: false,
      });
    });
    ipc.mockResolvedValueOnce("src/renamed.ts");
    await act(async () =>
      result.current.renameWorkspaceEntry("src/a.ts", "renamed.ts", "id"),
    );
    await act(async () => {
      finishRead();
      await check;
    });
    expect(flags()).toMatchObject({ "src/renamed.ts": false });

    ipc.mockClear();
    await act(async () =>
      result.current.applyDiskChanges("other", { paths: [], rescan: true }),
    );
    expect(ipc).not.toHaveBeenCalled();
  });
});
