// @vitest-environment jsdom

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
import { expectAccessible } from "../test/axe";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "../shell/Workbench";
import { useLayout } from "../state/layout";
import { created, resetFakeMonaco } from "./fake-monaco";

vi.mock("./draft-ipc", () => import("../test/mock-draft-ipc"));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("../git/git-ipc", async (original) => ({
  ...(await original<typeof import("../git/git-ipc")>()),
  invokeGit: vi.fn(() => Promise.reject("NOT_A_REPOSITORY")),
}));
// The real MonacoHost runs against a model/view-separated Monaco double.
vi.mock("monaco-editor", () => import("./fake-monaco"));

const ipc = vi.mocked(invoke);
const entries = ["main.ts", "notes.md"].map((name) => ({
  name,
  relativePath: name,
  kind: "file",
  identity: `${name}-identity`,
}));

beforeEach(() => {
  resetFakeMonaco();
  ipc.mockReset();
  vi.mocked(isTauri).mockReturnValue(true);
  ipc.mockImplementation(async (command, args) => {
    switch (command) {
      case "workspace_open":
        return { id: "project", name: "Project" };
      case "fs_list_directory":
        return entries;
      case "fs_read_file": {
        const relativePath = (args as { relativePath: string }).relativePath;
        return {
          relativePath,
          content: `contents of ${relativePath}`,
          version: "v1",
          workspaceId: "project",
          encoding: "utf-8",
        };
      }
      case "workspace_symbols_query":
        return {
          generation: 1,
          complete: true,
          truncated: false,
          symbols: [
            {
              name: "main",
              kind: "function",
              relativePath: "main.ts",
              line: 0,
              character: 0,
            },
          ],
        };
      case "editor_confirm_discard":
        return true;
      case "workspace_close":
        return undefined;
      default:
        throw new Error(`Unexpected IPC command ${command}`);
    }
  });
});

afterEach(() => {
  cleanup();
  useLayout.setState(useLayout.getInitialState(), true);
});

const group = (number: number) =>
  within(screen.getByRole("region", { name: `Editor group ${number}` }));

const live = () => created.editors.filter((editor) => !editor.disposed);

async function openMain() {
  const user = userEvent.setup();
  render(<Workbench />);
  await user.click(screen.getByRole("button", { name: "Open folder" }));
  await user.click(await screen.findByRole("button", { name: "main.ts" }));
  await waitFor(() => expect(live()).toHaveLength(1));
  return user;
}

function shortcut(key: string, modifiers: KeyboardEventInit = {}) {
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key,
    ...modifiers,
  });
}

async function splitRight() {
  shortcut("\\", { ctrlKey: true });
  await waitFor(() => expect(live()).toHaveLength(2));
}

async function editAction(
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
) {
  await user.click(screen.getByRole("menuitem", { name: "Edit" }));
  const actions = within(screen.getByRole("menu", { name: "Edit actions" }));
  await user.click(actions.getByRole("menuitem", { name }));
}

