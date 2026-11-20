import type { SidebarView } from "@turing/contracts";
import type { DockView } from "../state/dock-views";
import {
  commandIds,
  editorCommands,
  matchesShortcut,
  shortcutLabel,
} from "./commands";
import type { CommandId, MonacoCommand, Shortcut } from "./commands";

/** Read-only workbench state that decides command labels and availability. */
export type CommandState = {
  /** Running in the Tauri host rather than the browser preview. */
  native: boolean;
  /** Platform modifier shown in shortcut hints ("⌘" or "Ctrl"). */
  modifier: string;
  /** A workbench popup or dialog is open, so shortcuts stay with it. */
  modalOpen: boolean;
  editorOpen: boolean;
  editorBusy: boolean;
  editorReady: boolean;
  editorSupports: (id: MonacoCommand) => boolean;
  readOnly: boolean;
  canSave: boolean;
  autoSave: boolean;
  tabCount: number;
  /** Side-by-side editor groups; there is always at least one. */
  groupCount: number;
  canMoveEditorToNextGroup: boolean;
  hasWorkspace: boolean;
  workspaceBusy: boolean;
  recentCount: number;
  sidebar: SidebarView | null;
  /** The Explorer selection has an identity that can be renamed. */
  renameTarget: boolean;
  bottomPanel: boolean;
  dockView: DockView;
  assistant: boolean;
  problemCount: number;
  executionBusy: boolean;
  executionStopping: boolean;
  /** The active editor cannot run, for example an unsupported language. */
  runBlocked: boolean;
  terminalRunning: boolean;
};

export type PopupKind =
  "commands" | "files" | "line" | "shortcuts" | "about" | "recent";

/** Workbench operations that command run functions compose. */
export type CommandActions = {
  openPopup: (kind: PopupKind) => void;
  openWindow: (kind: "window_new_workbench" | "window_new_terminal") => void;
  clearRecents: () => void;
  createTerminal: (split: boolean) => void;
  closeTerminal: () => void;
  clearTerminal: () => void;
  toggleTerminal: () => void;
  runEditorCommand: (id: MonacoCommand) => void;
  newFile: () => void;
  createWorkspaceFile: () => void;
  openFile: () => void;
  openFolder: () => void;
  save: () => void;
  saveAs: () => void;
  toggleAutoSave: () => void;
  renameSelection: () => void;
  closeActiveEditor: () => void;
  closeAllEditors: () => void;
  splitEditor: () => void;
  moveEditorToNextGroup: () => void;
  focusEditorGroup: (direction: 1 | -1) => void;
  closeEditorGroup: () => void;
  selectSidebar: (view: SidebarView) => void;
  toggleSidebar: () => void;
  toggleSourceControl: () => void;
  toggleBottomPanel: () => void;
  showDock: (view: DockView) => void;
  revealDock: (view: DockView) => void;
  openSettings: () => void;
  toggleAssistant: () => void;
  goToLine: () => void;
  goToProblem: (direction: 1 | -1) => void;
  startRun: () => void;
  stopRun: () => void;
};

export type CommandContext = { state: CommandState; actions: CommandActions };

/** How a shortcut behaves outside ordinary availability. */
export type KeyboardPolicy = {
  /** The shortcut still works while focus is inside a terminal. */
  inTerminal?: boolean;
  /** The browser preview leaves this key to the browser (F5 reloads). */
  nativeOnly?: boolean;
  /** Swallow the key even when the command is unavailable. */
  reserved?: boolean;
};

export type CommandDeclaration = {
  label: string | ((state: CommandState) => string);
  shortcut?: Shortcut;
  hint?: string | ((modifier: string) => string | undefined);
  keyboard?: KeyboardPolicy;
  enabled?: (state: CommandState) => boolean;
  visible?: (state: CommandState) => boolean;
  pressed?: (state: CommandState) => boolean;
  run: (actions: CommandActions) => void;
};

export type Invocation =
  | { source: "menu" | "palette" | "control" }
  | { source: "shortcut"; inTerminal: boolean };

export type DispatchResult = "ran" | "claimed" | "ignored";

/** What menus, the palette, and workbench controls render for a command. */
export type CommandView = {
  id: CommandId;
  label: string;
  enabled: boolean;
  visible: boolean;
  pressed?: boolean;
  shortcut?: Shortcut;
  hint?: string;
};

