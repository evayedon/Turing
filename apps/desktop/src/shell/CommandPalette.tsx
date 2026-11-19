import { Search } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
type PaletteEntry = {
  label: string;
  disabled?: boolean;
  hidden?: boolean;
  hint?: string;
};

export function CommandPalette<Action extends PaletteEntry>({
  actions,
  dismiss,
  run,
  title = "Command palette",
  inputLabel = "Search commands",
  placeholder = "Search commands…",
  notice,
}: {
  actions: Action[];
  dismiss: () => void;
  run: (action: Action) => void;
  title?: string;
  inputLabel?: string;
  placeholder?: string;
  notice?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  function close() {
    dialog.current?.close?.();
    dismiss();
  }
  function execute(action: Action) {
    dialog.current?.close?.();
    run(action);
  }
  const words = query.trim().toLowerCase().split(/\s+/);
  const matching = actions.filter(
    ({ label, disabled, hidden }) =>
      !disabled &&
      !hidden &&
      words.every((word) => label.toLowerCase().includes(word)),
  );
  const matches = matching.slice(0, 100);
  const selected = Math.min(index, matches.length - 1);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (typeof element.showModal === "function") element.showModal();
    else element.open = true;
    input.current?.focus();
    return () => {
      if (typeof element.close === "function") element.close();
      else element.open = false;
    };
  }, []);

  useLayoutEffect(() => {
    dialog.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selected, query]);

  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    >
      <div className="palette-body">
        <label className="palette-input">
          <Search size={17} aria-hidden="true" />
          <input
            ref={input}
            role="combobox"
            aria-label={inputLabel}
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={
              selected >= 0 ? `palette-option-${selected}` : undefined
            }
            placeholder={placeholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Tab") {
                event.preventDefault();
                return;
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (matches.length)
                  setIndex(
                    (selected +
                      (event.key === "ArrowDown" ? 1 : matches.length - 1)) %
                      matches.length,
                  );
              }
              if (
                event.key === "Enter" &&
                selected >= 0 &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                execute(matches[selected]);
              }
            }}
          />
          <kbd>Esc</kbd>
        </label>
        <ul id="palette-results" role="listbox" aria-label="Commands">
          {matches.map((action, i) => (
            <li
              id={`palette-option-${i}`}
              key={`${action.label}:${i}`}
              role="option"
              aria-selected={i === selected}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => execute(action)}
            >
              {action.label}
              {action.hint && <kbd>{action.hint}</kbd>}
            </li>
          ))}
        </ul>
        {!matches.length && (
          <p className="panel-message" role="status">
            No matching commands.
          </p>
        )}
        {matching.length > matches.length && (
          <p className="panel-message" role="status">
            Keep typing to narrow the results.
          </p>
        )}
        {notice && (
          <p className="panel-message" role="status">
            {notice}
          </p>
        )}
        <footer>
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> Navigate
          </span>
          <span>
            <kbd>Enter</kbd> Run
          </span>
        </footer>
      </div>
    </dialog>
  );
}
