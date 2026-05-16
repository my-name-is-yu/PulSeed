import { z } from "zod/v3";
import type {
  MemoryCorrectionEntry,
  MemoryCorrectionKind,
  MemoryCorrectionTargetKind,
} from "./memory-correction-ledger.js";
import type { AgentMemoryEntry } from "../knowledge/types/agent-memory.js";

const UserFacingMemoryInspectStateSchema = z.enum([
  "active",
  "corrected",
  "superseded",
  "forgotten",
  "retracted",
  "suppressed",
  "unknown",
]);

const UserFacingMemoryInspectActionSchema = z.enum([
  "corrected",
  "superseded",
  "forgotten",
  "retracted",
  "suppressed",
]);

export const UserFacingMemoryInspectProjectionSchema = z.object({
  schema_version: z.literal("user-facing-memory-inspect/v1"),
  target_kind: z.enum(["agent_memory", "soil_record", "runtime_evidence", "dream_checkpoint"]),
  current_state: UserFacingMemoryInspectStateSchema,
  active_for_future_use: z.boolean(),
  replacement_recorded: z.boolean(),
  history_count: z.number().int().nonnegative(),
  history: z.array(z.object({
    occurred_at: z.string().datetime(),
    action: UserFacingMemoryInspectActionSchema,
    user_visible_effect: z.string().min(1),
    replacement_recorded: z.boolean(),
    reason_recorded: z.boolean(),
  }).strict()),
  read_only: z.literal(true).default(true),
  mutation_performed: z.literal(false).default(false),
  physical_delete_performed: z.literal(false).default(false),
  raw_content_visible: z.literal(false).default(false),
  raw_refs_visible: z.literal(false).default(false),
  sensitive_content_visible: z.literal(false).default(false),
}).strict();

export type UserFacingMemoryInspectProjection = z.infer<typeof UserFacingMemoryInspectProjectionSchema>;

export function projectUserFacingMemoryInspect(input: {
  targetKind: MemoryCorrectionTargetKind;
  history: readonly MemoryCorrectionEntry[];
  agentMemoryEntry?: AgentMemoryEntry | null;
}): UserFacingMemoryInspectProjection {
  const history = [...input.history].sort((left, right) => left.created_at.localeCompare(right.created_at));
  const latestCorrection = history.at(-1) ?? null;
  const currentState = currentStateFor(input.agentMemoryEntry ?? null, latestCorrection);
  const activeForFutureUse = activeForFutureUseFor(input.agentMemoryEntry ?? null, currentState);
  return UserFacingMemoryInspectProjectionSchema.parse({
    schema_version: "user-facing-memory-inspect/v1",
    target_kind: input.targetKind,
    current_state: currentState,
    active_for_future_use: activeForFutureUse,
    replacement_recorded: history.some((entry) => entry.replacement_ref !== null),
    history_count: history.length,
    history: history.map((entry) => ({
      occurred_at: entry.created_at,
      action: userFacingActionFor(entry.correction_kind),
      user_visible_effect: userVisibleEffectFor(entry.correction_kind),
      replacement_recorded: entry.replacement_ref !== null,
      reason_recorded: entry.reason.length > 0,
    })),
    read_only: true,
    mutation_performed: false,
    physical_delete_performed: false,
    raw_content_visible: false,
    raw_refs_visible: false,
    sensitive_content_visible: false,
  });
}

function currentStateFor(
  agentMemoryEntry: AgentMemoryEntry | null,
  latestCorrection: MemoryCorrectionEntry | null,
): z.infer<typeof UserFacingMemoryInspectStateSchema> {
  if (agentMemoryEntry?.correction_state) {
    return stateFromCorrectionStatus(agentMemoryEntry.correction_state.status);
  }
  if (agentMemoryEntry) {
    return stateFromAgentMemoryStatus(agentMemoryEntry.status);
  }
  if (latestCorrection) {
    return stateFromCorrectionKind(latestCorrection.correction_kind);
  }
  return "unknown";
}

function activeForFutureUseFor(
  agentMemoryEntry: AgentMemoryEntry | null,
  currentState: z.infer<typeof UserFacingMemoryInspectStateSchema>,
): boolean {
  if (agentMemoryEntry?.correction_state) {
    return agentMemoryEntry.correction_state.active;
  }
  if (currentState !== "active") return false;
  return agentMemoryEntry ? agentMemoryEntry.status === "raw" || agentMemoryEntry.status === "compiled" : false;
}

function stateFromAgentMemoryStatus(status: AgentMemoryEntry["status"]): z.infer<typeof UserFacingMemoryInspectStateSchema> {
  switch (status) {
    case "raw":
    case "compiled":
      return "active";
    case "archived":
      return "unknown";
    case "corrected":
      return "corrected";
    case "superseded":
      return "superseded";
    case "forgotten":
      return "forgotten";
    case "retracted":
      return "retracted";
    case "quarantined":
      return "suppressed";
  }
}

function stateFromCorrectionStatus(status: string): z.infer<typeof UserFacingMemoryInspectStateSchema> {
  if (status === "active") return "active";
  if (status === "corrected") return "corrected";
  if (status === "superseded") return "superseded";
  if (status === "forgotten") return "forgotten";
  if (status === "retracted") return "retracted";
  if (status === "quarantined") return "suppressed";
  return "unknown";
}

function stateFromCorrectionKind(kind: MemoryCorrectionKind): z.infer<typeof UserFacingMemoryInspectStateSchema> {
  if (kind === "corrected") return "corrected";
  if (kind === "superseded") return "superseded";
  if (kind === "forgotten") return "forgotten";
  if (kind === "retracted") return "retracted";
  if (kind === "quarantined") return "suppressed";
  return "unknown";
}

function userFacingActionFor(kind: MemoryCorrectionKind): z.infer<typeof UserFacingMemoryInspectActionSchema> {
  if (kind === "quarantined") return "suppressed";
  return kind;
}

function userVisibleEffectFor(kind: MemoryCorrectionKind): string {
  switch (kind) {
    case "corrected":
      return "An older memory is no longer active; a replacement may be used only through normal memory governance.";
    case "superseded":
      return "A newer memory superseded this one, so this one is no longer active for future use.";
    case "forgotten":
      return "The selected memory is no longer active for future use; audit history is retained.";
    case "retracted":
      return "The selected memory is no longer active as a supported memory.";
    case "quarantined":
      return "The selected memory is not eligible for normal use or display.";
  }
}
