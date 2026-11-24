// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import MonacoHost from "./MonacoHost";
import type { TextModels } from "./MonacoHost";
import { ModelRegistry } from "./model-registry";
import type { EditorTab } from "./use-editor";

const mocks = vi.hoisted(() => {
  let active: unknown;
  return {
    setLanguage: vi.fn(),
    setMarkers: vi.fn(),
    trigger: vi.fn(),
    find: vi.fn(),
    definition: vi.fn(),
    createModel: vi.fn(),
    setModel: vi.fn((model: unknown) => {
      active = model;
    }),
    getModel: vi.fn(() => active),
    selection: undefined as unknown,
    addAction: vi.fn<(action: unknown) => { dispose(): void }>(() => ({
      dispose() {},
    })),
    contextKey: { set: vi.fn() },
  };
});

vi.mock("monaco-editor", () => ({
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
  Uri: { from: vi.fn(() => ({})) },
  editor: {
    defineTheme: vi.fn(),
    create: () => ({
      onDidChangeCursorPosition: () => ({ dispose() {} }),
      getPosition: () => ({ lineNumber: 8, column: 4 }),
      getModel: mocks.getModel,
      getSelection: () => mocks.selection,
      addAction: mocks.addAction,
      createContextKey: () => mocks.contextKey,
      getAction: (id: string) => {
        if (id === "actions.find")
          return { isSupported: () => true, run: mocks.find };
        if (id === "editor.action.revealDefinition")
          return { isSupported: () => true, run: mocks.definition };
        if (id === "editor.action.revealDeclaration")
          return { isSupported: () => false, run: vi.fn() };
      },
      trigger: mocks.trigger,
      setModel: mocks.setModel,
      updateOptions: vi.fn(),
      focus: vi.fn(),
      dispose() {},
    }),
    createModel: mocks.createModel,
    setModelLanguage: mocks.setLanguage,
    setModelMarkers: mocks.setMarkers,
  },
}));

it("changes language on the same model after a rename and a manual selection", () => {
  let language = "plaintext";
  const model = {
    onDidChangeContent: () => ({ dispose() {} }),
    getLanguageId: () => language,
    getValue: () => "my draft",
    getEOL: () => "\n",
    setValue: vi.fn(),
    dispose: vi.fn(),
  };
  mocks.createModel.mockReturnValue(model);
  mocks.setLanguage.mockImplementation((_, next: string) => {
    language = next;
  });
  const report = vi.fn();
  const ready = vi.fn();
  const tab: EditorTab = {
    key: "doc",
    uri: "turing-workspace://workspace/main.txt",
    revision: 1,
    name: "main.txt",
    title: "main.txt",
    source: {
      kind: "workspace",
      workspaceId: "workspace",
      relativePath: "main.txt",
      version: "v1",
    },
    content: "",
    draft: "my draft",
    changedOnDisk: false,
  };
  const models: TextModels = new ModelRegistry();
  const view = (active: EditorTab) => (
    <MonacoHost
      active={active}
      tabs={[active]}
      models={models}
      group="1"
      readOnly={false}
      onInfo={report}
      onCommandsReady={ready}
      onChange={vi.fn()}
    />
  );
  const { rerender } = render(view(tab));
  const commands = ready.mock.calls[0][0];
  expect(commands.supports("find")).toBe(true);
  commands.run("find");
  commands.run("selectLine");
  expect(commands.supports("definition")).toBe(true);
  expect(commands.supports("declaration")).toBe(false);
  commands.run("definition");
  expect(mocks.definition).toHaveBeenCalledOnce();
  expect(mocks.find).toHaveBeenCalledOnce();
  expect(mocks.trigger).toHaveBeenCalledWith(
    "workbench",
    "expandLineSelection",
    null,
  );
  const renamed: EditorTab = { ...tab, name: "main.py", title: "main.py" };
  rerender(view(renamed));
  expect(mocks.setLanguage).toHaveBeenLastCalledWith(model, "python");
  rerender(view({ ...renamed, languageOverride: "markdown" }));
  expect(mocks.setLanguage).toHaveBeenLastCalledWith(model, "markdown");
  expect(mocks.createModel).toHaveBeenCalledOnce();
  expect(mocks.setModel).toHaveBeenCalledOnce();
  expect(model.setValue).not.toHaveBeenCalled();
  expect(model.dispose).not.toHaveBeenCalled();
  expect(report).toHaveBeenLastCalledWith(
    expect.objectContaining({ language: "Markdown", line: 8, column: 4 }),
  );
});

