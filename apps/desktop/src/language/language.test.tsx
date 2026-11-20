// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { LanguageAction, LanguageEvent } from "@turing/contracts";
import type { EditorTab } from "../editor/use-editor";
import { ProblemsPanel } from "./ProblemsPanel";
import { clangdProblems, compilerProblems } from "./problems";
import { currentProblems } from "./diagnostic-store";
import { useLanguage } from "./use-language";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

const source = {
  kind: "workspace" as const,
  workspaceId: "one",
  relativePath: "main.cpp",
  version: "a",
};
const tab: EditorTab = {
  key: "main",
  uri: "turing-workspace://one/main.cpp",
  revision: 1,
  name: "main.cpp",
  title: "main.cpp",
  source,
  content: "x",
  draft: "x",
  changedOnDisk: false,
};
const header: EditorTab = {
  ...tab,
  key: "header",
  name: "test.hpp",
  title: "test.hpp",
  source: { ...source, relativePath: "test.hpp" },
};
const diagnostic = {
  severity: 1,
  message: "Undeclared identifier",
  range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } },
};
const caps = {
  hover: true,
  completion: true,
  definition: true,
  prepareRename: false,
  rename: false,
};

let events: LanguageEvent[];
let actions: LanguageAction[];

beforeEach(() => {
  events = [];
  actions = [];
  bridge.invoke
    .mockReset()
    .mockImplementation(
      async (command: string, args: { action?: LanguageAction }) => {
        if (command === "language_start") return "session";
        if (command === "language_poll")
          return { capabilities: caps, events: events.splice(0) };
        if (command === "language_apply" && args.action)
          actions.push(args.action);
      },
    );
});

it("requires activation, syncs both tabs, clears stale problems, saves, renames, and revokes", async () => {
  const { result, rerender } = renderHook(
    ({ workspace, tabs }: { workspace: string; tabs: EditorTab[] }) =>
      useLanguage(workspace, true, tabs),
    { initialProps: { workspace: "one", tabs: [tab, header] } },
  );
  expect(bridge.invoke).not.toHaveBeenCalled();
  await act(() => result.current.start());
  await waitFor(() =>
    expect(actions).toEqual([
      { kind: "sync", path: "main.cpp", version: 1, text: "x", saved: false },
      { kind: "sync", path: "test.hpp", version: 2, text: "x", saved: false },
    ]),
  );
  events.push({
    kind: "diagnostics",
    path: "main.cpp",
    version: 1,
    diagnostics: [diagnostic],
  });
  const shown = (tabs: EditorTab[]) =>
    currentProblems(result.current.batches, tabs);
  await waitFor(() => expect(shown([tab, header])).toHaveLength(1));
  const edited = { ...tab, draft: "y", editRevision: 1 };
  rerender({ workspace: "one", tabs: [edited, header] });
  expect(shown([edited, header])).toEqual([]);
  await waitFor(() =>
    expect(actions).toContainEqual({
      kind: "sync",
      path: "main.cpp",
      version: 3,
      text: "y",
      saved: false,
    }),
  );
  events.push({
    kind: "diagnostics",
    path: "main.cpp",
    version: 1,
    diagnostics: [diagnostic],
  });
  const saved = {
    ...edited,
    content: "y",
    savedVersion: "b",
    source: { ...source, version: "b" },
  };
  rerender({ workspace: "one", tabs: [saved, header] });
  await waitFor(() =>
    expect(actions).toContainEqual({
      kind: "sync",
      path: "main.cpp",
      version: 4,
      text: "y",
      saved: true,
    }),
  );
  expect(shown([saved, header])).toEqual([]);
  const renamed = {
    ...saved,
    name: "next.cpp",
    title: "next.cpp",
    source: { ...saved.source, relativePath: "next.cpp" },
  };
  rerender({ workspace: "one", tabs: [renamed] });
  await waitFor(() =>
    expect(actions.slice(-3)).toEqual([
      { kind: "close", path: "main.cpp" },
      { kind: "close", path: "test.hpp" },
      { kind: "sync", path: "next.cpp", version: 5, text: "y", saved: false },
    ]),
  );
  rerender({ workspace: "two", tabs: [] });
  expect(result.current.status).toBe("idle");
  expect(result.current.capabilities).toBeNull();
  expect(bridge.invoke).toHaveBeenCalledWith("language_stop", {
    workspaceId: "one",
    sessionId: "session",
  });
});

