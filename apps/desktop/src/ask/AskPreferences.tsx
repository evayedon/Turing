import { useId, useState } from "react";
import type { FormEvent } from "react";
import { Gauge, Server } from "lucide-react";
import {
  MAX_DAILY_TOKENS,
  localDay,
  parseDailyLimit,
  validLocalAddress,
} from "./ask-history";
import type { AskPreferences, CloudBudget, LocalServer } from "./ask-history";
import { askErrorMessage } from "./ask-errors";

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
            Save conventions
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

export function AskLocalServer({
  server,
  disabled,
  save,
}: {
  server: LocalServer;
  disabled: boolean;
  save: (server: LocalServer) => void;
}) {
  const addressField = useId();
  const modelField = useId();
  const [address, setAddress] = useState(server.address);
  const [model, setModel] = useState(server.model);
  const [error, setError] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validLocalAddress(address.trim())) {
      setError(askErrorMessage("INVALID_LOCAL_SERVER"));
      return;
    }
    setError("");
    save({ address: address.trim(), model: model.trim() });
  }

  return (
    <details className="ask-credentials">
      <summary>
        <Server size={13} aria-hidden="true" />
        Local server · {server.address}
        {server.model ? ` · ${server.model}` : ""}
      </summary>
      <form onSubmit={submit}>
        <label htmlFor={addressField}>Local server address</label>
        <input
          id={addressField}
          value={address}
          maxLength={32}
          autoComplete="off"
          spellCheck={false}
          required
          disabled={disabled}
          onChange={(event) => setAddress(event.target.value)}
        />
        <label htmlFor={modelField}>Local model name (optional)</label>
        <input
          id={modelField}
          value={model}
          maxLength={256}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          onChange={(event) => setModel(event.target.value)}
        />
        <p>
          Loopback only. llama-server 127.0.0.1:8080, Ollama 127.0.0.1:11434
          (model name required), LM Studio 127.0.0.1:1234.
        </p>
        <div className="ask-actions">
          <button type="submit" disabled={disabled}>
            Save local server
          </button>
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

export function budgetUsage(budget: CloudBudget) {
  const used = budget.days[localDay()] ?? 0;
  const amount =
    budget.limit === undefined
      ? `${used.toLocaleString()} tokens`
      : `${used.toLocaleString()} of ${budget.limit.toLocaleString()} tokens`;
  return {
    amount,
    exceeded: budget.limit !== undefined && used >= budget.limit,
    text: `Today: ${amount} (measured)`,
  };
}

export function AskCloudBudget({
  budget,
  save,
}: {
  budget: CloudBudget;
  save: (limit: number | undefined) => void;
}) {
  const field = useId();
  const [limit, setLimit] = useState(budget.limit?.toString() ?? "");
  const [error, setError] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseDailyLimit(limit);
    if (parsed === null) {
      setError(
        `Enter a whole number of tokens from 1 to ${MAX_DAILY_TOKENS.toLocaleString()}, or leave it empty for no limit.`,
      );
      return;
    }
    setError("");
    setLimit(parsed?.toString() ?? "");
    save(parsed);
  }

  return (
    <details className="ask-credentials">
      <summary>
        <Gauge size={13} aria-hidden="true" />
        Cloud budget · {budgetUsage(budget).text}
      </summary>
      <form onSubmit={submit}>
        <label htmlFor={field}>Daily token limit (optional)</label>
        <input
          id={field}
          value={limit}
          inputMode="numeric"
          maxLength={16}
          autoComplete="off"
          onChange={(event) => setLimit(event.target.value)}
        />
        <p>
          Counts input and output tokens that OpenRouter reports for cloud
          answers on this device. Turing asks before sending once today&apos;s
          limit is used.
        </p>
        <div className="ask-actions">
          <button type="submit">Save budget</button>
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
