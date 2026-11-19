import { useEffect, useRef, useState } from "react";
import type { EditorTab } from "./use-editor";

const prefix = "turing:draft:v1:";
export const DRAFT_SNAPSHOT_INTERVAL_MS = 400;

type DraftSource =
  | { kind: "workspace"; root: string; relativePath: string; version: string }
  | { kind: "copy" };

export interface RecoveryDraft {
  id: string;
  name: string;
  title: string;
  draft: string;
  source: DraftSource;
  timestamp: number;
  languageOverride?: string;
}

export function isDirty(tab: EditorTab) {
  return (
    tab.draft !== tab.content ||
    (tab.recovered === true && tab.source.kind === "untitled")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDraft(value: unknown, id: string): value is RecoveryDraft {
  if (!isRecord(value) || !isRecord(value.source)) return false;
  const { source } = value;
  return (
    value.id === id &&
    typeof value.name === "string" &&
    typeof value.title === "string" &&
    typeof value.draft === "string" &&
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp) &&
    (value.languageOverride === undefined ||
      typeof value.languageOverride === "string") &&
    (source.kind === "copy" ||
      (source.kind === "workspace" &&
        typeof source.root === "string" &&
        typeof source.relativePath === "string" &&
        typeof source.version === "string"))
  );
}

function readDrafts() {
  const drafts: RecoveryDraft[] = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      try {
        const item: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
        if (isDraft(item, key.slice(prefix.length))) drafts.push(item);
      } catch {
        // A damaged entry must not prevent unrelated drafts from loading.
      }
    }
  } catch {
    // The editor can still operate if the WebView denies storage access.
  }
  return drafts.sort((left, right) => right.timestamp - left.timestamp);
}

export function useDraftRecovery(enabled: boolean) {
  const [available, setAvailable] = useState(() =>
    enabled ? readDrafts() : [],
  );
  const [error, setError] = useState<string>();
  const ids = useRef(new Map<string, string>());
  const queued = useRef(new Map<string, RecoveryDraft>());
  const timer = useRef<number | undefined>(undefined);

  function flush() {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    let failed = false;
    for (const [id, entry] of queued.current) {
      try {
        localStorage.setItem(prefix + id, JSON.stringify(entry));
        queued.current.delete(id);
      } catch {
        failed = true;
      }
    }
    if (failed)
      setError(
        "Draft recovery storage is unavailable. Save your edits before closing Turing.",
      );
  }

  useEffect(() => {
    if (!enabled) return;
    const flushOnHide = () => {
      if (document.hidden) flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flushOnHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flushOnHide);
      // A page reload or workbench unmount is not an explicit discard.
      flush();
    };
  }, [enabled]);

  function remove(id: string, snapshot?: RecoveryDraft) {
    try {
      const key = prefix + id;
      const stored = snapshot && localStorage.getItem(key);
      if (stored && stored !== JSON.stringify(snapshot)) {
        // A different window published a newer snapshot while this list was open.
        const tracked = new Set(ids.current.values());
        setAvailable(readDrafts().filter((entry) => !tracked.has(entry.id)));
        return;
      }
      localStorage.removeItem(key);
      queued.current.delete(id);
      setAvailable((drafts) =>
        drafts.some((entry) => entry.id === id)
          ? drafts.filter((entry) => entry.id !== id)
          : drafts,
      );
    } catch {
      queued.current.delete(id);
      setError("Turing could not remove a recovery draft from local storage.");
    }
  }

  function track(previous: EditorTab[], next: EditorTab[], root?: string) {
    if (!enabled) return;
    const old = new Map(previous.map((tab) => [tab.key, tab]));
    for (const tab of next) {
      const prior = old.get(tab.key);
      old.delete(tab.key);
      if (!isDirty(tab)) {
        forget(tab.key);
        continue;
      }
      if (
        prior?.draft === tab.draft &&
        prior.source === tab.source &&
        prior.languageOverride === tab.languageOverride
      )
        continue;
      const id = ids.current.get(tab.key) ?? crypto.randomUUID();
      ids.current.set(tab.key, id);
      queued.current.set(id, {
        id,
        name: tab.name,
        title: tab.title,
        draft: tab.draft,
        languageOverride: tab.languageOverride,
        timestamp: Date.now(),
        source:
          tab.source.kind === "workspace" && root
            ? {
                kind: "workspace",
                root,
                relativePath: tab.source.relativePath,
                version: tab.source.version,
              }
            : { kind: "copy" },
      });
    }
    for (const key of old.keys()) forget(key);
    if (queued.current.size && timer.current === undefined)
      timer.current = window.setTimeout(flush, DRAFT_SNAPSHOT_INTERVAL_MS);
  }

  function forget(key: string) {
    const id = ids.current.get(key);
    if (!id) return;
    ids.current.delete(key);
    remove(id);
  }

  function recovered(entry: RecoveryDraft, key: string) {
    // Keep the original when storage cannot durably accept the new copy.
    flush();
    const id = ids.current.get(key);
    if (!id || !queued.current.has(id)) remove(entry.id, entry);
  }

  return { available, error, track, remove, recovered };
}
