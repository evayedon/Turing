// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { SymbolsResponse } from "@turing/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { expectAccessible } from "../test/axe";
import { WorkspaceSymbolPicker } from "./WorkspaceSymbolPicker";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));

const ipc = vi.mocked(invoke);

function response(name: string, complete = true): SymbolsResponse {
  return {
    generation: 1,
    complete,
    truncated: false,
    symbols: complete
      ? [
          {
            name,
            kind: "function",
            relativePath: "src/example.ts",
            line: 3,
            character: 8,
          },
        ]
      : [],
  };
}

async function tick(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

beforeEach(() => {
  vi.useFakeTimers();
  ipc.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("workspace symbol picker", () => {
  it("debounces edits, drops late replies, and navigates by keyboard", async () => {
    let resolveOld!: (value: SymbolsResponse) => void;
    ipc.mockImplementationOnce(
      () => new Promise((resolve) => (resolveOld = resolve)),
    );
    ipc.mockResolvedValueOnce(response("current"));
    const navigate = vi.fn();
    render(
      <WorkspaceSymbolPicker
        workspaceId="first"
        dismiss={vi.fn()}
        navigate={navigate}
      />,
    );
    await tick(150);
    const input = screen.getByRole("combobox", {
      name: "Search workspace symbols",
    });
    fireEvent.change(input, { target: { value: "c" } });
    await tick(100);
    fireEvent.change(input, { target: { value: "cu" } });
    await tick(149);
    expect(ipc).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(ipc).toHaveBeenLastCalledWith("workspace_symbols_query", {
      workspaceId: "first",
      query: "cu",
      limit: 100,
    });
    await act(async () => resolveOld(response("outdated")));
    expect(screen.queryByRole("option", { name: /outdated/ })).toBeNull();
    expect(screen.getByRole("option", { name: /current/ })).toBeTruthy();
    vi.useRealTimers();
    await expectAccessible(document.body);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith(response("current").symbols[0]);
  });

  it("polls an incomplete index and discards replies across workspace switches", async () => {
    let resolveOld!: (value: SymbolsResponse) => void;
    ipc.mockResolvedValueOnce(response("", false));
    ipc.mockImplementationOnce(
      () => new Promise((resolve) => (resolveOld = resolve)),
    );
    ipc.mockResolvedValueOnce(response("fresh"));

    const dismiss = vi.fn();
    const navigate = vi.fn();
    const { rerender, unmount } = render(
      <WorkspaceSymbolPicker
        workspaceId="first"
        dismiss={dismiss}
        navigate={navigate}
      />,
    );
    await tick(150);
    expect(screen.getByRole("status").textContent).toContain("Indexing");
    await tick(150);
    rerender(
      <WorkspaceSymbolPicker
        workspaceId="second"
        dismiss={dismiss}
        navigate={navigate}
      />,
    );
    await tick(150);
    await act(async () => resolveOld(response("old registration")));
    expect(
      screen.queryByRole("option", { name: /old registration/ }),
    ).toBeNull();
    expect(screen.getByRole("option", { name: /fresh/ })).toBeTruthy();
    unmount();
    await tick(1000);
    expect(ipc).toHaveBeenCalledTimes(3);
  });
});
