import type { RecoveryRequest } from "@turing/contracts";

/** Empty journal for tests that exercise other editor and explorer IPC. */
export async function invokeRecovery(request: RecoveryRequest) {
  switch (request.action) {
    case "list":
      return { kind: "list", entries: [], skipped: false };
    case "snapshot":
    case "migrate":
      return { kind: "written", id: request.entry.id };
    case "matches":
      return { kind: "matches", matches: false };
    case "resolve":
      return { kind: "done" };
  }
}
