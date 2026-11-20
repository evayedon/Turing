// @vitest-environment jsdom

import { pollWorkspaceChanges } from "../explorer/watch-ipc";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorLocation, EditorTab } from "./use-editor";
import { Workbench } from "../shell/Workbench";
import { clearRecents } from "../shell/recent";
import { useLayout } from "../state/layout";

vi.mock("./draft-ipc", () => import("../test/mock-draft-ipc"));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));

// The workspace watcher polls in the background; hold it out of IPC sequences.
vi.mock("../explorer/watch-ipc", () => ({
  pollWorkspaceChanges: vi.fn(() => new Promise(() => {})),
}));

// Source control polls in the background; keep it out of these IPC sequences.
vi.mock("../git/git-ipc", async (original) => ({
  ...(await original<typeof import("../git/git-ipc")>()),
  invokeGit: vi.fn(() => Promise.reject("NOT_A_REPOSITORY")),
}));
vi.mock("./MonacoHost", () => ({
  default: ({
    active,
    readOnly,
    reveal,
    onChange,
  }: {
    active: EditorTab;
    readOnly: boolean;
    reveal?: EditorLocation & { key: string };
    onChange: (tab: EditorTab, value: string) => void;
  }) => (
    <textarea
      aria-label="File editor"
      data-location={
        reveal?.key === active.key
          ? `${reveal.line}:${reveal.column}`
          : undefined
      }
      value={active.draft}
      readOnly={readOnly}
      onChange={(event) => onChange(active, event.target.value)}
    />
  ),
}));

const ipc = vi.mocked(invoke);
const entries = ["main.ts", "notes.md"].map((name) => ({
  name,
  relativePath: name,
  kind: "file",
  identity: `${name}-identity`,
}));
const snapshot = (relativePath: string, content: string, version = "v1") => ({
  relativePath,
  content,
  version,
  workspaceId: "project",
  encoding: "utf-8",
});

beforeEach(() => {
  ipc.mockReset();
  vi.mocked(isTauri).mockReturnValue(true);
  ipc.mockImplementation(async (command, args) => {
    switch (command) {
      case "workspace_open":
        return { id: "project", name: "Project" };
      case "fs_list_directory":
        return entries;
      case "fs_read_file": {
        const path = (args as { relativePath: string }).relativePath;
        return snapshot(path, `contents of ${path}`);
      }
      default:
        throw new Error(`Unexpected IPC command ${command}`);
    }
  });
});

afterEach(() => {
  cleanup();
  useLayout.setState(useLayout.getInitialState(), true);
});

async function openFile(name = "main.ts") {
  const user = userEvent.setup();
  render(<Workbench />);
  await user.click(screen.getByRole("button", { name: "Open folder" }));
  await user.click(await screen.findByRole("button", { name }));
  const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "File editor",
  });
  return { user, editor };
}

