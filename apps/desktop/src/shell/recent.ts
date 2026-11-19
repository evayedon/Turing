import { useEffect, useState } from "react";

export type Recent = { kind: "workspace" | "file"; name: string; path: string };
const key = "turing:recents:v1";
const event = "turing:recents-changed";
const maximum = 20;
let inMemory: Recent[] = [];
let storageUnavailable = false;

function isRecent(value: unknown): value is Recent {
  if (typeof value !== "object" || value === null) return false;
  return (
    "kind" in value &&
    (value.kind === "file" || value.kind === "workspace") &&
    "name" in value &&
    typeof value.name === "string" &&
    "path" in value &&
    typeof value.path === "string" &&
    !!value.path &&
    value.path.length <= 4096
  );
}

export function readRecents(): Recent[] {
  if (storageUnavailable) return inMemory;
  try {
    const data: unknown = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    if (Array.isArray(data)) return data.slice(0, maximum).filter(isRecent);
  } catch {
    /* Blocked or invalid storage. */
  }
  return inMemory;
}

function write(entries: Recent[]) {
  inMemory = entries;
  try {
    window.localStorage.setItem(key, JSON.stringify(entries));
  } catch {
    // Preserve the session history if persistent storage is unavailable.
    storageUnavailable = true;
  }
  window.dispatchEvent(new Event(event));
}

export function rememberRecent(entry: Recent) {
  if (!isRecent(entry)) return;
  write(
    [
      entry,
      ...readRecents().filter(
        (item) => item.kind !== entry.kind || item.path !== entry.path,
      ),
    ].slice(0, maximum),
  );
}

export function clearRecents() {
  write([]);
}

export function useRecents() {
  const [entries, setEntries] = useState(readRecents);
  useEffect(() => {
    const update = () => setEntries(readRecents());
    window.addEventListener("storage", update);
    window.addEventListener(event, update);
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener(event, update);
    };
  }, []);
  return entries;
}
