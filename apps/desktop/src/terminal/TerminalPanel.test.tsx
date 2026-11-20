// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { Workbench } from "../shell/Workbench";
import { TerminalSessions } from "./TerminalSessions";
import { useLayout } from "../state/layout";
import { TerminalPanel, terminalStartupDeadline } from "./TerminalPanel";

/** Waits until a terminal inside `scope` has a running shell. */
const running = (scope: ParentNode = document) =>
  waitFor(() =>
    expect(
      scope.querySelector('.terminal-panel[data-phase="running"]'),
    ).toBeTruthy(),
  );

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: () => true,
}));

// The workspace watcher polls in the background; hold it out of IPC sequences.
vi.mock("../explorer/watch-ipc", () => ({
  pollWorkspaceChanges: vi.fn(() => new Promise(() => {})),
}));
vi.mock("./terminal-view", () => ({ createTerminalView: mocks.create }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { resolve, promise };
}

let resize: () => void;
let observers: (() => void)[];
let input: (bytes: Uint8Array) => void;
let disconnect: ReturnType<typeof vi.fn>;
let view: {
  size: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  disableInput: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  disconnect = vi.fn();
  observers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
        observers.push(callback);
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  view = {
    size: vi.fn(() => ({ rows: 18, cols: 100 })),
    write: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn(),
    clear: vi.fn(),
    disableInput: vi.fn(),
    dispose: vi.fn(),
  };
  mocks.create.mockImplementation((_: HTMLDivElement, send: typeof input) => {
    input = send;
    return view;
  });
});

afterEach(() => {
  cleanup();
  useLayout.setState(useLayout.getInitialState(), true);
  vi.unstubAllGlobals();
});

