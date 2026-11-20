import { invoke } from "@tauri-apps/api/core";
import type { RecoveryReply, RecoveryRequest } from "@turing/contracts";

export async function invokeRecovery<Kind extends RecoveryReply["kind"]>(
  request: RecoveryRequest,
  kind: Kind,
): Promise<Extract<RecoveryReply, { kind: Kind }>> {
  const reply = await invoke<RecoveryReply>("draft_recovery", { request });
  if (reply?.kind !== kind) throw new Error("Unexpected draft recovery reply");
  return reply as Extract<RecoveryReply, { kind: Kind }>;
}
