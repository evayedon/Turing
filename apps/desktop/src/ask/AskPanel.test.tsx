// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskEvent } from "@turing/contracts";
import { expectAccessible } from "../test/axe";
import { AskPanel } from "./AskPanel";
import { localDay } from "./ask-history";
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
afterEach(() => {
  cleanup();
  localStorage.clear();
});

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
      "auto",
    );
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      {
        workspaceId: "workspace",
        modelId: "auto",
        question: "Where is access checked?",
        localServer: "http://127.0.0.1:8080",
      },
      expect.any(Function),
    );
    expect(screen.getByText("Choosing a model…")).toBeTruthy();
    deliver({ kind: "routed", location: "local" });
    expect(screen.getByText("Generating locally…")).toBeTruthy();
    deliver({ kind: "delta", text: "Workspace " });
    expect(screen.getByText("Workspace")).toBeTruthy();
    deliver({ kind: "delta", text: "authorization [1]." });
    deliver({
      kind: "completed",
      sources: [source],
      indexCoverage: "partial",
      indexFreshness: "stale",
    });
    const citation = screen.getByRole("button", {
      name: "Source 1: src/workspace.rs:3–8",
    });
    expect(citation.closest("p")?.textContent).toBe(
      "Workspace authorization 1.",
    );
    expect(screen.getByText("Workspace context was limited.")).toBeTruthy();
    expect(screen.getByText("Answered by llama.cpp (local)")).toBeTruthy();
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
    deliver({
      kind: "awaitingCloudApproval",
      estimatedInputTokens: 812,
      sources: [
        {
          relativePath: "src/workspace.rs",
          version: "v1",
          startLine: 1,
          endLine: 12,
        },
      ],
    });
    expect(
      screen.getByRole("button", { name: "src/workspace.rs:1–12" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Review the request in the sharing dialog."),
    ).toBeTruthy();
    expect(screen.getByText("≈812 input tokens (estimate)")).toBeTruthy();
    await act(async () => deny("CLOUD_CONSENT_DECLINED"));
    expect(
      screen.getByRole("textbox", { name: "Ask about this workspace" }),
    ).toHaveProperty("value", "Where is the workspace?");
    expect(screen.queryByRole("list", { name: "Conversation" })).toBeNull();
    expect(screen.getByText("Cloud sharing canceled.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Ask" }));
    deliver({
      kind: "awaitingCloudApproval",
      sources: [],
      estimatedInputTokens: 10,
    });
    deliver({ kind: "cloudApproved" });
    deliver({ kind: "delta", text: "Answer" });
    deliver({
      kind: "completed",
      sources: [],
      indexCoverage: "complete",
      indexFreshness: "current",
      usage: { inputTokens: 41, outputTokens: 9 },
    });
    expect(
      screen.getByText("41 input tokens · 9 output tokens (measured)"),
    ).toBeTruthy();
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
        name: "Save conventions",
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
      "Start the local model server on 127.0.0.1:8080",
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
      await screen.findByText(
        "No local server is ready on 127.0.0.1:8080 and no OpenRouter key is saved.",
      ),
    ).toBeTruthy();
    await userEvent
      .setup()
      .selectOptions(
        screen.getByRole("combobox", { name: "Model" }),
        "llama.cpp",
      );
    expect(
      await screen.findByText("No local server is running on 127.0.0.1:8080."),
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

  it("remembers the chosen model for the folder without saving preferences", async () => {
    const workspacePath = "/test/model";
    const first = render(
      <AskPanel
        workspaceId="workspace"
        workspacePath={workspacePath}
        openSource={vi.fn()}
      />,
    );
    await userEvent
      .setup()
      .selectOptions(
        screen.getByRole("combobox", { name: "Model" }),
        "llama.cpp",
      );
    first.unmount();
    render(
      <AskPanel
        workspaceId="workspace"
        workspacePath={workspacePath}
        openSource={vi.fn()}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveProperty(
      "value",
      "llama.cpp",
    );
    localStorage.clear();
  });

  it("uses the configured local server for status, availability, and requests", async () => {
    vi.mocked(localAskStatus).mockResolvedValue("offline");
    render(<AskPanel workspaceId="workspace" openSource={vi.fn()} />);
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Model" }),
      "llama.cpp",
    );
    await user.click(screen.getByText(/Local server · 127\.0\.0\.1:8080/));
    const address = screen.getByRole("textbox", {
      name: "Local server address",
    });
    await user.clear(address);
    await user.type(address, "example.com:11434");
    await user.click(screen.getByRole("button", { name: "Save local server" }));
    expect(screen.getByRole("alert").textContent).toContain("loopback");
    await user.clear(address);
    await user.type(address, "localhost:11434");
    await user.type(
      screen.getByRole("textbox", { name: "Local model name (optional)" }),
      "llama3.2",
    );
    await user.click(screen.getByRole("button", { name: "Save local server" }));
    expect(vi.mocked(localAskStatus)).toHaveBeenLastCalledWith(
      "http://localhost:11434",
    );
    expect(
      await screen.findByText("No local server is running on localhost:11434."),
    ).toBeTruthy();
    await submit("Where is access checked?");
    expect(run.mock.lastCall?.[1]).toMatchObject({
      localServer: "http://localhost:11434",
      localModel: "llama3.2",
    });
    localStorage.clear();
  });

  it("routes Auto to the cloud when llama-server is unavailable", async () => {
    vi.mocked(localAskStatus).mockResolvedValue("offline");
    vi.mocked(cloudCredential).mockResolvedValue(true);
    render(<AskPanel workspaceId="workspace" openSource={vi.fn()} />);
    expect(
      await screen.findByText(
        "No local server is ready on 127.0.0.1:8080, so Auto will ask before using the cloud.",
      ),
    ).toBeTruthy();
    await submit("Where is the workspace?");
    deliver({ kind: "routed", location: "cloud" });
    deliver({
      kind: "awaitingCloudApproval",
      sources: [],
      estimatedInputTokens: 10,
    });
    deliver({ kind: "cloudApproved" });
    expect(
      screen.getByText("Preparing or generating cloud answer…"),
    ).toBeTruthy();
    deliver({ kind: "delta", text: "Answer" });
    deliver({
      kind: "completed",
      sources: [],
      indexCoverage: "complete",
      indexFreshness: "current",
    });
    expect(
      screen.getByText("Answered by Qwen3-Coder via OpenRouter (cloud)"),
    ).toBeTruthy();
  });

  describe("cloud budget", () => {
    const completedWith = (inputTokens: number, outputTokens: number) =>
      deliver({
        kind: "completed",
        sources: [],
        indexCoverage: "complete",
        indexFreshness: "current",
        usage: { inputTokens, outputTokens },
      });
    const budgetKey = "turing:ask-cloud-budget:v1";
    const today = localDay();

    async function chooseCloud() {
      await userEvent
        .setup()
        .selectOptions(
          screen.getByRole("combobox", { name: "Model" }),
          "openrouter-qwen3-coder",
        );
    }

    it("validates the limit and records measured cloud usage per local day", async () => {
      localStorage.setItem(
        budgetKey,
        JSON.stringify({
          days: Object.fromEntries(
            Array.from({ length: 40 }, (_, index) => [
              `2000-01-${String(index + 1).padStart(2, "0")}`,
              1,
            ]),
          ),
        }),
      );
      const { container } = render(
        <AskPanel workspaceId="workspace" openSource={vi.fn()} />,
      );
      await chooseCloud();
      const user = userEvent.setup();
      await user.click(screen.getByText(/Cloud budget/));
      const limit = screen.getByRole("textbox", {
        name: "Daily token limit (optional)",
      });
      for (const bad of ["-5", "1.5", "0", "abc", "100000001"]) {
        await user.clear(limit);
        await user.type(limit, bad);
        await user.click(screen.getByRole("button", { name: "Save budget" }));
        expect(screen.getByRole("alert").textContent).toContain("whole number");
      }
      await user.clear(limit);
      await user.type(limit, "500");
      await user.click(screen.getByRole("button", { name: "Save budget" }));
      expect(
        screen.getByText("Cloud budget · Today: 0 of 500 tokens (measured)"),
      ).toBeTruthy();
      await expectAccessible(container);

      await submit("Where is the workspace?");
      completedWith(41, 9);
      expect(
        screen.getByText("Cloud budget · Today: 50 of 500 tokens (measured)"),
      ).toBeTruthy();

      // Local answers never count against the cloud budget.
      await user.selectOptions(
        screen.getByRole("combobox", { name: "Model" }),
        "llama.cpp",
      );
      await submit("Local question");
      completedWith(100, 100);

      const stored = JSON.parse(localStorage.getItem(budgetKey) ?? "{}") as {
        limit: number;
        days: Record<string, number>;
      };
      expect(stored.limit).toBe(500);
      expect(stored.days[today]).toBe(50);
      expect(Object.keys(stored.days)).toHaveLength(31);
    });

    function overBudget() {
      localStorage.setItem(
        budgetKey,
        JSON.stringify({ limit: 100, days: { [today]: 120 } }),
      );
    }

    it("asks before a cloud request once today's budget is used; Cancel restores the question", async () => {
      overBudget();
      const { container } = render(
        <AskPanel workspaceId="workspace" openSource={vi.fn()} />,
      );
      await chooseCloud();
      const user = await submit("Over budget?");
      expect(run).not.toHaveBeenCalled();
      const dialog = screen.getByRole("alertdialog", {
        name: "Cloud budget reached",
      });
      expect(dialog.textContent).toContain(
        "Today's cloud budget is used: 120 of 100 tokens. Send anyway?",
      );
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Send anyway" }),
      );
      await expectAccessible(container);
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      const composer = screen.getByRole("textbox", {
        name: "Ask about this workspace",
      });
      expect(composer).toHaveProperty("value", "Over budget?");
      expect(document.activeElement).toBe(composer);
      expect(run).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "Ask" }));
      await user.keyboard("{Enter}");
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.lastCall?.[1].question).toBe("Over budget?");
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("asks for Auto only when the local server is not ready, never for local", async () => {
      overBudget();
      vi.mocked(localAskStatus).mockResolvedValue("offline");
      const offline = render(
        <AskPanel workspaceId="workspace" openSource={vi.fn()} />,
      );
      await screen.findByText(/so Auto will ask before using the cloud/);
      await submit("Auto offline");
      expect(screen.getByRole("alertdialog")).toBeTruthy();
      expect(run).not.toHaveBeenCalled();
      await userEvent
        .setup()
        .selectOptions(
          screen.getByRole("combobox", { name: "Model" }),
          "llama.cpp",
        );
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Ask" }));
      expect(run).toHaveBeenCalledTimes(1);
      offline.unmount();

      vi.mocked(localAskStatus).mockResolvedValue("ready");
      render(<AskPanel workspaceId="workspace" openSource={vi.fn()} />);
      await act(async () => {});
      await submit("Auto ready");
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(run).toHaveBeenCalledTimes(2);
    });
  });
});
