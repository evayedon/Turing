// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { expectAccessible } from "../test/axe";
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
  it("qualifies the empty shell, sidebars, dock views, menus and dialogs", async () => {
    const user = userEvent.setup();
    const { container } = render(<Workbench />);
    await expectAccessible(container, true);
    const settings = screen.getByRole("button", { name: "Settings" });
    for (const name of ["Search", "Source Control", "Toggle Bottom Panel"]) {
      screen.getByRole("button", { name }).focus();
      await user.keyboard("{Enter}");
      await expectAccessible(container, true);
    }
    screen.getByRole("tab", { name: "Terminal" }).focus();
    await user.keyboard("{ArrowRight}");
    await expectAccessible(container, true);
    await user.keyboard("{End}");
    await expectAccessible(container, true);

    for (const [opener, key] of [
      [screen.getByRole("menuitem", { name: "File" }), "{ArrowDown}"],
      [screen.getByRole("button", { name: "Open command palette" }), "{Enter}"],
      [settings, "{Enter}"],
    ] as const) {
      opener.focus();
      await user.keyboard(key);
      await expectAccessible(container, true);
      if (
        opener === settings ||
        opener.getAttribute("aria-label") === "Open command palette"
      ) {
        await user.tab();
        expect(
          screen.getByRole("dialog").contains(document.activeElement),
        ).toBe(true);
      }
      await user.keyboard("{Escape}");
      expect(document.activeElement).toBe(opener);
    }
  });

  it("follows workbench Tab order and cycles visible regions in both directions", async () => {
    const user = userEvent.setup();
    useLayout.setState({ terminal: true });
    render(<Workbench />);
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "File" }),
    );
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Edit" }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Open command palette" }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Explorer" }),
    );
    await user.keyboard("{F6}");
    expect(document.activeElement).toBe(
      screen.getByRole("region", { name: "Explorer" }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("separator", { name: "Resize sidebar" }),
    );
    await user.keyboard("{F6}");
    expect(document.activeElement).toBe(
      screen.getByRole("region", { name: "Editor" }),
    );
    await user.keyboard("{F6}");
    expect(document.activeElement).toBe(
      screen.getByRole("region", { name: "Terminal" }),
    );
    await user.keyboard("{F6}");
    expect(document.activeElement).toBe(
      screen.getByRole("contentinfo", { name: "Workbench status" }),
    );
    await user.keyboard("{Shift>}{F6}{/Shift}");
    expect(document.activeElement).toBe(
      screen.getByRole("region", { name: "Terminal" }),
    );
  });

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
    ).toContain("No problems to show.");
    await user.keyboard("{End}");
    expect(
      screen.getByRole("tabpanel", { name: "Output" }).textContent,
    ).toContain("unavailable");
  });

  it("maximizes the existing dock and restores the editor and splitter", async () => {
    const user = userEvent.setup();
    useLayout.setState({ terminal: true });
    render(<Workbench />);
    const editor = screen.getByRole("region", { name: "Editor" });
    const dock = screen.getByRole("region", { name: "Terminal" });
    await user.click(screen.getByRole("button", { name: "Maximize panel" }));
    expect(screen.queryByRole("region", { name: "Editor" })).toBeNull();
    expect(
      screen.queryByRole("separator", { name: "Resize bottom panel" }),
    ).toBeNull();
    expect(screen.getByRole("region", { name: "Terminal" })).toBe(dock);
    await user.click(
      screen.getByRole("button", { name: "Restore panel size" }),
    );
    expect(screen.getByRole("region", { name: "Editor" })).toBe(editor);
    expect(
      screen.getByRole("separator", { name: "Resize bottom panel" }),
    ).toBeTruthy();
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
