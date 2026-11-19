import { X } from "lucide-react";
import { useId, useLayoutEffect, useRef } from "react";
import { problemGroups } from "../language/problems";
import type { LanguageController } from "../language/use-language";

export function SettingsDialog({
  close,
  native,
  autoSave,
  toggleAutoSave,
  bottom,
  assistant,
  toggleBottom,
  toggleAssistant,
  resetSizes,
  language,
  workspaceId,
  severity,
  setSeverity,
}: {
  close: () => void;
  native: boolean;
  autoSave: boolean;
  toggleAutoSave: () => void;
  bottom: boolean;
  assistant: boolean;
  toggleBottom: () => void;
  toggleAssistant: () => void;
  resetSizes: () => void;
  language: LanguageController;
  workspaceId?: string;
  severity: string;
  setSeverity: (value: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const title = useId();
  const autoSaveDescription = useId();
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = document.activeElement;
    if (typeof element.showModal === "function") element.showModal();
    else element.open = true;
    closeButton.current?.focus();
    return () => {
      if (typeof element.close === "function") element.close();
      else element.open = false;
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);

  const status =
    language.message ??
    (language.status === "starting"
      ? "Starting clangd…"
      : language.status === "ready"
        ? "clangd is ready for open C/C++ workspace files."
        : !native
          ? "Live diagnostics require the desktop app."
          : !workspaceId
            ? "Open a workspace folder to enable C/C++ language intelligence."
            : "C/C++ language intelligence is off.");

  return (
    <dialog
      ref={dialog}
      className="settings-dialog"
      aria-labelledby={title}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        close();
      }}
    >
      <header className="panel-heading">
        <h2 id={title}>Settings</h2>
        <button
          ref={closeButton}
          type="button"
          className="icon-button"
          aria-label="Close settings"
          title="Close settings"
          onClick={close}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <fieldset className="settings-group">
        <legend>Files</legend>
        <label className="settings-row">
          <span>
            Auto Save
            <small id={autoSaveDescription}>
              {native
                ? "Save changes to files already on disk after a short pause."
                : "Auto Save requires the desktop app."}
            </small>
          </span>
          <input
            type="checkbox"
            aria-label="Auto Save"
            aria-describedby={autoSaveDescription}
            checked={autoSave}
            disabled={!native}
            onChange={toggleAutoSave}
          />
        </label>
      </fieldset>
      <fieldset className="settings-group">
        <legend>Diagnostics</legend>
        <div className="settings-row">
          <span role="status">{status}</span>
          {native && workspaceId && (
            <button
              type="button"
              className="settings-button"
              disabled={language.status === "starting"}
              onClick={() =>
                language.status === "ready"
                  ? language.stop()
                  : void language.start()
              }
            >
              {language.status === "ready"
                ? "Stop clangd"
                : language.status === "failed"
                  ? "Retry clangd"
                  : "Enable clangd"}
            </button>
          )}
        </div>
        <label className="settings-row">
          Severity
          <select
            value={severity}
            onChange={(event) => setSeverity(event.target.value)}
          >
            <option value="all">All</option>
            {problemGroups.map(({ severity, title }) => (
              <option key={severity} value={severity}>
                {title}
              </option>
            ))}
          </select>
        </label>
      </fieldset>
      <fieldset className="settings-group">
        <legend>Layout</legend>
        <label className="settings-row">
          Show bottom panel
          <input type="checkbox" checked={bottom} onChange={toggleBottom} />
        </label>
        <label className="settings-row">
          Show Turing AI panel
          <input
            type="checkbox"
            checked={assistant}
            onChange={toggleAssistant}
          />
        </label>
        <div className="settings-row">
          <button
            type="button"
            className="settings-button"
            onClick={resetSizes}
          >
            Reset panel sizes
          </button>
        </div>
      </fieldset>
    </dialog>
  );
}
