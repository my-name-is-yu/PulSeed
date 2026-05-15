// ─── EscalationHandler ───
//
// Handles /track command: converts conversation history to a PulSeed Goal (Tier 2 promotion).
// Phase 1c: creates the Goal but does NOT auto-start CoreLoop.
// User runs `pulseed run --goal <id>` to start the loop.

import type { StateManager } from "../../base/state/state-manager.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { GoalNegotiator } from "../../orchestrator/goal/goal-negotiator.js";
import type { ChatHistory } from "./chat-history.js";
import {
  PersonalAgentRuntimeStore,
  buildPersonalAgentDecisionTrace,
  stableId,
} from "../../runtime/personal-agent/index.js";

// ─── Types ───

export interface EscalationDeps {
  stateManager: StateManager;
  llmClient: ILLMClient;
  goalNegotiator: GoalNegotiator;
  personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">;
}

export interface EscalationResult {
  goalId: string;
  title: string;
  description: string;
}

const SYSTEM_PROMPT =
  "You are generating a PulSeed goal from a conversation. " +
  "Extract a clear, actionable goal description from the conversation below. " +
  "Return ONLY the goal description, nothing else.";

// ─── EscalationHandler ───

export class EscalationHandler {
  constructor(private readonly deps: EscalationDeps) {}

  /**
   * Convert conversation history to a tracked PulSeed Goal.
   *
   * Steps:
   *  1. Build LLM messages from conversation history
   *  2. Call LLM to extract goal description
   *  3. GoalNegotiator.negotiate(description) — feasibility + threshold refinement
   *  4. Goal is saved inside negotiate() — no separate saveGoal call needed
   *  5. Return EscalationResult
   */
  async escalateToGoal(history: ChatHistory): Promise<EscalationResult> {
    const messages = history.getMessages();
    if (messages.length === 0) {
      throw new Error("No conversation history to escalate.");
    }

    // Step 1: Build messages array for LLM
    const llmMessages = messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    // Step 2: Call LLM to extract goal description
    const response = await this.deps.llmClient.sendMessage(llmMessages, {
      system: SYSTEM_PROMPT,
    });
    const goalDescription = response.content.trim();

    if (!goalDescription) {
      throw new Error("LLM returned empty goal description.");
    }
    const goalId = trackGoalId(goalDescription, history);
    await this.recordTrackDecision(goalDescription, history, goalId);

    // Step 3: Negotiate goal (also persists it internally)
    const { goal } = await this.deps.goalNegotiator.negotiate(goalDescription, { goalId });

    // Step 4: Return result
    return {
      goalId: goal.id,
      title: goal.title,
      description: goal.description,
    };
  }

  private async recordTrackDecision(
    goalDescription: string,
    history: ChatHistory,
    goalId: string,
  ): Promise<void> {
    const baseDir = typeof this.deps.stateManager.getBaseDir === "function"
      ? this.deps.stateManager.getBaseDir()
      : null;
    const store = this.deps.personalAgentRuntime
      ?? (baseDir ? new PersonalAgentRuntimeStore(baseDir, { controlBaseDir: baseDir }) : null);
    if (!store) return;
    const now = new Date().toISOString();
    await store.recordTrace(buildPersonalAgentDecisionTrace({
      callerPath: "explicit_user_command",
      source: {
        sourceKind: "explicit_command",
        sourceId: history.getSessionId(),
        emittedAt: now,
        sourceEpoch: "track",
        highWatermark: goalId,
        replayKey: trackReplayKey(goalDescription, history),
        summary: "/track requested durable goal creation from chat history.",
        sourceRef: { kind: "chat_command", ref: "/track" },
      },
      target: {
        kind: "goal",
        ref: { kind: "goal", ref: goalId },
        effect: "create_goal",
        summary: goalDescription,
      },
      decision: "allow",
      decisionReason: "/track goal creation was allowed by InterventionPolicy before GoalNegotiator persisted durable goal state.",
      capabilityDecision: "available",
      capabilityRefs: [{ kind: "capability", ref: "durable_goal_state_write" }],
      policyRef: { kind: "intervention_policy", ref: "policy:chat-track-v1" },
      currentRefs: [{ kind: "chat_session", ref: history.getSessionId() }],
      auditRefs: [{ kind: "chat_command", ref: "/track" }],
      outcomeEvent: {
        type: "action_outcome",
        summary: "/track materialized a durable goal.",
        targetRef: { kind: "goal", ref: goalId },
      },
    }));
  }
}

function trackGoalId(goalDescription: string, history: ChatHistory): string {
  return `goal:track:${stableId(trackReplayKey(goalDescription, history))}`;
}

function trackReplayKey(goalDescription: string, history: ChatHistory): string {
  return [
    "chat:track",
    history.getSessionId(),
    goalDescription.trim(),
  ].join(":");
}
