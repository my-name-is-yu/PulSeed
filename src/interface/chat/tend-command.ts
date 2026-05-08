// --- TendCommand ---
//
// Implements the /tend slash command for chat mode.
// Summarizes chat history via LLM, generates a structured goal,
// confirms with the user, then starts a daemon to work on it autonomously.

import { randomUUID } from "node:crypto";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { GoalNegotiator } from "../../orchestrator/goal/goal-negotiator.js";
import type { DaemonClient } from "../../runtime/daemon/client.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { Goal } from "../../base/types/goal.js";
import type { ChatMessage } from "./chat-history.js";
import {
  BackgroundRunLedger,
  type BackgroundRunCreateInput,
} from "../../runtime/store/background-run-store.js";
import { resolveConfiguredDaemonRuntimeRoot } from "../../runtime/daemon/runtime-root.js";
import type { RuntimeControlReplyTarget } from "../../runtime/store/runtime-operation-schemas.js";
import type { RuntimeReplyTarget, RuntimeSessionRef } from "../../runtime/session-registry/types.js";

// --- Types ---

export interface TendDeps {
  llmClient: ILLMClient;
  goalNegotiator: GoalNegotiator;
  daemonClient: DaemonClient;
  stateManager: StateManager;
  chatHistory: ChatMessage[];
  sessionId?: string | null;
  workspace?: string | null;
  replyTarget?: RuntimeControlReplyTarget | null;
  backgroundRunLedger?: Pick<BackgroundRunLedger, "create" | "terminal">;
}

export interface TendResult {
  success: boolean;
  goalId?: string;
  goalTitle?: string;
  backgroundRunId?: string;
  /** maxIterations from parsed args, carried through confirmation flow. */
  maxIterations?: number;
  /** Formatted message for chat display. */
  message: string;
  /** Formatted confirmation prompt shown to user before daemon start. */
  confirmation?: string;
  /** True when execution is paused waiting for user confirmation. */
  needsConfirmation?: boolean;
}

// --- Constants ---

const MAX_HISTORY_MESSAGES = 20;
const DEFAULT_TEND_GOAL_NEGOTIATION_TIMEOUT_MS = 300_000;
const TEND_USAGE = "Usage: /tend [goal-id] [--max <positive-integer>]";
// Persisted runtime protocol tokens keep the legacy coreloop spelling for compatibility.
const DURABLE_LOOP_BACKGROUND_RUN_ID_PREFIX = "run:coreloop:";
const DURABLE_LOOP_BACKGROUND_RUN_KIND = "coreloop_run";
const SUMMARY_PROMPT = `You are analyzing a developer's chat conversation to extract their main objective.
Summarize what the user wants to achieve in 1-3 sentences. Focus on concrete, measurable outcomes.
Be specific -- mention file names, metrics, or technical goals if present.
Output only the summary, no preamble.`;

// --- TendCommand ---

export class TendCommand {
  /**
   * Main entry point for /tend.
   * Parses args, optionally generates a goal from chat history,
   * and starts the daemon.
   */
  async execute(args: string, deps: TendDeps): Promise<TendResult> {
    const parsedArgs = parseArgs(args);
    if (!parsedArgs.success) {
      return {
        success: false,
        message: parsedArgs.message,
      };
    }
    const { goalId, maxIterations } = parsedArgs;

    // Path A: existing goal-id provided -- skip generation
    if (goalId) {
      return this.tendExistingGoal(goalId, maxIterations, deps);
    }

    // Path B: no chat history to work from
    if (deps.chatHistory.length === 0) {
      return {
        success: false,
        message: "No conversation yet. Chat first to describe what you want, then use /tend.",
      };
    }

    // Path C: auto-generate goal from chat history
    return this.tendFromChat(maxIterations, deps);
  }

