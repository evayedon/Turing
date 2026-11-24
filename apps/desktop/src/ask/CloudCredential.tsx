import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import type { AskCredentialAction } from "@turing/contracts";
import { KeyRound } from "lucide-react";
import { cloudCredential } from "./ask-ipc";
import { askErrorMessage } from "./ask-errors";

export function CloudCredential({ disabled }: { disabled: boolean }) {
  const field = useId();
  const [configured, setConfigured] = useState<boolean>();
  const [saving, setSaving] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void cloudCredential({ kind: "status" }).then(
      (stored) => {
        if (active) {
          setConfigured(stored);
          setSaving(false);
        }
      },
      (cause: unknown) => {
        if (active) {
          setError(askErrorMessage(cause));
          setSaving(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);

  async function update(action: AskCredentialAction) {
    setSaving(true);
    setError("");
    try {
      setConfigured(await cloudCredential(action));
    } catch (cause) {
      setError(askErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const key = new FormData(form).get("key");
    form.reset();
    if (typeof key === "string" && key.trim())
      void update({ kind: "save", key });
  }

  return (
    <details
      className="ask-credentials"
      data-configured={configured ? "" : undefined}
      open={configured === false || undefined}
    >
      <summary>
        <KeyRound size={13} aria-hidden="true" />
        {configured ? "OpenRouter API key saved" : "OpenRouter API key"}
      </summary>
      <form onSubmit={save}>
        <label htmlFor={field}>OpenRouter API key</label>
        <input
          id={field}
          name="key"
          type="password"
          autoComplete="off"
          maxLength={512}
          required
          disabled={disabled || saving}
        />
        <div className="ask-actions">
          <button type="submit" disabled={disabled || saving}>
            Save key
          </button>
          {configured && (
            <button
              type="button"
              disabled={disabled || saving}
              onClick={() => void update({ kind: "remove" })}
            >
              Remove key
            </button>
          )}
        </div>
      </form>
      {error && (
        <p className="ask-error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
