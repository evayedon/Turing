// @vitest-environment jsdom

import { invoke, isTauri } from "@tauri-apps/api/core";
import {
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
import { useLayout } from "../state/layout";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));

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

async function openFile() {
  const user = userEvent.setup();
  render(<Workbench />);
  await user.click(screen.getByRole("button", { name: "Open folder" }));
  await user.click(await screen.findByRole("button", { name: "main.ts" }));
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

    expect(await screen.findByText("This file changed on disk.")).toBeTruthy();
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
    screen.getByRole("button", { name: "File", expanded: false }),
  );
  const actions = within(screen.getByRole("group", { name: "File actions" }));
  await user.click(actions.getByRole("button", { name }));
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
  it("shows and toggles the session Auto Save state from the File menu", async () => {
    const user = userEvent.setup();
    render(<Workbench />);

    await fileAction(user, "Auto Save");
    expect(screen.queryByRole("group", { name: "File actions" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "File" }));
    const activeToggle = screen.getByRole("button", {
      name: "Auto Save",
      pressed: true,
    });
    expect(activeToggle.textContent).toContain("On");
    await user.click(activeToggle);
    await user.click(screen.getByRole("button", { name: "File" }));
    expect(
      screen.getByRole("button", { name: "Auto Save", pressed: false })
        .textContent,
    ).toContain("Off");
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
    await fileAction(user, "Close File");
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
    await fileAction(user, "New File");
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
      suggestedName: undefined,
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
    await fileAction(user, "New File");
    ipc.mockResolvedValueOnce(null);
    await fileAction(user, "Save");
    expect(
      screen.getByRole("tab", { name: "Untitled-1", selected: true }),
    ).toBeTruthy();
    expect(ipc).toHaveBeenLastCalledWith("file_save_as", {
      content: "",
      suggestedName: undefined,
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

    await fileAction(user, "New File");
    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "File editor",
    });
    fireEvent.change(editor, { target: { value: "only in memory" } });
    await user.click(screen.getByRole("button", { name: "File" }));
    const actions = within(screen.getByRole("group", { name: "File actions" }));
    for (const name of ["Open File", "Open Folder", "Save", "Save As"]) {
      expect(
        actions.getByRole<HTMLButtonElement>("button", { name }).disabled,
      ).toBe(true);
    }
    expect(editor.value).toBe("only in memory");
    expect(ipc).not.toHaveBeenCalled();
  });
});
