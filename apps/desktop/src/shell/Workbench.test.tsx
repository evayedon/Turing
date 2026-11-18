// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { useLayout } from "../state/layout";
import { Workbench } from "./Workbench";

afterEach(() => {
  cleanup();
  useLayout.setState(useLayout.getInitialState(), true);
});

describe("workbench panels", () => {
  it("opens Explorer, Editor, Terminal, and AI on launch", () => {
    render(<Workbench />);

    for (const name of ["Explorer", "Editor", "Terminal", "AI panel"]) {
      expect(screen.getByRole("region", { name })).toBeTruthy();
    }
    expect(screen.queryByRole("region", { name: "Git" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Explorer", pressed: true }),
    ).toBeTruthy();
  });

  it("switches sidebars with the keyboard and closes the active sidebar", async () => {
    const user = userEvent.setup();
    render(<Workbench />);

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "File" }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Explorer" }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Git" }),
    );
    await user.keyboard("{Enter}");

    expect(screen.getByRole("region", { name: "Git" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Explorer" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Git", pressed: true }),
    ).toBeTruthy();

    await user.keyboard("[Space]");
    expect(screen.queryByRole("region", { name: "Git" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Git", pressed: false }),
    ).toBeTruthy();
  });

  it("keeps terminal and AI visibility independent of the sidebar", async () => {
    const user = userEvent.setup();
    render(<Workbench />);

    await user.click(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.queryByRole("region", { name: "Terminal" })).toBeNull();
    expect(screen.getByRole("region", { name: "AI panel" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "AI panel" }));
    expect(screen.queryByRole("region", { name: "AI panel" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Terminal" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.getByRole("region", { name: "Terminal" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "AI panel" })).toBeNull();
    expect(screen.getByRole("region", { name: "Explorer" })).toBeTruthy();
  });
});
