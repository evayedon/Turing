import { beforeEach, describe, expect, it } from "vitest";
import { useLayout } from "./layout";

beforeEach(() => useLayout.setState(useLayout.getInitialState(), true));

describe("desktop layout", () => {
  it("opens the explorer on launch", () => {
    expect(useLayout.getState().sidebar).toBe("explorer");
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
      terminal: false,
      assistant: true,
    });
    toggleAssistant();
    expect(useLayout.getState()).toMatchObject({
      terminal: false,
      assistant: false,
    });
    toggleTerminal();
    expect(useLayout.getState()).toMatchObject({
      terminal: true,
      assistant: false,
    });
  });
});