describe("TerminalPanel", () => {
  it("requires native access and starts only when explicitly requested", () => {
    const { rerender } = render(<TerminalPanel native={false} />);
    expect(screen.getByText("Terminal requires the desktop app.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start terminal" })).toBeNull();
    rerender(<TerminalPanel native workspaceId="approved" />);
    expect(screen.getByRole("button", { name: "Start terminal" })).toBeTruthy();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("starts a terminal when Show Terminal reveals it, then clears and closes it from the menu", async () => {
    const pending = deferred<never>();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "terminal_start")
        return Promise.resolve({ id: "menu", workspaceDirectory: false });
      if (command === "terminal_read") return pending.promise;
      return Promise.resolve();
    });
    const user = userEvent.setup();
    render(<Workbench />);
    const menu = screen.getByRole("menuitem", { name: "Terminal" });
    await user.click(menu);
    await user.click(screen.getByRole("menuitem", { name: "Show Terminal" }));
    await running();
    expect(screen.queryByRole("button", { name: "Start terminal" })).toBeNull();
    await user.click(menu);
    await user.click(screen.getByRole("menuitem", { name: "Open Terminal" }));
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "terminal_start",
      ),
    ).toHaveLength(1);
    await user.click(menu);
    await user.click(screen.getByRole("menuitem", { name: "Clear Terminal" }));
    expect(view.clear).toHaveBeenCalledOnce();
    await user.click(menu);
    await user.click(screen.getByRole("menuitem", { name: "Close Terminal" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("terminal_close", {
        id: "menu",
      }),
    );
  });

  it("creates two split PTYs, resizes each, and removes only the selected session", async () => {
    const pending = deferred<never>();
    let started = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "terminal_start")
        return Promise.resolve({
          id: `pty-${++started}`,
          workspaceDirectory: false,
        });
      if (command === "terminal_read") return pending.promise;
      return Promise.resolve();
    });
    const user = userEvent.setup();
    render(<Workbench />);
    const menu = screen.getByRole("menuitem", { name: "Terminal" });
    await user.click(menu);
    await user.click(
      screen.getByRole("menuitem", { name: "New Terminal Window" }),
    );
    expect(mocks.invoke).toHaveBeenCalledWith("window_new_terminal", undefined);
    expect(started).toBe(0);
    await user.click(menu);
    await user.click(screen.getByRole("menuitem", { name: "Split Terminal" }));
    const first = await screen.findByRole("tabpanel", { name: "Terminal 1" });
    const second = await screen.findByRole("tabpanel", { name: "Terminal 2" });
    await running(first);
    await running(second);
    const divider = screen.getByRole("separator", {
      name: "Resize terminal panes",
    });
    divider.focus();
    await user.keyboard("{ArrowRight}");
    expect(divider.getAttribute("aria-valuenow")).toBe("55");
    view.size.mockReturnValue({ rows: 20, cols: 73 });
    act(() => observers.forEach((measure) => measure()));
    for (const id of ["pty-1", "pty-2"]) {
      expect(mocks.invoke).toHaveBeenCalledWith("terminal_resize", {
        id,
        rows: 20,
        cols: 73,
      });
    }
    await user.click(screen.getByRole("button", { name: "Remove Terminal 2" }));
    expect(screen.queryByRole("tabpanel", { name: "Terminal 2" })).toBeNull();
    await running(first);
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "terminal_close",
      ),
    ).toHaveLength(1);
    expect(
      screen.queryByRole("separator", { name: "Resize terminal panes" }),
    ).toBeNull();
  });

  it("starts a restored terminal without taking focus, and focuses or reopens it on request", async () => {
    useLayout.setState({ terminal: true, dockView: "Terminal" });
    const start = deferred<{ id: string; workspaceDirectory: boolean }>();
    let starts = 0;
    const pendingRead = deferred<never>();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "terminal_start") {
        starts++;
        return starts === 1
          ? start.promise
          : Promise.resolve({ id: "second", workspaceDirectory: false });
      }
      if (command === "terminal_read") return pendingRead.promise;
      return Promise.resolve();
    });
    const user = userEvent.setup();
    render(
      <StrictMode>
        <Workbench />
      </StrictMode>,
    );
    // A restored, visible terminal starts on its own and leaves focus alone.
    await waitFor(() => expect(starts).toBe(1));
    await act(async () =>
      start.resolve({ id: "first", workspaceDirectory: false }),
    );
    await running();
    expect(view.focus).not.toHaveBeenCalled();
    const terminal = screen.getByRole("tab", { name: "Terminal" });
    await user.click(terminal);
    expect(view.focus).toHaveBeenCalledOnce();
    expect(starts).toBe(1);

    await user.click(screen.getByRole("tab", { name: "Problems" }));
    await user.click(screen.getByRole("button", { name: "Hide bottom panel" }));
    await user.click(
      screen.getByRole("button", { name: "Open command palette" }),
    );
    await user.type(
      screen.getByRole("combobox", { name: "Search commands" }),
      "open terminal",
    );
    await user.click(screen.getByRole("option", { name: /^Open Terminal/ }));
    expect(view.focus).toHaveBeenCalledTimes(2);
    expect(starts).toBe(1);
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "terminal_close",
      expect.anything(),
    );

    await user.click(screen.getByRole("button", { name: "Kill terminal" }));
    await screen.findByRole("button", { name: "Restart terminal" });
    expect(starts).toBe(1);
    expect(mocks.invoke).toHaveBeenCalledWith("terminal_close", {
      id: "first",
    });
    await user.click(screen.getByRole("tab", { name: "Problems" }));
    await user.click(screen.getByRole("tab", { name: "Terminal" }));
    await running();
    expect(starts).toBe(2);
    expect(view.focus).toHaveBeenCalledTimes(3);
  });

  it.each(["activity control", "keyboard shortcut", "command palette"])(
    "starts from a collapsed dock using the %s and preserves the session when reopened",
    async (action) => {
      const pendingRead = deferred<never>();
      mocks.invoke.mockImplementation((command: string) => {
        if (command === "terminal_start")
          return Promise.resolve({ id: "fresh", workspaceDirectory: false });
        if (command === "terminal_read") return pendingRead.promise;
        return Promise.resolve();
      });
      const user = userEvent.setup();
      render(<Workbench />);
      expect(screen.queryByRole("region", { name: "Terminal" })).toBeNull();
      expect(mocks.invoke).not.toHaveBeenCalled();
      const toggle = screen.getByRole("button", {
        name: "Toggle Bottom Panel",
      });
      if (action === "activity control") await user.click(toggle);
      else if (action === "keyboard shortcut")
        await user.keyboard("{Control>}`{/Control}");
      else {
        await user.click(
          screen.getByRole("button", { name: "Open command palette" }),
        );
        await user.type(
          screen.getByRole("combobox", { name: "Search commands" }),
          "open terminal",
        );
        await user.click(
          screen.getByRole("option", { name: /^Open Terminal/ }),
        );
      }
      await running();
      expect(view.focus).toHaveBeenCalledOnce();
      await user.click(toggle);
      expect(screen.queryByRole("region", { name: "Terminal" })).toBeNull();
      await user.click(toggle);
      expect(view.focus).toHaveBeenCalledTimes(2);
      expect(view.dispose).not.toHaveBeenCalled();
      expect(
        mocks.invoke.mock.calls.filter(
          ([command]) => command === "terminal_start",
        ),
      ).toHaveLength(1);
    },
  );

  it("does not steal focus if the user moves to another control while starting", async () => {
    const start = deferred<{ id: string; workspaceDirectory: boolean }>();
    const pendingRead = deferred<never>();
    mocks.invoke.mockImplementation((command: string) =>
      command === "terminal_start" ? start.promise : pendingRead.promise,
    );
    const user = userEvent.setup();
    render(<Workbench />);
    await user.click(
      screen.getByRole("button", { name: "Toggle Bottom Panel" }),
    );
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "terminal_start",
        expect.anything(),
      ),
    );
    const file = screen.getByRole("menuitem", { name: "File" });
    file.focus();
    await act(async () =>
      start.resolve({ id: "session", workspaceDirectory: false }),
    );
    expect(document.activeElement).toBe(file);
    expect(view.focus).not.toHaveBeenCalled();
  });

  it("streams output, forwards input, resizes, and closes while a read is pending", async () => {
    const output = deferred<{
      bytes: number[];
      finished: boolean;
      exitCode: null;
    }>();
    const pending = deferred<{
      bytes: number[];
      finished: boolean;
      exitCode: null;
    }>();
    let reads = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "terminal_start")
        return Promise.resolve({ id: "session", workspaceDirectory: true });
      if (command === "terminal_read")
        return (++reads === 1 ? output : pending).promise;
      return Promise.resolve();
    });
    const user = userEvent.setup();
    render(<TerminalPanel native workspaceId="approved" />);
    await user.click(screen.getByRole("button", { name: "Start terminal" }));
    const close = await screen.findByRole("button", { name: "Close terminal" });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "terminal_start",
      expect.objectContaining({
        rows: 18,
        cols: 100,
        workspaceId: "approved",
        attempt: expect.any(String),
        profile: "system",
      }),
    );
    await act(async () =>
      output.resolve({
        bytes: [226, 152, 131],
        finished: false,
        exitCode: null,
      }),
    );
    expect(view.write).toHaveBeenCalledWith([226, 152, 131]);
    await waitFor(() => expect(reads).toBe(2));

    view.size.mockReturnValue({ rows: 22, cols: 120 });
    act(() => {
      input(Uint8Array.of(3));
      resize();
    });
    expect(mocks.invoke).toHaveBeenCalledWith("terminal_input", {
      id: "session",
      data: [3],
    });
    expect(mocks.invoke).toHaveBeenCalledWith("terminal_resize", {
      id: "session",
      rows: 22,
      cols: 120,
    });

    await user.click(close);
    expect(mocks.invoke).toHaveBeenCalledWith("terminal_close", {
      id: "session",
    });
    expect(document.activeElement).toBe(
      await screen.findByRole("button", { name: "Restart terminal" }),
    );
    expect(disconnect).toHaveBeenCalledOnce();
    expect(view.disableInput).toHaveBeenCalledOnce();
    await act(async () =>
      pending.resolve({ bytes: [65], finished: false, exitCode: null }),
    );
    expect(view.write).toHaveBeenCalledTimes(1);
  });

  it("cleans up a native session if startup completes after unmount", async () => {
    const start = deferred<{ id: string; workspaceDirectory: boolean }>();
    mocks.invoke.mockImplementation((command: string) =>
      command === "terminal_start" ? start.promise : Promise.resolve(),
    );
    const { unmount } = render(<TerminalPanel native />);
    await userEvent.click(
      screen.getByRole("button", { name: "Start terminal" }),
    );
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "terminal_start",
        expect.anything(),
      ),
    );
    unmount();
    await act(async () =>
      start.resolve({ id: "late", workspaceDirectory: false }),
    );
    expect(mocks.invoke).toHaveBeenLastCalledWith("terminal_close", {
      id: "late",
    });
    expect(disconnect).toHaveBeenCalledOnce();
    expect(view.dispose).toHaveBeenCalledOnce();
  });

  it("shows a startup error and permits retry", async () => {
    const pendingRead = deferred<never>();
    mocks.invoke
      .mockRejectedValueOnce("SHELL_UNAVAILABLE")
      .mockResolvedValueOnce({ id: "retry", workspaceDirectory: false })
      .mockReturnValueOnce(pendingRead.promise);
    render(<TerminalPanel native />);
    await userEvent.click(
      screen.getByRole("button", { name: "Start terminal" }),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /No usable system shell/,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Retry terminal" }),
    );
    await screen.findByRole("button", { name: "Close terminal" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(view.focus).toHaveBeenCalledOnce();
  });

  it("keeps final output visible and reports the shell exit without another close request", async () => {
    mocks.invoke
      .mockResolvedValueOnce({ id: "session", workspaceDirectory: false })
      .mockResolvedValueOnce({ bytes: [65], finished: true, exitCode: 7 });
    render(<TerminalPanel native />);
    await userEvent.click(
      screen.getByRole("button", { name: "Start terminal" }),
    );
    expect((await screen.findByRole("status")).textContent).toBe(
      "Shell exited with code 7.",
    );
    expect(view.write).toHaveBeenCalledWith([65]);
    expect(view.dispose).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("button", { name: "Restart terminal" }),
    ).toBeTruthy();
  });
});