describe("editor groups", () => {
  it("qualifies open workspaces with tabs and split groups", async () => {
    const user = await openMain();
    await user.click(screen.getByRole("button", { name: "notes.md" }));
    await screen.findByRole("tab", { name: "notes.md" });
    await expectAccessible(document.body);
    const treeRow = screen.getByRole("button", { name: "notes.md" });
    treeRow.focus();
    await user.keyboard("{F2}");
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Rename entry" }),
    );
    await expectAccessible(document.body);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "notes.md" }),
    );
    screen.getByRole("tab", { name: "notes.md" }).focus();
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: "main.ts", selected: true }),
    );
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: "notes.md", selected: true }),
    );
    await splitRight();
    await expectAccessible(document.body);
  });

  it("opens the symbol picker from the workspace and restores keyboard focus on Escape", async () => {
    const user = await openMain();
    const tab = screen.getByRole("tab", { name: "main.ts" });
    tab.focus();
    await user.keyboard("{Control>}t{/Control}");
    const input = screen.getByRole("combobox", {
      name: "Search workspace symbols",
    });
    expect(document.activeElement).toBe(input);
    await user.keyboard("main");
    const option = await screen.findByRole("option", {
      name: /main.*function/,
    });
    await user.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toBe(option.id);
    await expectAccessible(document.body, true);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(tab);
  });

  it("splits one document into two views of a single shared model", async () => {
    await openMain();
    await splitRight();
    const [left, right] = live();
    expect(created.models).toHaveLength(1);
    expect(left.getModel()).toBe(created.models[0]);
    expect(right.getModel()).toBe(left.getModel());
    expect(group(1).getByRole("tab", { name: "main.ts" })).toBeTruthy();
    expect(
      group(2).getByRole("tab", { name: "main.ts", selected: true }),
    ).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Open files, group 2" }));
    // The new group is active and has keyboard focus.
    expect(document.activeElement).toBe(right.input);
    expect(group(2).getByRole("button", { name: "Save" })).toBeTruthy();
    expect(group(1).queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("keeps cursor and view state per group", async () => {
    const user = await openMain();
    await splitRight();
    const [left, right] = live();
    act(() => left.setPosition({ lineNumber: 5, column: 3 }));
    act(() => right.setPosition({ lineNumber: 2, column: 2 }));
    left.scrollTop = 140;
    right.scrollTop = 48;
    expect(left.getPosition()).toEqual({ lineNumber: 5, column: 3 });

    // Group 2 is active, so the Explorer opens notes.md there.
    await user.click(screen.getByRole("button", { name: "notes.md" }));
    await group(2).findByRole("tab", { name: "notes.md", selected: true });
    expect(right.getModel()?.getValue()).toBe("contents of notes.md");
    expect(left.getModel()?.getValue()).toBe("contents of main.ts");
    expect(group(1).queryByRole("tab", { name: "notes.md" })).toBeNull();

    await user.click(group(2).getByRole("tab", { name: "main.ts" }));
    expect(right.getModel()).toBe(left.getModel());
    expect(right.getPosition()).toEqual({ lineNumber: 2, column: 2 });
    expect(left.getPosition()).toEqual({ lineNumber: 5, column: 3 });
    expect(right.scrollTop).toBe(48);
    expect(left.scrollTop).toBe(140);
  });

  it("shares edits and the undo stack between groups", async () => {
    const user = await openMain();
    await splitRight();
    const [left, right] = live();
    const model = created.models[0];
    act(() => model.type("edited in group 2"));
    expect(
      group(1).getByRole("tab", { name: "main.ts (unsaved)" }),
    ).toBeTruthy();
    expect(
      group(2).getByRole("tab", { name: "main.ts (unsaved)" }),
    ).toBeTruthy();
    expect(left.input.value).toBe("edited in group 2");

    shortcut("F6", { ctrlKey: true });
    await waitFor(() => expect(document.activeElement).toBe(left.input));
    // Undo from group 1 reverts the edit made in group 2: one stack.
    await editAction(user, /^Undo/);
    expect(model.getValue()).toBe("contents of main.ts");
    expect(right.input.value).toBe("contents of main.ts");
    expect(group(1).getByRole("tab", { name: "main.ts" })).toBeTruthy();
    expect(group(2).getByRole("tab", { name: "main.ts" })).toBeTruthy();
  });

  it("disposes a model only after the last group closes its document", async () => {
    const user = await openMain();
    await splitRight();
    const [, right] = live();
    const model = created.models[0];

    await user.click(group(2).getByRole("button", { name: "Close main.ts" }));
    expect(model.disposed).toBe(false);
    expect(right.disposed).toBe(true);
    expect(screen.queryByRole("region", { name: "Editor group 2" })).toBeNull();
    expect(screen.getByRole("tab", { name: "main.ts" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close main.ts" }));
    expect(model.disposed).toBe(true);
    expect(live()).toHaveLength(0);
  });

  it("closes a group and the documents only it was showing", async () => {
    const user = await openMain();
    await splitRight();
    await user.click(screen.getByRole("button", { name: "notes.md" }));
    await group(2).findByRole("tab", { name: "notes.md", selected: true });
    const [main, notes] = created.models;
    act(() => notes.type("unsaved notes"));

    await user.click(
      group(2).getByRole("button", { name: "Close editor group 2" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Editor group 2" }),
      ).toBeNull(),
    );
    expect(ipc).toHaveBeenCalledWith("editor_confirm_discard", {
      action: "tab",
    });
    expect(notes.disposed).toBe(true);
    expect(main.disposed).toBe(false);
    expect(screen.queryByRole("tab", { name: /notes\.md/ })).toBeNull();
    expect(
      screen.getByRole("tab", { name: "main.ts", selected: true }),
    ).toBeTruthy();
  });

  it("disposes every workspace model when the folder closes", async () => {
    const user = await openMain();
    await splitRight();
    await user.click(screen.getByRole("button", { name: "Close workspace" }));
    await waitFor(() => expect(created.models[0].disposed).toBe(true));
    expect(live()).toHaveLength(0);
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("moves a tab into the next group and focuses groups in both directions", async () => {
    const user = await openMain();
    await user.click(screen.getByRole("button", { name: "notes.md" }));
    await screen.findByRole("tab", { name: "notes.md", selected: true });
    await user.click(screen.getByRole("menuitem", { name: "View" }));
    const view = within(screen.getByRole("menu", { name: "View actions" }));
    await user.click(view.getByRole("menuitem", { name: "Editor Layout" }));
    const layout = within(
      await screen.findByRole("menu", { name: "Editor Layout" }),
    );
    await user.click(
      layout.getByRole("menuitem", { name: "Move Editor into Next Group" }),
    );
    await waitFor(() => expect(live()).toHaveLength(2));
    expect(group(1).queryByRole("tab", { name: "notes.md" })).toBeNull();
    expect(
      group(2).getByRole("tab", { name: "notes.md", selected: true }),
    ).toBeTruthy();
    expect(created.models).toHaveLength(2);
    expect(created.models.some(({ disposed }) => disposed)).toBe(false);

    const [left, right] = live();
    shortcut("F6", { ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(document.activeElement).toBe(left.input));
    shortcut("F6", { ctrlKey: true });
    await waitFor(() => expect(document.activeElement).toBe(right.input));
  });
});