it("updates and clears clangd and compiler markers independently", () => {
  const model = {
    onDidChangeContent: () => ({ dispose() {} }),
    getLanguageId: () => "cpp",
    getValue: () => "int x;",
    getEOL: () => "\n",
    dispose: vi.fn(),
    canUndo: () => false,
  };
  mocks.createModel.mockReturnValue(model);
  const tab: EditorTab = {
    key: "cpp",
    uri: "untitled:main.cpp",
    revision: 1,
    name: "main.cpp",
    title: "main.cpp",
    source: { kind: "untitled" },
    content: "int x;",
    draft: "int x;",
    changedOnDisk: false,
  };
  const models: TextModels = new ModelRegistry();
  const view = (show: boolean) => (
    <MonacoHost
      active={tab}
      tabs={[tab]}
      models={models}
      group="1"
      readOnly={false}
      onInfo={vi.fn()}
      onChange={vi.fn()}
      problems={
        show
          ? [
              {
                id: "clangd:cpp:0",
                tabKey: "cpp",
                filename: "main.cpp",
                source: "clangd",
                severity: "error",
                message: "error",
                start: { line: 0, character: 1 },
                end: { line: 0, character: 2 },
              },
            ]
          : []
      }
    />
  );
  const { rerender } = render(view(true));
  expect(mocks.setMarkers).toHaveBeenCalledWith(model, "clangd", [
    expect.objectContaining({ startColumn: 2, severity: 8 }),
  ]);
  expect(mocks.setMarkers).toHaveBeenCalledWith(model, "compiler", []);
  rerender(view(false));
  expect(mocks.setMarkers).toHaveBeenCalledWith(model, "clangd", []);
});

it("reports selected lines and offers the Ask context-menu action for saved files", () => {
  mocks.addAction.mockClear();
  mocks.createModel.mockReturnValue({
    onDidChangeContent: () => ({ dispose() {} }),
    getLanguageId: () => "rust",
    getValue: () => "",
    getEOL: () => "\n",
    setValue: vi.fn(),
    dispose: vi.fn(),
  });
  // Lines 3–5 fully selected: the selection ends at column 1 of line 6.
  mocks.selection = {
    startLineNumber: 3,
    endLineNumber: 6,
    endColumn: 1,
    isEmpty: () => false,
  };
  const report = vi.fn();
  const ask = vi.fn();
  const tab: EditorTab = {
    key: "doc",
    uri: "turing-workspace://workspace/a.rs",
    revision: 1,
    name: "a.rs",
    title: "a.rs",
    source: {
      kind: "workspace",
      workspaceId: "workspace",
      relativePath: "a.rs",
      version: "v1",
    },
    content: "",
    draft: "",
    changedOnDisk: false,
  };
  const view = (canAsk: boolean) => (
    <MonacoHost
      active={tab}
      tabs={[tab]}
      models={new ModelRegistry()}
      group="1"
      readOnly={false}
      onInfo={report}
      onChange={vi.fn()}
      canAskSelection={canAsk}
      onAskSelection={ask}
    />
  );
  const { rerender } = render(view(true));
  expect(report).toHaveBeenLastCalledWith(
    expect.objectContaining({ selection: { startLine: 3, endLine: 5 } }),
  );
  expect(mocks.contextKey.set).toHaveBeenLastCalledWith(true);
  const action = mocks.addAction.mock.calls
    .map(([descriptor]) => descriptor as { id: string; run: () => void })
    .find(({ id }) => id === "turing.askSelection");
  expect(action).toMatchObject({
    label: "Ask Turing AI About Selection",
    precondition: "editorHasSelection && turingCanAskSelection",
    contextMenuGroupId: "1_turing",
  });
  action?.run();
  expect(ask).toHaveBeenCalledOnce();
  rerender(view(false));
  expect(mocks.contextKey.set).toHaveBeenLastCalledWith(false);
  mocks.selection = undefined;
});
