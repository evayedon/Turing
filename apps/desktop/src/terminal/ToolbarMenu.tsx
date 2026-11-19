import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

export type ToolbarMenuItem =
  { label: string; disabled?: boolean; run: () => void } | "-";

/** An icon button that opens a small keyboard-navigable action menu. */
export function ToolbarMenu({
  label,
  icon,
  items,
  disabled,
}: {
  label: string;
  icon: ReactNode;
  items: ToolbarMenuItem[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  const entries = () =>
    Array.from(
      menu.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );

  useEffect(() => {
    if (!open) return;
    entries()[0]?.focus();
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [open]);

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }

  return (
    <div className="toolbar-menu">
      <button
        ref={trigger}
        type="button"
        className="dock-action"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {icon}
      </button>
      {open && (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={label}
          className="toolbar-menu-list"
          onKeyDown={(event) => {
            const items = entries();
            const index = items.indexOf(event.target as HTMLButtonElement);
            const next =
              event.key === "ArrowDown"
                ? (index + 1) % items.length
                : event.key === "ArrowUp"
                  ? (index + items.length - 1) % items.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : undefined;
            if (next !== undefined) {
              event.preventDefault();
              items[next]?.focus();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close(true);
            } else if (event.key === "Tab") {
              close(false);
            }
          }}
        >
          {items.map((item, index) =>
            item === "-" ? (
              <div key={`separator-${index}`} role="separator" />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  close(true);
                  item.run();
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
