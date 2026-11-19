// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MenuBar } from "./MenuBar";
import { menus } from "./commands";
import type { Command, CommandId, Commands } from "./commands";

afterEach(cleanup);

function fixture() {
  const run = vi.fn();
  const disabled = vi.fn();
  const outside = vi.fn();
  const commands = Object.fromEntries(
    menus
      .flatMap(({ entries }) =>
        entries.flatMap((row) =>
          row === "-" ? [] : typeof row === "string" ? [row] : row.entries,
        ),
      )
      .map((id): [CommandId, Command] => [id, { label: id, run: vi.fn() }]),
  ) as Commands;
  commands.newWindow = { label: "New Window", disabled: true, run: vi.fn() };
  commands.newText = { label: "New Text File", run };
  commands.newWorkspace = {
    label: "New Workspace File",
    disabled: true,
    run: disabled,
  };
  commands.output = { label: "Show Output", run };
  render(
    <>
      <MenuBar commands={commands} onRun={(id) => commands[id].run()} />
      <p>Outside text</p>
      <button onClick={outside}>Outside action</button>
    </>,
  );
  return { user: userEvent.setup(), run, disabled, outside };
}

const file = () => screen.getByRole("menuitem", { name: "File" });
const fileMenu = () => screen.queryByRole("menu", { name: "File actions" });

describe("workbench menu bar", () => {
  it("dismisses outside clicks and keeps the clicked control focused", async () => {
    const { user, outside } = fixture();
    await user.click(file());
    expect(fileMenu()).toBeTruthy();
    await user.click(screen.getByText("Outside text"));
    expect(fileMenu()).toBeNull();
    await user.click(file());
    const button = screen.getByRole("button", { name: "Outside action" });
    await user.click(button);
    expect(outside).toHaveBeenCalledOnce();
    expect(fileMenu()).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("navigates top-level menus and restores focus on Escape", async () => {
    const { user, run } = fixture();
    await user.tab();
    expect(document.activeElement).toBe(file());
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "New Window" }),
    );
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("menu", { name: "Edit actions" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Edit actions" })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Edit" }),
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps disabled rows discoverable but blocks keyboard and pointer activation", async () => {
    const { user, disabled, run } = fixture();
    await user.click(file());
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    const disabledItem = screen.getByRole("menuitem", {
      name: "New Workspace File",
    });
    expect(disabledItem.getAttribute("aria-disabled")).toBe("true");
    await user.click(disabledItem);
    expect(disabled).not.toHaveBeenCalled();
    expect(fileMenu()).toBeTruthy();
    await user.keyboard("{Home}{ArrowDown}{Enter}");
    expect(run).toHaveBeenCalledOnce();
    expect(fileMenu()).toBeNull();
    expect(document.activeElement).toBe(file());
  });

  it("opens and closes a submenu with arrows and returns focus to its parent", async () => {
    const { user, run } = fixture();
    await user.click(screen.getByRole("menuitem", { name: "View" }));
    const parent = within(
      screen.getByRole("menu", { name: "View actions" }),
    ).getByRole("menuitem", { name: "Dock Panels" });
    parent.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("menu", { name: "Dock Panels" })).toBeTruthy();
    await user.keyboard("{ArrowLeft}");
    expect(screen.queryByRole("menu", { name: "Dock Panels" })).toBeNull();
    expect(document.activeElement).toBe(parent);
    await user.keyboard("{ArrowRight}{ArrowDown}{Enter}");
    expect(run).toHaveBeenCalledOnce();
  });

  it("dismisses on window blur and tolerates a WebView blur without a next target", async () => {
    const { user } = fixture();
    await user.click(file());
    fireEvent.blur(file(), { relatedTarget: null });
    expect(fileMenu()).toBeTruthy();
    fireEvent.blur(window);
    expect(fileMenu()).toBeNull();
  });
});
