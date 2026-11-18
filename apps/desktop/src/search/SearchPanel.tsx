import { useEffect, useRef, useState } from "react";
import { FileSearch, Search } from "lucide-react";
import type {
  SearchMatch,
  SearchOptions,
  SearchResponse,
} from "@turing/contracts";
import type { EditorLocation } from "../editor/use-editor";
import {
  invokeWorkspace,
  workspaceErrorMessage,
} from "../explorer/workspace-ipc";

type SearchState =
  | { kind: "idle" | "running" | "cancelled" }
  | { kind: "failed"; message: string }
  | { kind: "finished"; response: SearchResponse };

interface Request {
  cancelled: boolean;
  id?: string;
}

function cancelRequest(workspaceId: string, request: Request) {
  request.cancelled = true;
  if (request.id) {
    void invokeWorkspace("workspace_search_cancel", {
      workspaceId,
      searchId: request.id,
    }).catch(() => {
      // Workspace revocation can win the race and cancel this request itself.
    });
  }
}

export function SearchPanel({
  workspaceId,
  native,
  editorBusy,
  open,
}: {
  workspaceId?: string;
  native: boolean;
  editorBusy: boolean;
  open: (path: string, location: EditorLocation) => void;
}) {
  if (!native || !workspaceId) {
    return (
      <div className="pane-empty">
        <FileSearch size={17} aria-hidden="true" />
        <p>
          {native
            ? "Open a folder to search its files."
            : "Workspace search requires the desktop app."}
        </p>
      </div>
    );
  }
  return (
    <WorkspaceSearch
      key={workspaceId}
      workspaceId={workspaceId}
      editorBusy={editorBusy}
      open={open}
    />
  );
}

function WorkspaceSearch({
  workspaceId,
  editorBusy,
  open,
}: {
  workspaceId: string;
  editorBusy: boolean;
  open: (path: string, location: EditorLocation) => void;
}) {
  const [options, setOptions] = useState<SearchOptions>({
    query: "",
    caseSensitive: false,
    wholeWord: false,
    filenameFilter: "",
  });
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const [pending, setPending] = useState(false);
  const active = useRef<Request | null>(null);
  const query = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      if (active.current) cancelRequest(workspaceId, active.current);
      active.current = null;
    },
    [workspaceId],
  );

  async function search() {
    if (active.current || !options.query.trim()) return;
    const request: Request = { cancelled: false };
    active.current = request;
    setPending(true);
    setState({ kind: "running" });
    try {
      request.id = await invokeWorkspace("workspace_search_begin", {
        workspaceId,
        options,
      });
      if (request.cancelled) {
        await invokeWorkspace("workspace_search_cancel", {
          workspaceId,
          searchId: request.id,
        });
        return;
      }
      const response = await invokeWorkspace("workspace_search_run", {
        workspaceId,
        searchId: request.id,
      });
      if (!request.cancelled) setState({ kind: "finished", response });
    } catch (cause) {
      if (!request.cancelled)
        setState(
          cause === "SEARCH_CANCELLED"
            ? { kind: "cancelled" }
            : { kind: "failed", message: workspaceErrorMessage(cause) },
        );
    } finally {
      if (active.current === request) {
        active.current = null;
        setPending(false);
      }
    }
  }

  return (
    <>
      <form
        className="workspace-search"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label>
          Search text
          <input
            ref={query}
            type="search"
            maxLength={256}
            value={options.query}
            onChange={(event) =>
              setOptions({ ...options, query: event.target.value })
            }
          />
        </label>
        <label>
          Filename filter
          <input
            type="text"
            maxLength={256}
            placeholder="Optional, e.g. .tsx"
            value={options.filenameFilter}
            onChange={(event) =>
              setOptions({ ...options, filenameFilter: event.target.value })
            }
          />
        </label>
        <div className="search-options">
          <label>
            <input
              type="checkbox"
              checked={options.caseSensitive}
              onChange={(event) =>
                setOptions({ ...options, caseSensitive: event.target.checked })
              }
            />
            Match case
          </label>
          <label>
            <input
              type="checkbox"
              checked={options.wholeWord}
              onChange={(event) =>
                setOptions({ ...options, wholeWord: event.target.checked })
              }
            />
            Whole word
          </label>
        </div>
        <div className="search-actions">
          <button
            type="submit"
            className="quiet-button"
            disabled={pending || !options.query.trim()}
          >
            <Search size={14} aria-hidden="true" /> Search
          </button>
          {state.kind === "running" && (
            <button
              type="button"
              className="quiet-button"
              onClick={() => {
                if (active.current) cancelRequest(workspaceId, active.current);
                setState({ kind: "cancelled" });
                query.current?.focus();
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </form>
      {state.kind === "idle" && (
        <p className="panel-message">Enter text to search files on disk.</p>
      )}
      {state.kind === "running" && (
        <p className="panel-message" role="status">
          Searching workspace…
        </p>
      )}
      {state.kind === "cancelled" && (
        <p className="panel-message" role="status">
          Search canceled.
        </p>
      )}
      {state.kind === "failed" && (
        <p className="panel-message search-error" role="alert">
          {state.message}
        </p>
      )}
      {state.kind === "finished" && (
        <SearchResults
          response={state.response}
          editorBusy={editorBusy}
          open={open}
        />
      )}
    </>
  );
}

function SearchResults({
  response,
  editorBusy,
  open,
}: {
  response: SearchResponse;
  editorBusy: boolean;
  open: (path: string, location: EditorLocation) => void;
}) {
  const count = response.files.reduce(
    (sum, file) => sum + file.matches.length,
    0,
  );

  function hit(path: string, match: SearchMatch) {
    const { line, column, before, text, after } = match;
    return (
      <li key={`${line}:${column}`}>
        <button
          type="button"
          disabled={editorBusy}
          onClick={() => open(path, { line, column })}
          aria-label={`${path}, line ${line}, column ${column}: ${before}${text}${after}`}
        >
          <span className="search-position" aria-hidden="true">
            {line}:{column}
          </span>
          <span className="search-snippet">
            {before}
            <mark>{text}</mark>
            {after}
          </span>
        </button>
      </li>
    );
  }

  return (
    <>
      <p className="panel-message" role="status">
        {count === 0
          ? "No matches found."
          : `${count} ${count === 1 ? "match" : "matches"} in ${response.files.length} ${response.files.length === 1 ? "file" : "files"}.`}
        {response.truncated &&
          " Search reached a scan limit. Refine your query for more targeted results."}
        {response.skippedFiles > 0 &&
          ` Skipped ${response.skippedFiles} unreadable, changed, or unsupported entries.`}
      </p>
      {response.files.map(({ relativePath, matches }) => (
        <details className="search-file" key={relativePath} open>
          <summary title={relativePath}>
            {relativePath} <span>({matches.length})</span>
          </summary>
          <ul aria-label={`Matches in ${relativePath}`}>
            {matches.map((match) => hit(relativePath, match))}
          </ul>
        </details>
      ))}
    </>
  );
}