it("cancels a submitted request, reports crashes, and requires explicit retry", async () => {
  const { result } = renderHook(() => useLanguage("one", true, [tab]));
  await act(() => result.current.start());
  await waitFor(() => expect(actions).toHaveLength(1));
  const signal = new AbortController();
  const pending = result.current.request(
    tab,
    "hover",
    { line: 0, character: 0 },
    signal.signal,
  );
  signal.abort();
  await expect(pending).resolves.toBeUndefined();
  await waitFor(() =>
    expect(actions.slice(-2)).toEqual([
      {
        kind: "request",
        feature: "hover",
        path: "main.cpp",
        version: 1,
        position: { line: 0, character: 0 },
        requestId: 3,
      },
      { kind: "cancel", requestId: 3 },
    ]),
  );
  bridge.invoke.mockRejectedValue("SERVER_EXITED");
  await waitFor(() => expect(result.current.status).toBe("failed"));
  expect(result.current.capabilities).toBeNull();
  expect(
    bridge.invoke.mock.calls.filter(
      ([command]) => command === "language_start",
    ),
  ).toHaveLength(1);
  bridge.invoke.mockRejectedValue("UNAVAILABLE");
  await act(() => result.current.start());
  expect(result.current.message).toMatch(/clangd was not found/);
});

it("groups severities, keeps compiler identity separate, and opens a keyboard-selected location", () => {
  const live = clangdProblems([diagnostic], tab);
  const build = compilerProblems(
    {
      document: { key: tab.key, version: "a" },
      name: tab.title,
      language: "cpp",
      phase: "failed",
      elapsedMs: 0,
      exitCode: 1,
      cancelled: false,
      truncated: false,
      output: [
        {
          stream: "buildStderr",
          text: "/tmp/turing-run-123/main.cpp:3:2: warning: Compiler warning",
        },
      ],
    },
    [tab],
  );
  const open = vi.fn();
  const problems = [...live, ...build];
  const { rerender } = render(
    <ProblemsPanel problems={problems} filter="all" open={open} />,
  );
  expect(screen.getByRole("region", { name: "Errors" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Warnings" })).toBeTruthy();
  const first = screen.getByRole("button", { name: /Undeclared/ });
  const second = screen.getByRole("button", { name: /Compiler warning/ });
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(document.activeElement).toBe(second);
  fireEvent.click(second);
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({
      source: "compiler",
      start: { line: 2, character: 1 },
    }),
  );
  rerender(<ProblemsPanel problems={problems} filter="warning" open={open} />);
  expect(screen.queryByRole("button", { name: /Undeclared/ })).toBeNull();
});

it("waits for the current draft before requesting a completion", async () => {
  const { result, rerender } = renderHook(
    ({ document }: { document: EditorTab }) =>
      useLanguage("one", true, [document]),
    { initialProps: { document: tab } },
  );
  await act(() => result.current.start());
  await waitFor(() => expect(actions).toHaveLength(1));
  const edited = { ...tab, draft: "xy", editRevision: 1 };
  rerender({ document: edited });
  const pending = result.current.request(
    edited,
    "completion",
    { line: 0, character: 2 },
    new AbortController().signal,
  );
  await waitFor(() => {
    expect(actions.slice(-2)).toEqual([
      { kind: "sync", path: "main.cpp", version: 2, text: "xy", saved: false },
      {
        kind: "request",
        path: "main.cpp",
        version: 2,
        feature: "completion",
        position: { line: 0, character: 2 },
        requestId: 3,
      },
    ]);
  });
  events.push({ kind: "response", requestId: 3, value: { items: [] } });
  await expect(pending).resolves.toEqual({ items: [] });
});
