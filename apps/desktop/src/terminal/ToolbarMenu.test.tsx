// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ToolbarMenu } from "./ToolbarMenu";

afterEach(cleanup);

function setup() {
  const first = vi.fn();
  const last = vi.fn();
  render(
    <>
      <ToolbarMenu
        label="More terminal actions"
        icon={<span>…</span>}
        items={[
          { label: "Rename…", run: first },
          { label: "Unavailable", disabled: true, run: vi.fn() },
          "-",
          { label: "Clear", run: last },
        ]}
      />
      <button type="button">Outside</button>
    </>,
  );
  return {
    user: userEvent.setup(),
    trigger: screen.getByRole("button", { name: "More terminal actions" }),
    first,
    last,
  };
}

it("opens on the first enabled item, skips disabled items and wraps", async () => {
  const { user, trigger } = setup();
  await user.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "Rename…" }),
  );
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "Clear" }),
  );
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "Rename…" }),
  );
  await user.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "Clear" }),
  );
});

it("runs the chosen item, closes and returns focus to the trigger", async () => {
  const { user, trigger, last } = setup();
  await user.click(trigger);
  await user.click(screen.getByRole("menuitem", { name: "Clear" }));
  expect(last).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("closes on Escape, Tab and outside pointer presses", async () => {
  const { user, trigger, first } = setup();
  await user.click(trigger);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(trigger);

  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("menu")).toBeTruthy();
  await user.keyboard("{Tab}");
  expect(screen.queryByRole("menu")).toBeNull();

  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "Outside" }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(first).not.toHaveBeenCalled();
});

it("renders outside clipping containers and opens above a trigger near the bottom", async () => {
  const { user, trigger } = setup();
  const geometry = vi
    .spyOn(trigger, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(300, window.innerHeight - 30, 24, 24));
  try {
    await user.click(trigger);
    const menu = screen.getByRole("menu");
    expect(menu.parentElement).toBe(document.body);
    expect(parseFloat(menu.style.top)).toBeLessThan(
      trigger.getBoundingClientRect().top,
    );
  } finally {
    geometry.mockRestore();
  }
});
