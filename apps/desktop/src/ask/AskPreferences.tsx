import { useId, useState } from "react";
import type { FormEvent } from "react";
import type { AskPreferences } from "./ask-history";

export function AskProjectPreferences({
  modelId,
  preferences,
  retain,
  disabled,
  save,
  setRetention,
  clear,
}: {
  modelId: string;
  preferences: AskPreferences;
  retain: boolean;
  disabled: boolean;
  save: (preferences: AskPreferences) => void;
  setRetention: (enabled: boolean) => void;
  clear: () => void;
}) {
  const field = useId();
  const [conventions, setConventions] = useState(preferences.conventions);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save({ modelId, conventions: conventions.trim() });
  }

  return (
    <details className="ask-credentials">
      <summary>Project preferences and history</summary>
      <form className="ask-form" onSubmit={submit}>
        <label htmlFor={field}>Project conventions</label>
        <textarea
          id={field}
          rows={2}
          value={conventions}
          maxLength={256}
          onChange={(event) => setConventions(event.target.value)}
        />
        <p>
          Saved conventions accompany questions, including in the cloud sharing
          preview.
        </p>
        <div className="ask-actions">
          <button type="submit" disabled={disabled}>
            Save conventions and selected model
          </button>
        </div>
      </form>
      <label>
        <input
          type="checkbox"
          checked={retain}
          disabled={disabled}
          onChange={(event) => setRetention(event.target.checked)}
        />
        Keep the last 20 completed answers for this folder on this device
      </label>
      <div className="ask-actions">
        <button type="button" disabled={disabled} onClick={clear}>
          Clear conversation
        </button>
      </div>
    </details>
  );
}
