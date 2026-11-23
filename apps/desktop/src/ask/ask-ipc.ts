import { Channel, invoke } from "@tauri-apps/api/core";
import type { AskEvent, AskModel, AskRequest } from "@turing/contracts";

export const localAskModel: AskModel = {
  id: "llama.cpp",
  label: "llama.cpp",
  location: "local",
};

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

export function cancelAsk(requestId: string) {
  return invoke<void>("ask_cancel", { requestId });
}