  /**
   * Summarize recent chat messages into a concise objective string.
   */
  async summarizeChat(history: ChatMessage[], llmClient: ILLMClient): Promise<string> {
    const recent = history.slice(-MAX_HISTORY_MESSAGES);
    const transcript = recent
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");

    const prompt = `${SUMMARY_PROMPT}\n\nConversation:\n${transcript}`;

    try {
      const response = await llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { max_tokens: 200, model_tier: "light" }
      );
      return response.content.trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to summarize chat: ${msg}`);
    }
  }

  /**
   * Generate a structured Goal from a plain-text summary via GoalNegotiator.
   */
  async generateGoal(summary: string, goalNegotiator: GoalNegotiator): Promise<Goal> {
    const result = await goalNegotiator.negotiate(summary, {
      constraints: ["source: tend (auto-generated from chat)"],
      timeoutMs: DEFAULT_TEND_GOAL_NEGOTIATION_TIMEOUT_MS,
    });
    return result.goal;
  }

  async startAcceptedGoal(
    goalId: string,
    maxIterations: number | undefined,
    deps: TendDeps
  ): Promise<TendResult> {
    const goal = await deps.stateManager.loadGoal(goalId);
    if (!goal) {
      return {
        success: false,
        message: `Goal not found: ${goalId}`,
      };
    }
    return this.startDaemon(goal, maxIterations, deps);
  }

  /**
   * Format a goal for the confirmation prompt shown to the user before daemon start.
   * Prefixed with the seedling symbol per design spec.
   */
  formatConfirmation(goal: Goal): string {
    const lines: string[] = [
      "🌱 Tend to this goal?",
      "",
      `  Title: ${goal.title}`,
    ];

    if (goal.dimensions.length > 0) {
      lines.push("  Dimensions:");
      for (const dim of goal.dimensions) {
        const t = dim.threshold;
        let thresholdStr = "";
        if (t.type === "min") thresholdStr = `min ${t.value}`;
        else if (t.type === "max") thresholdStr = `max ${t.value}`;
        else if (t.type === "range") thresholdStr = `${t.low}–${t.high}`;
        else if (t.type === "present") thresholdStr = "present";
        else if (t.type === "match") thresholdStr = `match: ${t.value}`;
        lines.push(`    - ${dim.name}: ${thresholdStr}`);
      }
    }

    if (goal.constraints && goal.constraints.length > 0) {
      lines.push("  Constraints:");
      for (const c of goal.constraints) {
        lines.push(`    - ${c}`);
      }
    }

    lines.push("");
    lines.push("  [Y/n]");
    return lines.join("\n");
  }

  // --- Private helpers ---

  private async tendExistingGoal(
    goalId: string,
    maxIterations: number | undefined,
    deps: TendDeps
  ): Promise<TendResult> {
    const goal = await deps.stateManager.loadGoal(goalId);
    if (!goal) {
      return {
        success: false,
        message: `Goal not found: ${goalId}`,
      };
    }
    return this.startDaemon(goal, maxIterations, deps);
  }

  private async tendFromChat(
    maxIterations: number | undefined,
    deps: TendDeps
  ): Promise<TendResult> {
    let summary: string;
    try {
      summary = await this.summarizeChat(deps.chatHistory, deps.llmClient);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Could not summarize chat: ${msg}. Try /track or create a goal manually with 'pulseed add'.`,
      };
    }

    let goal: Goal;
    try {
      goal = await this.generateGoal(summary, deps.goalNegotiator);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Could not generate goal: ${msg}. Try describing your goal more specifically and retry /tend.`,
      };
    }

    const confirmation = this.formatConfirmation(goal);
    return {
      success: true,
      goalId: goal.id,
      goalTitle: goal.title,
      maxIterations,
      message: "Generated goal from conversation.",
      confirmation,
      needsConfirmation: true,
    };
  }

  private async startDaemon(
    goal: Goal,
    maxIterations: number | undefined,
    deps: TendDeps
  ): Promise<TendResult> {
    const run = await createDurableLoopBackgroundRun(goal, deps);
    try {
      await deps.daemonClient.startGoal(goal.id, {
        backgroundRun: {
          backgroundRunId: run.id,
          parentSessionId: run.parent_session_id,
          notifyPolicy: run.notify_policy,
          replyTargetSource: run.reply_target_source,
          pinnedReplyTarget: run.pinned_reply_target,
        },
      });
      const iterNote = maxIterations !== undefined ? ` (max ${maxIterations} iterations)` : "";
      return {
        success: true,
        goalId: goal.id,
        goalTitle: goal.title,
        backgroundRunId: run.id,
        message: `🌱 [tend] ${goal.id}: Started — "${goal.title}"${iterNote}\nBackground run: ${run.id}\nRun 'pulseed status' to check progress.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await getBackgroundRunLedger(deps).terminal(run.id, {
        status: "failed",
        completed_at: new Date().toISOString(),
        error: msg,
      }).catch(() => undefined);
      return {
        success: false,
        backgroundRunId: run.id,
        message: `Daemon unavailable: ${msg}. Start the daemon with 'pulseed daemon start' first.`,
      };
    }
  }
}

