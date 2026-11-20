// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  DirectoryEntry,
  SearchResponse,
  WorkspaceChanges,
} from "@turing/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEditor } from "../editor/use-editor";
import { SearchPanel } from "../search/SearchPanel";
import { useExplorer } from "./use-explorer";
import { useWorkspaceWatcher, WATCH_POLL_MS } from "./use-workspace-watcher";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
const ipc = vi.mocked(invoke);
const entry = (path: string, kind: DirectoryEntry["kind"]): DirectoryEntry => ({
  name: path.split("/").at(-1)!,
  relativePath: path,
  kind,
  identity: path,
});
const changes = (...paths: string[]): WorkspaceChanges => ({
  paths,
  rescan: false,
});
let disk: Map<string, DirectoryEntry[]>;
let workspace: string;

beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  workspace = "original";
  disk = new Map([
    ["", [entry("src", "directory")]],
    ["src", [entry("src/deep", "directory")]],
    ["src/deep", [entry("src/deep/file.txt", "file")]],
  ]);
  ipc.mockReset();
  ipc.mockImplementation(async (command, args) => {
    switch (command) {
      case "workspace_open":
        return { id: workspace, name: workspace };
      case "workspace_close":
        return;
      case "fs_list_directory": {
        const entries = disk.get(
          String(
            args && "relativePath" in args ? args.relativePath : undefined,
          ),
        );
        if (!entries) throw "NOT_FOUND";
        return entries;
      }
      case "workspace_watch_poll":
        return changes();
      default:
        throw new Error(`Unexpected command ${command}`);
    }
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("refreshes creation, file rename, deletion, and evicts the cached directory subtree on move", async () => {
  const { result } = renderHook(useExplorer);
  await act(async () => result.current.open());
  await act(async () => result.current.browse("src"));
  await act(async () => result.current.browse("src/deep"));

  disk.set("src/deep", [
    entry("src/deep/file.txt", "file"),
    entry("src/deep/new.txt", "file"),
  ]);
  ipc.mockClear();
  await act(async () =>
    result.current.applyChanges(
      workspace,
      changes("src/deep/new.txt", "src/deep/new.txt"),
    ),
  );
  expect(ipc).toHaveBeenCalledTimes(1);
  expect(
    result.current.folders.get("src/deep")?.map(({ name }) => name),
  ).toEqual(["file.txt", "new.txt"]);

  disk.set("src/deep", [entry("src/deep/renamed.txt", "file")]);
  await act(async () =>
    result.current.applyChanges(
      workspace,
      changes("src/deep/file.txt", "src/deep/renamed.txt", "src/deep/new.txt"),
    ),
  );
  expect(
    result.current.folders.get("src/deep")?.map(({ name }) => name),
  ).toEqual(["renamed.txt"]);

  disk.set("", [entry("moved", "directory")]);
  disk.delete("src");
  disk.delete("src/deep");
  await act(async () =>
    result.current.applyChanges(workspace, changes("src", "moved")),
  );
  expect([...result.current.folders.keys()]).toEqual([""]);
  expect(result.current.folders.get("")?.[0].name).toBe("moved");
  expect(result.current.relativePath).toBe("");
});

it("refreshes a pending first listing and rejects a slower old listing", async () => {
  const { result } = renderHook(useExplorer);
  await act(async () => result.current.open());
  let finishListing!: (entries: DirectoryEntry[]) => void;
  ipc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishListing = resolve;
      }),
  );
  let browse: Promise<void> | null;
  act(() => {
    browse = result.current.browse("src") ?? null;
  });
  const fresh = [entry("src/new.txt", "file")];
  disk.set("src", fresh);
  await act(async () =>
    result.current.applyChanges(workspace, changes("src/new.txt")),
  );
  await act(async () => {
    finishListing([]);
    await browse;
  });
  expect(result.current.folders.get("src")).toEqual(fresh);
});

it.each(["close", "replace"])(
  "drops pending listings after workspace %s",
  async (action) => {
    const { result } = renderHook(useExplorer);
    await act(async () => result.current.open());
    let finishListing!: (entries: DirectoryEntry[]) => void;
    ipc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishListing = resolve;
        }),
    );
    const old = result.current.applyChanges(workspace, changes("stale.txt"));
    const fresh = [entry("fresh.txt", "file")];
    if (action === "replace") {
      workspace = "replacement";
      disk.set("", fresh);
      await act(async () => result.current.open());
    } else {
      await act(async () => result.current.close());
    }
    await act(async () => {
      finishListing([entry("stale.txt", "file")]);
      await old;
    });
    expect(result.current.folders.get("")).toEqual(
      action === "replace" ? fresh : undefined,
    );
  },
);

it("delivers a watcher poll while the Search panel awaits results", async () => {
  vi.useFakeTimers();
  function Harness() {
    const explorer = useExplorer();
    const id = explorer.workspace?.id;
    const editor = useEditor(id, true);
    useWorkspaceWatcher(id, true, (workspaceId, changeSet) => {
      void explorer.applyChanges(workspaceId, changeSet);
      void editor.applyDiskChanges(workspaceId, changeSet);
    });
    return (
      <>
        <button onClick={() => void explorer.open()}>Open workspace</button>
        <button onClick={() => void editor.open("open.txt")}>
          Open document
        </button>
        {editor.active?.changedOnDisk && <p>Document changed</p>}
        <ul>
          {explorer.folders.get("")?.map(({ name }) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
        <SearchPanel
          workspaceId={id}
          native
          editorBusy={false}
          open={() => {}}
        />
      </>
    );
  }

  render(<Harness />);
  await act(async () => fireEvent.click(screen.getByText("Open workspace")));
  const normal = ipc.getMockImplementation()!;
  let version = "v1";
  let finishSearch!: (response: SearchResponse) => void;
  ipc.mockImplementation(async (command, args) => {
    if (command === "workspace_search_begin") return "search-id";
    if (command === "workspace_search_run")
      return new Promise((resolve) => {
        finishSearch = resolve;
      });
    if (command === "fs_read_file")
      return {
        workspaceId: workspace,
        relativePath: "open.txt",
        version,
        content: version,
        encoding: "utf-8",
      };
    if (command === "workspace_watch_poll")
      return changes("created.txt", "open.txt");
    return normal(command, args);
  });
  await act(async () => fireEvent.click(screen.getByText("Open document")));
  fireEvent.change(screen.getByLabelText("Search text"), {
    target: { value: "needle" },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Search" })),
  );
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();

  version = "v2";
  disk.set("", [entry("created.txt", "file"), entry("open.txt", "file")]);
  await act(async () => vi.advanceTimersByTimeAsync(WATCH_POLL_MS));
  expect(screen.getByText("created.txt")).toBeTruthy();
  expect(screen.getByText("Document changed")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  await act(async () =>
    finishSearch({ files: [], truncated: false, skippedFiles: 0 }),
  );
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
});
