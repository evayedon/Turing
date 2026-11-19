export type LanguageFeature = "hover" | "completion" | "definition";
export type LanguageCapabilities = Record<LanguageFeature, boolean>;
export type LanguagePosition = { line: number; character: number };
export type LanguageAction =
  | {
      kind: "sync";
      path: string;
      version: number;
      text: string;
      saved: boolean;
    }
  | { kind: "close"; path: string }
  | {
      kind: "request";
      path: string;
      version: number;
      position: LanguagePosition;
      feature: LanguageFeature;
      requestId: number;
    }
  | { kind: "cancel"; requestId: number };
export type LanguageEvent =
  | {
      kind: "diagnostics";
      path: string;
      version: number;
      diagnostics: unknown[];
    }
  | { kind: "response"; requestId: number; value: unknown };
export type LanguageUpdate = {
  capabilities: LanguageCapabilities | null;
  events: LanguageEvent[];
};

type Session = { workspaceId: string; sessionId: string };
export type LanguageCommands = {
  language_start: [{ workspaceId: string }, string | null];
  language_apply: [Session & { action: LanguageAction }, void];
  language_poll: [Session, LanguageUpdate];
  language_stop: [Session, void];
};
