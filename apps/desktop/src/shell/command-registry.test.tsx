// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import { MenuBar } from "./MenuBar";
import {
  commandRegistry,
  describeCommands,
  dispatch,
  handleShortcut,
  paletteEntries,
} from "./command-registry";
import type {
  CommandActions,
  CommandContext,
  CommandState,
} from "./command-registry";
import { commandIds } from "./commands";

afterEach(cleanup);

function state(overrides: Partial<CommandState> = {}): CommandState {
  return {
    native: true,
    modifier: "Ctrl",
    modalOpen: false,
    editorOpen: true,
    editorBusy: false,
    editorReady: true,
    editorSupports: () => true,
    readOnly: false,
    canSave: true,
    autoSave: false,
    tabCount: 1,
    groupCount: 1,
    canMoveEditorToNextGroup: false,
    hasWorkspace: true,
    workspaceBusy: false,
    recentCount: 0,
    sidebar: "explorer",
    renameTarget: false,
    canRenameSymbol: false,
    bottomPanel: false,
    dockView: "Terminal",
    assistant: false,
    problemCount: 0,
    executionBusy: false,
    executionStopping: false,
    runBlocked: false,
    terminalRunning: false,
    ...overrides,
  };
}

function actions(): CommandActions {
  return {
    openPopup: vi.fn(),
    openWindow: vi.fn(),
    clearRecents: vi.fn(),
    createTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    clearTerminal: vi.fn(),
    toggleTerminal: vi.fn(),
    runEditorCommand: vi.fn(),
    newFile: vi.fn(),
    createWorkspaceFile: vi.fn(),
    openFile: vi.fn(),
    openFolder: vi.fn(),
    save: vi.fn(),
    saveAs: vi.fn(),
    toggleAutoSave: vi.fn(),
    renameSelection: vi.fn(),
    renameSymbol: vi.fn(),
    closeActiveEditor: vi.fn(),
    closeAllEditors: vi.fn(),
    splitEditor: vi.fn(),
    moveEditorToNextGroup: vi.fn(),
    focusEditorGroup: vi.fn(),
    closeEditorGroup: vi.fn(),
    selectSidebar: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleSourceControl: vi.fn(),
    toggleBottomPanel: vi.fn(),
    showDock: vi.fn(),
    revealDock: vi.fn(),
    openSettings: vi.fn(),
    toggleAssistant: vi.fn(),
    goToLine: vi.fn(),
    goToProblem: vi.fn(),
    startRun: vi.fn(),
    stopRun: vi.fn(),
  };
}

function context(overrides: Partial<CommandState> = {}): CommandContext {
  return { state: state(overrides), actions: actions() };
}

function key(init: KeyboardEventInit, target: EventTarget = document.body) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

const save = { key: "s", ctrlKey: true };

