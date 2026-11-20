import { useId, useRef } from "react";
import { FileCode2, X } from "lucide-react";
import { isDirty } from "./use-draft-recovery";
import type { EditorTab } from "./use-editor";

/** One editor group's tabs, with arrow-key, Home and End navigation. */
export function EditorTabStrip({
  label,
  panelId,
  tabs,
  active,
  busy,
  select,
  close,
}: {
  label: string;
  panelId: string;
  tabs: EditorTab[];
  active?: EditorTab;
  busy: boolean;
  select: (key: string) => void;
  close: (tab: EditorTab) => unknown;
}) {
  const id = useId();
  const strip = useRef<HTMLDivElement>(null);
  return (
    <div className="editor-tabs" ref={strip}>
      {/* Close buttons share the visual strip but sit outside the ARIA tablist. */}
      <div
        role="tablist"
        aria-label={label}
        aria-owns={tabs.map((_, index) => `${id}-${index}`).join(" ")}
      />
      {tabs.map((tab, index) => {
        const { name } = tab;
        const dirty = isDirty(tab);
        return (
          <div className="editor-tab" key={tab.key}>
            <button
              type="button"
              role="tab"
              id={`${id}-${index}`}
              aria-controls={active === tab ? panelId : undefined}
              title={tab.title}
              aria-selected={active === tab}
              aria-label={dirty ? `${name} (unsaved)` : name}
              disabled={busy}
              tabIndex={active === tab ? 0 : -1}
              onClick={() => select(tab.key)}
              onKeyDown={(event) => {
                const next =
                  event.key === "ArrowLeft"
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === "ArrowRight"
                      ? (index + 1) % tabs.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? tabs.length - 1
                          : undefined;
                if (next === undefined) return;
                event.preventDefault();
                const buttons =
                  strip.current?.querySelectorAll<HTMLButtonElement>(
                    '[role="tab"]',
                  );
                buttons?.[next]?.focus();
                select(tabs[next].key);
              }}
            >
              <FileCode2 size={14} aria-hidden="true" />
              <span>{name}</span>
              {dirty && (
                <span className="editor-dirty" aria-hidden="true">
                  {" "}
                  ●
                </span>
              )}
            </button>
            <button
              type="button"
              disabled={busy}
              aria-label={`Close ${name}`}
              onClick={() => void close(tab)}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