export type CommandViews = Record<CommandId, CommandView>;

const editorDeclarations = Object.fromEntries(
  (Object.keys(editorCommands) as MonacoCommand[]).map((id) => {
    const { label, edit, hint } = editorCommands[id];
    const declaration: CommandDeclaration = {
      label,
      hint,
      shortcut:
        id === "definition" || id === "references"
          ? { key: "F12", shift: id === "references" }
          : undefined,
      visible: (state) => id !== "symbol" || state.editorSupports(id),
      enabled: (state) =>
        state.editorOpen &&
        state.editorSupports(id) &&
        !(edit && state.readOnly),
      run: (actions) => actions.runEditorCommand(id),
    };
    return [id, declaration];
  }),
) as Record<MonacoCommand, CommandDeclaration>;

const native = (state: CommandState) => state.native;

/** Every workbench command, declared once. */
export const commandRegistry: Record<CommandId, CommandDeclaration> = {
  ...editorDeclarations,
  newWindow: {
    label: "New Window",
    enabled: native,
    shortcut: { key: "n", primary: true, shift: true },
    run: (actions) => actions.openWindow("window_new_workbench"),
  },
  openRecent: {
    label: "Open Recent…",
    enabled: (state) => state.native && !state.workspaceBusy,
    run: (actions) => actions.openPopup("recent"),
  },
  clearRecent: {
    label: "Clear Recent History",
    enabled: (state) => state.recentCount > 0,
    run: (actions) => actions.clearRecents(),
  },
  newTerminal: {
    label: "New Terminal",
    enabled: native,
    shortcut: { key: "`", code: "Backquote", ctrl: true, shift: true },
    keyboard: { inTerminal: true },
    run: (actions) => actions.createTerminal(false),
  },
  splitTerminal: {
    label: "Split Terminal",
    enabled: native,
    run: (actions) => actions.createTerminal(true),
  },
  terminalWindow: {
    label: "New Terminal Window",
    enabled: native,
    run: (actions) => actions.openWindow("window_new_terminal"),
  },
  newText: {
    label: "New Text File",
    enabled: (state) => !state.editorBusy,
    run: (actions) => actions.newFile(),
  },
  newWorkspace: {
    label: "New Workspace File",
    enabled: (state) => state.hasWorkspace && !state.workspaceBusy,
    run: (actions) => actions.createWorkspaceFile(),
  },
  openFile: {
    label: "Open File",
    enabled: (state) => state.native && !state.editorBusy,
    run: (actions) => actions.openFile(),
  },
  openFolder: {
    label: "Open Folder",
    enabled: (state) => state.native && !state.workspaceBusy,
    run: (actions) => actions.openFolder(),
  },
  save: {
    label: "Save",
    enabled: (state) => state.canSave && !state.editorBusy,
    shortcut: { key: "s", primary: true },
    run: (actions) => actions.save(),
  },
  saveAs: {
    label: "Save As",
    enabled: (state) => state.native && state.editorOpen && !state.editorBusy,
    shortcut: { key: "s", primary: true, shift: true },
    run: (actions) => actions.saveAs(),
  },
  autoSave: {
    label: "Auto Save",
    enabled: native,
    pressed: (state) => state.autoSave,
    run: (actions) => actions.toggleAutoSave(),
  },
  rename: {
    label: "Rename Explorer Item",
    enabled: (state) =>
      state.sidebar === "explorer" &&
      state.renameTarget &&
      !state.workspaceBusy,
    hint: "F2",
    run: (actions) => actions.renameSelection(),
  },
  closeEditor: {
    label: "Close Editor",
    enabled: (state) => state.editorOpen && !state.editorBusy,
    run: (actions) => actions.closeActiveEditor(),
  },
  closeAll: {
    label: "Close All Editors",
    enabled: (state) => state.tabCount > 0 && !state.editorBusy,
    run: (actions) => actions.closeAllEditors(),
  },
  splitEditor: {
    label: "Split Editor Right",
    shortcut: { key: "\\", primary: true },
    enabled: (state) => state.editorOpen && !state.editorBusy,
    run: (actions) => actions.splitEditor(),
  },
  moveEditorToNextGroup: {
    label: "Move Editor into Next Group",
    enabled: (state) =>
      state.editorOpen && !state.editorBusy && state.canMoveEditorToNextGroup,
    run: (actions) => actions.moveEditorToNextGroup(),
  },
  focusNextGroup: {
    label: "Focus Next Editor Group",
    shortcut: { key: "F6", ctrl: true },
    enabled: (state) => state.groupCount > 1,
    run: (actions) => actions.focusEditorGroup(1),
  },
  focusPreviousGroup: {
    label: "Focus Previous Editor Group",
    shortcut: { key: "F6", ctrl: true, shift: true },
    enabled: (state) => state.groupCount > 1,
    run: (actions) => actions.focusEditorGroup(-1),
  },
  closeGroup: {
    label: "Close Editor Group",
    enabled: (state) => state.groupCount > 1 && !state.editorBusy,
    run: (actions) => actions.closeEditorGroup(),
  },
  explorer: {
    label: "Show Explorer",
    run: (actions) => actions.selectSidebar("explorer"),
  },
  search: {
    label: "Show Search",
    run: (actions) => actions.selectSidebar("search"),
  },
  sidebar: {
    label: "Toggle Sidebar",
    run: (actions) => actions.toggleSidebar(),
  },
  dock: {
    label: (state) =>
      state.bottomPanel ? "Hide Bottom Panel" : "Show Bottom Panel",
    run: (actions) => actions.toggleBottomPanel(),
  },
  showTerminal: {
    label: "Show Terminal",
    run: (actions) => actions.showDock("Terminal"),
  },
  output: {
    label: "Show Output",
    run: (actions) => actions.showDock("Output"),
  },
  problems: {
    label: "Show Problems",
    run: (actions) => actions.showDock("Problems"),
  },
  palette: {
    label: "Command Palette",
    shortcut: { key: "p", primary: true, shift: true },
    keyboard: { inTerminal: true },
    run: (actions) => actions.openPopup("commands"),
  },
  settings: {
    label: "Open Settings",
    run: (actions) => actions.openSettings(),
  },
  sourceControl: {
    label: (state) =>
      state.sidebar === "git" ? "Hide Source Control" : "Show Source Control",
    run: (actions) => actions.toggleSourceControl(),
  },
  assistant: {
    label: (state) => (state.assistant ? "Hide Turing AI" : "Show Turing AI"),
    run: (actions) => actions.toggleAssistant(),
  },
  goFile: {
    label: "Go to File…",
    enabled: (state) =>
      !state.editorBusy && (state.native || state.tabCount > 0),
    shortcut: { key: "p", primary: true },
    run: (actions) => actions.openPopup("files"),
  },
  goLine: {
    label: "Go to Line/Column…",
    enabled: (state) => state.editorOpen && state.editorReady,
    run: (actions) => actions.goToLine(),
  },
  nextProblem: {
    label: "Next Problem",
    shortcut: { key: "F8" },
    enabled: (state) => state.problemCount > 0,
    run: (actions) => actions.goToProblem(1),
  },
  previousProblem: {
    label: "Previous Problem",
    shortcut: { key: "F8", shift: true },
    enabled: (state) => state.problemCount > 0,
    run: (actions) => actions.goToProblem(-1),
  },
  run: {
    label: "Run Without Debugging",
    shortcut: { key: "F5" },
    keyboard: { nativeOnly: true, reserved: true },
    enabled: (state) =>
      state.editorOpen &&
      !state.editorBusy &&
      !state.executionBusy &&
      !state.runBlocked,
    run: (actions) => actions.startRun(),
  },
  stop: {
    label: "Stop Execution",
    enabled: (state) => state.executionBusy && !state.executionStopping,
    run: (actions) => actions.stopRun(),
  },
  openTerminal: {
    label: "Open Terminal",
    enabled: native,
    shortcut: { key: "`", ctrl: true },
    keyboard: { inTerminal: true },
    run: (actions) => actions.revealDock("Terminal"),
  },
  closeTerminal: {
    label: "Close Terminal",
    enabled: (state) => state.terminalRunning,
    run: (actions) => actions.closeTerminal(),
  },
  clearTerminal: {
    label: "Clear Terminal",
    enabled: (state) => state.terminalRunning,
    run: (actions) => actions.clearTerminal(),
  },
  hideTerminal: {
    label: "Hide Terminal panel",
    enabled: (state) => state.bottomPanel && state.dockView === "Terminal",
    run: (actions) => actions.toggleTerminal(),
  },
  shortcuts: {
    label: "Keyboard Shortcuts",
    run: (actions) => actions.openPopup("shortcuts"),
  },
  about: {
    label: "About Turing",
    run: (actions) => actions.openPopup("about"),
  },
};

