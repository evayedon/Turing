import { ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { menus } from "./commands";
import type { CommandId } from "./commands";
import type { CommandViews } from "./command-registry";

export function MenuBar({
  commands,
  onRun,
}: {
  commands: CommandViews;
  onRun: (id: CommandId) => void;
}) {
  const [open, setOpen] = useState<number>();
  const [submenu, setSubmenu] = useState<number>();
  const [tab, setTab] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const restoringSubmenu = useRef(false);
  const submenuOrigin = useRef<HTMLButtonElement>(null);
  const top = (index: number) =>
    root.current?.querySelectorAll<HTMLButtonElement>("[data-menu-trigger]")[
      index
    ];

  function openMenu(index: number, last = false) {
    focusLast.current = last;
    setTab(index);
    setSubmenu(undefined);
    if (open === index) {
      const buttons = root.current?.querySelectorAll<HTMLButtonElement>(
        "[data-menu-root] > button",
      );
      (last ? [...(buttons ?? [])].at(-1) : buttons?.[0])?.focus();
    }
    setOpen(index);
  }

  function close(restore: boolean) {
    if (restore && open !== undefined) top(open)?.focus();
    setOpen(undefined);
    setSubmenu(undefined);
  }

  useLayoutEffect(() => {
    if (open === undefined) return;
    if (restoringSubmenu.current && submenu === undefined) {
      restoringSubmenu.current = false;
      submenuOrigin.current?.focus();
      return;
    }
    const menu = root.current?.querySelector(
      submenu === undefined ? "[data-menu-root]" : "[data-menu-sub]",
    );
    const buttons = [
      ...(menu?.querySelectorAll<HTMLButtonElement>(":scope > button") ?? []),
    ];
    (focusLast.current ? buttons.at(-1) : buttons[0])?.focus();
    focusLast.current = false;
  }, [open, submenu]);

  useEffect(() => {
    if (open === undefined) return;
    function outside(event: PointerEvent) {
      if (root.current && !event.composedPath().includes(root.current)) {
        setOpen(undefined);
        setSubmenu(undefined);
      }
    }
    function blur() {
      setOpen(undefined);
      setSubmenu(undefined);
    }
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", blur);
    };
  }, [open]);

  function moveMenu(index: number) {
    if (open !== undefined) openMenu(index);
    else {
      setTab(index);
      top(index)?.focus();
    }
  }

  function menuKeys(event: KeyboardEvent<HTMLDivElement>, nested: boolean) {
    const key = event.key;
    if (key === "Escape" || (nested && key === "ArrowLeft")) {
      event.preventDefault();
      event.stopPropagation();
      if (!nested) close(true);
      else {
        restoringSubmenu.current = true;
        setSubmenu(undefined);
      }
      return;
    }
    if (key === "Tab") {
      close(true);
      return;
    }
    if (!nested && (key === "ArrowLeft" || key === "ArrowRight")) {
      if (
        key === "ArrowRight" &&
        event.target instanceof HTMLButtonElement &&
        event.target.hasAttribute("data-submenu-index")
      ) {
        submenuOrigin.current = event.target;
        setSubmenu(Number(event.target.dataset.submenuIndex));
      } else if (open !== undefined) {
        moveMenu(
          (open + (key === "ArrowRight" ? 1 : menus.length - 1)) % menus.length,
        );
      }
      event.preventDefault();
      return;
    }
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        ":scope > button",
      ),
    ];
    const index = items.findIndex((item) => item === event.target);
    const next =
      key === "Home"
        ? 0
        : key === "End"
          ? items.length - 1
          : key === "ArrowDown"
            ? (index + 1) % items.length
            : key === "ArrowUp"
              ? (index + items.length - 1) % items.length
              : undefined;
    if (next !== undefined) {
      event.preventDefault();
      items[next]?.focus();
    }
  }

  function item(id: CommandId) {
    const command = commands[id];
    if (!command.visible) return null;
    const hint = command.hint;
    return (
      <button
        key={id}
        type="button"
        role={command.pressed === undefined ? "menuitem" : "menuitemcheckbox"}
        aria-checked={command.pressed}
        aria-description={hint}
        aria-disabled={!command.enabled || undefined}
        tabIndex={-1}
        onClick={() => {
          if (!command.enabled) return;
          close(true);
          onRun(id);
        }}
      >
        <span>{command.label}</span>
        {hint && <kbd aria-hidden="true">{hint}</kbd>}
      </button>
    );
  }

  return (
    <div
      ref={root}
      className="workbench-menubar"
      role="menubar"
      aria-label="Turing menus"
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          close(false);
      }}
    >
      {menus.map(({ label, entries }, index) => (
        <div key={label} className="workbench-menu" role="none">
          <button
            type="button"
            role="menuitem"
            data-menu-trigger=""
            tabIndex={tab === index ? 0 : -1}
            aria-haspopup="menu"
            aria-expanded={open === index}
            onMouseEnter={() => {
              if (open !== undefined && open !== index) openMenu(index);
            }}
            onClick={() => {
              if (open === index) close(true);
              else openMenu(index);
            }}
            onKeyDown={(event) => {
              const key = event.key;
              if (key === "ArrowDown" || key === "ArrowUp") {
                event.preventDefault();
                openMenu(index, key === "ArrowUp");
              }
              if (
                key === "ArrowLeft" ||
                key === "ArrowRight" ||
                key === "Home" ||
                key === "End"
              ) {
                event.preventDefault();
                moveMenu(
                  key === "Home"
                    ? 0
                    : key === "End"
                      ? menus.length - 1
                      : (index +
                          (key === "ArrowRight" ? 1 : menus.length - 1)) %
                        menus.length,
                );
              }
            }}
          >
            {label}
          </button>
          {open === index && (
            <div
              className="workbench-menu-panel"
              data-menu-root=""
              role="menu"
              aria-label={`${label} actions`}
              onKeyDown={(event) => menuKeys(event, false)}
            >
              {entries.map((entry, row) =>
                entry === "-" ? (
                  <div key={row} role="separator" />
                ) : typeof entry === "string" ? (
                  item(entry)
                ) : (
                  <button
                    key={entry.label}
                    type="button"
                    data-submenu-index={row}
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={submenu === row}
                    tabIndex={-1}
                    onClick={(event) => {
                      submenuOrigin.current = event.currentTarget;
                      setSubmenu(submenu === row ? undefined : row);
                    }}
                  >
                    <span>{entry.label}</span>
                    <ChevronRight size={13} aria-hidden="true" />
                  </button>
                ),
              )}
            </div>
          )}
          {open === index &&
            entries.map(
              (entry, row) =>
                typeof entry !== "string" &&
                submenu === row && (
                  <div
                    key={entry.label}
                    className="workbench-menu-panel workbench-submenu"
                    data-menu-sub=""
                    role="menu"
                    aria-label={entry.label}
                    onKeyDown={(event) => menuKeys(event, true)}
                  >
                    {entry.entries.map(item)}
                  </div>
                ),
            )}
        </div>
      ))}
    </div>
  );
}
