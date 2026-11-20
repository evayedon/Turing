// @vitest-environment jsdom

import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { DirectoryEntry, WorkspaceChanges } from "@turing/contracts";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "../shell/Workbench";
import { useLayout } from "../state/layout";
import { pollWorkspaceChanges } from "./watch-ipc";

vi.mock("../editor/draft-ipc", () => import("../test/mock-draft-ipc"));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

// The workspace watcher polls in the background; hold it out of IPC sequences.
vi.mock("./watch-ipc", () => ({
  pollWorkspaceChanges: vi.fn(() => new Promise(() => {})),
}));

// Source control polls in the background; keep it out of these IPC sequences.
vi.mock("../git/git-ipc", async (original) => ({
  ...(await original<typeof import("../git/git-ipc")>()),
  invokeGit: vi.fn(() => Promise.reject("NOT_A_REPOSITORY")),
}));

const ipc = vi.mocked(invoke);
const project = { id: "workspace", name: "project" };
const entries = [
  { name: "src", relativePath: "src", kind: "directory" },
  { name: "README.md", relativePath: "README.md", kind: "file" },
];

beforeEach(() => {
  ipc.mockReset();
  vi.mocked(isTauri).mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  useLayout.setState(useLayout.getInitialState(), true);
});

describe("workspace explorer", () => {
  it("explains that the browser preview cannot access native workspaces", () => {
    vi.mocked(isTauri).mockReturnValue(false);
    render(<Workbench />);

    expect(
      screen.getByText(/native workspace access is unavailable/i),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open folder" })).toBeNull();
    expect(ipc).not.toHaveBeenCalled();
  });

  it("opens the selected folder, browses a subfolder, and closes the grant", async () => {
    const user = userEvent.setup();
    ipc
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(entries)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(entries)
      .mockResolvedValueOnce(undefined);

    render(<Workbench />);
    const explorer = within(screen.getByRole("region", { name: "Explorer" }));
    await user.click(explorer.getByRole("button", { name: "Open folder" }));
    const child = await explorer.findByRole("button", { name: "src/" });
    expect(explorer.getByText("README.md")).toBeTruthy();
    expect(ipc).toHaveBeenNthCalledWith(1, "workspace_open", undefined);
    expect(ipc).toHaveBeenNthCalledWith(2, "fs_list_directory", {
      workspaceId: project.id,
      relativePath: "",
    });

    await user.click(child);
    expect(await explorer.findByText("This folder is empty.")).toBeTruthy();
    expect(ipc).toHaveBeenNthCalledWith(3, "fs_list_directory", {
      workspaceId: project.id,
      relativePath: "src",
    });

    await user.click(screen.getByRole("button", { name: "Source Control" }));
    await user.click(screen.getByRole("button", { name: "Explorer" }));
    const reopened = within(screen.getByRole("region", { name: "Explorer" }));
    expect(reopened.getByText("project/src")).toBeTruthy();

    await user.click(reopened.getByRole("button", { name: "Up" }));
    expect(await reopened.findByText("README.md")).toBeTruthy();
    await user.click(reopened.getByRole("button", { name: "Close workspace" }));
    expect(
      await reopened.findByRole("button", { name: "Open folder" }),
    ).toBeTruthy();
    expect(ipc).toHaveBeenLastCalledWith("workspace_close", {
      workspaceId: project.id,
    });
  });

  it("keeps folder context and navigates the expanded branch with arrow keys", async () => {
    const user = userEvent.setup();
    ipc
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(entries)
      .mockResolvedValueOnce([
        { name: "main.ts", relativePath: "src/main.ts", kind: "file" },
      ])
      .mockResolvedValueOnce(entries);
    render(<Workbench />);
    await user.click(screen.getByRole("button", { name: "Open folder" }));
    const folder = await screen.findByRole("button", { name: "src/" });
    const readme = screen.getByRole("button", { name: "README.md" });
    // Roving tabindex: the tree is one Tab stop, arrows move inside it.
    expect(folder.tabIndex).toBe(0);
    expect(readme.tabIndex).toBe(-1);
    folder.focus();
    await user.keyboard("{ArrowRight}");
    const child = await screen.findByRole("button", { name: "main.ts" });
    expect(folder.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "README.md" })).toBeTruthy();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(child);
    expect(child.tabIndex).toBe(0);
    expect(folder.tabIndex).toBe(-1);
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(folder);
    await user.keyboard("{ArrowLeft}");
    expect(screen.queryByRole("button", { name: "main.ts" })).toBeNull();
  });

  it("handles a canceled folder selection without listing anything", async () => {
    const user = userEvent.setup();
    ipc.mockResolvedValueOnce(null);
    render(<Workbench />);

    const button = screen.getByRole("button", { name: "Open folder" });
    await user.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(ipc).toHaveBeenCalledTimes(1);
  });

  it("shows pending and failed listings and lets the user retry", async () => {
    const user = userEvent.setup();
    let rejectListing!: (error: string) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectListing = reject;
    });
    ipc
      .mockResolvedValueOnce(project)
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(entries);
    render(<Workbench />);

    await user.click(screen.getByRole("button", { name: "Open folder" }));
    const explorer = within(screen.getByRole("region", { name: "Explorer" }));
    const status = explorer.getByRole("status");
    await waitFor(() => expect(status.textContent).toContain("Loading folder"));
    rejectListing("PERMISSION_DENIED");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "could not access",
    );

    await user.click(screen.getByRole("button", { name: "Reload folder" }));
    expect(await screen.findByText("README.md")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("workspace watcher reconciliation", () => {
  const poll = vi.mocked(pollWorkspaceChanges);
  /** Pending watcher polls; the test answers each one explicitly. */
  let polls: ((changes: WorkspaceChanges) => void)[];
  let disk: Map<string, DirectoryEntry[]>;

  const dir = (path: string): DirectoryEntry => ({
    name: path.split("/").at(-1) ?? path,
    relativePath: path,
    kind: "directory",
  });
  const file = (path: string): DirectoryEntry => ({
    name: path.split("/").at(-1) ?? path,
    relativePath: path,
    kind: "file",
  });

  beforeEach(() => {
    polls = [];
    poll.mockImplementation(
      () => new Promise((resolve) => polls.push(resolve)),
    );
    disk = new Map([
      ["", [dir("src"), file("README.md")]],
      ["src", [file("src/old-0.ts"), file("src/old-1.ts")]],
    ]);
    ipc.mockImplementation(async (command, args) => {
      if (command === "workspace_open") return project;
      if (command === "fs_list_directory") {
        const listing = disk.get(
          (args as { relativePath: string }).relativePath,
        );
        if (!listing) throw "NOT_FOUND";
        return listing;
      }
      throw new Error(`Unexpected command ${command}`);
    });
  });

  afterEach(() => {
    poll.mockReset();
    poll.mockImplementation(() => new Promise(() => {}));
  });

  async function emit(changes: WorkspaceChanges) {
    await waitFor(() => expect(polls.length).toBeGreaterThan(0), {
      timeout: 3000,
    });
    polls.shift()?.(changes);
  }

  const listed = () =>
    ipc.mock.calls
      .filter(([command]) => command === "fs_list_directory")
      .map(([, args]) => (args as { relativePath: string }).relativePath);

  async function openExpanded() {
    const user = userEvent.setup();
    render(<Workbench />);
    await user.click(screen.getByRole("button", { name: "Open folder" }));
    await user.click(await screen.findByRole("button", { name: "src/" }));
    expect(
      await screen.findByRole("button", { name: "old-0.ts" }),
    ).toBeTruthy();
    expect(poll).toHaveBeenCalledWith(project.id);
    ipc.mockClear();
  }

  it("converges after a rename burst by re-listing only the affected folder", async () => {
    await openExpanded();
    disk.set("src", [file("src/new-0.ts"), file("src/new-1.ts")]);
    await emit({
      paths: ["src/new-0.ts", "src/new-1.ts", "src/old-0.ts", "src/old-1.ts"],
      rescan: false,
    });
    expect(
      await screen.findByRole("button", { name: "new-1.ts" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "old-0.ts" })).toBeNull();
    expect(listed()).toEqual(["src"]);
  });

  it("forgets a folder renamed away and keeps browsing from its parent", async () => {
    await openExpanded();
    disk.delete("src");
    disk.set("", [dir("lib"), file("README.md")]);
    await emit({ paths: ["lib", "src"], rescan: false });
    expect(await screen.findByRole("button", { name: "lib/" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "src/" })).toBeNull();
    expect(screen.queryByRole("button", { name: "old-0.ts" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // The browse location moves out of the vanished folder.
    await waitFor(() => expect(screen.queryByText("project/src")).toBeNull());
    expect(screen.getByTitle("project/").textContent).toBe("project");
    expect(listed().sort()).toEqual(["", "src"]);
  });

  it("re-lists every loaded folder once on overflow", async () => {
    await openExpanded();
    disk.set("", [dir("src"), file("CHANGELOG.md"), file("README.md")]);
    disk.set("src", [file("src/old-0.ts")]);
    await emit({ paths: [], rescan: true });
    expect(
      await screen.findByRole("button", { name: "CHANGELOG.md" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "old-1.ts" })).toBeNull(),
    );
    expect(listed().sort()).toEqual(["", "src"]);
  });

  it("stops polling once the workspace is closed", async () => {
    const user = userEvent.setup();
    await openExpanded();
    ipc.mockResolvedValueOnce(undefined);
    await user.click(screen.getByRole("button", { name: "Close workspace" }));
    await screen.findByRole("button", { name: "Open folder" });
    const calls = poll.mock.calls.length;
    polls.shift()?.({ paths: ["src/old-0.ts"], rescan: false });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(poll.mock.calls.length).toBe(calls);
    expect(listed()).toEqual([]);
  });
});
