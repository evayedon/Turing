// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import MonacoHost from "./MonacoHost";
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
  };
});

vi.mock("monaco-editor", () => ({
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
  Uri: { from: vi.fn(() => ({})) },
  editor: {
    defineTheme: vi.fn(),
    create: () => ({
      onDidChangeModelContent: () => ({ dispose() {} }),
      onDidChangeCursorPosition: () => ({ dispose() {} }),
      getPosition: () => ({ lineNumber: 8, column: 4 }),
      getModel: mocks.getModel,
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
  const view = (active: EditorTab) => (
    <MonacoHost
      active={active}
      tabs={[active]}
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
  const view = (show: boolean) => (
    <MonacoHost
      active={tab}
      tabs={[tab]}
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
