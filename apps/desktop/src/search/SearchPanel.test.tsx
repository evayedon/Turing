// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { expectAccessible } from "../test/axe";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchPanel } from "./SearchPanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
const ipc = vi.mocked(invoke);

beforeEach(() => ipc.mockReset());
afterEach(cleanup);

function setup(workspaceId = "project") {
  const user = userEvent.setup();
  const open = vi.fn();
  const view = render(
    <SearchPanel
      workspaceId={workspaceId}
      native
      editorBusy={false}
      open={open}
    />,
  );
  return { user, open, ...view };
}

describe("workspace search", () => {
  it("announces matches and opens a result by keyboard", async () => {
    const { user, open, container } = setup();
    ipc.mockResolvedValueOnce("search").mockResolvedValueOnce({
      files: [
        {
          relativePath: "main.ts",
          matches: [
            { line: 2, column: 3, before: "  ", text: "needle", after: "()" },
          ],
        },
      ],
      truncated: false,
      skippedFiles: 0,
    });
    const query = screen.getByRole("searchbox", { name: "Search text" });
    // WebKit only announces live regions that already exist, so the count
    // must land in the region rendered before the search started.
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");
    query.focus();
    await user.keyboard("needle{Enter}");
    const match = await screen.findByRole("button", {
      name: /main.ts, line 2, column 3/,
    });
    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toContain("1 match in 1 file");
    await expectAccessible(container);
    screen.getByText("main.ts").focus();
    await user.tab();
    expect(document.activeElement).toBe(match);
    await user.keyboard("{Enter}");
    expect(open).toHaveBeenCalledWith("main.ts", { line: 2, column: 3 });
  });

  it("distinguishes empty, scan limit, and failure states", async () => {
    const { user } = setup();
    const submit = screen.getByRole("button", { name: "Search" });
    await user.type(
      screen.getByRole("searchbox", { name: "Search text" }),
      "needle",
    );
    ipc.mockResolvedValueOnce("one").mockResolvedValueOnce({
      files: [],
      skippedFiles: 2,
      truncated: true,
    });
    await user.click(submit);
    expect(screen.getByRole("status").textContent).toMatch(
      /No matches found.*scan limit.*Skipped 2/,
    );

    ipc.mockRejectedValueOnce("PERMISSION_DENIED");
    await user.click(submit);
    expect(screen.getByRole("alert").textContent).toContain("could not access");
  });

  it("cancels a running scan and ignores a response that wins the race", async () => {
    const { user } = setup();
    let resolveSearch: (result: unknown) => void = () => {};
    ipc
      .mockResolvedValueOnce("running")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSearch = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const query = screen.getByRole("searchbox", { name: "Search text" });
    await user.type(query, "needle{Enter}");
    expect(screen.getByRole("status").textContent).toContain("Searching");
    await waitFor(() =>
      expect(ipc).toHaveBeenCalledWith("workspace_search_run", {
        workspaceId: "project",
        searchId: "running",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(query);
    expect(ipc).toHaveBeenCalledWith("workspace_search_cancel", {
      workspaceId: "project",
      searchId: "running",
    });
    await act(async () =>
      resolveSearch({ files: [], truncated: false, skippedFiles: 0 }),
    );
    expect(screen.getByRole("status").textContent).toBe("Search canceled.");
  });

  it("releases a pending reservation when the workspace changes", async () => {
    const { user, open, rerender } = setup();
    let finishBegin: (id: string) => void = () => {};
    ipc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishBegin = resolve;
        }),
    );
    await user.type(
      screen.getByRole("searchbox", { name: "Search text" }),
      "needle{Enter}",
    );
    rerender(
      <SearchPanel workspaceId="other" native editorBusy={false} open={open} />,
    );
    await act(async () => finishBegin("old-job"));
    expect(ipc).toHaveBeenNthCalledWith(2, "workspace_search_cancel", {
      workspaceId: "project",
      searchId: "old-job",
    });
    expect(
      ipc.mock.calls.some(([command]) => command === "workspace_search_run"),
    ).toBe(false);
    expect(
      screen.getByText("Enter text to search files on disk."),
    ).toBeTruthy();
  });

  it("requires an active workspace and native backend", () => {
    const open = vi.fn();
    const view = render(<SearchPanel native editorBusy={false} open={open} />);
    expect(screen.getByText("Open a folder to search its files.")).toBeTruthy();
    view.rerender(
      <SearchPanel
        workspaceId="project"
        native={false}
        editorBusy={false}
        open={open}
      />,
    );
    expect(
      screen.getByText("Workspace search requires the desktop app."),
    ).toBeTruthy();
    expect(ipc).not.toHaveBeenCalled();
  });
});
