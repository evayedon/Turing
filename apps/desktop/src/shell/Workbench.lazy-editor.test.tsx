// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useLayout } from "../state/layout";
import { Workbench } from "./Workbench";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(() => false),
  invoke: vi.fn(),
}));
vi.mock("../explorer/watch-ipc", () => ({
  pollWorkspaceChanges: vi.fn(() => new Promise(() => {})),
}));

// Hold the lazily imported editor chunk until the test releases it.
const chunk = vi.hoisted(() => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
});
vi.mock("../editor/MonacoHost", async () => {
  await chunk.ready;
  return { default: () => <textarea aria-label="Source text" /> };
});

afterEach(() => {
  cleanup();
  useLayout.setState(useLayout.getInitialState(), true);
});

it("renders the workbench shell while the editor chunk is still pending", async () => {
  const user = userEvent.setup();
  render(<Workbench />);
  await user.click(screen.getByRole("button", { name: "New File…" }));

  expect(await screen.findByRole("tab", { name: /Untitled/ })).toBeTruthy();
  expect(screen.getByRole("menubar")).toBeTruthy();
  expect(
    screen.getByRole("navigation", { name: "Workbench panels" }),
  ).toBeTruthy();
  expect(screen.getByRole("region", { name: "Explorer" })).toBeTruthy();
  expect(
    screen.getByText("Loading editor…").closest('[role="status"]'),
  ).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Source text" })).toBeNull();

  chunk.release();
  expect(
    await screen.findByRole("textbox", { name: "Source text" }),
  ).toBeTruthy();
  expect(screen.queryByText("Loading editor…")).toBeNull();
});
