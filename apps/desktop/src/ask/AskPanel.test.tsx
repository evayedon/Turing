// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskEvent } from "@turing/contracts";
import { expectAccessible } from "../test/axe";
import { AskPanel } from "./AskPanel";
import { cancelAsk, cloudCredential, localAskStatus, runAsk } from "./ask-ipc";

vi.mock("./ask-ipc", async (original) => ({
  ...(await original<typeof import("./ask-ipc")>()),
  runAsk: vi.fn(),
  cancelAsk: vi.fn(),
  cloudCredential: vi.fn(),
  localAskStatus: vi.fn(),
}));

const run = vi.mocked(runAsk);
const cancel = vi.mocked(cancelAsk);

beforeEach(() => {
  run.mockReset().mockImplementation(() => new Promise(() => {}));
  cancel.mockReset().mockResolvedValue(undefined);
  vi.mocked(cloudCredential).mockReset().mockResolvedValue(false);
  vi.mocked(localAskStatus).mockReset().mockResolvedValue("ready");
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
    expect(screen.getByText("Workspace context was limited.")).toBeTruthy();
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

  it("shows cloud approval, restores the question after denial, and presents token usage after approval", async () => {
    let deny: (cause: unknown) => void = () => {};
    run.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          deny = reject;
        }),
    );
    render(<AskPanel workspaceId="workspace" openSource={vi.fn()} />);
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Model" }),
      "openrouter-qwen3-coder",
    );
    await submit("Where is the workspace?");
    expect(run.mock.lastCall?.[1].modelId).toBe("openrouter-qwen3-coder");
    deliver({ kind: "awaitingCloudApproval" });
    expect(
      screen.getByText("Review the request in the sharing dialog."),
    ).toBeTruthy();
    await act(async () => deny("CLOUD_CONSENT_DECLINED"));
    expect(screen.getByRole("textbox")).toHaveProperty(
      "value",
      "Where is the workspace?",
    );
    expect(screen.queryByRole("list", { name: "Conversation" })).toBeNull();
    expect(screen.getByText("Cloud sharing canceled.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Ask" }));
    deliver({ kind: "awaitingCloudApproval" });
    deliver({ kind: "cloudApproved" });
    deliver({ kind: "delta", text: "Answer" });
    deliver({
      kind: "completed",
      sources: [],
      indexCoverage: "complete",
      indexFreshness: "current",
      usage: { inputTokens: 41, outputTokens: 9 },
    });
    expect(screen.getByText("41 input tokens · 9 output tokens")).toBeTruthy();
  });

  it("retains completed answers and feedback only after opt-in and restores them for the same folder", async () => {
    const workspacePath = "/test/retention";
    const openSource = vi.fn();
    const first = render(
      <AskPanel
        workspaceId="old-grant"
        workspacePath={workspacePath}
        openSource={openSource}
      />,
    );
    const user = userEvent.setup();
    const complete = (text: string) => {
      deliver({ kind: "delta", text });
      deliver({
        kind: "completed",
        sources: [],
        indexCoverage: "complete",
        indexFreshness: "current",
      });
    };
    await submit("First question");
    complete("Session answer");
    expect(localStorage.length).toBe(0);
    await user.click(screen.getByText("Project preferences and history"));
    await user.type(
      screen.getByRole("textbox", { name: "Project conventions" }),
      "Use snake_case.",
    );
    await user.click(
      screen.getByRole("button", {
        name: "Save conventions and selected model",
      }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: /Keep the last 20/ }),
    );
    await submit("Second question");
    expect(run.mock.lastCall?.[1].conventions).toBe("Use snake_case.");
    complete("Retained answer");
    await user.click(screen.getAllByRole("button", { name: "Helpful" })[1]);
    first.unmount();

    const other = render(
      <AskPanel
        workspaceId="other"
        workspacePath="/test/other"
        openSource={openSource}
      />,
    );
    expect(screen.queryByText("Retained answer")).toBeNull();
    other.unmount();

    render(
      <AskPanel
        workspaceId="new-grant"
        workspacePath={workspacePath}
        openSource={openSource}
      />,
    );
    expect(screen.getByText("Retained answer")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Helpful", pressed: true }),
    ).toBeTruthy();
    await user.click(screen.getByText("Project preferences and history"));
    await user.click(
      screen.getByRole("button", { name: "Clear conversation" }),
    );
    expect(screen.queryByText("Retained answer")).toBeNull();
    expect(
      localStorage.getItem(`turing:ask-project:v1:${workspacePath}`),
    ).not.toContain("Retained answer");
    localStorage.clear();
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

  it("keeps earlier turns and renders fenced code as a code block", async () => {
    const { container } = render(
      <AskPanel workspaceId="workspace" openSource={vi.fn()} />,
    );
    await submit("First question");
    deliver({ kind: "delta", text: "Plain answer" });
    deliver({
      kind: "completed",
      sources: [],
      indexCoverage: "complete",
      indexFreshness: "current",
    });
    await submit("Second question");
    deliver({ kind: "delta", text: "Use this:\n```rust\nfn main() {}\n```" });
    const conversation = screen.getByRole("list", { name: "Conversation" });
    expect(conversation.children).toHaveLength(2);
    expect(screen.getByText("Plain answer")).toBeTruthy();
    expect(container.querySelector("pre code")?.textContent).toBe(
      "fn main() {}\n",
    );
    expect(screen.getByText("Use this:")).toBeTruthy();
  });

  it("shows model availability before asking", async () => {
    vi.mocked(localAskStatus).mockResolvedValue("offline");
    render(<AskPanel workspaceId="workspace" openSource={vi.fn()} />);
    expect(
      await screen.findByText("llama-server isn't running on 127.0.0.1:8080."),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "llama.cpp (local · offline)" }),
    ).toBeTruthy();
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Model" }),
      "openrouter-qwen3-coder",
    );
    expect(
      await screen.findByText("Save an OpenRouter API key to use this model."),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", {
        name: "Qwen3-Coder via OpenRouter (cloud · key needed)",
      }),
    ).toBeTruthy();
  });
});
