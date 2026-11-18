import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

export interface MenuAction {
  label: string;
  run: () => void;
  disabled?: boolean;
  pressed?: boolean;
  hint?: string;
}

export function ActionMenu({
  label,
  actions,
  children,
}: {
  label: string;
  actions: MenuAction[];
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!expanded || !root.current) return;
    const menu = root.current;
    const document = menu.ownerDocument;
    const window = document.defaultView;

    function dismiss() {
      setExpanded(false);
    }
    function onClick(event: MouseEvent) {
      if (!event.composedPath().includes(menu)) dismiss();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
        return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      trigger.current?.focus();
    }

    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    window?.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      window?.removeEventListener("blur", dismiss);
    };
  }, [expanded]);

  return (
    <div
      className="action-menu"
      ref={root}
      onBlur={(event) => {
        // Some WebViews report no next focus when clicking a button. Let the
        // composed click path handle that case so an inside click can run.
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          setExpanded(false);
        }
      }}
    >
      <button
        type="button"
        ref={trigger}
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => {
          trigger.current?.focus();
          setExpanded((previous) => !previous);
        }}
      >
        {label}
      </button>
      <div
        id={panelId}
        hidden={!expanded}
        className="action-menu-panel"
        role="group"
        aria-label={`${label} actions`}
      >
        {actions.map(({ label, run, disabled, pressed, hint }) => (
          <button
            key={label}
            type="button"
            disabled={disabled}
            aria-pressed={pressed}
            onClick={() => {
              setExpanded(false);
              trigger.current?.focus();
              run();
            }}
          >
            {label}
            {hint && <kbd aria-hidden="true">{hint}</kbd>}
            {pressed !== undefined && (
              <span className="action-menu-state" aria-hidden="true">
                {pressed ? "On" : "Off"}
              </span>
            )}
          </button>
        ))}
        {children}
      </div>
    </div>
  );
}
