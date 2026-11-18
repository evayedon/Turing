import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLayout } from "./layout";

beforeEach(() => useLayout.setState(useLayout.getInitialState(), true));

describe("desktop layout", () => {
  it("opens the explorer and collapses the bottom dock on a fresh launch", () => {
    expect(useLayout.getState()).toMatchObject({
      sidebar: "explorer",
      terminal: false,
      dockView: "Terminal",
    });
  });

  it("restores a saved open dock and selected tab", async () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) =>
          key === "turing:visible-panes:v1"
            ? JSON.stringify({ terminal: true, dockView: "Output" })
            : null,
      },
    });
    try {
      vi.resetModules();
      const { useLayout: restoredLayout } = await import("./layout");
      expect(restoredLayout.getState()).toMatchObject({
        terminal: true,
        dockView: "Output",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("switches between sidebar views and closes the active view", () => {
    const { toggleSidebar } = useLayout.getState();
    toggleSidebar("git");
    expect(useLayout.getState().sidebar).toBe("git");
    toggleSidebar("git");
    expect(useLayout.getState().sidebar).toBeNull();
    toggleSidebar("explorer");
    expect(useLayout.getState().sidebar).toBe("explorer");
  });

  it("toggles the terminal and AI panel independently", () => {
    const { toggleTerminal, toggleAssistant } = useLayout.getState();
    toggleTerminal();
    expect(useLayout.getState()).toMatchObject({
      terminal: true,
      assistant: false,
    });
    toggleAssistant();
    expect(useLayout.getState()).toMatchObject({
      terminal: true,
      assistant: true,
    });
    toggleTerminal();
    expect(useLayout.getState()).toMatchObject({
      terminal: false,
      assistant: true,
    });
  });
});
