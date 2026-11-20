// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditorCommands } from "../shell/commands";
import {
  currentProblems,
  stampOf,
  type DiagnosticBatch,
} from "../language/diagnostic-store";
import { MONACO_MARKER_INTERVAL_MS } from "../language/monaco-markers";
import { adjacentProblem } from "../language/problem-navigation";
import type { LanguageController } from "../language/use-language";
import { attachLanguage } from "../language/monaco-language";
import MonacoHost from "./MonacoHost";
import type { TextModels } from "./MonacoHost";
import { applyModelEdit } from "./apply-model-edit";
import {
  created,
  editor,
  MarkerSeverity,
  providers,
  resetFakeMonaco,
} from "./fake-monaco";
import { LARGE_DOCUMENT_LENGTH } from "./performance-budget";
import { ModelRegistry } from "./model-registry";
import type { EditorReveal, EditorTab } from "./use-editor";

vi.mock("monaco-editor/languages/definitions/typescript/typescript.js", () => ({
  conf: {},
  language: {},
}));
vi.mock("monaco-editor", () => import("./fake-monaco"));
vi.mock("../language/monaco-language", () => ({
  attachLanguage: vi.fn(() => () => {}),
}));

beforeEach(() => {
  resetFakeMonaco();
  vi.mocked(attachLanguage).mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const tab: EditorTab = {
  key: "doc",
  uri: "turing-workspace://project/main.cpp",
  revision: 1,
  name: "main.cpp",
  title: "main.cpp",
  source: {
    kind: "workspace",
    workspaceId: "project",
    relativePath: "main.cpp",
    version: "v1",
  },
  content: "int main() {}",
  draft: "int main() {}",
  changedOnDisk: false,
};

const language: LanguageController = {
  status: "ready",
  message: undefined,
  capabilities: {
    hover: true,
    completion: true,
    definition: true,
    prepareRename: false,
    rename: false,
  },
  batches: [],
  start: async () => {},
  stop: () => {},
  request: async () => undefined,
  rename: async () => ({ value: undefined, documents: new Map() }),
};

it("gives two groups one model while reveal, info and commands follow the active group", () => {
  const models: TextModels = new ModelRegistry();
  const change = vi.fn();
  const info = vi.fn();
  const ready = vi.fn<(commands: EditorCommands | undefined) => void>();
  const groups = (reveal?: EditorReveal, showSecond = true) => (
    <>
      {["1", "2"].map(
        (group) =>
          (group === "1" || showSecond) && (
            <MonacoHost
              key={group}
              models={models}
              group={group}
              primary={group === "1"}
              focused={group === "2"}
              active={tab}
              tabs={[tab]}
              reveal={reveal}
              readOnly={false}
              onChange={change}
              onInfo={info}
              onCommandsReady={ready}
              workspaceId="project"
              language={language}
            />
          ),
      )}
    </>
  );
  const { rerender } = render(groups());
  const [left, right] = created.editors;
  expect(created.models).toHaveLength(1);
  expect(left.getModel()).toBe(right.getModel());

  // Language providers are global: only the primary view registers them,
  // and they treat a model shown by any view as active.
  expect(attachLanguage).toHaveBeenCalledOnce();
  const isShown = vi.mocked(attachLanguage).mock.calls[0][5];
  const model = models.get("doc");
  expect(model && isShown(model)).toBe(true);

  // Both views hear an edit to the shared model; it is reported once.
  act(() => created.models[0].type("int main() { return 0; }"));
  expect(change).toHaveBeenCalledOnce();
  expect(change).toHaveBeenCalledWith(tab, "int main() { return 0; }");

  rerender(groups({ key: "doc", group: "2", line: 4, column: 2 }));
  expect(right.getPosition()).toEqual({ lineNumber: 4, column: 2 });
  expect(left.getPosition()).toEqual({ lineNumber: 1, column: 1 });

  act(() => left.setPosition({ lineNumber: 9, column: 1 }));
  expect(info).not.toHaveBeenCalledWith(expect.objectContaining({ line: 9 }));
  const commands = ready.mock.calls.at(-1)?.[0];
  expect(commands?.position()).toEqual({ line: 4, column: 2 });
  expect(ready.mock.calls.every(([value]) => value !== undefined)).toBe(true);

  // Unmounting a view leaves the shared model to the registry.
  rerender(groups(undefined, false));
  expect(right.disposed).toBe(true);
  expect(created.models[0].disposed).toBe(false);
  expect(models.retain(new Set())).toEqual(["doc"]);
  expect(created.models[0].disposed).toBe(true);
});

it("applies large document keystrokes without reading or replacing the model text", () => {
  const models: TextModels = new ModelRegistry();
  const content = "x".repeat(LARGE_DOCUMENT_LENGTH);
  let active = { ...tab, draft: content, content };
  const onChange = vi.fn((_: EditorTab, draft: string) => {
    active = { ...active, draft };
  });
  const view = () => (
    <MonacoHost
      models={models}
      group="1"
      active={active}
      tabs={[active]}
      readOnly={false}
      onChange={onChange}
      onInfo={() => {}}
    />
  );
  const { rerender } = render(view());
  const [model] = created.models;
  const read = vi.spyOn(model, "getValue");
  const replace = vi.spyOn(model, "setValue");
  expect(model.getLanguageId()).toBe("plaintext");
  for (const char of "typing") {
    act(() => model.replace(1, 0, char));
    rerender(view());
  }
  expect(onChange).toHaveBeenCalledTimes(6);
  expect(active.draft).toBe("xgnipyt" + content.slice(1));
  expect(read).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

it("keeps a hidden open document's model and draft in sync through rename, undo and redo", () => {
  const models: TextModels = new ModelRegistry();
  const original = "int old; old++;";
  const renamed = "int renamed; renamed++;";
  let hidden: EditorTab = {
    ...tab,
    key: "hidden",
    source: { kind: "untitled" },
    content: original,
    draft: original,
  };
  const onChange = vi.fn((document: EditorTab, draft: string) => {
    expect(document.key).toBe(hidden.key);
    hidden = { ...hidden, draft };
  });
  const view = (active = tab) => (
    <MonacoHost
      models={models}
      group="1"
      active={active}
      tabs={[tab, hidden]}
      readOnly={false}
      onChange={onChange}
      onInfo={() => {}}
    />
  );
  const { rerender } = render(view());
  const model = created.models[1];
  expect(created.editors[0].getModel()).not.toBe(model);
  act(() => {
    expect(
      applyModelEdit(
        models,
        hidden,
        [4, 9].map((start) => ({
          start,
          end: start + 3,
          position: { line: 0, character: start },
          before: "old",
          after: "renamed",
        })),
        renamed,
      ),
    ).toBe(true);
    hidden = { ...hidden, draft: renamed };
  });
  rerender(view());
  expect(model.getValue()).toBe(renamed);
  expect(onChange).not.toHaveBeenCalled();

  act(() => model.undo());
  expect(model.getValue()).toBe(original);
  expect(hidden.draft).toBe(original);
  expect(model.canUndo()).toBe(false);
  rerender(view());

  act(() => model.redo());
  expect(model.getValue()).toBe(renamed);
  expect(hidden.draft).toBe(renamed);
  expect(onChange).toHaveBeenCalledTimes(2);
  rerender(view(hidden));
  expect(created.editors[0].input.value).toBe(renamed);
  expect(model.canUndo()).toBe(true);
});

it("switches only managed TypeScript workspace models and uses their negotiated Go commands", () => {
  const models: TextModels = new ModelRegistry();
  const active: EditorTab = {
    ...tab,
    name: "main.tsx",
    source: {
      ...tab.source,
      kind: "workspace",
      workspaceId: "project",
      relativePath: "main.tsx",
      version: "v1",
    },
  };
  const standalone: EditorTab = {
    ...active,
    key: "standalone",
    name: "standalone.ts",
    languageOverride: "typescript",
    source: { kind: "untitled" },
  };
  const ready = vi.fn<(commands: EditorCommands | undefined) => void>();
  const server = {
    ...language,
    capabilities: language.capabilities && {
      ...language.capabilities,
      references: true,
      declaration: false,
    },
    logs: [],
    rustBuildScripts: false,
    setRustBuildScripts: () => {},
  };
  const managed: LanguageController = {
    ...language,
    capabilities: null,
    servers: {
      clangd: { ...server, capabilities: null },
      typescript: server,
      pyright: { ...server, capabilities: null },
      "rust-analyzer": { ...server, capabilities: null },
    },
    forTab: () => server,
  };
  const view = (language?: LanguageController) => (
    <MonacoHost
      models={models}
      group="1"
      active={active}
      tabs={[active, standalone]}
      readOnly={false}
      onChange={() => {}}
      onInfo={() => {}}
      onCommandsReady={ready}
      workspaceId="project"
      language={language}
    />
  );
  const { rerender } = render(view());
  expect(created.models.map((model) => model.getLanguageId())).toEqual([
    "typescript",
    "typescript",
  ]);
  rerender(view(managed));
  expect(created.models.map((model) => model.getLanguageId())).toEqual([
    "turing-typescript",
    "typescript",
  ]);
  expect(vi.mocked(attachLanguage).mock.lastCall?.[6]).toBe("typescript");
  const commands = ready.mock.lastCall?.[0];
  expect(commands?.supports("references")).toBe(true);
  expect(commands?.supports("declaration")).toBe(false);
  rerender(view());
  expect(created.models.map((model) => model.getLanguageId())).toEqual([
    "typescript",
    "typescript",
  ]);
});

it("mounts separate fixed, themed widget hosts above both split panes and removes them with the views", () => {
  const models: TextModels = new ModelRegistry();
  const { container, unmount } = render(
    <main className="workbench">
      {["1", "2"].map((group) => (
        <section
          key={group}
          data-editor-group={group}
          style={{ overflow: "hidden" }}
        >
          <MonacoHost
            active={tab}
            tabs={[tab]}
            models={models}
            group={group}
            primary={group === "1"}
            focused={group === "1"}
            readOnly={false}
            onChange={vi.fn()}
            onInfo={vi.fn()}
          />
        </section>
      ))}
    </main>,
  );
  const workbench = container.querySelector(".workbench");
  const hosts = [...container.querySelectorAll(".monaco-overflow-host")];
  expect(hosts).toHaveLength(2);
  for (const [index, view] of created.editors.entries()) {
    expect(view.options).toMatchObject({
      fixedOverflowWidgets: true,
      overflowWidgetsDomNode: hosts[index],
      hover: { above: false },
    });
    expect(hosts[index].parentElement).toBe(workbench);
    expect(hosts[index].classList.contains("monaco-editor")).toBe(true);
  }
  unmount();
  expect(hosts.every((host) => !host.isConnected)).toBe(true);
});

it("uses the active model's provider preconditions for global navigation commands", () => {
  const models: TextModels = new ModelRegistry();
  const ready = vi.fn<(commands: EditorCommands | undefined) => void>();
  const view = (active: EditorTab, controller?: LanguageController) => (
    <MonacoHost
      active={active}
      tabs={[active]}
      models={models}
      group="1"
      workspaceId="project"
      language={controller}
      readOnly={false}
      onChange={vi.fn()}
      onInfo={vi.fn()}
      onCommandsReady={ready}
    />
  );
  const ts = { ...tab, name: "main.ts", languageOverride: "typescript" };
  const { rerender } = render(view(ts));
  const commands = () => ready.mock.lastCall?.[0];
  const available = () =>
    (
      ["definition", "declaration", "implementation", "references"] as const
    ).filter((id) => commands()?.supports(id));

  expect(available()).toEqual([]);
  providers.set(
    "typescript",
    new Set(["editorHasDefinitionProvider", "editorHasReferenceProvider"]),
  );
  expect(available()).toEqual(["definition", "references"]);
  commands()?.run("definition");
  commands()?.run("references");
  commands()?.run("implementation");
  expect(created.editors[0].triggered).toEqual([
    "editor.action.revealDefinition",
    "editor.action.goToReferences",
  ]);

  rerender(view({ ...ts, languageOverride: "plaintext" }));
  expect(available()).toEqual([]);
  rerender(view({ ...ts, languageOverride: "python" }));
  expect(available()).toEqual([]);
  providers.set("cpp", new Set(["editorHasDefinitionProvider"]));
  rerender(view(tab));
  expect(available()).toEqual([]);
  rerender(view(tab, language));
  expect(available()).toEqual(["definition"]);
  rerender(
    view({ ...tab, draft: "x".repeat(LARGE_DOCUMENT_LENGTH) }, language),
  );
  expect(available()).toEqual([]);
  rerender(view(tab, language));
  expect(available()).toEqual(["definition"]);
  rerender(view({ ...tab, source: { kind: "untitled" } }, language));
  expect(available()).toEqual([]);
});

function markerFixture() {
  vi.useFakeTimers();
  const models: TextModels = new ModelRegistry();
  const publish = vi.fn<(batches: DiagnosticBatch[]) => void>();
  const ts = { ...tab, name: "main.ts", languageOverride: "typescript" };
  const view = (active: EditorTab) => (
    <MonacoHost
      active={active}
      tabs={[active]}
      models={models}
      group="1"
      readOnly={false}
      onChange={vi.fn()}
      onInfo={vi.fn()}
      onMonacoDiagnostics={publish}
    />
  );
  const { rerender, unmount } = render(view(ts));
  const model = created.models[0];
  const error = {
    severity: MarkerSeverity.Error,
    message: "Type mismatch",
    startLineNumber: 2,
    startColumn: 3,
    endLineNumber: 2,
    endColumn: 4,
  };
  const advance = () => vi.advanceTimersByTime(MONACO_MARKER_INTERVAL_MS);
  const batches = () => publish.mock.lastCall?.[0] ?? [];
  return {
    ts,
    model,
    error,
    advance,
    batches,
    publish,
    unmount,
    update: (next: EditorTab) => rerender(view(next)),
  };
}

it("coalesces Monaco diagnostics, ignores native owners and includes the result in both navigation directions", () => {
  const { ts, model, error, advance, batches, publish } = markerFixture();
  const read = vi.spyOn(editor, "getModelMarkers");
  editor.setModelMarkers(model, "typescript", [error]);
  editor.setModelMarkers(model, "clangd", [
    { ...error, message: "clangd copy" },
  ]);
  editor.setModelMarkers(model, "compiler", [
    { ...error, message: "compiler copy" },
  ]);
  editor.setModelMarkers(model, "typescript", [
    error,
    {
      ...error,
      severity: MarkerSeverity.Warning,
      message: "Warning",
      startLineNumber: 1,
      endLineNumber: 1,
    },
    { ...error, severity: MarkerSeverity.Hint, message: "Hint" },
  ]);
  expect(read).not.toHaveBeenCalled();
  advance();
  expect(read).toHaveBeenCalledExactlyOnceWith({
    resource: model.uri,
    owner: "typescript",
    take: 200,
  });
  expect(publish).toHaveBeenCalledOnce();
  expect(batches()).toMatchObject([{ producer: "monaco", stamp: stampOf(ts) }]);
  const problems = currentProblems(batches(), [ts]);
  expect(problems.map(({ severity, source }) => [severity, source])).toEqual([
    ["warning", "monaco"],
    ["error", "monaco"],
    ["info", "monaco"],
  ]);
  expect(problems[1].start).toEqual({ line: 1, character: 2 });
  expect(adjacentProblem(problems, [ts.key], undefined, 1)).toEqual(
    problems[0],
  );
  expect(adjacentProblem(problems, [ts.key], undefined, -1)).toEqual(
    problems[2],
  );
  editor.setModelMarkers(model, "typescript", []);
  advance();
  expect(currentProblems(batches(), [ts])).toEqual([]);
});

it("drops queued stale markers, refuses to restamp old ones, and skips large documents", () => {
  const { ts, model, error, advance, batches, publish, update, unmount } =
    markerFixture();
  editor.setModelMarkers(model, "typescript", [error]);
  const edited = { ...ts, editRevision: 1, draft: ts.draft + " " };
  update(edited);
  advance();
  expect(publish).not.toHaveBeenCalled();
  editor.setModelMarkers(model, "clangd", [error]);
  advance();
  expect(currentProblems(batches(), [edited])).toEqual([]);

  editor.setModelMarkers(model, "typescript", [error]);
  advance();
  expect(currentProblems(batches(), [edited])).toHaveLength(1);
  for (const stale of [
    { ...edited, revision: 2 },
    { ...edited, uri: "untitled:renamed.ts" },
    { ...edited, languageOverride: "python" },
    { ...edited, changedOnDisk: true },
  ])
    expect(currentProblems(batches(), [stale])).toEqual([]);
  expect(currentProblems(batches(), [])).toEqual([]);

  const read = vi.spyOn(editor, "getModelMarkers");
  editor.setModelMarkers(model, "typescript", [error]);
  update({
    ...edited,
    editRevision: 2,
    draft: "x".repeat(LARGE_DOCUMENT_LENGTH),
  });
  advance();
  expect(read).not.toHaveBeenCalled();

  update(edited);
  editor.setModelMarkers(model, "typescript", [error]);
  unmount();
  advance();
  expect(read).not.toHaveBeenCalled();
});
