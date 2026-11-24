import type { AskError } from "@turing/contracts";

const messages = {
  WORKSPACE_DENIED: "This workspace is no longer available to Ask.",
  INVALID_QUESTION: "Enter a question up to 2,048 UTF-8 bytes.",
  BUSY: "An earlier request is finishing. Try again in a moment.",
  MODEL_UNAVAILABLE: "Start llama-server on 127.0.0.1:8080 and try again.",
  INDEX_UNAVAILABLE: "Ask could not read this workspace. Try again.",
  INFERENCE_FAILED: "The model could not finish the answer. Try again.",
  CLOUD_CONSENT_DECLINED: "Cloud sharing canceled.",
  CLOUD_QUESTION_TOO_LONG:
    "Shorten the question so it fits in the cloud sharing preview.",
  CLOUD_KEY_REQUIRED: "Save an OpenRouter API key to use this model.",
  INVALID_CLOUD_KEY: "Enter a valid OpenRouter API key.",
  CREDENTIAL_STORE: "Could not access the system credential store.",
  PROVIDER_UNAUTHORIZED:
    "OpenRouter rejected the key or model access. Check the key and account credits.",
  PROVIDER_RATE_LIMITED:
    "OpenRouter rate limited this request. Check your credits or try again later.",
  PROVIDER_UNAVAILABLE: "OpenRouter is unavailable. Try again later.",
} satisfies Record<AskError, string>;

export function askErrorMessage(error: unknown) {
  return typeof error === "string" && Object.hasOwn(messages, error)
    ? messages[error as AskError]
    : messages.INFERENCE_FAILED;
}
