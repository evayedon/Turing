import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AskCredentialAction,
  AskEvent,
  AskIndexAction,
  AskIndexStatus,
  AskLocalStatus,
  AskModel,
  AskRequest,
} from "@turing/contracts";

/** Routed by the native host: local when llama-server is ready, else cloud with consent. */
export const autoAskModel = { id: "auto", label: "Auto (local first)" };

export const localAskModel: AskModel = {
  id: "llama.cpp",
  label: "llama.cpp",
  location: "local",
};

export const cloudAskModel: AskModel = {
  id: "openrouter-qwen3-coder",
  label: "Qwen3-Coder via OpenRouter",
  location: "cloud",
};

export function cloudCredential(action: AskCredentialAction) {
  return invoke<boolean>("ask_cloud_credential", { action });
}

export function runAsk(
  requestId: string,
  request: AskRequest,
  onEvent: (event: AskEvent) => void,
) {
  return invoke<void>("ask_run", {
    requestId,
    request,
    events: new Channel<AskEvent>(onEvent),
  });
}

export function localAskStatus() {
  return invoke<AskLocalStatus>("ask_local_status");
}

export function cancelAsk(requestId: string) {
  return invoke<void>("ask_cancel", { requestId });
}

export function manageAskIndex(workspaceId: string, action: AskIndexAction) {
  return invoke<AskIndexStatus>("ask_index", { workspaceId, action });
}
