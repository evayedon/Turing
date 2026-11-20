export type Shortcut = {
  key: string;
  code?: string;
  primary?: boolean;
  ctrl?: boolean;
  shift?: boolean;
};

export const monacoActions = {
  undo: "undo",
  redo: "redo",
  cut: "editor.action.clipboardCutAction",
  copy: "editor.action.clipboardCopyAction",
  paste: "editor.action.clipboardPasteAction",
  selectAll: "editor.action.selectAll",
  find: "actions.find",
  replace: "editor.action.startFindReplaceAction",
  comment: "editor.action.commentLine",
  selectLine: "expandLineSelection",
  duplicateLine: "editor.action.copyLinesDownAction",
  moveUp: "editor.action.moveLinesUpAction",
  moveDown: "editor.action.moveLinesDownAction",
  cursorAbove: "editor.action.insertCursorAbove",
  cursorBelow: "editor.action.insertCursorBelow",
  symbol: "editor.action.quickOutline",
  definition: "editor.action.revealDefinition",
  declaration: "editor.action.revealDeclaration",
  implementation: "editor.action.goToImplementation",
  references: "editor.action.goToReferences",
} as const;

export type MonacoCommand = keyof typeof monacoActions;

export type EditorCommands = {
  supports: (id: MonacoCommand) => boolean;
  run: (id: MonacoCommand) => void;
  reveal: (line: number, column: number) => void;
  /** The cursor as a 1-based Monaco line and UTF-16 column. */
  position: () => { line: number; column: number } | undefined;
};

export type CommandId =
  | MonacoCommand
  | "newWindow"
  | "openRecent"
  | "clearRecent"
  | "newTerminal"
  | "splitTerminal"
  | "terminalWindow"
  | "newText"
  | "newWorkspace"
  | "openFile"
  | "openFolder"
  | "save"
  | "saveAs"
  | "autoSave"
  | "rename"
  | "closeEditor"
  | "closeAll"
  | "explorer"
  | "search"
  | "sidebar"
  | "dock"
  | "showTerminal"
  | "output"
  | "problems"
  | "palette"
  | "settings"
  | "sourceControl"
  | "assistant"
  | "goFile"
  | "goLine"
  | "workspaceSymbol"
  | "nextProblem"
  | "previousProblem"
  | "run"
  | "stop"
  | "openTerminal"
  | "closeTerminal"
  | "clearTerminal"
  | "hideTerminal"
  | "shortcuts"
  | "about";

export const editorCommands: Record<
  MonacoCommand,
  { label: string; edit?: boolean; hint?: (modifier: string) => string }
> = {
  undo: { label: "Undo", edit: true, hint: (mod) => `${mod}+Z` },
  redo: {
    label: "Redo",
    edit: true,
    hint: (mod) => (mod === "⌘" ? "⌘+Shift+Z" : "Ctrl+Y"),
  },
  cut: { label: "Cut", edit: true, hint: (mod) => `${mod}+X` },
  copy: { label: "Copy", hint: (mod) => `${mod}+C` },
  paste: { label: "Paste", edit: true, hint: (mod) => `${mod}+V` },
  selectAll: { label: "Select All", hint: (mod) => `${mod}+A` },
  find: { label: "Find", hint: (mod) => `${mod}+F` },
  replace: { label: "Replace", edit: true },
  comment: {
    label: "Toggle Line Comment",
    edit: true,
    hint: (mod) => `${mod}+/`,
  },
  selectLine: { label: "Select Line", hint: (mod) => `${mod}+L` },
  duplicateLine: { label: "Duplicate Line", edit: true },
  moveUp: {
    label: "Move Line Up",
    edit: true,
    hint: (mod) => (mod === "⌘" ? "⌥+↑" : "Alt+↑"),
  },
  moveDown: {
    label: "Move Line Down",
    edit: true,
    hint: (mod) => (mod === "⌘" ? "⌥+↓" : "Alt+↓"),
  },
  cursorAbove: { label: "Add Cursor Above", edit: true },
  cursorBelow: { label: "Add Cursor Below", edit: true },
  symbol: { label: "Go to Symbol in File…" },
  definition: { label: "Go to Definition" },
  declaration: { label: "Go to Declaration" },
  implementation: { label: "Go to Implementation" },
  references: { label: "Go to References" },
};

export function shortcutLabel(shortcut: Shortcut, modifier: string) {
  return [
    shortcut.primary ? modifier : shortcut.ctrl ? "Ctrl" : "",
    shortcut.shift ? "Shift" : "",
    shortcut.key.toUpperCase(),
  ]
    .filter(Boolean)
    .join("+");
}

export function matchesShortcut(event: KeyboardEvent, shortcut: Shortcut) {
  return (
    !event.altKey &&
    (shortcut.code
      ? event.code === shortcut.code || event.key === shortcut.key
      : event.key.toLowerCase() === shortcut.key.toLowerCase()) &&
    event.shiftKey === !!shortcut.shift &&
    (shortcut.primary
      ? event.ctrlKey !== event.metaKey
      : !event.metaKey && event.ctrlKey === !!shortcut.ctrl)
  );
}

export type MenuRow = CommandId | "-" | { label: string; entries: CommandId[] };

export const menus: { label: string; entries: MenuRow[] }[] = [
  {
    label: "File",
    entries: [
      "newWindow",
      "newText",
      "newWorkspace",
      "-",
      "openFile",
      "openFolder",
      "openRecent",
      "-",
      "save",
      "saveAs",
      "autoSave",
      "-",
      "rename",
      "closeEditor",
      "closeAll",
    ],
  },
  {
    label: "Edit",
    entries: [
      "undo",
      "redo",
      "-",
      "cut",
      "copy",
      "paste",
      "selectAll",
      "-",
      "find",
      "replace",
      "comment",
    ],
  },
  {
    label: "Selection",
    entries: [
      "selectAll",
      "selectLine",
      "-",
      "duplicateLine",
      "moveUp",
      "moveDown",
      "-",
      "cursorAbove",
      "cursorBelow",
    ],
  },
  {
    label: "View",
    entries: [
      "explorer",
      "search",
      "sidebar",
      "dock",
      { label: "Dock Panels", entries: ["showTerminal", "output", "problems"] },
      "-",
      "palette",
      "settings",
    ],
  },
  {
    label: "Go",
    entries: [
      "goFile",
      "goLine",
      "symbol",
      "workspaceSymbol",
      "-",
      "nextProblem",
      "previousProblem",
      "-",
      "definition",
      "declaration",
      "implementation",
      "references",
    ],
  },
  { label: "Run", entries: ["run", "stop", "-", "output"] },
  {
    label: "Terminal",
    entries: [
      "newTerminal",
      "splitTerminal",
      "terminalWindow",
      "-",
      "openTerminal",
      "showTerminal",
      "-",
      "closeTerminal",
      "clearTerminal",
    ],
  },
  { label: "Help", entries: ["shortcuts", "about"] },
];

export const commandIds = [
  ...new Set<CommandId>([
    ...menus.flatMap(({ entries }) =>
      entries.flatMap((row) =>
        row === "-" ? [] : typeof row === "string" ? [row] : row.entries,
      ),
    ),
    "sourceControl",
    "assistant",
    "hideTerminal",
    "clearRecent",
  ]),
];
