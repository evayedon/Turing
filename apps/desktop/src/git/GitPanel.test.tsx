// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GitStatus } from "@turing/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitPanel } from "./GitPanel";
import { useGit } from "./use-git";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
const ipc = vi.mocked(invoke);

beforeEach(() => {
  ipc.mockReset();
});
afterEach(cleanup);

const dirty: GitStatus = {
  branch: "main",
  ahead: 1,
  behind: 0,
  entries: [
    { path: "src/app.ts", staged: true, state: "modified", originalPath: null },
    { path: "README.md", staged: false, state: "modified", originalPath: null },
    {
      path: "notes.txt",
      staged: false,
      state: "untracked",
      originalPath: null,
    },
  ],
};

function Harness({
  workspaceId = "1",
  native = true,
  openFile = vi.fn(),
}: {
  workspaceId?: string;
  native?: boolean;
  openFile?: (path: string) => void;
}) {
  const git = useGit(workspaceId, native);
  return <GitPanel git={git} editorBusy={false} openFile={openFile} />;
}

/** Routes IPC by command name so polling order does not matter. */
function route(handlers: Record<string, (args: unknown) => unknown>) {
  ipc.mockImplementation((command, args) => {
    const handler = handlers[command];
    if (!handler) return Promise.reject(new Error(`unexpected ${command}`));
    try {
      return Promise.resolve(handler(args));
    } catch (error) {
      return Promise.reject(error);
    }
  });
}

describe("source control panel", () => {
  it("explains when the desktop app or a folder is missing", () => {
    render(<Harness native={false} />);
    expect(screen.getByText(/Open a folder in the desktop app/)).toBeTruthy();
    expect(ipc).not.toHaveBeenCalled();
  });

  it("shows a clear message for a folder that is not a repository", async () => {
    route({
      git_status: () => {
        throw "NOT_A_REPOSITORY";
      },
    });
    render(<Harness />);
    expect(
      await screen.findByText("This folder is not a Git repository."),
    ).toBeTruthy();
  });

  it("groups staged and unstaged changes and stages a single file", async () => {
    const user = userEvent.setup();
    const stage = vi.fn(() => null);
    route({ git_status: () => dirty, git_stage: stage });
    render(<Harness />);

    expect(
      await screen.findByRole("region", { name: "Staged changes" }),
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "Changes" })).toBeTruthy();
    expect(screen.getByText("↑1 ↓0")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Stage README.md" }));
    expect(stage).toHaveBeenCalledWith({
      workspaceId: "1",
      relativePath: "README.md",
    });
  });

  it("commits with Ctrl+Enter and reports the new hash", async () => {
    const user = userEvent.setup();
    const commit = vi.fn(() => "abc1234");
    route({ git_status: () => dirty, git_commit: commit });
    render(<Harness />);

    const box = await screen.findByRole("textbox", { name: "Commit message" });
    await user.type(box, "Add git panel");
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() =>
      expect(commit).toHaveBeenCalledWith({
        workspaceId: "1",
        message: "Add git panel",
      }),
    );
    expect(await screen.findByText("Committed abc1234.")).toBeTruthy();
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("disables commit until something is staged and a message is typed", async () => {
    route({
      git_status: () => ({ ...dirty, entries: dirty.entries.slice(1) }),
    });
    render(<Harness />);
    const commit = await screen.findByRole("button", { name: /^Commit/ });
    expect((commit as HTMLButtonElement).disabled).toBe(true);
  });

  it("surfaces an actionable error when git identity is missing", async () => {
    const user = userEvent.setup();
    route({
      git_status: () => dirty,
      git_commit: () => {
        throw "IDENTITY_MISSING";
      },
    });
    render(<Harness />);
    await user.type(
      await screen.findByRole("textbox", { name: "Commit message" }),
      "x",
    );
    await user.click(screen.getByRole("button", { name: /^Commit 1 file/ }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "user.name",
    );
  });

  it("switches to an existing branch from the branch list", async () => {
    const user = userEvent.setup();
    const checkout = vi.fn(() => null);
    route({
      git_status: () => dirty,
      git_branches: () => [
        { name: "main", isHead: true, isRemote: false },
        { name: "feature/x", isHead: false, isRemote: false },
        { name: "origin/main", isHead: false, isRemote: true },
      ],
      git_checkout: checkout,
    });
    render(<Harness />);

    await user.click(await screen.findByRole("button", { name: "main" }));
    const list = screen.getByRole("list", { name: "Local branches" });
    expect(list.textContent).not.toContain("origin/main");
    await user.click(screen.getByRole("button", { name: "feature/x" }));
    expect(checkout).toHaveBeenCalledWith({
      workspaceId: "1",
      branchName: "feature/x",
      create: false,
    });
  });

  it("opens a changed file in the editor", async () => {
    const user = userEvent.setup();
    const openFile = vi.fn();
    route({ git_status: () => dirty });
    render(<Harness openFile={openFile} />);
    await user.click(await screen.findByTitle("src/app.ts"));
    expect(openFile).toHaveBeenCalledWith("src/app.ts");
  });
});