describe("editor workspace", () => {
  it("opens files through scoped reads and switches and closes tabs", async () => {
    const { user, editor } = await openFile();
    expect(ipc).toHaveBeenCalledWith("fs_read_file", {
      workspaceId: "project",
      relativePath: "main.ts",
    });
    expect(editor.value).toBe("contents of main.ts");
    await user.click(screen.getByRole("button", { name: "notes.md" }));
    expect(
      await screen.findByRole("tab", { name: "notes.md", selected: true }),
    ).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "main.ts" }));
    expect(editor.value).toBe("contents of main.ts");
    await user.click(screen.getByRole("button", { name: "Close main.ts" }));
    expect(screen.queryByRole("tab", { name: "main.ts" })).toBeNull();
    expect(
      screen.getByRole("tab", { name: "notes.md", selected: true }),
    ).toBeTruthy();
  });

  it("offers the shared conflict choices and shows deletion on both tab strips", async () => {
    let deliver!: (value: { paths: string[]; rescan: boolean }) => void;
    vi.mocked(pollWorkspaceChanges).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    const { user, editor } = await openFile();
    await user.click(
      screen.getByRole("button", { name: "Split Editor Right" }),
    );
    fireEvent.change(editor, { target: { value: "my draft" } });
    const normal = ipc.getMockImplementation()!;
    let deleted = false;
    ipc.mockImplementation(async (command, args) => {
      if (command === "fs_read_file") {
        if (deleted) throw "NOT_FOUND";
        return snapshot("main.ts", "external text", "v2");
      }
      return normal(command, args);
    });
    await act(async () => deliver({ paths: ["main.ts"], rescan: false }));
    await waitFor(() =>
      // One notice per group, plus the persistent live region.
      expect(screen.getAllByText(/Keep your draft, compare it/)).toHaveLength(
        3,
      ),
    );
    const left = within(screen.getByRole("region", { name: "Editor group 1" }));
    await user.click(left.getByRole("button", { name: "Compare with disk" }));
    expect(
      left.getByRole("region", { name: "Disk comparison" }).textContent,
    ).toContain("external text");
    expect(left.getByRole("button", { name: "Save As a copy…" })).toBeTruthy();
    await user.click(left.getByRole("button", { name: "Keep mine" }));
    expect(screen.getAllByText(/Draft kept/)).toHaveLength(3);

    deleted = true;
    vi.mocked(pollWorkspaceChanges).mockResolvedValueOnce({
      paths: ["main.ts"],
      rescan: false,
    });
    await waitFor(() =>
      expect(
        screen.getAllByRole("tab", {
          name: "main.ts (unsaved) (Deleted on disk)",
        }),
      ).toHaveLength(2),
    );
    expect(
      screen
        .getAllByRole<HTMLTextAreaElement>("textbox", { name: "File editor" })
        .map(({ value }) => value),
    ).toEqual(["my draft", "my draft"]);
  });

  it("creates a named workspace file and enables Run for its saved extension", async () => {
    const user = userEvent.setup();
    render(<Workbench />);
    await user.click(screen.getByRole("button", { name: "Open folder" }));
    await user.click(
      screen.getByRole("button", { name: "New workspace file" }),
    );
    const name = screen.getByRole("textbox", { name: "New filename" });
    expect(document.activeElement).toBe(name);
    ipc.mockResolvedValueOnce(snapshot("hello.py", "", "created"));
    await user.type(name, "hello.py{Enter}");
    expect(
      await screen.findByRole("tab", { name: "hello.py", selected: true }),
    ).toBeTruthy();
    expect(ipc).toHaveBeenCalledWith("workspace_create_file", {
      workspaceId: "project",
      parent: "",
      name: "hello.py",
    });
    expect(
      screen.getByRole("button", { name: "Run File" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("renames a dirty file with F2, preserves its buffer, and saves with the new path", async () => {
    const { user, editor } = await openFile();
    fireEvent.change(editor, { target: { value: "my draft" } });
    const row = screen.getByRole("button", { name: "main.ts" });
    row.focus();
    await user.keyboard("{F2}");
    const rename = screen.getByRole("textbox", { name: "Rename entry" });
    await user.clear(rename);
    ipc.mockResolvedValueOnce("main.py").mockResolvedValueOnce([
      {
        name: "main.py",
        kind: "file",
        relativePath: "main.py",
        identity: "updated",
      },
    ]);
    await user.type(rename, "main.py{Enter}");
    expect(
      await screen.findByRole("tab", { name: "main.py (unsaved)" }),
    ).toBeTruthy();
    expect(editor.value).toBe("my draft");
    expect(
      screen.getByRole("button", { name: "Language mode: Python" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Run File" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(ipc).toHaveBeenCalledWith("workspace_rename_entry", {
      workspaceId: "project",
      relativePath: "main.ts",
      name: "main.py",
      expectedIdentity: "main.ts-identity",
    });
    ipc.mockResolvedValueOnce("v2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Run File" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(ipc).toHaveBeenCalledWith("fs_write_file", {
      workspaceId: "project",
      relativePath: "main.py",
      content: "my draft",
      expectedVersion: "v1",
    });
  });

  it("renames a folder from its context action and updates descendant tabs", async () => {
    const user = userEvent.setup();
    const folder = {
      name: "src",
      relativePath: "src",
      kind: "directory",
      identity: "folder",
    };
    const child = {
      name: "app.py",
      relativePath: "src/app.py",
      kind: "file",
      identity: "child",
    };
    render(<Workbench />);
    ipc
      .mockResolvedValueOnce({ id: "project", name: "Project" })
      .mockResolvedValueOnce([folder]);
    await user.click(screen.getByRole("button", { name: "Open folder" }));
    const row = await screen.findByRole("button", { name: "src/" });
    ipc.mockResolvedValueOnce([child]);
    await user.click(row);
    await user.click(await screen.findByRole("button", { name: "app.py" }));
    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "File editor",
    });
    fireEvent.change(editor, { target: { value: "dirty child" } });
    fireEvent.contextMenu(row);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const field = screen.getByRole("textbox", { name: "Rename entry" });
    await user.clear(field);
    ipc
      .mockResolvedValueOnce("code")
      .mockResolvedValueOnce([
        { ...folder, name: "code", relativePath: "code" },
      ]);
    await user.type(field, "code{Enter}");
    const tab = await screen.findByRole("tab", { name: "app.py (unsaved)" });
    expect(tab.getAttribute("title")).toBe("code/app.py");
    expect(editor.value).toBe("dirty child");
    expect(await screen.findByRole("button", { name: "app.py" })).toBeTruthy();
  });

  it("retains the name field on a conflict and cancels with Escape", async () => {
    const { user } = await openFile();
    const row = screen.getByRole("button", { name: "main.ts" });
    row.focus();
    await user.keyboard("{F2}");
    const field = screen.getByRole("textbox", { name: "Rename entry" });
    await user.clear(field);
    ipc.mockRejectedValueOnce("NAME_TAKEN");
    await user.type(field, "notes.md{Enter}");
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /already in use/,
    );
    expect(screen.getByRole("textbox", { name: "Rename entry" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Rename entry" })).toBeNull();
    expect(screen.getByRole("tab", { name: "main.ts" })).toBeTruthy();
  });

  it("suggests Python in an untitled buffer and manual mode cannot enable Run", async () => {
    const user = userEvent.setup();
    render(<Workbench />);
    await fileAction(user, "New Text File");
    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "File editor",
    });
    const content = "def greet():\n    print('hello')";
    fireEvent.change(editor, { target: { value: content } });
    expect(
      screen.getByRole("button", { name: "Language mode: Python" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Run File" }).hasAttribute("disabled"),
    ).toBe(true);
    ipc.mockResolvedValueOnce({
      ...savedFile,
      name: "hello.py",
      displayPath: "/picked/hello.py",
    });
    await user.click(screen.getByRole("button", { name: "Save As…" }));
    expect(await screen.findByRole("tab", { name: "hello.py" })).toBeTruthy();
    expect(ipc).toHaveBeenCalledWith("file_save_as", {
      content,
      suggestedName: "Untitled-1.py",
    });
    await user.click(
      screen.getByRole("button", { name: "Language mode: Python" }),
    );
    await user.click(
      within(
        screen.getByRole("group", { name: "Select language mode" }),
      ).getByRole("button", { name: "Markdown" }),
    );
    expect(
      screen.getByRole("button", { name: "Language mode: Markdown" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Run File" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(editor.value).toBe(content);
  });

  it("keeps a non-executable saved filename blocked after a Python override", async () => {
    const { user } = await openFile("notes.md");
    await user.click(
      screen.getByRole("button", { name: "Language mode: Markdown" }),
    );
    await user.click(
      within(
        screen.getByRole("group", { name: "Select language mode" }),
      ).getByRole("button", { name: "Python" }),
    );
    expect(
      screen.getByRole("button", { name: "Language mode: Python" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Run File" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("finds an unopened nested file from Go to File using scoped listing", async () => {
    const user = userEvent.setup();
    const folder = { name: "src", relativePath: "src", kind: "directory" };
    render(<Workbench />);
    ipc
      .mockResolvedValueOnce({ id: "project", name: "Project" })
      .mockResolvedValueOnce([folder]);
    await user.click(screen.getByRole("button", { name: "Open folder" }));
    await screen.findByRole("button", { name: "src/" });
    ipc
      .mockResolvedValueOnce([folder])
      .mockResolvedValueOnce([
        { name: "nested.py", relativePath: "src/nested.py", kind: "file" },
      ]);
    fireEvent.keyDown(document.body, { key: "p", ctrlKey: true });
    await user.type(
      await screen.findByRole("combobox", { name: "Search files" }),
      "nested",
    );
    await user.click(
      await screen.findByRole("option", { name: "src/nested.py" }),
    );
    expect(await screen.findByRole("tab", { name: "nested.py" })).toBeTruthy();
    expect(ipc).toHaveBeenCalledWith("fs_read_file", {
      workspaceId: "project",
      relativePath: "src/nested.py",
    });
  });

  it("opens a workspace symbol from the Go menu at its editor location", async () => {
    const user = userEvent.setup();
    render(<Workbench />);
    await user.click(screen.getByRole("button", { name: "Open folder" }));
    await screen.findByRole("button", { name: "main.ts" });
    ipc.mockResolvedValueOnce({
      generation: 1,
      complete: true,
      truncated: false,
      symbols: [
        {
          name: "launch",
          kind: "function",
          relativePath: "main.ts",
          line: 2,
          character: 8,
        },
      ],
    });
    await user.click(screen.getByRole("menuitem", { name: "Go" }));
    await user.click(
      screen.getByRole("menuitem", { name: /Go to Symbol in Workspace/ }),
    );
    await screen.findByRole("option", { name: /launch/ });
    await user.keyboard("{Enter}");
    const editor = await screen.findByRole("textbox", { name: "File editor" });
    expect(editor.getAttribute("data-location")).toBe("3:9");
    expect(ipc).toHaveBeenCalledWith("fs_read_file", {
      workspaceId: "project",
      relativePath: "main.ts",
    });
  });

  it("opens search results using scoped reads and reveals repeated hits in an existing tab", async () => {
    const user = userEvent.setup();
    render(<Workbench />);
    await user.click(screen.getByRole("button", { name: "Open folder" }));
    await screen.findByRole("button", { name: "main.ts" });
    await user.click(screen.getByRole("button", { name: "Search" }));
    const panel = within(screen.getByRole("region", { name: "Search" }));
    await user.type(
      panel.getByRole("searchbox", { name: "Search text" }),
      "doc",
    );
    await user.type(
      panel.getByRole("textbox", { name: "Filename filter" }),
      ".ts",
    );
    await user.click(panel.getByRole("checkbox", { name: "Match case" }));
    await user.click(panel.getByRole("checkbox", { name: "Whole word" }));
    ipc.mockResolvedValueOnce("job").mockResolvedValueOnce({
      files: [
        {
          relativePath: "main.ts",
          matches: [
            { line: 3, column: 5, before: "the ", text: "doc", after: "" },
            { line: 12, column: 8, before: "another ", text: "doc", after: "" },
          ],
        },
      ],
      skippedFiles: 0,
      truncated: false,
    });
    await user.click(panel.getByRole("button", { name: "Search" }));
    expect(ipc).toHaveBeenCalledWith("workspace_search_begin", {
      workspaceId: "project",
      options: {
        query: "doc",
        filenameFilter: ".ts",
        caseSensitive: true,
        wholeWord: true,
      },
    });
    expect(ipc).toHaveBeenCalledWith("workspace_search_run", {
      workspaceId: "project",
      searchId: "job",
    });
    const results = within(
      await panel.findByRole("list", { name: "Matches in main.ts" }),
    );
    await user.click(results.getByRole("button", { name: /line 3, column 5/ }));
    const editor = await screen.findByRole("textbox", { name: "File editor" });
    expect(editor.getAttribute("data-location")).toBe("3:5");
    expect(ipc).toHaveBeenCalledWith("fs_read_file", {
      workspaceId: "project",
      relativePath: "main.ts",
    });
    await user.click(
      results.getByRole("button", { name: /line 12, column 8/ }),
    );
    expect(editor.getAttribute("data-location")).toBe("12:8");
    expect(
      ipc.mock.calls.filter(([command]) => command === "fs_read_file"),
    ).toHaveLength(1);
  });

  it("marks drafts dirty and clears the indicator only after a successful versioned save", async () => {
    const { editor } = await openFile();
    fireEvent.change(editor, { target: { value: "edited" } });
    expect(
      screen.getByRole("tab", { name: "main.ts (unsaved)", selected: true }),
    ).toBeTruthy();
    ipc.mockResolvedValueOnce("v2");
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "main.ts", selected: true }),
      ).toBeTruthy(),
    );
    expect(ipc).toHaveBeenLastCalledWith("fs_write_file", {
      workspaceId: "project",
      relativePath: "main.ts",
      content: "edited",
      expectedVersion: "v1",
    });
    fireEvent.change(editor, { target: { value: "again" } });
    ipc.mockResolvedValueOnce("v3");
    fireEvent.keyDown(editor, { key: "s", metaKey: true });
    await waitFor(() =>
      expect(ipc).toHaveBeenLastCalledWith("fs_write_file", {
        workspaceId: "project",
        relativePath: "main.ts",
        content: "again",
        expectedVersion: "v2",
      }),
    );
    await screen.findByRole("tab", { name: "main.ts", selected: true });
  });

  it("retains the draft after a save conflict and can reload with confirmation", async () => {
    const { user, editor } = await openFile();
    fireEvent.change(editor, { target: { value: "my draft" } });
    ipc.mockRejectedValueOnce("FILE_CONFLICT");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /save was blocked/i,
    );
    expect(editor.value).toBe("my draft");
    expect(screen.getByRole("tab", { name: "main.ts (unsaved)" })).toBeTruthy();

    ipc
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(snapshot("main.ts", "new on disk", "v2"));
    await user.click(screen.getByRole("button", { name: "Reload from disk" }));
    await waitFor(() => expect(editor.value).toBe("new on disk"));
    expect(ipc).toHaveBeenCalledWith("editor_confirm_discard", {
      action: "reload",
    });
    expect(screen.getByRole("tab", { name: "main.ts" })).toBeTruthy();
  });

  it("keeps dirty content after an ordinary write failure", async () => {
    const { user, editor } = await openFile();
    fireEvent.change(editor, { target: { value: "keep the draft" } });
    ipc.mockRejectedValueOnce("PERMISSION_DENIED");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /could not access/i,
    );
    expect(editor.value).toBe("keep the draft");
    expect(screen.getByRole("tab", { name: "main.ts (unsaved)" })).toBeTruthy();
  });

  it("detects an external version change on focus without changing the buffer", async () => {
    const { editor } = await openFile();
    ipc.mockResolvedValueOnce(snapshot("main.ts", "external content", "other"));
    fireEvent(window, new Event("focus"));

    expect(
      await screen.findByText("This file changed on disk.", {
        selector: ".editor-conflict span",
      }),
    ).toBeTruthy();
    // Announced through a live region that existed before the change.
    expect(
      screen
        .getAllByRole("status")
        .map(({ textContent }) => textContent)
        .includes("This file changed on disk."),
    ).toBe(true);
    expect(editor.value).toBe("contents of main.ts");
    expect(screen.getByRole("tab", { name: "main.ts" })).toBeTruthy();
  });

  it("protects dirty tabs, workspace transitions, and native exit when discard is canceled", async () => {
    const { user, editor } = await openFile();
    fireEvent.change(editor, { target: { value: "keep me" } });
    for (const [button, action] of [
      ["Close main.ts", "tab"],
      ["Close workspace", "workspace"],
      ["Switch folder", "workspace"],
    ]) {
      ipc.mockResolvedValueOnce(false);
      await user.click(screen.getByRole("button", { name: button }));
      expect(ipc).toHaveBeenLastCalledWith("editor_confirm_discard", {
        action,
      });
    }
    ipc.mockResolvedValueOnce(false);
    fireEvent(window, new Event("turing-close-requested"));
    await waitFor(() =>
      expect(ipc).toHaveBeenLastCalledWith("editor_confirm_discard", {
        action: "exit",
      }),
    );
    expect(ipc).not.toHaveBeenCalledWith("editor_exit", undefined);
    expect(editor.value).toBe("keep me");

    ipc.mockResolvedValueOnce(true).mockResolvedValueOnce(undefined);
    fireEvent(window, new Event("turing-close-requested"));
    await waitFor(() =>
      expect(ipc).toHaveBeenCalledWith("editor_exit", undefined),
    );
  });
});

async function fileAction(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(
    screen.getByRole("menuitem", { name: "File", expanded: false }),
  );
  const actions = within(screen.getByRole("menu", { name: "File actions" }));
  await user.click(
    actions.getByRole(name === "Auto Save" ? "menuitemcheckbox" : "menuitem", {
      name,
    }),
  );
}

const pickedFile = {
  fileId: "picked-file",
  name: "standalone.ts",
  displayPath: "/demo/standalone.ts",
  version: "picked-version",
  content: "const opened = true;",
};
const savedFile = {
  fileId: "saved-file",
  name: "saved.ts",
  displayPath: "/demo/saved.ts",
  version: "saved-version",
};

describe("File menu", () => {
  it("opens windows through fixed IPC commands and reopens recent workspaces only through the picker", async () => {
    clearRecents();
    const user = userEvent.setup();
    render(<Workbench />);
    ipc.mockResolvedValueOnce(undefined);
    await fileAction(user, "New Window");
    expect(ipc).toHaveBeenCalledWith("window_new_workbench", undefined);
    ipc
      .mockResolvedValueOnce({
        id: "project",
        name: "Fixture",
        displayPath: "/approved/fixture",
      })
      .mockResolvedValueOnce([]);
    await fileAction(user, "Open Folder");
    await within(screen.getByRole("region", { name: "Explorer" })).findByText(
      "Fixture",
    );
    await fileAction(user, "Open Recent…");
    const recent = await screen.findByRole("option", {
      name: /Fixture.*\/approved\/fixture/,
    });
    const lists = ipc.mock.calls.filter(
      ([command]) => command === "fs_list_directory",
    ).length;
    ipc.mockResolvedValueOnce(null);
    await user.click(recent);
    await waitFor(() =>
      expect(ipc).toHaveBeenCalledWith("workspace_open", {
        recentPath: "/approved/fixture",
      }),
    );
    expect(
      ipc.mock.calls.filter(([command]) => command === "fs_list_directory"),
    ).toHaveLength(lists);
    await fileAction(user, "Open Recent…");
    await user.click(
      screen.getByRole("option", { name: "Clear Recent History" }),
    );
    await fileAction(user, "Open Recent…");
    expect(screen.queryByRole("option", { name: /Fixture/ })).toBeNull();
  });

  it("confirms Close All once for dirty editors and leaves them intact on cancellation", async () => {
    const { user, editor } = await openFile();
    fireEvent.change(editor, { target: { value: "unsaved" } });
    await fileAction(user, "New Text File");
    ipc.mockResolvedValueOnce(false);
    await fileAction(user, "Close All Editors");
    expect(ipc).toHaveBeenCalledWith("editor_confirm_discard", {
      action: "closeAll",
    });
    expect(screen.getByRole("tab", { name: "main.ts (unsaved)" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Untitled-1" })).toBeTruthy();
    ipc.mockResolvedValueOnce(true);
    await fileAction(user, "Close All Editors");
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "Untitled-1" })).toBeNull(),
    );
    expect(screen.queryByRole("tab", { name: "main.ts (unsaved)" })).toBeNull();
  });

  it("shows and toggles the session Auto Save state from the File menu", async () => {
    const user = userEvent.setup();
    render(<Workbench />);

    await fileAction(user, "Auto Save");
    expect(screen.queryByRole("menu", { name: "File actions" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "File" }));
    const activeToggle = screen.getByRole("menuitemcheckbox", {
      name: "Auto Save",
      checked: true,
    });
    expect(activeToggle.getAttribute("aria-checked")).toBe("true");
    await user.click(activeToggle);
    await user.click(screen.getByRole("menuitem", { name: "File" }));
    expect(
      screen.getByRole("menuitemcheckbox", {
        name: "Auto Save",
        checked: false,
      }).textContent,
    ).toContain("Auto Save");
  });

  it("opens a native selection without a workspace and revokes its grant on close", async () => {
    const user = userEvent.setup();
    render(<Workbench />);
    ipc.mockResolvedValueOnce(pickedFile);

    await fileAction(user, "Open File");
    expect(
      (
        await screen.findByRole<HTMLTextAreaElement>("textbox", {
          name: "File editor",
        })
      ).value,
    ).toBe(pickedFile.content);
    expect(ipc).toHaveBeenCalledExactlyOnceWith("file_open", undefined);
    expect(screen.getByText("No workspace")).toBeTruthy();

    ipc.mockResolvedValueOnce(undefined);
    await fileAction(user, "Close Editor");
    expect(ipc).toHaveBeenLastCalledWith("file_close", {
      fileId: pickedFile.fileId,
    });
    expect(
      within(screen.getByRole("region", { name: "Editor" })).queryByRole("tab"),
    ).toBeNull();
  });

  it("keeps the workspace and its tabs when opening a standalone file", async () => {
    const user = userEvent.setup();
    render(<Workbench />);
    await fileAction(user, "Open Folder");
    await user.click(await screen.findByRole("button", { name: "main.ts" }));
    await screen.findByRole("tab", { name: "main.ts" });

    ipc.mockResolvedValueOnce(pickedFile);
    await fileAction(user, "Open File");
    expect(
      screen.getByRole("tab", { name: "main.ts", selected: false }),
    ).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "standalone.ts", selected: true }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "main.ts" })).toBeTruthy();
    expect(ipc).not.toHaveBeenCalledWith("workspace_close", expect.anything());

    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "File editor",
    });
    fireEvent.change(editor, { target: { value: "standalone draft" } });
    ipc.mockResolvedValueOnce(undefined);
    await user.click(screen.getByRole("button", { name: "Close workspace" }));
    expect(screen.queryByRole("tab", { name: "main.ts" })).toBeNull();
    expect(
      screen.getByRole("tab", { name: "standalone.ts (unsaved)" }),
    ).toBeTruthy();
    expect(editor.value).toBe("standalone draft");
    expect(ipc).toHaveBeenLastCalledWith("workspace_close", {
      workspaceId: "project",
    });
  });

  it("creates an untitled buffer, uses the picker on first save, and uses its grant afterward", async () => {
    const user = userEvent.setup();
    render(<Workbench />);
    await fileAction(user, "New Text File");
    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "File editor",
    });
    expect(editor.value).toBe("");
    expect(ipc).not.toHaveBeenCalled();

    fireEvent.change(editor, { target: { value: "const created = true;" } });
    expect(
      screen.getByRole("tab", { name: "Untitled-1 (unsaved)" }),
    ).toBeTruthy();
    ipc.mockResolvedValueOnce(savedFile);
    fireEvent.keyDown(editor, { key: "s", metaKey: true });
    await screen.findByRole("tab", { name: "saved.ts", selected: true });
    expect(ipc).toHaveBeenLastCalledWith("file_save_as", {
      content: "const created = true;",
      suggestedName: "Untitled-1",
    });
    expect(editor.value).toBe("const created = true;");

    fireEvent.change(editor, { target: { value: "const changed = true;" } });
    ipc.mockResolvedValueOnce("next-version");
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    await screen.findByRole("tab", { name: "saved.ts", selected: true });
    expect(ipc).toHaveBeenLastCalledWith("file_write", {
      fileId: savedFile.fileId,
      expectedVersion: savedFile.version,
      content: "const changed = true;",
    });
  });

  it("can save an empty untitled buffer and retains it when the picker is canceled", async () => {
    const user = userEvent.setup();
    render(<Workbench />);
    await fileAction(user, "New Text File");
    ipc.mockResolvedValueOnce(null);
    await fileAction(user, "Save");
    expect(
      screen.getByRole("tab", { name: "Untitled-1", selected: true }),
    ).toBeTruthy();
    expect(ipc).toHaveBeenLastCalledWith("file_save_as", {
      content: "",
      suggestedName: "Untitled-1",
    });
    expect(screen.queryByRole("alert")).toBeNull();

    ipc.mockResolvedValueOnce(savedFile);
    await fileAction(user, "Save");
    expect(screen.getByRole("tab", { name: "saved.ts" })).toBeTruthy();
  });

  it("saves an existing file as a new selection and retains the draft on conflict or cancellation", async () => {
    const { user, editor } = await openFile();
    fireEvent.change(editor, { target: { value: "copy this draft" } });
    ipc.mockResolvedValueOnce(null);
    await fileAction(user, "Save As");
    expect(screen.getByRole("tab", { name: "main.ts (unsaved)" })).toBeTruthy();

    ipc.mockRejectedValueOnce("FILE_CONFLICT");
    await fileAction(user, "Save As");
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /save was blocked/i,
    );
    expect(editor.value).toBe("copy this draft");

    ipc.mockResolvedValueOnce(savedFile);
    await fileAction(user, "Save As");
    expect(ipc).toHaveBeenLastCalledWith("file_save_as", {
      content: "copy this draft",
      suggestedName: "main.ts",
    });
    expect(
      screen.getByRole("tab", { name: "saved.ts", selected: true }),
    ).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /main.ts/i })).toBeNull();
    expect(screen.getByRole("button", { name: "main.ts" })).toBeTruthy();
    expect(ipc).not.toHaveBeenCalledWith("fs_write_file", expect.anything());
  });

  it("leaves no tab on rejected or canceled file selection", async () => {
    const user = userEvent.setup();
    render(<Workbench />);
    for (const [code, message] of [
      ["INVALID_ENCODING", /not UTF-8 text/i],
      ["FILE_TOO_LARGE", /exceeds the 2 MiB/i],
    ] as const) {
      ipc.mockRejectedValueOnce(code);
      await fileAction(user, "Open File");
      expect((await screen.findByRole("alert")).textContent).toMatch(message);
      expect(
        within(screen.getByRole("region", { name: "Editor" })).queryByRole(
          "tab",
        ),
      ).toBeNull();
    }
    ipc.mockResolvedValueOnce(null);
    await fileAction(user, "Open File");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Editor" })).queryByRole("tab"),
    ).toBeNull();
  });

  it("allows an in-memory untitled buffer in browser preview while disabling filesystem actions", async () => {
    const user = userEvent.setup();
    vi.mocked(isTauri).mockReturnValue(false);
    render(<Workbench />);

    await fileAction(user, "New Text File");
    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "File editor",
    });
    fireEvent.change(editor, { target: { value: "only in memory" } });
    await user.click(screen.getByRole("menuitem", { name: "File" }));
    const actions = within(screen.getByRole("menu", { name: "File actions" }));
    for (const name of ["Open File", "Open Folder", "Save", "Save As"]) {
      expect(
        actions.getByRole("menuitem", { name }).getAttribute("aria-disabled"),
      ).toBe("true");
    }
    expect(editor.value).toBe("only in memory");
    expect(ipc).not.toHaveBeenCalled();
  });
});
