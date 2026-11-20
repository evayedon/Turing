import { useEffect, useEffectEvent, useState } from "react";
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
  managedSymbols,
}: {
  workspaceId: string;
  dismiss: () => void;
  navigate: (symbol: WorkspaceSymbol) => void;
  managedSymbols?: (
    query: string,
    signal: AbortSignal,
  ) => Promise<WorkspaceSymbol[]>;
}) {
  const [query, setQuery] = useState({ text: "" });
  const [managed, setManaged] = useState<{
    query: typeof query;
    symbols: WorkspaceSymbol[];
  }>();
  const searchManaged = useEffectEvent((text: string, signal: AbortSignal) =>
    managedSymbols?.(text, signal),
  );
  useEffect(() => {
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void searchManaged(query.text, abort.signal)?.then((symbols) => {
        if (!abort.signal.aborted) setManaged({ query, symbols });
      });
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [query, workspaceId]);
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
  const merged = new Map<string, WorkspaceSymbol>();
  for (const symbol of [
    ...(managed?.query === query ? managed.symbols : []),
    ...(result?.response?.symbols ?? []),
  ]) {
    const id = JSON.stringify([
      symbol.relativePath,
      symbol.line,
      symbol.character,
      symbol.name,
    ]);
    if (!merged.has(id)) merged.set(id, symbol);
  }
  const actions = [...merged.values()].slice(0, RESULT_LIMIT).map((symbol) => ({
    label: symbol.name,
    detail: `${symbol.kind} · ${symbol.relativePath}:${symbol.line + 1}`,
    symbol,
  }));

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