export type CommandRegistry = Record<CommandId, CommandDeclaration>;

function describe(
  id: CommandId,
  declaration: CommandDeclaration,
  state: CommandState,
): CommandView {
  const { label, shortcut, hint, enabled, visible, pressed } = declaration;
  return {
    id,
    label: typeof label === "function" ? label(state) : label,
    enabled: enabled?.(state) ?? true,
    visible: visible?.(state) ?? true,
    pressed: pressed?.(state),
    shortcut,
    hint: shortcut
      ? shortcutLabel(shortcut, state.modifier)
      : typeof hint === "function"
        ? hint(state.modifier)
        : hint,
  };
}

/** Resolves labels, hints, and availability for every surface at once. */
export function describeCommands(
  state: CommandState,
  registry: CommandRegistry = commandRegistry,
): CommandViews {
  return Object.fromEntries(
    commandIds.map((id) => [id, describe(id, registry[id], state)]),
  ) as CommandViews;
}

/** Palette rows, in menu order, sharing availability with the menus. */
export function paletteEntries(commands: CommandViews) {
  return commandIds.map((id) => {
    const { label, enabled, visible, hint } = commands[id];
    return { id, label, hint, disabled: !enabled, hidden: !visible };
  });
}

/**
 * The single availability rule set. Decides whether an invocation runs the
 * command, swallows a shortcut without running it, or leaves it alone.
 */