async function createDurableLoopBackgroundRun(goal: Goal, deps: TendDeps) {
  const pinnedReplyTarget = normalizePinnedReplyTarget(deps.replyTarget ?? null);
  const parentSessionId = deps.sessionId ? `session:conversation:${deps.sessionId}` : null;
  const sourceRefs = deps.sessionId ? [chatSessionSourceRef(deps.sessionId)] : [];
  const input: BackgroundRunCreateInput = {
    id: `${DURABLE_LOOP_BACKGROUND_RUN_ID_PREFIX}${randomUUID()}`,
    kind: DURABLE_LOOP_BACKGROUND_RUN_KIND,
    goal_id: goal.id,
    parent_session_id: parentSessionId,
    notify_policy: pinnedReplyTarget ? "done_only" : "silent",
    reply_target_source: pinnedReplyTarget ? "pinned_run" : "none",
    pinned_reply_target: pinnedReplyTarget,
    title: goal.title,
    workspace: deps.workspace ?? null,
    source_refs: sourceRefs,
  };
  return getBackgroundRunLedger(deps).create(input);
}

function getBackgroundRunLedger(deps: TendDeps): Pick<BackgroundRunLedger, "create" | "terminal"> {
  if (deps.backgroundRunLedger) return deps.backgroundRunLedger;
  return new BackgroundRunLedger(resolveConfiguredDaemonRuntimeRoot(deps.stateManager.getBaseDir()));
}

function chatSessionSourceRef(sessionId: string): RuntimeSessionRef {
  return {
    kind: "chat_session",
    id: sessionId,
    path: null,
    relative_path: `chat/sessions/${sessionId}.json`,
    updated_at: null,
  };
}

function normalizePinnedReplyTarget(replyTarget: RuntimeControlReplyTarget | null): RuntimeReplyTarget | null {
  if (!replyTarget) return null;
  const channel = replyTarget.channel ?? replyTarget.surface;
  if (!channel) return null;
  return {
    channel,
    target_id: replyTarget.conversation_id ?? replyTarget.identity_key ?? replyTarget.response_channel ?? null,
    thread_id: replyTarget.message_id ?? null,
    metadata: {
      ...replyTarget,
      ...(replyTarget.metadata ?? {}),
    },
  };
}

// --- Arg parsing ---

function parseArgs(args: string): { success: true; goalId?: string; maxIterations?: number } | { success: false; message: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let goalId: string | undefined;
  let maxIterations: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const token = parts[i]!;
    if (token === "--max") {
      if (maxIterations !== undefined) {
        return { success: false, message: `${TEND_USAGE}\nExpected at most one --max option.` };
      }
      const rawValue = parts[i + 1];
      if (!rawValue || rawValue.startsWith("--")) {
        return { success: false, message: `${TEND_USAGE}\nMissing value for --max.` };
      }
      if (!/^[1-9]\d*$/.test(rawValue)) {
        return { success: false, message: `${TEND_USAGE}\n--max must be a positive integer.` };
      }
      const n = Number(rawValue);
      if (!Number.isInteger(n) || n <= 0) {
        return { success: false, message: `${TEND_USAGE}\n--max must be a positive integer.` };
      }
      maxIterations = n;
      i++;
    } else if (token.startsWith("--")) {
      return { success: false, message: `${TEND_USAGE}\nUnknown option: ${token}` };
    } else {
      if (goalId) {
        return { success: false, message: `${TEND_USAGE}\nExpected at most one goal id.` };
      }
      goalId = token;
    }
  }

  return { success: true, goalId, maxIterations };
}