it("ends an unresponsive start, retries, and cleans up a late reply", async () => {
  const old = deferred<{ id: string; workspaceDirectory: boolean }>();
  const never = deferred<never>();
  let count = 0;
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "terminal_start")
      return ++count === 1
        ? old.promise
        : Promise.resolve({ id: "replacement", workspaceDirectory: false });
    if (command === "terminal_read") return never.promise;
    return Promise.resolve();
  });
  render(<TerminalPanel native />);
  const user = userEvent.setup();
  const original = globalThis.setTimeout;
  const deadline = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((callback, delay, ...args) =>
      original(
        callback,
        delay === terminalStartupDeadline ? 30 : delay,
        ...args,
      ),
    );
  try {
    await user.click(screen.getByRole("button", { name: "Start terminal" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /did not start in time/,
    );
    expect(mocks.invoke).toHaveBeenCalledWith("terminal_cancel_start", {
      attempt: expect.any(String),
    });
    await user.click(screen.getByRole("button", { name: "Retry terminal" }));
    await screen.findByRole("button", { name: "Close terminal" });
    await act(async () =>
      old.resolve({ id: "late", workspaceDirectory: false }),
    );
    expect(mocks.invoke).toHaveBeenCalledWith("terminal_close", { id: "late" });
    expect(screen.queryByRole("alert")).toBeNull();
  } finally {
    deadline.mockRestore();
  }
});

