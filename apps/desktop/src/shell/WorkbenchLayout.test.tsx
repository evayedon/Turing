// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayout } from "../state/layout";
import { fitColumns, initialSizes, layoutKey } from "./pane-layout";
import { Workbench } from "./Workbench";

beforeEach(() => {
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
  });
});

afterEach(() => {
  cleanup();
  useLayout.setState(useLayout.getInitialState(), true);
  vi.unstubAllGlobals();
});

describe("Nebula workbench", () => {
  it("searches and runs commands with the keyboard and restores focus", async () => {
    const user = userEvent.setup();
    useLayout.setState({ terminal: true });
    render(<Workbench />);
    const trigger = screen.getByRole("button", {
      name: "Open command palette",
    });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "P", ctrlKey: true, shiftKey: true });
    const search = screen.getByRole("combobox", { name: "Search commands" });
    expect(document.activeElement).toBe(search);
    await user.type(search, "hide terminal");
    expect(
      screen.getByRole("option", { name: "Hide Terminal panel" }),
    ).toBeTruthy();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("region", { name: "Terminal" })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.keyDown(trigger, { key: "P", metaKey: true, shiftKey: true });
    await user.type(screen.getByRole("combobox"), "unlikely query");
    expect(screen.getByText("No matching commands.")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("switches dock views with keyboard and exposes honest unavailable states", async () => {
    const user = userEvent.setup();
    useLayout.setState({ terminal: true });
    render(<Workbench />);
    screen.getByRole("tab", { name: "Terminal" }).focus();
    await user.keyboard("{ArrowRight}");
    const problems = screen.getByRole("tab", {
      name: "Problems",
      selected: true,
    });
    expect(document.activeElement).toBe(problems);
    expect(
      screen.getByRole("tabpanel", { name: "Problems" }).textContent,
    ).toContain("unavailable");
    await user.keyboard("{End}");
    expect(
      screen.getByRole("tabpanel", { name: "Output" }).textContent,
    ).toContain("unavailable");
  });

  it("changes shared pane sizes from the keyboard and restores them after remount", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      layoutKey,
      JSON.stringify({ sidebar: 200, assistant: 210, terminal: 130 }),
    );
    useLayout.setState({ terminal: true, assistant: true });
    const first = render(<Workbench />);
    const side = screen.getByRole("separator", { name: "Resize sidebar" });
    const bottom = screen.getByRole("separator", {
      name: "Resize bottom panel",
    });
    const right = screen.getByRole("separator", { name: "Resize AI panel" });
    side.focus();
    await user.keyboard("{ArrowRight}");
    expect(side.getAttribute("aria-valuenow")).toBe("208");
    right.focus();
    await user.keyboard("{ArrowLeft}");
    expect(right.getAttribute("aria-valuenow")).toBe("218");
    bottom.focus();
    await user.keyboard("{ArrowUp}");
    expect(bottom.getAttribute("aria-valuenow")).toBe("138");
    first.unmount();
    render(<Workbench />);
    expect(
      screen
        .getByRole("separator", { name: "Resize sidebar" })
        .getAttribute("aria-valuenow"),
    ).toBe("208");
    expect(
      screen
        .getByRole("separator", { name: "Resize bottom panel" })
        .getAttribute("aria-valuenow"),
    ).toBe("138");
  });

  it("resets saved sizes in Settings and persists bottom-panel preferences", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      layoutKey,
      JSON.stringify({ sidebar: 200, assistant: 210, terminal: 130 }),
    );
    render(<Workbench />);
    await user.click(
      screen.getByRole("button", { name: "Toggle Bottom Panel" }),
    );
    await user.click(screen.getByRole("tab", { name: "Problems" }));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Reset panel sizes" }));
    expect(JSON.parse(window.localStorage.getItem(layoutKey) ?? "{}")).toEqual(
      initialSizes,
    );
    expect(
      JSON.parse(
        window.localStorage.getItem("turing:visible-panes:v1") ?? "{}",
      ),
    ).toMatchObject({ terminal: true, dockView: "Problems" });
    await user.keyboard("{Escape}");
    expect(
      screen
        .getByRole("separator", { name: "Resize bottom panel" })
        .getAttribute("aria-valuenow"),
    ).toBe(String(initialSizes.terminal));
  });

  it("previews a pointer drag and persists the committed size", () => {
    render(<Workbench />);
    const side = screen.getByRole("separator", { name: "Resize sidebar" });
    Object.defineProperty(side, "setPointerCapture", { value: vi.fn() });
    function pointer(type: string, clientX: number) {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireEvent(side, event);
    }
    pointer("pointerdown", 260);
    pointer("pointermove", 282);
    expect(side.getAttribute("aria-valuenow")).toBe("250");
    expect(
      JSON.parse(window.localStorage.getItem(layoutKey) ?? "{}").sidebar,
    ).toBe(228);
    pointer("pointerup", 282);
    expect(
      JSON.parse(window.localStorage.getItem(layoutKey) ?? "{}").sidebar,
    ).toBe(250);
  });

  it("fits side panels without consuming the editor minimum at narrow desktop sizes", () => {
    const sized = fitColumns(680, initialSizes, true, true);
    expect(sized.sidebar).toBeGreaterThanOrEqual(144);
    expect(sized.assistant).toBeGreaterThanOrEqual(148);
    expect(
      680 - 46 - 12 - sized.sidebar - sized.assistant,
    ).toBeGreaterThanOrEqual(259);
  });
});
