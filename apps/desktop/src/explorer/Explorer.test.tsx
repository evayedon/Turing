// @vitest-environment jsdom

import { invoke, isTauri } from "@tauri-apps/api/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "../shell/Workbench";
import { useLayout } from "../state/layout";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
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

    await user.click(screen.getByRole("button", { name: "Git" }));
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
    expect((await screen.findByRole("status")).textContent).toContain(
      "Loading folder",
    );
    rejectListing("PERMISSION_DENIED");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "could not access",
    );

    await user.click(screen.getByRole("button", { name: "Reload folder" }));
    expect(await screen.findByText("README.md")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
