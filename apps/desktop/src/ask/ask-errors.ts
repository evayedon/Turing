import type { AskError } from "@turing/contracts";

const messages = {
  WORKSPACE_DENIED: "This workspace is no longer available to Ask.",
  INVALID_QUESTION: "Enter a question up to 2,048 UTF-8 bytes.",
  INVALID_LOCAL_SERVER:
    "Enter a loopback address such as 127.0.0.1:8080 and a model name up to 256 characters.",
  BUSY: "An earlier request is finishing. Try again in a moment.",
  MODEL_UNAVAILABLE: "Start the local model server and try again.",
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
  PROVIDER_NO_PRIVATE_ROUTE:
    "No privacy-compliant OpenRouter provider was available for this model (providers that store or train on data are excluded). Try again later or use the local model.",
} satisfies Record<AskError, string>;

/** `localServer` names the configured address in the local startup hint. */
export function askErrorMessage(error: unknown, localServer?: string) {
  if (error === "MODEL_UNAVAILABLE" && localServer)
    return `Start the local model server on ${localServer} and try again.`;
  return typeof error === "string" && Object.hasOwn(messages, error)
    ? messages[error as AskError]
    : messages.INFERENCE_FAILED;
}
