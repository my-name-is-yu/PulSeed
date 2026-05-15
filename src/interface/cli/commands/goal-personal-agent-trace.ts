import type { StateManager } from "../../../base/state/state-manager.js";
import {
  allocateDeterministicGoalId,
  recordExplicitCommandDecision,
  type CapabilityRegistryDecisionKind,
  type InterventionDecisionKind,
  type InterventionTargetEffect,
  type RuntimeGraphRef,
} from "../../../runtime/personal-agent/index.js";
import { getCliLogger } from "../cli-logger.js";
import { formatOperationError } from "../utils.js";

export async function allocateCliGoalId(
  stateManager: StateManager,
  seed: unknown,
): Promise<string> {
  return allocateDeterministicGoalId(seed, async (goalId) => (await stateManager.loadGoal(goalId)) !== null);
}

export async function recordCliGoalCommandDecision(
  stateManager: StateManager,
  input: {
    command: string;
    goalId: string;
    targetSummary: string;
    effect: InterventionTargetEffect;
    sourceId?: string;
    sourceEpoch?: string;
    replayKey?: string;
    summary?: string;
    decision?: InterventionDecisionKind;
    decisionReason?: string;
    capabilityDecision?: CapabilityRegistryDecisionKind;
    capabilityRefs?: RuntimeGraphRef[];
    currentRefs?: RuntimeGraphRef[];
    auditRefs?: RuntimeGraphRef[];
    outcomeSummary?: string;
  },
): Promise<boolean> {
  try {
    await recordExplicitCommandDecision({
      baseDir: stateManager.getBaseDir(),
      surface: "cli",
      command: input.command,
      sourceId: input.sourceId,
      sourceEpoch: input.sourceEpoch,
      replayKey: input.replayKey,
      summary: input.summary,
      target: {
        kind: "goal",
        ref: { kind: "goal", ref: input.goalId },
        effect: input.effect,
        summary: input.targetSummary,
      },
      decision: input.decision,
      decisionReason: input.decisionReason,
      capabilityDecision: input.capabilityDecision,
      capabilityRefs: input.capabilityRefs ?? [{ kind: "capability", ref: "goal_state_mutation" }],
      currentRefs: input.currentRefs,
      auditRefs: input.auditRefs,
      outcomeSummary: input.outcomeSummary,
    });
    return true;
  } catch (err) {
    getCliLogger().error(formatOperationError(`record personal-agent decision for ${input.command}`, err));
    return false;
  }
}
