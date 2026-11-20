import { useEffect, useState } from "react";
import type { SymbolsResponse, WorkspaceSymbol } from "@turing/contracts";
import {
  invokeWorkspace,
  workspaceErrorMessage,
} from "../explorer/workspace-ipc";
import { CommandPalette } from "./CommandPalette";

const DEBOUNCE_MS = 150;
const REFRESH_MS = 500;
const RESULT_LIMIT = 100;

export function WorkspaceSymbolPicker({
  workspaceId,
  dismiss,
  navigate,
}: {
  workspaceId: string;
  dismiss: () => void;
  navigate: (symbol: WorkspaceSymbol) => void;
}) {
  const [query, setQuery] = useState({ text: "" });
  const [reply, setReply] = useState<{
    workspaceId: string;
    query: typeof query;
    response?: SymbolsResponse;
    error?: string;
  }>();

  useEffect(() => {
    let current = true;
    let timer = window.setTimeout(refresh, DEBOUNCE_MS);
    async function refresh() {
      try {
        const response = await invokeWorkspace("workspace_symbols_query", {
          workspaceId,
          query: query.text,
          limit: RESULT_LIMIT,
        });
        if (!current) return;
        setReply({ workspaceId, query, response });
        timer = window.setTimeout(
          refresh,
          response.complete ? REFRESH_MS : DEBOUNCE_MS,
        );
      } catch (error) {
        if (current) {
          setReply({ workspaceId, query, error: workspaceErrorMessage(error) });
        }
      }
    }
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [workspaceId, query]);

  const result =
    reply?.workspaceId === workspaceId && reply.query === query
      ? reply
      : undefined;
  const actions =
    result?.response?.symbols.map((symbol) => ({
      label: symbol.name,
      detail: `${symbol.kind} · ${symbol.relativePath}:${symbol.line + 1}`,
      symbol,
    })) ?? [];

  return (
    <CommandPalette
      title="Go to Symbol in Workspace"
      inputLabel="Search workspace symbols"
      placeholder="Search workspace symbols…"
      emptyMessage="No matching symbols."
      actionLabel="Go to Symbol"
      notice={
        result?.error ??
        (!result?.response
          ? "Starting workspace symbol index…"
          : !result.response.complete
            ? "Indexing workspace symbols…"
            : result.response.truncated
              ? "Symbol results are limited."
              : undefined)
      }
      onQueryChange={(value) => {
        if (value === query.text) return;
        setReply(undefined);
        setQuery({ text: value });
      }}
      actions={actions}
      dismiss={dismiss}
      run={({ symbol }) => navigate(symbol)}
    />
  );
}
