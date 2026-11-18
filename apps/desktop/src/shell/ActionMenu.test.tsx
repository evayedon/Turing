// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionMenu } from "./ActionMenu";

afterEach(cleanup);

function fixture() {
  const run = vi.fn();
  const disabled = vi.fn();
  const outsideAction = vi.fn();
  render(
    <>
      <ActionMenu
        label="File"
        actions={[
          { label: "Disabled command", run: disabled, disabled: true },
          { label: "New File", run },
        ]}
      >
        <p>Menu help</p>
      </ActionMenu>
      <p>Outside content</p>
      <button type="button" onClick={outsideAction}>
        Outside action
      </button>
    </>,
  );
  return {
    user: userEvent.setup(),
    trigger: screen.getByRole("button", { name: "File" }),
    run,
    disabled,
    outsideAction,
  };
}

const panel = () => screen.queryByRole("group", { name: "File actions" });

describe("action menu", () => {
  it("dismisses for clicks on non-focusable content and preserves an outside button's action and focus", async () => {
    const { user, trigger, outsideAction } = fixture();
    await user.click(trigger);
    expect(panel()).toBeTruthy();
    await user.click(screen.getByText("Outside content"));
    expect(panel()).toBeNull();

    await user.click(trigger);
    const outside = screen.getByRole("button", { name: "Outside action" });
    await user.click(outside);
    expect(panel()).toBeNull();
    expect(outsideAction).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(outside);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const { user, trigger, run } = fixture();
    await user.tab();
    await user.keyboard("{Enter}");
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "New File" }),
    );
    await user.keyboard("{Escape}");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(run).not.toHaveBeenCalled();
  });

  it("executes a keyboard command once, with disabled actions skipped", async () => {
    const { user, trigger, run, disabled } = fixture();
    await user.tab();
    await user.keyboard("[Space]");
    await user.tab();
    await user.keyboard("{Enter}");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(run).toHaveBeenCalledOnce();
    expect(disabled).not.toHaveBeenCalled();
  });

  it("keeps inside clicks available before activation even without a next focus target", async () => {
    const { user, trigger, run, disabled } = fixture();
    await user.click(trigger);
    fireEvent.blur(trigger, { relatedTarget: null });
    await user.click(screen.getByText("Menu help"));
    await user.click(screen.getByRole("button", { name: "Disabled command" }));
    expect(panel()).toBeTruthy();
    expect(disabled).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "New File" }));
    expect(run).toHaveBeenCalledOnce();
    expect(panel()).toBeNull();
  });

  it("toggles with the trigger and dismisses on window blur or keyboard focus leaving", async () => {
    const { user, trigger } = fixture();
    await user.click(trigger);
    await user.click(trigger);
    expect(panel()).toBeNull();
    await user.click(trigger);
    fireEvent.blur(window);
    expect(panel()).toBeNull();

    await user.click(trigger);
    await user.tab();
    await user.tab();
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Outside action" }),
    );
  });
});
