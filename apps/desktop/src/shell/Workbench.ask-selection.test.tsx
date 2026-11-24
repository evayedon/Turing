// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AskEvent } from "@turing/contracts";
import type { EditorInfo } from "../editor/editor-info";
import { useLayout } from "../state/layout";
import { Workbench } from "./Workbench";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    constructor(public onmessage: (event: AskEvent) => void) {}
  },
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
}));
vi.mock("../explorer/watch-ipc", () => ({
  pollWorkspaceChanges: vi.fn(() => new Promise(() => {})),
}));

// Stands in for Monaco: reports a line selection and offers the context-menu action.
vi.mock("../editor/MonacoHost", () => ({
  default: ({
    active,
    onInfo,
    onAskSelection,
    canAskSelection,
  }: {
    active: { key: string };
    onInfo: (info: EditorInfo) => void;
    onAskSelection?: () => void;
    canAskSelection?: boolean;
  }) => (
    <div>
      <button
        type="button"
        onClick={() =>
          onInfo({
            key: active.key,
            language: "Rust",
            line: 12,
            column: 1,
            eol: "LF",
            selection: { startLine: 10, endLine: 12 },
          })
        }
      >
        Select lines
      </button>
      {canAskSelection && (
        <button type="button" onClick={onAskSelection}>
          Context menu ask
        </button>
      )}
    </div>
  ),
}));

beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "workspace_open") return { id: "repo", name: "Project" };
    if (command === "fs_list_directory")
      return [{ name: "a.rs", relativePath: "src/a.rs", kind: "file" }];
    if (command === "fs_read_file")
      return {
        workspaceId: "repo",
        relativePath: "src/a.rs",
        content: "fn main() {}\n",
        encoding: "utf-8",
        version: "v7",
      };
    if (command === "ask_run") return new Promise(() => {});
  });
  useLayout.setState(useLayout.getInitialState(), true);
});

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  localStorage.clear();
  useLayout.setState(useLayout.getInitialState(), true);
});

it("attaches a saved selection to Ask and sends it as a reference", async () => {
  const user = userEvent.setup();
  render(<Workbench />);
  await user.click(screen.getByRole("menuitem", { name: "File" }));
  await user.click(screen.getByRole("menuitem", { name: "Open Folder" }));
  const explorer = within(screen.getByRole("region", { name: "Explorer" }));
  await user.click(await explorer.findByRole("button", { name: "a.rs" }));
  await screen.findByRole("tab", { name: /a\.rs/ });

  await user.click(screen.getByRole("menuitem", { name: "Selection" }));
  const command = screen.getByRole("menuitem", {
    name: "Ask Turing AI About Selection",
  });
  expect(command.getAttribute("aria-disabled")).toBe("true");
  expect(command.getAttribute("aria-description")).toBe(
    "Select lines in the editor to ask about them.",
  );
  await user.keyboard("{Escape}");

  await user.click(screen.getByRole("button", { name: "Select lines" }));
  expect(useLayout.getState().assistant).toBe(false);
  await user.click(screen.getByRole("button", { name: "Context menu ask" }));

  expect(useLayout.getState().assistant).toBe(true);
  const composer = await screen.findByRole("textbox", {
    name: "Ask about this workspace",
  });
  expect(document.activeElement).toBe(composer);
  const chip = screen.getByRole("group", { name: "Attached selection" });
  expect(chip.textContent).toContain("src/a.rs:10–12");

  await user.click(
    within(chip).getByRole("button", {
      name: "Remove selection src/a.rs:10–12",
    }),
  );
  expect(
    screen.queryByRole("group", { name: "Attached selection" }),
  ).toBeNull();

  await user.click(screen.getByRole("menuitem", { name: "Selection" }));
  await user.click(
    screen.getByRole("menuitem", { name: "Ask Turing AI About Selection" }),
  );
  expect(
    screen.getByRole("group", { name: "Attached selection" }),
  ).toBeTruthy();
  await user.type(composer, "What does this do?");
  await user.click(screen.getByRole("button", { name: "Ask" }));

  expect(invoke).toHaveBeenCalledWith(
    "ask_run",
    expect.objectContaining({
      request: expect.objectContaining({
        workspaceId: "repo",
        question: "What does this do?",
        selection: {
          relativePath: "src/a.rs",
          version: "v7",
          startLine: 10,
          endLine: 12,
        },
      }),
    }),
  );
  expect(
    screen.queryByRole("group", { name: "Attached selection" }),
  ).toBeNull();
});
