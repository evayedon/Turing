// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskEvent } from "@turing/contracts";
import { expectAccessible } from "../test/axe";
import { AskPanel } from "./AskPanel";
import { cancelAsk, runAsk } from "./ask-ipc";

vi.mock("./ask-ipc", async (original) => ({
  ...(await original<typeof import("./ask-ipc")>()),
  runAsk: vi.fn(),
  cancelAsk: vi.fn(),
}));

const run = vi.mocked(runAsk);
const cancel = vi.mocked(cancelAsk);

beforeEach(() => {
  run.mockReset().mockImplementation(() => new Promise(() => {}));
  cancel.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

async function submit(question: string) {
  const user = userEvent.setup();
  await user.type(
    screen.getByRole("textbox", { name: "Ask about this workspace" }),
    question,
  );
  await user.click(screen.getByRole("button", { name: "Ask" }));
  return user;
}

function deliver(event: AskEvent) {
  const call = run.mock.lastCall;
  if (!call) throw new Error("Expected an active Ask request");
  act(() => call[2](event));
}

describe("Ask panel", () => {
  it("streams an answer and reveals versioned sources with coverage and freshness notices", async () => {
    const openSource = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const source = {
      relativePath: "src/workspace.rs",
      version: "v1",
      startLine: 3,
      endLine: 8,
    };
    const { container } = render(
      <AskPanel workspaceId="workspace" openSource={openSource} />,
    );
    const user = await submit("Where is access checked?");
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveProperty(
      "value",
      "llama.cpp",
    );
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      {
        workspaceId: "workspace",
        modelId: "llama.cpp",
        question: "Where is access checked?",
      },
      expect.any(Function),
    );
    deliver({ kind: "delta", text: "Workspace " });
    expect(screen.getByText("Workspace")).toBeTruthy();
    deliver({ kind: "delta", text: "authorization [1]." });
    deliver({
      kind: "completed",
      sources: [source],
      indexCoverage: "partial",
      indexFreshness: "stale",
    });
    expect(screen.getByText("Workspace authorization [1].")).toBeTruthy();
    expect(
      screen.getByText("Only part of the workspace was scanned."),
    ).toBeTruthy();
    expect(
      screen.getByText("Some source files changed during this answer."),
    ).toBeTruthy();
    const reference = screen.getByRole("button", {
      name: "src/workspace.rs:3–8",
    });
    await user.click(reference);
    expect(openSource).toHaveBeenCalledWith(source);
    await user.click(reference);
    expect(
      await screen.findByText(
        "The editor or saved file differs from the cited version.",
      ),
    ).toBeTruthy();
    await expectAccessible(container);
  });

  it("stops the current request and discards late events", async () => {
    render(<AskPanel workspaceId="workspace" openSource={vi.fn()} />);
    const user = await submit("Where is access checked?");
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(cancel).toHaveBeenCalledWith(run.mock.lastCall?.[0]);
    expect(screen.getByText("Stopping…")).toBeTruthy();
    deliver({ kind: "cancelled" });
    deliver({ kind: "delta", text: "Late content" });
    expect(screen.getByText("Response stopped.")).toBeTruthy();
    expect(screen.queryByText("Late content")).toBeNull();
  });

  it("explains model startup failures and cancels when the workspace changes", async () => {
    run.mockRejectedValueOnce("MODEL_UNAVAILABLE");
    const openSource = vi.fn();
    const { rerender } = render(
      <AskPanel key="first" workspaceId="first" openSource={openSource} />,
    );
    await submit("Where is access checked?");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Start llama-server",
    );
    await submit("Where is access checked?");
    const previous = run.mock.lastCall;
    rerender(
      <AskPanel key="second" workspaceId="second" openSource={openSource} />,
    );
    expect(cancel).toHaveBeenCalledWith(previous?.[0]);
    deliver({ kind: "delta", text: "Previous workspace content" });
    expect(screen.queryByText("Previous workspace content")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
