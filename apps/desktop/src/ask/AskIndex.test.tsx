// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AskIndexStatus } from "@turing/contracts";
import { AskIndex } from "./AskIndex";
import { manageAskIndex } from "./ask-ipc";

vi.mock("./ask-ipc", () => ({ manageAskIndex: vi.fn() }));
afterEach(cleanup);

it("shows workspace index progress and scopes controls to the open workspace", async () => {
  let status: AskIndexStatus = { phase: "ready", files: 14, partial: true };
  const manage = vi
    .mocked(manageAskIndex)
    .mockImplementation(async (_, action) => {
      if (action === "pause") status = { ...status, phase: "paused" };
      if (action === "resume") status = { ...status, phase: "ready" };
      if (action === "rebuild")
        status = { phase: "indexing", files: 0, partial: false };
      if (action === "disable")
        status = { phase: "disabled", files: 0, partial: false };
      return status;
    });

  const user = userEvent.setup();
  render(<AskIndex workspaceId="active-repo" visible />);
  expect(manage).not.toHaveBeenCalled();
  await user.click(screen.getByText("Workspace index"));
  expect(
    await screen.findByText("Ready · 14 files · Limited coverage"),
  ).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Pause" }));
  expect(
    await screen.findByText("Paused · 14 files · Limited coverage"),
  ).toBeTruthy();
  expect(manage).toHaveBeenCalledWith("active-repo", "pause");
  await user.click(screen.getByRole("button", { name: "Resume" }));
  expect(manage).toHaveBeenCalledWith("active-repo", "resume");
  await user.click(screen.getByRole("button", { name: "Rebuild" }));
  expect(await screen.findByText("Indexing · 0 files")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Disable" }));
  expect(await screen.findByText("Disabled · 0 files")).toBeTruthy();
});
