// @vitest-environment jsdom

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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionUpdate } from "@turing/contracts";
import type { EditorTab } from "../editor/use-editor";
import { Workbench } from "../shell/Workbench";
import { useLayout } from "../state/layout";
import { executionErrorMessage } from "./execution-ipc";
import { executionLanguage, runDisabledReason } from "./use-execution";

const ipc = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: ipc,
  Channel: function () {},
}));

// The workspace watcher polls in the background; hold it out of IPC sequences.
vi.mock("../explorer/watch-ipc", () => ({
  pollWorkspaceChanges: vi.fn(() => new Promise(() => {})),
}));
vi.mock("../editor/MonacoHost", () => ({
  default: ({
    active,
    onChange,
  }: {
    active: EditorTab;
    onChange: (tab: EditorTab, text: string) => void;
  }) => (
    <textarea
      aria-label="Source text"
      value={active.draft}
      onChange={(event) => onChange(active, event.target.value)}
    />
  ),
}));

afterEach(() => {
  cleanup();
  ipc.mockReset();
  useLayout.setState(useLayout.getInitialState(), true);
});

function registerFile(
  name = "hello.py",
  overrides: Record<string, unknown> = {},
) {
  ipc.mockImplementation((command: string) => {
    if (command in overrides) return overrides[command];
    if (command === "workspace_open")
      return Promise.resolve({ id: "w", name: "fixture" });
    if (command === "fs_list_directory")
      return Promise.resolve([{ name, relativePath: name, kind: "file" }]);
    if (command === "fs_read_file")
      return Promise.resolve({
        workspaceId: "w",
        relativePath: name,
        content: "original",
        encoding: "utf-8",
        version: "v1",
      });
    return Promise.resolve();
  });
}

async function openFile(name = "hello.py") {
  const user = userEvent.setup();
  render(<Workbench />);
  const explorer = screen.getByRole("region", { name: "Explorer" });
  await user.click(
    within(explorer).getByRole("button", { name: "Open folder" }),
  );
  await user.click(await within(explorer).findByRole("button", { name }));
  await screen.findByRole("textbox", { name: "Source text" });
  return user;
}

const completed: ExecutionUpdate = {
  phase: "completed",
  cancelled: false,
  elapsedMs: 42,
  exitCode: 0,
  truncated: false,
  error: null,
  output: [{ stream: "stdout", bytes: [111, 107] }],
};

describe("Run & Build", () => {
  it("uses the saved workspace revision, reveals Output, and suppresses duplicate requests", async () => {
    let finish!: (value: ExecutionUpdate) => void;
    const pending = new Promise<ExecutionUpdate>((resolve) => {
      finish = resolve;
    });
    registerFile("hello.py", {
      execution_start: Promise.resolve({
        id: "one",
        name: "hello.py",
        language: "python",
      }),
      execution_read: pending,
    });
    await openFile();
    const editor = screen.getByRole("region", { name: "Editor" });
    expect(
      ipc.mock.calls.some(([command]) => command === "execution_start"),
    ).toBe(false);
    const input = within(editor).getByRole("textbox", { name: "Source text" });
    fireEvent.keyDown(input, { key: "F5" });
    fireEvent.keyDown(input, { key: "F5" });
    await waitFor(() =>
      expect(
        ipc.mock.calls.filter(([command]) => command === "execution_start"),
      ).toHaveLength(1),
    );
    expect(ipc).toHaveBeenCalledWith(
      "execution_start",
      expect.objectContaining({
        source: {
          kind: "workspace",
          workspaceId: "w",
          relativePath: "hello.py",
          version: "v1",
        },
      }),
    );
    const output = screen.getByRole("tabpanel", { name: "Output" });
    expect(within(output).getByRole("button", { name: "Stop" })).toBeTruthy();
    await act(async () => finish(completed));
    expect(within(output).getByText("ok")).toBeTruthy();
    expect(within(output).getByText(/exit code 0/i)).toBeTruthy();
  });

  it("requires saving a changed buffer and runs the new revision after save", async () => {
    registerFile("hello.py", {
      fs_write_file: Promise.resolve("v2"),
      execution_start: Promise.resolve({ id: "one" }),
      execution_read: Promise.resolve(completed),
    });
    const user = await openFile();
    const editor = screen.getByRole("region", { name: "Editor" });
    const input = within(editor).getByRole("textbox", { name: "Source text" });
    fireEvent.change(input, { target: { value: "modified" } });
    const run = within(editor).getByRole("button", { name: "Run File" });
    expect(run.hasAttribute("disabled")).toBe(true);
    expect(run.getAttribute("aria-description")).toMatch(/save your changes/i);
    fireEvent.keyDown(input, { key: "F5" });
    expect(
      ipc.mock.calls.some(([command]) => command === "execution_start"),
    ).toBe(false);
    await user.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(run.hasAttribute("disabled")).toBe(false));
    await user.click(run);
    await waitFor(() =>
      expect(ipc).toHaveBeenCalledWith(
        "execution_start",
        expect.objectContaining({
          source: expect.objectContaining({ version: "v2" }),
        }),
      ),
    );
  });

  it("explains unsupported files and blocks the shortcut", async () => {
    registerFile("readme.txt");
    await openFile("readme.txt");
    const run = screen.getByRole("button", { name: "Run File" });
    expect(run.hasAttribute("disabled")).toBe(true);
    expect(run.getAttribute("aria-description")).toMatch(
      /supports Python, C, C\+\+/,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Source text" }), {
      key: "F5",
    });
    expect(
      ipc.mock.calls.some(([command]) => command === "execution_start"),
    ).toBe(false);
  });

  it("sends Stop to the active run and displays the stopped state", async () => {
    let finish!: (value: ExecutionUpdate) => void;
    registerFile("hello.py", {
      execution_start: Promise.resolve({ id: "one" }),
      execution_read: new Promise<ExecutionUpdate>((resolve) => {
        finish = resolve;
      }),
    });
    const user = await openFile();
    const runMenu = screen.getByRole("menuitem", { name: "Run" });
    await user.click(runMenu);
    await user.click(
      screen.getByRole("menuitem", { name: "Run Without Debugging" }),
    );
    const output = screen.getByRole("tabpanel", { name: "Output" });
    await user.click(runMenu);
    await user.click(screen.getByRole("menuitem", { name: "Stop Execution" }));
    await waitFor(() =>
      expect(ipc).toHaveBeenCalledWith("execution_stop", { id: "one" }),
    );
    await act(async () =>
      finish({ ...completed, cancelled: true, exitCode: null }),
    );
    expect(within(output).getByText("Stopped")).toBeTruthy();
  });
});

