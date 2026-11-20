// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceChanges } from "@turing/contracts";
import { pollWorkspaceChanges } from "./watch-ipc";
import {
  foldersToRefresh,
  touches,
  useWorkspaceWatcher,
  WATCH_POLL_MS,
  WATCH_RETRY_MS,
} from "./use-workspace-watcher";

vi.mock("./watch-ipc", () => ({ pollWorkspaceChanges: vi.fn() }));

const poll = vi.mocked(pollWorkspaceChanges);
const none: WorkspaceChanges = { paths: [], rescan: false };

beforeEach(() => {
  vi.useFakeTimers();
  poll.mockReset();
  poll.mockResolvedValue(none);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const advance = (ms: number) =>
  act(async () => vi.advanceTimersByTimeAsync(ms));

describe("workspace change sets", () => {
  it("treat a path as its subtree without matching sibling prefixes", () => {
    const changes = { paths: ["src"], rescan: false };
    expect(touches(changes, "src")).toBe(true);
    expect(touches(changes, "src/deep/a.ts")).toBe(true);
    expect(touches(changes, "src-other/a.ts")).toBe(false);
    expect(touches({ paths: [], rescan: true }, "anything")).toBe(true);
  });

  it("refresh the containing folder and every loaded folder below a change", () => {
    const loaded = ["", "src", "src/deep", "docs", "srcs"];
    expect(
      foldersToRefresh(
        { paths: ["src/a.ts", "docs/x/y.md"], rescan: false },
        loaded,
      ),
    ).toEqual(["src"]);
    expect(foldersToRefresh({ paths: ["src"], rescan: false }, loaded)).toEqual(
      ["", "src", "src/deep"],
    );
    expect(foldersToRefresh({ paths: [], rescan: true }, loaded)).toEqual(
      loaded,
    );
  });
});

describe("workspace watcher polling", () => {
  it("delivers only non-empty change sets on a steady interval", async () => {
    const onChanges = vi.fn();
    const changes = { paths: ["a.ts"], rescan: false };
    poll.mockResolvedValueOnce(none).mockResolvedValueOnce(changes);
    renderHook(() => useWorkspaceWatcher("ws-1", true, onChanges));
    await advance(0);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(onChanges).not.toHaveBeenCalled();
    await advance(WATCH_POLL_MS);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(onChanges).toHaveBeenCalledWith("ws-1", changes);
  });

  it("stops after the registration is revoked and backs off on other errors", async () => {
    poll.mockRejectedValueOnce("IO_ERROR");
    const { rerender } = renderHook(
      ({ id }) => useWorkspaceWatcher(id, true, vi.fn()),
      { initialProps: { id: "ws-1" } },
    );
    await advance(WATCH_POLL_MS);
    expect(poll).toHaveBeenCalledTimes(1);
    await advance(WATCH_RETRY_MS - WATCH_POLL_MS);
    expect(poll).toHaveBeenCalledTimes(2);

    poll.mockReset();
    poll.mockRejectedValue("PERMISSION_DENIED");
    rerender({ id: "ws-2" });
    await advance(WATCH_RETRY_MS * 3);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledWith("ws-2");
  });

  it("drops a reply for a replaced workspace and never polls in the browser", async () => {
    let resolve!: (changes: WorkspaceChanges) => void;
    poll.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    const onChanges = vi.fn();
    const { rerender } = renderHook(
      ({ id }) => useWorkspaceWatcher(id, true, onChanges),
      { initialProps: { id: "old" as string | undefined } },
    );
    rerender({ id: undefined });
    await act(async () => resolve({ paths: ["stale.ts"], rescan: false }));
    await advance(WATCH_POLL_MS * 4);
    expect(onChanges).not.toHaveBeenCalled();
    expect(poll).toHaveBeenCalledTimes(1);

    renderHook(() => useWorkspaceWatcher("ws", false, onChanges));
    await advance(WATCH_POLL_MS * 4);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
