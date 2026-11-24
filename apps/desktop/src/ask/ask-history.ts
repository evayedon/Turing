import type { AskEvent, AskSource } from "@turing/contracts";
import { autoAskModel, cloudAskModel, localAskModel } from "./ask-ipc";

export type CompletedAsk = Extract<AskEvent, { kind: "completed" }>;
export type AskFeedback = "helpful" | "unhelpful";

export interface SavedTurn {
  id: string;
  question: string;
  answer: string;
  result: CompletedAsk;
  feedback?: AskFeedback;
}

export interface AskPreferences {
  modelId: string;
  conventions: string;
}

export const defaultPreferences: AskPreferences = {
  modelId: autoAskModel.id,
  conventions: "",
};

/** Device-wide: the local server belongs to this machine, not to a folder. */
export interface LocalServer {
  /** `host:port` with a loopback host; Rust revalidates the full URL. */
  address: string;
  model: string;
}

export const defaultLocalServer: LocalServer = {
  address: "127.0.0.1:8080",
  model: "",
};

const LOCAL_SERVER_KEY = "turing:ask-local-server:v1";

export function validLocalAddress(address: string) {
  const match = /^(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/.exec(address);
  return !!match && Number(match[1]) >= 1 && Number(match[1]) <= 65535;
}

export function loadLocalServer(): LocalServer {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(LOCAL_SERVER_KEY) ?? "null",
    );
    return record(value) &&
      typeof value.address === "string" &&
      validLocalAddress(value.address) &&
      typeof value.model === "string"
      ? { address: value.address, model: value.model.slice(0, 256) }
      : defaultLocalServer;
  } catch {
    return defaultLocalServer;
  }
}

export function saveLocalServer(server: LocalServer) {
  localStorage.setItem(LOCAL_SERVER_KEY, JSON.stringify(server));
}

interface ProjectAsk {
  preferences: AskPreferences;
  retain: boolean;
  turns: SavedTurn[];
}

const MAX_TURNS = 20;
const MAX_ANSWER_CHARS = 16_384;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function source(value: unknown): value is AskSource {
  return (
    record(value) &&
    typeof value.relativePath === "string" &&
    typeof value.version === "string" &&
    count(value.startLine) &&
    value.startLine > 0 &&
    count(value.endLine) &&
    value.endLine >= value.startLine
  );
}

function completed(value: unknown): value is CompletedAsk {
  return (
    record(value) &&
    value.kind === "completed" &&
    (value.indexCoverage === "complete" || value.indexCoverage === "partial") &&
    (value.indexFreshness === "current" || value.indexFreshness === "stale") &&
    Array.isArray(value.sources) &&
    value.sources.length <= 4 &&
    value.sources.every(source) &&
    (value.usage === undefined ||
      (record(value.usage) &&
        count(value.usage.inputTokens) &&
        count(value.usage.outputTokens)))
  );
}

function turn(value: unknown): value is SavedTurn {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.question === "string" &&
    typeof value.answer === "string" &&
    (value.feedback === undefined ||
      value.feedback === "helpful" ||
      value.feedback === "unhelpful") &&
    completed(value.result)
  );
}

function key(path: string) {
  return `turing:ask-project:v1:${path}`;
}

export function loadProjectAsk(path: string | undefined): ProjectAsk {
  const fallback = {
    preferences: defaultPreferences,
    retain: false,
    turns: [],
  };
  if (!path) return fallback;
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(key(path)) ?? "null",
    );
    if (!record(value)) return fallback;
    const prefs = value.preferences;
    const preferences =
      record(prefs) &&
      typeof prefs.conventions === "string" &&
      [autoAskModel.id, localAskModel.id, cloudAskModel.id].includes(
        String(prefs.modelId),
      )
        ? {
            modelId: String(prefs.modelId),
            conventions: prefs.conventions.slice(0, 256),
          }
        : defaultPreferences;
    const retain = value.retain === true;
    return {
      preferences,
      retain,
      turns:
        retain && Array.isArray(value.turns)
          ? value.turns.slice(-MAX_TURNS).filter(turn)
          : [],
    };
  } catch {
    return fallback;
  }
}

export function updateProjectAsk(
  path: string,
  update: (current: ProjectAsk) => ProjectAsk,
) {
  const current = update(loadProjectAsk(path));
  localStorage.setItem(key(path), JSON.stringify(current));
}

export function mergeTurns(
  old: SavedTurn[],
  incoming: SavedTurn[],
): SavedTurn[] {
  const turns = new Map(old.map((entry) => [entry.id, entry]));
  for (const entry of incoming) {
    turns.set(entry.id, {
      ...entry,
      answer: entry.answer.slice(0, MAX_ANSWER_CHARS),
    });
  }
  return [...turns.values()].slice(-MAX_TURNS);
}

/** Device-wide daily cloud token limit and measured usage by local date. */
export interface CloudBudget {
  limit?: number;
  /** `YYYY-MM-DD` (local time) → measured input + output tokens. */
  days: Record<string, number>;
}

const CLOUD_BUDGET_KEY = "turing:ask-cloud-budget:v1";
const BUDGET_DAYS = 31;
export const MAX_DAILY_TOKENS = 100_000_000;

export function localDay(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Returns the limit for valid input, `null` for invalid, `undefined` for none. */
export function parseDailyLimit(text: string): number | undefined | null {
  const value = text.trim().replace(/[,_\s]/g, "");
  if (!value) return undefined;
  if (!/^\d{1,9}$/.test(value)) return null;
  const limit = Number(value);
  return limit >= 1 && limit <= MAX_DAILY_TOKENS ? limit : null;
}

export function loadCloudBudget(): CloudBudget {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(CLOUD_BUDGET_KEY) ?? "null",
    );
    if (!record(value)) return { days: {} };
    const days = record(value.days)
      ? Object.fromEntries(
          Object.entries(value.days).filter(
            (entry): entry is [string, number] =>
              /^\d{4}-\d{2}-\d{2}$/.test(entry[0]) && count(entry[1]),
          ),
        )
      : {};
    return count(value.limit) &&
      value.limit >= 1 &&
      value.limit <= MAX_DAILY_TOKENS
      ? { limit: value.limit, days }
      : { days };
  } catch {
    return { days: {} };
  }
}

function saveCloudBudget(budget: CloudBudget) {
  const days = Object.fromEntries(
    Object.entries(budget.days)
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .slice(0, BUDGET_DAYS),
  );
  localStorage.setItem(CLOUD_BUDGET_KEY, JSON.stringify({ ...budget, days }));
}

export function saveDailyLimit(limit: number | undefined) {
  const { days } = loadCloudBudget();
  saveCloudBudget(limit === undefined ? { days } : { limit, days });
  return loadCloudBudget();
}

export function recordCloudUsage(tokens: number, date = new Date()) {
  const budget = loadCloudBudget();
  const day = localDay(date);
  budget.days[day] = Math.min(
    (budget.days[day] ?? 0) + tokens,
    Number.MAX_SAFE_INTEGER,
  );
  saveCloudBudget(budget);
  return loadCloudBudget();
}
