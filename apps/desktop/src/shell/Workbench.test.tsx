// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { expectAccessible } from "../test/axe";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { AskEvent } from "@turing/contracts";
import { autoSaveKey } from "../editor/use-editor";
import { useLayout } from "../state/layout";
import { Workbench } from "./Workbench";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    constructor(public onmessage: (event: AskEvent) => void) {}
  },
  isTauri: vi.fn(() => false),
  invoke: vi.fn(),
}));

// The workspace watcher polls in the background; hold it out of IPC sequences.
vi.mock("../explorer/watch-ipc", () => ({
  pollWorkspaceChanges: vi.fn(() => new Promise(() => {})),
}));

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() {
      return storage.size;
    },
    key: (index: number) => [...storage.keys()][index] ?? null,
    removeItem: (key: string) => storage.delete(key),
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  useLayout.setState(useLayout.getInitialState(), true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();

  vi.mocked(invoke).mockReset();
  vi.mocked(isTauri).mockReturnValue(false);
  useLayout.setState(useLayout.getInitialState(), true);
});

describe("workbench panels", () => {
  it("offers a new file from Start and shows the empty Recent list", async () => {
    const user = userEvent.setup();
    render(<Workbench />);
    expect(
      screen.getByRole("region", { name: "Recent" }).textContent,
    ).toContain("No recent files or folders.");
    await user.click(screen.getByRole("button", { name: "New File…" }));
    expect(await screen.findByRole("tab", { name: /Untitled/ })).toBeTruthy();
  });

  it("offers a saved recovery snapshot from the editor pane", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const entry = {
      id: "previous",
      name: "Untitled-1",
      title: "Untitled-1",
      draft: "recover me",
      source: { kind: "copy" },
      timestamp: 1,
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "draft_recovery" && args && "request" in args) {
        const request = args.request;
        if (request && typeof request === "object" && "action" in request) {
          if (request.action === "list")
            return { kind: "list", entries: [entry], skipped: false };
          if (request.action === "snapshot")
            return { kind: "written", id: "restored" };
        }
      }
    });
    const user = userEvent.setup();
    render(<Workbench />);
    (await screen.findByText("Recover unsaved drafts (1)")).focus();
    await user.keyboard("{Enter}");
    await expectAccessible(document.body);
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Restore Untitled-1" }),
    );
    const regions = screen.getAllByRole("status");
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("tab", { name: "Recovered-1-Untitled-1 (unsaved)" }),
    ).toBeTruthy();
    expect(screen.queryByText("Recover unsaved drafts (1)")).toBeNull();
    // The notice lands in a live region that existed before the restore.
    expect(
      regions.some(({ textContent }) =>
        textContent?.startsWith("Recovered copy."),
      ),
    ).toBe(true);
  });

  it("opens Explorer and Editor on a fresh profile", () => {
    render(<Workbench />);

    for (const name of ["Explorer", "Editor"]) {
      expect(screen.getByRole("region", { name })).toBeTruthy();
    }
    expect(screen.queryByRole("region", { name: "Source Control" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Terminal" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Turing AI" })).toBeNull();
    const rail = screen.getByRole("navigation", { name: "Workbench panels" });
    expect(
      [...rail.querySelectorAll("button")].map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Explorer",
      "Search",
      "Source Control",
      "Run & Debug",
      "Turing AI",
      "Toggle Bottom Panel",
      "Settings",
    ]);
    expect(
      screen.getByRole("button", { name: "Explorer", pressed: true }),
    ).toBeTruthy();
  });

  it("switches sidebars with the keyboard and closes the active sidebar", async () => {
    const user = userEvent.setup();
    render(<Workbench />);

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "File" }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Open command palette" }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Explorer" }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Search" }),
    );
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("region", { name: "Search" }).textContent,
    ).toContain("Workspace search requires the desktop app");
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Source Control" }),
    );
    await user.keyboard("{Enter}");

    expect(screen.getByRole("region", { name: "Source Control" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Explorer" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Source Control", pressed: true }),
    ).toBeTruthy();

    await user.keyboard("[Space]");
    expect(screen.queryByRole("region", { name: "Source Control" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Terminal" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Turing AI" })).toBeNull();
    const rail = screen.getByRole("navigation", { name: "Workbench panels" });
    expect(
      [...rail.querySelectorAll("button")].map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Explorer",
      "Search",
      "Source Control",
      "Run & Debug",
      "Turing AI",
      "Toggle Bottom Panel",
      "Settings",
    ]);
    expect(
      screen.getByRole("button", { name: "Source Control", pressed: false }),
    ).toBeTruthy();
  });

  it("toggles AI alongside Explorer and reopens the dock with its selected tab", async () => {
    const user = userEvent.setup();
    render(<Workbench />);
    const toggle = screen.getByRole("button", { name: "Toggle Bottom Panel" });
    const runDebug = screen.getByRole("button", { name: "Run & Debug" });
    expect(runDebug.getAttribute("aria-disabled")).toBe("true");
    await user.click(runDebug);
    expect(screen.queryByRole("region", { name: "Run & Debug" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Turing AI" }));
    expect(screen.getByRole("region", { name: "Turing AI" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Editor" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Explorer" })).toBeTruthy();

    await user.click(toggle);
    await user.click(screen.getByRole("tab", { name: "Output" }));
    await user.click(screen.getByRole("button", { name: "Hide bottom panel" }));
    expect(document.activeElement).toBe(toggle);
    expect(screen.queryByRole("tablist", { name: "Bottom dock" })).toBeNull();
    await user.click(toggle);
    expect(
      screen.getByRole("tab", { name: "Output", selected: true }),
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "Turing AI" })).toBeTruthy();
  });

  it("opens Ask from the workbench and follows a streamed source into the editor", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const source = {
      relativePath: "README.md",
      version: "v1",
      startLine: 1,
      endLine: 2,
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "workspace_open") return { id: "repo", name: "Project" };
      if (command === "fs_list_directory") return [];
      if (command === "fs_read_file")
        return {
          ...source,
          workspaceId: "repo",
          content: "Project documentation",
          encoding: "utf-8",
        };
      if (command === "ask_run" && args && "events" in args) {
        const events = args.events;
        if (!(events instanceof Channel))
          throw new Error("Expected an Ask channel");
        events.onmessage({
          kind: "delta",
          text: "The project guide is in [1].",
        });
        events.onmessage({
          kind: "completed",
          sources: [source],
          indexCoverage: "complete",
          indexFreshness: "current",
        });
      }
    });

    const user = userEvent.setup();
    render(<Workbench />);
    const toggle = screen.getByRole("button", { name: "Turing AI" });
    await user.click(toggle);
    expect(
      screen.getByText("Open a folder to ask about its files."),
    ).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Open Folder" }));
    await user.type(
      await screen.findByRole("textbox", { name: "Ask about this workspace" }),
      "Where is the project guide?",
    );
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(
      await screen.findByRole("button", { name: "Source 1: README.md:1–2" }),
    ).toBeTruthy();

    await user.click(toggle);
    expect(screen.queryByRole("region", { name: "Turing AI" })).toBeNull();
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "README.md:1–2" }));
    expect(await screen.findByRole("tab", { name: "README.md" })).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("fs_read_file", {
      workspaceId: "repo",
      relativePath: "README.md",
    });
  });

  it("applies settings and returns keyboard focus to the opener", async () => {
    const user = userEvent.setup();
    render(<Workbench />);
    const opener = screen.getByRole("button", { name: "Settings" });
    opener.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close settings" }),
    );
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Auto Save" })
        .disabled,
    ).toBe(true);
    await user.click(
      screen.getByRole("checkbox", { name: "Show bottom panel" }),
    );
    expect(
      screen.getByRole("group", { name: "Diagnostics" }).textContent,
    ).toContain("Live diagnostics require the desktop app.");
    await user.selectOptions(screen.getByLabelText("Severity"), "warning");
    expect(useLayout.getState().terminal).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(screen.getByRole("tablist", { name: "Bottom dock" })).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Problems" }));
    expect(screen.queryByLabelText("Severity")).toBeNull();
    await user.click(opener);
    expect(
      screen.getByRole<HTMLSelectElement>("combobox", { name: "Severity" })
        .value,
    ).toBe("warning");
  });

  it("shares native Auto Save with the File menu and restores it on remount", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const user = userEvent.setup();
    const { unmount } = render(<Workbench />);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const input = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Auto Save",
    });
    expect(input.checked).toBe(false);
    await user.click(input);
    expect(window.localStorage.getItem(autoSaveKey)).toBe("true");
    unmount();
    render(<Workbench />);
    await user.click(screen.getByRole("menuitem", { name: "File" }));
    expect(
      screen.getByRole("menuitemcheckbox", {
        name: "Auto Save",
        checked: true,
      }),
    ).toBeTruthy();
  });
});