it("splits a terminal into a group of side-by-side panes without a small cap", async () => {
  const pending = deferred<never>();
  let count = 0;
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "terminal_start")
      return Promise.resolve({
        id: String(++count),
        workspaceDirectory: false,
        shell: "zsh",
      });
    if (command === "terminal_read") return pending.promise;
    return Promise.resolve();
  });
  const user = userEvent.setup();
  render(<TerminalSessions native shown activation={0} />);
  await running();
  const split = screen.getByRole("button", { name: "Split terminal pane" });
  for (let pane = 2; pane <= 5; pane++) {
    await user.click(split);
    await waitFor(() =>
      expect(
        document.querySelectorAll(
          '[role="tabpanel"]:not([hidden]) .terminal-panel[data-phase="running"]',
        ),
      ).toHaveLength(pane),
    );
  }
  expect(screen.getAllByRole("separator")).toHaveLength(4);
  // Each split lands after the active (newest) terminal, drawn as one group.
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
    "┌zsh",
    "├zsh 2",
    "├zsh 3",
    "├zsh 4",
    "└zsh 5",
  ]);
  expect(split.hasAttribute("disabled")).toBe(false);

  // Removing a middle pane keeps the rest of the group together.
  await user.click(screen.getByRole("button", { name: "Remove zsh 3" }));
  expect(screen.getAllByRole("separator")).toHaveLength(3);
  expect(
    document.querySelectorAll('[role="tabpanel"]:not([hidden])'),
  ).toHaveLength(4);
});

