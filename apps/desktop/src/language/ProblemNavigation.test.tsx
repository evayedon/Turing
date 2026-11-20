// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expectAccessible } from "../test/axe";
import userEvent from "@testing-library/user-event";
import { useEffect, useEffectEvent } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ExecutionUpdate } from "@turing/contracts";
import type { EditorCommands } from "../shell/commands";
import type { EditorLocation, EditorTab } from "../editor/use-editor";
import { stampOf, type DiagnosticBatch } from "./diagnostic-store";
import { Workbench } from "../shell/Workbench";
import { useLayout } from "../state/layout";

const ipc = vi.hoisted(() => vi.fn());
const editor = vi.hoisted(() => ({
  cursor: { line: 1, column: 1 },
  reveals: [] as { line: number; column: number }[],
  markerProblems: [] as DiagnosticBatch["problems"],
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: ipc,
  Channel: function () {},
}));

// The workspace watcher polls in the background; hold it out of IPC sequences.
vi.mock("../explorer/watch-ipc", () => ({
  pollWorkspaceChanges: vi.fn(() => new Promise(() => {})),
}));
// Stands in for Monaco: records reveals and moves its cursor like Monaco.
vi.mock("../editor/MonacoHost", () => ({
  default: function MonacoHost({
    active,
    reveal,
    onCommandsReady,
    onMonacoDiagnostics,
  }: {
    active: EditorTab;
    reveal?: EditorLocation & { key: string };
    onCommandsReady?: (commands: EditorCommands | undefined) => void;
    onMonacoDiagnostics?: (batches: DiagnosticBatch[]) => void;
  }) {
    useEffect(() => {
      onCommandsReady?.({
        supports: () => false,
        run: () => {},
        reveal: () => {},
        position: () => ({ ...editor.cursor }),
      });
      return () => onCommandsReady?.(undefined);
    }, [onCommandsReady]);
    const publish = useEffectEvent(() => {
      if (editor.markerProblems.length)
        onMonacoDiagnostics?.([
          {
            producer: "monaco",
            stamp: stampOf(active),
            problems: editor.markerProblems,
          },
        ]);
    });
    useEffect(() => {
      publish();
    }, []);
    useEffect(() => {
      if (!reveal) return;
      editor.cursor = { line: reveal.line, column: reveal.column };
      editor.reveals.push({ line: reveal.line, column: reveal.column });
    }, [reveal]);
    return <textarea aria-label="Source text" value={active.draft} readOnly />;
  },
}));

afterEach(() => {
  cleanup();
  ipc.mockReset();
  editor.cursor = { line: 1, column: 1 };
  editor.reveals = [];
  editor.markerProblems = [];
  useLayout.setState(useLayout.getInitialState(), true);
});

// Before `x`: "int " (4 bytes) + é (2 bytes, 1 UTF-16 unit) + " = " (3),
// so the compiler's byte column 10 is editor column 4 + 1 + 3 + 1 = 9.
const content = "int é = x + y;";
const stderr = [
  "/tmp/turing-run-1/main.cpp:1:1: error: first problem",
  "/tmp/turing-run-1/main.cpp:1:10: error: second problem",
].join("\n");

const failedBuild: ExecutionUpdate = {
  phase: "failed",
  cancelled: false,
  elapsedMs: 5,
  exitCode: 1,
  truncated: false,
  error: null,
  output: [
    {
      stream: "buildStderr",
      bytes: Array.from(new TextEncoder().encode(stderr)),
    },
  ],
};

async function openDocument(filename = "main.cpp") {
  ipc.mockImplementation((command: string) => {
    if (command === "workspace_open")
      return Promise.resolve({ id: "w", name: "fixture" });
    if (command === "fs_list_directory")
      return Promise.resolve([
        { name: filename, relativePath: filename, kind: "file" },
      ]);
    if (command === "fs_read_file")
      return Promise.resolve({
        workspaceId: "w",
        relativePath: filename,
        content,
        encoding: "utf-8",
        version: "v1",
      });
    if (command === "execution_start")
      return Promise.resolve({ id: "run", name: "main.cpp", language: "cpp" });
    if (command === "execution_read") return Promise.resolve(failedBuild);
    return Promise.resolve();
  });
  const user = userEvent.setup();
  render(<Workbench />);
  const explorer = screen.getByRole("region", { name: "Explorer" });
  await user.click(
    within(explorer).getByRole("button", { name: "Open folder" }),
  );
  await user.click(
    await within(explorer).findByRole("button", { name: filename }),
  );
  return screen.findByRole("textbox", { name: "Source text" });
}

it("moves between problems with F8 and Shift+F8 and announces each one", async () => {
  const input = await openDocument();

  // Nothing to visit before the build has failed.
  fireEvent.keyDown(input, { key: "F8" });
  expect(editor.reveals).toEqual([]);

  fireEvent.keyDown(input, { key: "F5" });
  // Output shows the raw build log once the failed run has been read.
  await screen.findAllByText(/second problem/);
  await expectAccessible(document.body);
  screen.getByRole("tab", { name: "Output" }).focus();
  await userEvent.setup().keyboard("{ArrowLeft}");
  expect(screen.getByRole("tab", { name: "Problems", selected: true })).toBe(
    document.activeElement,
  );
  await expectAccessible(document.body);
  const announcer = screen.getByRole("status", { name: "Problem navigation" });

  fireEvent.keyDown(input, { key: "F8" });
  await waitFor(() => expect(editor.reveals).toEqual([{ line: 1, column: 1 }]));
  expect(announcer.textContent).toBe(
    "Error 1 of 2: first problem (main.cpp:1:1)",
  );

  fireEvent.keyDown(input, { key: "F8" });
  await waitFor(() => expect(editor.reveals).toHaveLength(2));
  expect(editor.reveals[1]).toEqual({ line: 1, column: 9 });
  expect(announcer.textContent).toBe(
    "Error 2 of 2: second problem (main.cpp:1:9)",
  );

  fireEvent.keyDown(input, { key: "F8", shiftKey: true });
  await waitFor(() => expect(editor.reveals).toHaveLength(3));
  expect(editor.reveals[2]).toEqual({ line: 1, column: 1 });
});

it("shows Monaco markers in Problems and enables both Go commands without a compiler run", async () => {
  editor.markerProblems = [
    {
      severity: "error",
      message: "Type mismatch",
      start: { line: 2, character: 3 },
      end: { line: 2, character: 4 },
    },
  ];
  const input = await openDocument("main.ts");
  const user = userEvent.setup();
  await user.click(screen.getByRole("menuitem", { name: "Go" }));
  for (const name of ["Next Problem", "Previous Problem"]) {
    const command = screen.getByRole("menuitem", { name });
    expect(command.hasAttribute("aria-disabled")).toBe(false);
  }
  await user.keyboard("{Escape}");
  fireEvent.keyDown(input, { key: "F8", shiftKey: true });
  await waitFor(() => expect(editor.reveals).toEqual([{ line: 3, column: 4 }]));
  expect(
    screen.getByRole("status", { name: "Problem navigation" }).textContent,
  ).toBe("Error 1 of 1: Type mismatch (main.ts:3:4)");
  await user.click(screen.getByRole("menuitem", { name: "View" }));
  await user.click(screen.getByRole("menuitem", { name: "Dock Panels" }));
  await user.click(screen.getByRole("menuitem", { name: "Show Problems" }));
  expect(
    (await screen.findByRole("button", { name: /Type mismatch/ })).textContent,
  ).toContain("Monaco");
  expect(ipc).not.toHaveBeenCalledWith("execution_start", expect.anything());
});