describe("declarative command registry", () => {
  it("declares every command that menus and the palette list", () => {
    for (const id of commandIds) expect(commandRegistry[id]).toBeDefined();
    const views = describeCommands(state({ bottomPanel: true }));
    expect(views.dock.label).toBe("Hide Bottom Panel");
    expect(views.save.hint).toBe("Ctrl+S");
    expect(views.rename.hint).toBe("F2");
    expect(views.redo.hint).toBe("Ctrl+Y");
    expect(describeCommands(state({ modifier: "⌘" })).redo.hint).toBe(
      "⌘+Shift+Z",
    );
  });

  it("opens workspace symbols with the platform shortcut only for a native workspace", () => {
    for (const [modifier, event] of [
      ["Ctrl", { key: "t", ctrlKey: true }],
      ["⌘", { key: "t", metaKey: true }],
    ] as const) {
      const target = context({ modifier, native: true, hasWorkspace: true });
      expect(handleShortcut(target, key(event))).toBe("ran");
      expect(target.actions.openPopup).toHaveBeenCalledWith("symbols");
      const preview = context({ modifier, native: false, hasWorkspace: true });
      expect(handleShortcut(preview, key(event))).toBe("ignored");
      const empty = context({ modifier, native: true, hasWorkspace: false });
      expect(handleShortcut(empty, key(event))).toBe("ignored");
    }
  });

  it("treats a disabled command as a no-op from every entry point", () => {
    const disabled = context({ canSave: false });
    for (const source of ["menu", "palette", "control"] as const)
      expect(dispatch(disabled, "save", { source })).toBe("ignored");
    const event = key(save);
    expect(handleShortcut(disabled, event)).toBe("ignored");
    expect(event.defaultPrevented).toBe(false);
    expect(disabled.actions.save).not.toHaveBeenCalled();

    const enabled = context();
    for (const source of ["menu", "palette", "control"] as const)
      expect(dispatch(enabled, "save", { source })).toBe("ran");
    const pressed = key(save);
    expect(handleShortcut(enabled, pressed)).toBe("ran");
    expect(pressed.defaultPrevented).toBe(true);
    expect(enabled.actions.save).toHaveBeenCalledTimes(4);
  });

  it("gates editor group commands on the group layout", () => {
    const single = context();
    const views = describeCommands(single.state);
    expect(views.splitEditor.enabled).toBe(true);
    expect(views.splitEditor.hint).toBe("Ctrl+\\");
    expect(views.moveEditorToNextGroup.enabled).toBe(false);
    expect(views.focusNextGroup.enabled).toBe(false);
    expect(views.closeGroup.enabled).toBe(false);
    expect(views.focusNextGroup.hint).toBe("Ctrl+F6");
    expect(views.focusPreviousGroup.hint).toBe("Ctrl+Shift+F6");
    expect(handleShortcut(single, key({ key: "F6", ctrlKey: true }))).toBe(
      "ignored",
    );
    expect(handleShortcut(single, key({ key: "\\", ctrlKey: true }))).toBe(
      "ran",
    );
    expect(single.actions.splitEditor).toHaveBeenCalledOnce();

    const split = context({ groupCount: 2, canMoveEditorToNextGroup: true });
    expect(
      handleShortcut(split, key({ key: "F6", ctrlKey: true, shiftKey: true })),
    ).toBe("ran");
    expect(split.actions.focusEditorGroup).toHaveBeenCalledWith(-1);
    expect(dispatch(split, "closeGroup", { source: "menu" })).toBe("ran");
    expect(split.actions.closeEditorGroup).toHaveBeenCalledOnce();
    expect(
      dispatch(split, "moveEditorToNextGroup", { source: "palette" }),
    ).toBe("ran");
    const busy = context({ groupCount: 2, editorBusy: true });
    expect(dispatch(busy, "closeGroup", { source: "menu" })).toBe("ignored");
    expect(dispatch(busy, "splitEditor", { source: "menu" })).toBe("ignored");
  });

  it("does not run hidden commands", () => {
    const hidden = context({ editorSupports: (id) => id !== "symbol" });
    expect(describeCommands(hidden.state).symbol.visible).toBe(false);
    expect(dispatch(hidden, "symbol", { source: "palette" })).toBe("ignored");
    expect(hidden.actions.runEditorCommand).not.toHaveBeenCalled();
  });

  it("only runs terminal-safe shortcuts while focus is in a terminal", () => {
    const screenElement = document.createElement("div");
    screenElement.className = "terminal-screen";
    const inner = document.createElement("textarea");
    screenElement.append(inner);
    document.body.append(screenElement);
    const target = context();

    const blocked = key(save, inner);
    expect(handleShortcut(target, blocked)).toBe("ignored");
    expect(blocked.defaultPrevented).toBe(false);
    expect(target.actions.save).not.toHaveBeenCalled();

    const palette = key({ key: "P", ctrlKey: true, shiftKey: true }, inner);
    expect(handleShortcut(target, palette)).toBe("ran");
    expect(target.actions.openPopup).toHaveBeenCalledWith("commands");
    expect(
      handleShortcut(target, key({ key: "`", ctrlKey: true }, inner)),
    ).toBe("ran");
    expect(target.actions.revealDock).toHaveBeenCalledWith("Terminal");
    expect(
      handleShortcut(
        target,
        key(
          { key: "~", code: "Backquote", ctrlKey: true, shiftKey: true },
          inner,
        ),
      ),
    ).toBe("ran");
    expect(target.actions.createTerminal).toHaveBeenCalledWith(false);
    screenElement.remove();
  });

  it("routes Rename Symbol F2 only in Monaco and allows the menu invocation", () => {
    const editor = document.createElement("div");
    editor.className = "monaco-host";
    const input = document.createElement("textarea");
    editor.append(input);
    const terminalList = document.createElement("button");
    terminalList.className = "terminal-session";
    const target = context({ canRenameSymbol: true });
    expect(describeCommands(target.state).renameSymbol.hint).toBe("F2");
    const terminalKey = key({ key: "F2" }, terminalList);
    expect(handleShortcut(target, terminalKey)).toBe("ignored");
    expect(terminalKey.defaultPrevented).toBe(false);
    expect(handleShortcut(target, key({ key: "F2" }, input))).toBe("ran");
    expect(dispatch(target, "renameSymbol", { source: "menu" })).toBe("ran");
    expect(target.actions.renameSymbol).toHaveBeenCalledTimes(2);
  });

  it("leaves F5 to the browser preview and reserves it natively", () => {
    const preview = context({ native: false });
    const reload = key({ key: "F5" });
    expect(handleShortcut(preview, reload)).toBe("ignored");
    expect(reload.defaultPrevented).toBe(false);

    const blocked = context({ runBlocked: true });
    const swallowed = key({ key: "F5" });
    expect(handleShortcut(blocked, swallowed)).toBe("claimed");
    expect(swallowed.defaultPrevented).toBe(true);
    expect(blocked.actions.startRun).not.toHaveBeenCalled();
    expect(dispatch(blocked, "run", { source: "menu" })).toBe("ignored");

    const ready = context();
    expect(handleShortcut(ready, key({ key: "F5" }))).toBe("ran");
    expect(ready.actions.startRun).toHaveBeenCalledOnce();
  });

  it("ignores shortcuts while a workbench modal is open", () => {
    const modal = context({ modalOpen: true });
    const event = key(save);
    expect(handleShortcut(modal, event)).toBe("ignored");
    expect(event.defaultPrevented).toBe(false);
    expect(dispatch(modal, "save", { source: "menu" })).toBe("ran");
  });

  it("shows the same enabled state in the menu and the palette", async () => {
    const commands = describeCommands(
      state({ native: false, hasWorkspace: false }),
    );
    const run = vi.fn();
    render(<MenuBar commands={commands} onRun={run} />);
    await userEvent
      .setup()
      .click(screen.getByRole("menuitem", { name: "File" }));
    const entries = paletteEntries(commands);
    for (const id of ["newWindow", "newText", "newWorkspace"] as const) {
      const item = screen.getByRole("menuitem", { name: commands[id].label });
      const row = entries.find((entry) => entry.id === id);
      expect(item.getAttribute("aria-disabled") === "true").toBe(
        !commands[id].enabled,
      );
      expect(row?.disabled).toBe(!commands[id].enabled);
    }
    cleanup();
    render(
      <CommandPalette actions={entries} dismiss={vi.fn()} run={vi.fn()} />,
    );
    const options = screen
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toContain("New Text File");
    expect(options).not.toContain("New Window");
    expect(options).not.toContain("New Workspace File");
  });
});