export function resolveInvocation(
  state: CommandState,
  id: CommandId,
  invocation: Invocation,
  registry: CommandRegistry = commandRegistry,
): DispatchResult {
  const declaration = registry[id];
  const available =
    (declaration.enabled?.(state) ?? true) &&
    (declaration.visible?.(state) ?? true);
  if (invocation.source !== "shortcut") return available ? "ran" : "ignored";
  const keyboard = declaration.keyboard ?? {};
  if (state.modalOpen) return "ignored";
  if (invocation.inTerminal && !keyboard.inTerminal) return "ignored";
  if (keyboard.nativeOnly && !state.native) return "ignored";
  if (available) return "ran";
  return keyboard.reserved ? "claimed" : "ignored";
}

/**
 * The one dispatch path for menus, the palette, workbench controls, and
 * keyboard shortcuts. Returns "claimed" when a shortcut is swallowed without
 * running its command.
 */
export function dispatch(
  context: CommandContext,
  id: CommandId,
  invocation: Invocation,
  registry: CommandRegistry = commandRegistry,
): DispatchResult {
  const result = resolveInvocation(context.state, id, invocation, registry);
  if (result === "ran") registry[id].run(context.actions);
  return result;
}

/** Finds the first command bound to a key event, in menu order. */
export function commandForShortcut(
  event: KeyboardEvent,
  registry: CommandRegistry = commandRegistry,
): CommandId | undefined {
  return commandIds.find((id) => {
    const shortcut = registry[id].shortcut;
    return shortcut && matchesShortcut(event, shortcut);
  });
}

/**
 * Routes a window keydown through {@link dispatch}. The key is consumed only
 * when dispatch runs or claims the command.
 */
export function handleShortcut(
  context: CommandContext,
  event: KeyboardEvent,
  registry: CommandRegistry = commandRegistry,
): DispatchResult {
  if (
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    document.querySelector("dialog[open]")
  )
    return "ignored";
  const id = commandForShortcut(event, registry);
  if (!id) return "ignored";
  const invocation: Invocation = {
    source: "shortcut",
    inTerminal:
      event.target instanceof Element &&
      !!event.target.closest(".terminal-screen"),
  };
  if (resolveInvocation(context.state, id, invocation, registry) === "ignored")
    return "ignored";
  event.preventDefault();
  event.stopPropagation();
  return dispatch(context, id, invocation, registry);
}
