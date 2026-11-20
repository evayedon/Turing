// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditorCommands } from "../shell/commands";
import type { LanguageController } from "../language/use-language";
import { attachLanguage } from "../language/monaco-language";
import MonacoHost from "./MonacoHost";
import type { TextModels } from "./MonacoHost";
import { created, resetFakeMonaco } from "./fake-monaco";
import { ModelRegistry } from "./model-registry";
import type { EditorReveal, EditorTab } from "./use-editor";

vi.mock("monaco-editor", () => import("./fake-monaco"));
vi.mock("../language/monaco-language", () => ({
  attachLanguage: vi.fn(() => () => {}),
}));

beforeEach(resetFakeMonaco);
afterEach(cleanup);

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
