import type { AskEvent, AskSource } from "@turing/contracts";
import { cloudAskModel, localAskModel } from "./ask-ipc";

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
  modelId: localAskModel.id,
  conventions: "",
};

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
      (prefs.modelId === localAskModel.id || prefs.modelId === cloudAskModel.id)
        ? {
            modelId: prefs.modelId,
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