describe("single-file Run support", () => {
  it.each([
    ["hello.C", "cpp"],
    ["hello.c", "c"],
    ["hello.rs", "rust"],
    ["hello.go", "go"],
    ["Hello.java", "java"],
    ["hello.js", "javascript"],
    ["hello.mjs", "javascript"],
    ["hello.cjs", "javascript"],
    ["hello.ts", "typescript"],
    ["hello.mts", "typescript"],
    ["hello.cts", "typescript"],
    ["hello.cs", "csharp"],
  ])("allows a saved %s in the desktop workbench", (name, language) => {
    const tab: EditorTab = {
      key: name,
      uri: "turing-workspace://w/" + name,
      revision: 1,
      name,
      title: name,
      source: {
        kind: "workspace",
        workspaceId: "w",
        relativePath: name,
        version: "v1",
      },
      content: "",
      draft: "",
      changedOnDisk: false,
    };
    expect(executionLanguage(name)).toBe(language);
    expect(runDisabledReason(tab, true)).toBeUndefined();
    expect(runDisabledReason(tab, false)).toBe("Run requires the desktop app.");
  });

  it.each([
    ["C_COMPILER_UNAVAILABLE", /Clang or GCC/],
    ["RUST_UNAVAILABLE", /rustc/],
    ["GO_UNAVAILABLE", /Install Go/],
    ["JAVA_UNAVAILABLE", /Install a JDK/],
    ["NODE_UNAVAILABLE", /Install Node.js/],
    ["TYPESCRIPT_UNAVAILABLE", /TypeScript runtime unavailable/],
    ["DOTNET_UNAVAILABLE", /SDK.*dotnet/],
  ])("gives installation guidance for %s", (error, guidance) => {
    expect(executionErrorMessage(error)).toMatch(guidance);
  });

  it("reports a missing Go toolchain after discovery and allows retry", async () => {
    registerFile("hello.go", {
      execution_start: Promise.resolve({
        id: "one",
        name: "hello.go",
        language: "go",
      }),
      execution_read: Promise.resolve({
        ...completed,
        phase: "failed",
        error: "GO_UNAVAILABLE",
        exitCode: null,
        output: [],
      }),
    });
    const user = await openFile("hello.go");
    const run = screen.getByRole("button", { name: "Run File" });
    expect(run.hasAttribute("disabled")).toBe(false);
    await user.click(run);
    expect(await screen.findByText(/Go toolchain unavailable/)).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Run File" });
    expect(retry.getAttribute("aria-description")).toMatch(/Install Go/);
    expect(retry.hasAttribute("disabled")).toBe(false);
  });
});
