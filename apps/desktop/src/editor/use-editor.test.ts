// @vitest-environment jsdom

import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_SAVE_DELAY_MS, useEditor } from "./use-editor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));

const ipc = vi.mocked(invoke);

beforeEach(() => {
  vi.useFakeTimers();
  ipc.mockReset();
  ipc.mockImplementation(async (command, args) => {
    if (command === "fs_read_file") {
      return {
        workspaceId: "workspace",
        relativePath:
          args && "relativePath" in args ? args.relativePath : "sample.ts",
        content: "saved",
        encoding: "utf-8",
        version: "v1",
      };
    }
    if (command === "file_open") {
      return {
        fileId: "standalone",
        name: "one.ts",
        displayPath: "/sample/one.ts",
        content: "saved",
        version: "v1",
      };
    }
    if (command === "fs_write_file" || command === "file_write") return "v2";
    throw new Error(`Unexpected command ${command}`);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function advance(ms = AUTO_SAVE_DELAY_MS) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

function setup(native = true) {
  const { result } = renderHook(() => useEditor("workspace", native));
  function edit(draft: string) {
    const active = result.current.active;
    if (!active) throw new Error("Expected an open editor");
    act(() => result.current.edit(active, draft));
  }
  return { result, edit };
}

describe("editor Auto Save", () => {
  it("defaults off, debounces changes when enabled, and cancels queued saves when disabled", async () => {
    const { result, edit } = setup();
    await act(async () => result.current.open("sample.ts"));
    edit("with autosave off");
    await advance();
    expect(ipc).not.toHaveBeenCalledWith("fs_write_file", expect.anything());

    act(() => result.current.toggleAutoSave());
    await advance(AUTO_SAVE_DELAY_MS - 1);
    edit("latest draft");
    await advance(AUTO_SAVE_DELAY_MS - 1);
    expect(ipc).not.toHaveBeenCalledWith("fs_write_file", expect.anything());
    await advance(1);
    expect(ipc).toHaveBeenLastCalledWith("fs_write_file", {
      workspaceId: "workspace",
      relativePath: "sample.ts",
      expectedVersion: "v1",
      content: "latest draft",
    });
    expect(result.current.active?.content).toBe("latest draft");

    edit("pending draft");
    act(() => result.current.toggleAutoSave());
    await advance();
    expect(result.current.active?.content).toBe("latest draft");
    expect(result.current.active?.draft).toBe("pending draft");
    expect(
      ipc.mock.calls.filter(([command]) => command === "fs_write_file"),
    ).toHaveLength(1);
  });

  it("uses a standalone file grant and preserves typing during an in-flight save", async () => {
    const { result, edit } = setup();
    await act(async () => result.current.openFile());
    act(() => result.current.toggleAutoSave());
    edit("first draft");

    let completeSave!: (version: string) => void;
    ipc.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        completeSave = resolve;
      }),
    );
    await advance();
    expect(result.current.readOnly).toBe(false);
    edit("typed during save");
    await act(async () => completeSave("new-version"));
    expect(result.current.active?.draft).toBe("typed during save");
    expect(result.current.active?.content).toBe("first draft");
    await advance();
    expect(ipc).toHaveBeenLastCalledWith("file_write", {
      fileId: "standalone",
      expectedVersion: "new-version",
      content: "typed during save",
    });
  });

  it("rechecks unsaved changes before quitting when Auto Save was in flight", async () => {
    const { result, edit } = setup();
    await act(async () => result.current.open("sample.ts"));
    act(() => result.current.toggleAutoSave());
    edit("first draft");

    let completeSave!: (version: string) => void;
    ipc.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        completeSave = resolve;
      }),
    );
    await advance();
    edit("newer unsaved changes");
    fireEvent(window, new Event("turing-close-requested"));
    expect(ipc).not.toHaveBeenCalledWith("editor_confirm_discard", {
      action: "exit",
    });

    ipc.mockResolvedValueOnce(false);
    await act(async () => completeSave("v2"));
    await advance(0);
    expect(ipc).toHaveBeenLastCalledWith("editor_confirm_discard", {
      action: "exit",
    });
    expect(ipc).not.toHaveBeenCalledWith("editor_exit", undefined);
    expect(result.current.active?.draft).toBe("newer unsaved changes");
  });

  it("retains and reports a conflicting draft without retrying or prompting", async () => {
    const { result, edit } = setup();
    await act(async () => result.current.open("sample.ts"));
    act(() => result.current.toggleAutoSave());
    edit("my draft");
    ipc.mockRejectedValueOnce("FILE_CONFLICT");

    await advance();
    expect(result.current.active).toMatchObject({
      draft: "my draft",
      content: "saved",
      changedOnDisk: true,
    });
    expect(result.current.error).toContain("Auto Save failed.");
    // Editing a known conflict still requires the usual explicit resolution.
    edit("my newer draft");
    await advance();
    expect(
      ipc.mock.calls.filter(([command]) => command === "fs_write_file"),
    ).toHaveLength(1);
    expect(ipc).not.toHaveBeenCalledWith("file_save_as", expect.anything());
  });

  it("pauses after an ordinary write failure until the draft is edited again", async () => {
    const { result, edit } = setup();
    await act(async () => result.current.open("sample.ts"));
    act(() => result.current.toggleAutoSave());
    edit("first draft");
    ipc.mockRejectedValueOnce("PERMISSION_DENIED");
    await advance();
    expect(result.current.error).toContain("Auto Save failed.");
    await advance();
    expect(
      ipc.mock.calls.filter(([command]) => command === "fs_write_file"),
    ).toHaveLength(1);

    edit("updated draft");
    await advance();
    expect(result.current.active?.content).toBe("updated draft");
    expect(result.current.error).toBeUndefined();
  });

  it("leaves untitled and browser drafts in memory", async () => {
    const desktop = setup();
    act(() => desktop.result.current.toggleAutoSave());
    act(() => desktop.result.current.newFile());
    desktop.edit("untitled draft");
    const browser = setup(false);
    act(() => browser.result.current.toggleAutoSave());
    act(() => browser.result.current.newFile());
    browser.edit("browser draft");
    await advance();
    expect(desktop.result.current.active?.draft).toBe("untitled draft");
    expect(browser.result.current.autoSave).toBe(false);
    expect(ipc).not.toHaveBeenCalled();
  });
});
