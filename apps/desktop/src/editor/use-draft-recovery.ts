import { useEffect, useEffectEvent, useRef, useState } from "react";
import { isLargeDocument } from "./performance-budget";
import type { EditorTab } from "./use-editor";

import type { RecoveryDraft, RecoveryRequest } from "@turing/contracts";
import { invokeRecovery } from "./draft-ipc";

const prefix = "turing:draft:v1:";
export const DRAFT_SNAPSHOT_INTERVAL_MS = 400;

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
    Number.isSafeInteger(value.timestamp) &&
    value.timestamp >= 0 &&
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
  const drafts: { key: string; raw: string; entry: RecoveryDraft }[] = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      try {
        const raw = localStorage.getItem(key);
        if (raw === null) continue;
        const item: unknown = JSON.parse(raw);
        if (isDraft(item, key.slice(prefix.length)))
          drafts.push({ key, raw, entry: item });
      } catch {
        // A damaged entry must not prevent unrelated drafts from loading.
      }
    }
  } catch {
    // The editor can still operate if the WebView denies storage access.
  }
  return drafts;
}

type Snapshot = Extract<RecoveryRequest, { action: "snapshot" }>;
type Tracked = {
  stored?: string;
  original?: string;
  scheduled?: boolean;
  tooLarge?: boolean;
};

export function useDraftRecovery(enabled: boolean) {
  const [available, setAvailable] = useState<RecoveryDraft[]>([]);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const tracked = useRef(new Map<string, Tracked>());
  const queued = useRef(new Map<string, Snapshot>());
  const timer = useRef<number | undefined>(undefined);
  const operations = useRef(Promise.resolve());

  function notice(key: string, message?: string) {
    setNotices((previous) => {
      if (previous[key] === message) return previous;
      const next = { ...previous };
      if (message) next[key] = message;
      else delete next[key];
      return next;
    });
  }

  function unavailable(key: string, name: string) {
    notice(
      key,
      `Recovery is unavailable for ${name}'s latest edits. Save the document before closing Turing.`,
    );
  }

  function enqueue<T>(action: () => Promise<T>) {
    const result = operations.current.then(action);
    operations.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function hide(id: string) {
    setAvailable((entries) => entries.filter((entry) => entry.id !== id));
  }

  async function resolve(id: string) {
    await invokeRecovery({ action: "resolve", id }, "done");
    hide(id);
  }

  function remove(id: string) {
    return enqueue(async () => {
      try {
        await resolve(id);
      } catch {
        notice("resolve", "Turing could not remove a recovery draft.");
      }
    });
  }

  function flush() {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    for (const key of queued.current.keys()) {
      const document = tracked.current.get(key);
      if (!document || document.scheduled) continue;
      document.scheduled = true;
      void enqueue(async () => {
        document.scheduled = false;
        // A queued write must not revive a document closed in the meantime.
        if (tracked.current.get(key) !== document) return;
        const snapshot = queued.current.get(key);
        if (!snapshot) return;
        queued.current.delete(key);
        try {
          const replaces = document.original ?? document.stored;
          const { id } = await invokeRecovery(
            { ...snapshot, replaces },
            "written",
          );
          document.stored = id;
          document.original = undefined;
          if (tracked.current.get(key) === document && !document.tooLarge)
            notice(key);
        } catch {
          if (tracked.current.get(key) === document)
            unavailable(key, snapshot.entry.name);
        }
      });
    }
    return operations.current;
  }

  const flushOnHide = useEffectEvent(() => {
    if (document.hidden) void flush();
  });
  const flushOnPageHide = useEffectEvent(() => void flush());
  const load = useEffectEvent(async (cancelled: () => boolean) => {
    await enqueue(async () => {
      for (const { key, raw, entry } of readDrafts()) {
        if (cancelled()) return;
        try {
          if (localStorage.getItem(key) !== raw) continue;
          await invokeRecovery({ action: "migrate", entry }, "written");
          if (localStorage.getItem(key) === raw) localStorage.removeItem(key);
        } catch {
          unavailable("legacy-" + entry.id, entry.name);
        }
      }
      try {
        const reply = await invokeRecovery({ action: "list" }, "list");
        if (cancelled()) return;
        setAvailable(reply.entries);
        if (reply.skipped)
          notice("integrity", "Turing skipped damaged recovery drafts.");
      } catch {
        if (!cancelled())
          notice("load", "Turing could not load recovery drafts.");
      }
    });
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void load(() => cancelled);
    const onHide = () => flushOnHide();
    const onPageHide = () => flushOnPageHide();
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onHide);
      flushOnPageHide();
    };
  }, [enabled]);

  function forget(key: string) {
    const document = tracked.current.get(key);
    if (!document) return;
    notice(key);
    tracked.current.delete(key);
    queued.current.delete(key);
    // The earlier write may still be in flight and publish its ID.
    void enqueue(async () => {
      try {
        if (document.stored) await resolve(document.stored);
        if (document.original) await resolve(document.original);
      } catch {
        notice("resolve", "Turing could not remove a recovery draft.");
      }
    });
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
      const document = tracked.current.get(tab.key) ?? {};
      tracked.current.set(tab.key, document);
      if (isLargeDocument(tab.draft)) {
        queued.current.delete(tab.key);
        if (!document.tooLarge) unavailable(tab.key, tab.name);
        document.tooLarge = true;
        continue;
      }
      document.tooLarge = false;
      queued.current.set(tab.key, {
        action: "snapshot",
        uri: tab.uri,
        workspaceId:
          tab.source.kind === "workspace" ? tab.source.workspaceId : undefined,
        entry: {
          id: tab.key,
          name: tab.name,
          title: tab.title,
          draft: tab.draft,
          languageOverride: tab.languageOverride,
          timestamp: Date.now(),
          source:
            tab.source.kind === "workspace"
              ? {
                  kind: "workspace",
                  root: root ?? "",
                  relativePath: tab.source.relativePath,
                  version: tab.source.version,
                }
              : { kind: "copy" },
        },
      });
    }
    for (const key of old.keys()) forget(key);
    if (queued.current.size && timer.current === undefined)
      timer.current = window.setTimeout(
        () => void flush(),
        DRAFT_SNAPSHOT_INTERVAL_MS,
      );
  }

  function recovered(entry: RecoveryDraft, key: string) {
    const document = tracked.current.get(key) ?? {};
    tracked.current.set(key, document);
    document.original = entry.id;
    hide(entry.id);
    return flush();
  }

  function matches(id: string, workspaceId: string) {
    return enqueue(async () => {
      const reply = await invokeRecovery(
        { action: "matches", id, workspaceId },
        "matches",
      );
      return reply.matches;
    });
  }

  async function prepareExit() {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    queued.current.clear();
    const originals = [...tracked.current.values()].flatMap(({ original }) =>
      original ? [original] : [],
    );
    await enqueue(async () => {
      for (const id of originals) await resolve(id);
    });
  }

  return {
    available,
    error: Object.values(notices).join(" "),
    track,
    remove,
    recovered,
    matches,
    prepareExit,
  };
}