it("never holds more native sessions than visible terminals under StrictMode", async () => {
  const pending = deferred<never>();
  const open = new Set<string>();
  let count = 0;
  mocks.invoke.mockImplementation((command: string, args?: { id?: string }) => {
    if (command === "terminal_start") {
      // Mirrors the native per-window limit of four sessions.
      if (open.size >= 4) return Promise.reject("SESSION_LIMIT");
      const id = String(++count);
      open.add(id);
      return Promise.resolve({ id, workspaceDirectory: false, shell: "zsh" });
    }
    if (command === "terminal_close" && args?.id) open.delete(args.id);
    if (command === "terminal_read") return pending.promise;
    return Promise.resolve();
  });
  const user = userEvent.setup();
  render(
    <StrictMode>
      <TerminalSessions native shown activation={0} />
    </StrictMode>,
  );
  await running();
  for (const action of ["New terminal session", "New terminal session"])
    await user.click(screen.getByRole("button", { name: action }));
  await user.click(screen.getByRole("button", { name: "Split terminal pane" }));
  await waitFor(() =>
    expect(
      document.querySelectorAll('.terminal-panel[data-phase="running"]'),
    ).toHaveLength(4),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(open.size).toBe(4);
});

it("starts a newly created terminal promptly under StrictMode", async () => {
  const pending = deferred<never>();
  let count = 0;
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "terminal_start")
      return Promise.resolve({
        id: String(++count),
        workspaceDirectory: false,
        shell: "zsh",
      });
    if (command === "terminal_read") return pending.promise;
    return Promise.resolve();
  });
  const user = userEvent.setup();
  render(
    <StrictMode>
      <TerminalSessions native activation={0} />
    </StrictMode>,
  );
  const create = screen.getByRole("button", { name: "New terminal session" });
  await user.click(create);
  await running(screen.getByRole("tabpanel", { name: "zsh" }));
  // A second terminal mounts already asked to start.
  await user.click(create);
  const second = await screen.findByRole("tabpanel", {
    name: /^(Terminal|zsh) 2$/,
  });
  await running(second);
});

it("renames sessions, keeps a vertical group on tab switches, and reuses display numbers", async () => {
  const pending = deferred<never>();
  let count = 0;
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "terminal_start")
      return Promise.resolve({
        id: String(++count),
        workspaceDirectory: false,
        shell: "bash",
      });
    if (command === "terminal_read") return pending.promise;
    return Promise.resolve();
  });
  const user = userEvent.setup();
  render(<TerminalSessions native activation={0} />);
  await user.click(screen.getByRole("button", { name: "Launch profile" }));
  await user.click(screen.getByRole("menuitem", { name: "New Bash terminal" }));
  await user.click(
    screen.getByRole("button", { name: "More terminal actions" }),
  );
  await user.click(screen.getByRole("menuitem", { name: "Split Down" }));
  const separator = screen.getByRole("separator");
  expect(separator.getAttribute("aria-orientation")).toBe("horizontal");
  await screen.findByRole("tab", { name: "bash 2" });
  expect(
    mocks.invoke.mock.calls.filter(([command]) => command === "terminal_start"),
  ).toEqual(
    Array.from({ length: 2 }, () => [
      "terminal_start",
      expect.objectContaining({ profile: "bash" }),
    ]),
  );
  await user.click(
    screen.getByRole("button", { name: "More terminal actions" }),
  );
  await user.click(screen.getByRole("menuitem", { name: "Rename…" }));
  await user.clear(screen.getByRole("textbox", { name: "Terminal name" }));
  await user.type(
    screen.getByRole("textbox", { name: "Terminal name" }),
    "Build{Enter}",
  );
  expect(
    screen.getByRole("tab", { name: "Build" }).getAttribute("aria-selected"),
  ).toBe("true");
  await user.click(
    screen.getByRole("button", { name: "New terminal session" }),
  );
  await screen.findByRole("tab", { name: "bash 3" });
  expect(screen.queryByRole("separator")).toBeNull();
  await user.click(screen.getByRole("tab", { name: "Build" }));
  expect(screen.getByRole("separator").getAttribute("aria-orientation")).toBe(
    "horizontal",
  );
  await user.click(screen.getByRole("button", { name: "Remove Build" }));
  await user.click(
    screen.getByRole("button", { name: "New terminal session" }),
  );
  await screen.findByRole("tab", { name: "bash 2" });
  expect(count).toBe(4);
});
