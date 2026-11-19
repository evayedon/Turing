import { Braces } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { documentLanguage, languages } from "./languages";
import type { EditorTab } from "./use-editor";

export function LanguagePicker({
  tab,
  select,
}: {
  tab: EditorTab;
  select: (language: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    picker.current
      ?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
      ?.focus();
  }, [open]);
  const label = documentLanguage(tab).label;
  function dismiss() {
    setOpen(false);
    trigger.current?.focus();
  }
  return (
    <div
      className="language-picker"
      onBlur={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
    >
      <button
        type="button"
        ref={trigger}
        title="Select language mode"
        aria-label={`Language mode: ${label}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Braces size={13} aria-hidden="true" /> {label}
      </button>
      {open && (
        <div
          ref={picker}
          role="group"
          aria-label="Select language mode"
          className="language-options"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              dismiss();
            }
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            const options = [...event.currentTarget.querySelectorAll("button")];
            const current = options.findIndex(
              (button) => button === event.target,
            );
            const direction = event.key === "ArrowDown" ? 1 : -1;
            event.preventDefault();
            options[
              (current + direction + options.length) % options.length
            ]?.focus();
          }}
        >
          {[{ label: "Automatic", id: undefined }, ...languages].map(
            ({ id, label }) => (
              <button
                key={id ?? "auto"}
                type="button"
                aria-pressed={tab.languageOverride === id}
                onClick={() => {
                  select(id);
                  dismiss();
                }}
              >
                {label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
