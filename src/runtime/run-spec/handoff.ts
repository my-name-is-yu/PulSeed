import { randomUUID } from "node:crypto";
import path from "node:path";
import type { StateManager } from "../../base/state/state-manager.js";
import { GoalSchema, type Goal } from "../../base/types/goal.js";
import { getPulseedDirPath } from "../../base/utils/paths.js";
import { validateProtectedPath } from "../../tools/fs/FileValidationTool/protected-path-policy.js";
import { BackgroundRunLedger, type BackgroundRunCreateInput } from "../store/background-run-store.js";
import type { RuntimeReplyTarget } from "../session-registry/types.js";
import { resolveConfiguredDaemonRuntimeRoot } from "../daemon/runtime-root.js";
import { DaemonClient, isDaemonRunning, type DaemonStartGoalOptions } from "../daemon/client.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { ConfirmationDecision } from "../confirmation-decision.js";
import {
  applyRunSpecRevision,
  formatRunSpecSetupProposal,
  requiredMissingFields,
} from "./confirmation.js";
import { createRunSpecStore } from "./store.js";
import { deriveRunSpecFromText } from "./derive.js";
import { RunSpecSchema, type RunSpec } from "./types.js";

export interface RunSpecConfirmationSnapshot {
  state: "pending" | "confirmed" | "cancelled";
  spec: RunSpec;
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunSpecHandoffDeps {
  stateManager: StateManager;
  llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">;
  daemonClient?: Pick<DaemonClient, "startGoal">;
  daemonClientFactory?: () => Promise<Pick<DaemonClient, "startGoal">>;
  host?: string;
  getPendingConfirmation?: () => Promise<RunSpecConfirmationSnapshot | null> | RunSpecConfirmationSnapshot | null;
  setPendingConfirmation?: (confirmation: RunSpecConfirmationSnapshot | null) => Promise<void> | void;
  conversationSessionId?: string | null;
  sessionCwd?: string | null;
  replyTarget?: Record<string, unknown> | null;
  currentTurnStartedAt?: string | null;
}

export interface DraftRunSpecInput {
  text: string;
  cwd?: string;
  channel?: string | null;
  conversationId?: string | null;
  sessionId?: string | null;
  replyTarget?: Record<string, unknown> | null;
  originMetadata?: Record<string, unknown>;
}

export interface UpdateRunSpecDraftInput {
  runSpecId?: string;
  workspacePath?: string;
  deadline?: {
    raw: string;
    iso_at?: string | null;
    timezone?: string | null;
    finalization_buffer_minutes?: number | null;
    confidence?: "high" | "medium" | "low";
  };
  metricDirection?: "maximize" | "minimize";
  timezone?: string;
}

export interface RunSpecHandoffResult {
  success: boolean;
  message: string;
  spec?: RunSpec;
  goalId?: string;
  backgroundRunId?: string;
  data?: Record<string, unknown>;
}

export class RunSpecHandoffService {
  constructor(private readonly deps: RunSpecHandoffDeps) {}

  async draft(input: DraftRunSpecInput): Promise<RunSpecHandoffResult> {
    const spec = await deriveRunSpecFromText(input.text, {
      cwd: input.cwd ?? this.deps.sessionCwd ?? undefined,
      conversationId: input.conversationId ?? this.deps.conversationSessionId ?? null,
      channel: input.channel ?? null,
      sessionId: input.sessionId ?? this.deps.conversationSessionId ?? null,
      replyTarget: input.replyTarget ?? this.deps.replyTarget ?? null,
      originMetadata: input.originMetadata ?? {},
      llmClient: this.deps.llmClient,
    });
    if (!spec) {
      return {
        success: false,
        message: "No long-running work draft was derived from this request.",
      };
    }
    return this.persistPendingDraft(spec);
  }

  async persistPendingDraft(spec: RunSpec): Promise<RunSpecHandoffResult> {
    const parsed = RunSpecSchema.parse({ ...spec, status: "draft" });
    const store = createRunSpecStore(this.deps.stateManager);
    await store.save(parsed);
    const proposal = formatRunSpecSetupProposal(parsed);
    const message = [
      proposal,
      "",
      "PulSeed prepared this as typed long-running work. It has not started background work.",
      "Reply with approval to confirm, cancel to discard it, or provide updated workspace/deadline/metric details.",
    ].join("\n");
    await this.setPending({
      state: "pending",
      spec: parsed,
      prompt: message,
      createdAt: parsed.created_at,
      updatedAt: parsed.updated_at,
    });
    return {
      success: true,
      message,
      spec: parsed,
      data: {
        run_spec_id: parsed.id,
        status: parsed.status,
        profile: parsed.profile,
        missing_fields: parsed.missing_fields,
      },
    };
  }

  async updatePendingDraft(input: UpdateRunSpecDraftInput): Promise<RunSpecHandoffResult> {
    const pending = await this.requireMatchingPending(input.runSpecId);
    if (!pending.success || !pending.confirmation) {
      return { success: false, message: pending.message };
    }
    const decision: ConfirmationDecision = {
      decision: "revise",
      confidence: 1,
      revision: {
        ...(input.workspacePath ? { workspace_path: input.workspacePath } : {}),
        ...(input.deadline ? { deadline: input.deadline } : {}),
        ...(input.metricDirection ? { metric_direction: input.metricDirection } : {}),
      },
    };
    const revised = applyRunSpecRevision(pending.confirmation.spec, decision, {
      timezone: input.timezone,
    });
    if (!revised) {
      return {
        success: false,
        message: "Long-running work update needs a workspace path, deadline, or metric direction.",
      };
    }
    await createRunSpecStore(this.deps.stateManager).save(revised);
    const proposal = formatRunSpecSetupProposal(revised);
    await this.setPending({
      ...pending.confirmation,
      spec: revised,
      prompt: proposal,
      updatedAt: revised.updated_at,
    });
    return {
      success: true,
      message: [
        proposal,
        "",
        "Long-running work updated. Reply with approval to confirm, cancel to discard it, or provide another update.",
      ].join("\n"),
      spec: revised,
      data: { run_spec_id: revised.id, status: revised.status },
    };
  }

  async cancelPendingDraft(runSpecId?: string): Promise<RunSpecHandoffResult> {
    const pending = await this.requireMatchingPending(runSpecId);
    if (!pending.success || !pending.confirmation) {
      return { success: false, message: pending.message };
    }
    const cancelled = RunSpecSchema.parse({
      ...pending.confirmation.spec,
      status: "cancelled",
      updated_at: new Date().toISOString(),
    });
    await createRunSpecStore(this.deps.stateManager).save(cancelled);
    await this.setPending(null);
    return {
      success: true,
      message: "Long-running work cancelled.\nNo background work was started.",
      spec: cancelled,
      data: { run_spec_id: cancelled.id, status: cancelled.status },
    };
  }

  async startPendingDraft(runSpecId?: string): Promise<RunSpecHandoffResult> {
    const pending = await this.requireMatchingPending(runSpecId);
    if (!pending.success || !pending.confirmation) {
      return { success: false, message: pending.message };
    }
    const required = requiredMissingFields(pending.confirmation.spec);
    if (this.wasDraftCreatedInCurrentTurn(pending.confirmation)) {
      return {
        success: false,
        message: [
          "Long-running work is drafted and awaiting confirmation.",
          "It was created in this same turn, so PulSeed will not start background work until the operator confirms the draft in a later turn.",
        ].join("\n"),
        spec: pending.confirmation.spec,
      };
    }
    if (required.length > 0) {
      return {
        success: false,
        message: [
          "Run cannot start until required fields are resolved:",
          ...required.map((field) => `- ${field.question}`),
        ].join("\n"),
        spec: pending.confirmation.spec,
      };
    }
    const confirmed = RunSpecSchema.parse({
      ...pending.confirmation.spec,
      status: "confirmed",
      updated_at: new Date().toISOString(),
    });
    await createRunSpecStore(this.deps.stateManager).save(confirmed);
    const started = await this.startConfirmed(confirmed);
    if (started.success) {
      await this.setPending({
        ...pending.confirmation,
        state: "confirmed",
        spec: confirmed,
        updatedAt: confirmed.updated_at,
      });
    } else if (started.data?.confirmed_but_not_started === true) {
      const draft = RunSpecSchema.parse({ ...confirmed, status: "draft" });
      await createRunSpecStore(this.deps.stateManager).save(draft);
      await this.setPending({
        ...pending.confirmation,
        state: "pending",
        spec: draft,
        updatedAt: draft.updated_at,
      });
      return { ...started, spec: draft };
    }
    return started;
  }

  async startConfirmed(spec: RunSpec): Promise<RunSpecHandoffResult> {
    const safetyBlock = validateRunSpecStartSafety(spec);
    if (safetyBlock) {
      return {
        success: false,
        message: safetyBlock,
        spec,
        data: { confirmed_but_not_started: true },
      };
    }
    const client = await this.getDaemonClient();
    if (!client) {
      return {
        success: false,
        message: [
          "Long-running work approved.",
          "",
          "Daemon start is unavailable in this chat surface, so no background work was started.",
          "Start or connect the PulSeed daemon, then approve from a daemon-capable chat surface.",
        ].join("\n"),
        spec,
      };
    }
    const goal = await this.createGoalFromRunSpec(spec);
    const run = await this.createRunSpecBackgroundRun(spec, goal);
    try {
      await client.startGoal(goal.id, {
        backgroundRun: {
          backgroundRunId: run.id,
          parentSessionId: run.parent_session_id,
          notifyPolicy: run.notify_policy,
          replyTargetSource: run.reply_target_source,
          pinnedReplyTarget: run.pinned_reply_target,
        },
      } satisfies DaemonStartGoalOptions);
      return {
        success: true,
        message: [
          "Long-running work approved.",
          `Started background work for: ${goal.title}`,
          "Ask for progress here, or run `pulseed status` for a plain status summary.",
          "Use `/sessions --details` or diagnostic CLI commands when you need exact IDs.",
        ].join("\n"),
        spec,
        goalId: goal.id,
        backgroundRunId: run.id,
        data: { run_spec_id: spec.id, goal_id: goal.id, background_run_id: run.id },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await Promise.all(this.getBackgroundRunLedgers().map((ledger) => ledger.terminal(run.id, {
        status: "failed",
        completed_at: new Date().toISOString(),
        error: message,
      }).catch(() => undefined)));
      return {
        success: false,
        message: [
          "Long-running work approved.",
          "",
          `Daemon start failed, so no background work was started: ${message}`,
          "Start the daemon with `pulseed daemon start`, then approve again from a daemon-capable chat surface.",
          "Use diagnostic status commands if you need the failed background run record.",
        ].join("\n"),
        spec,
        goalId: goal.id,
        backgroundRunId: run.id,
      };
    }
  }

  private async requireMatchingPending(runSpecId?: string): Promise<{
    success: boolean;
    message: string;
    confirmation?: RunSpecConfirmationSnapshot;
  }> {
    const pending = await this.getPending();
    if (!pending || pending.state !== "pending") {
      return { success: false, message: "There is no pending long-running work draft for this chat session." };
    }
    if (pending.spec.status === "cancelled") {
      return { success: false, message: "That long-running draft was cancelled and cannot be reused." };
    }
    if (runSpecId && pending.spec.id !== runSpecId) {
      return {
        success: false,
        message: "That long-running draft does not match the pending confirmation in this chat session.",
      };
    }
    return { success: true, message: "pending RunSpec found", confirmation: pending };
  }

  private async getPending(): Promise<RunSpecConfirmationSnapshot | null> {
    if (this.deps.getPendingConfirmation) {
      const value = await this.deps.getPendingConfirmation();
      return value ? parseConfirmation(value) : null;
    }
    return null;
  }

  private async setPending(confirmation: RunSpecConfirmationSnapshot | null): Promise<void> {
    await this.deps.setPendingConfirmation?.(confirmation);
  }

  private async getDaemonClient(): Promise<Pick<DaemonClient, "startGoal"> | null> {
    if (this.deps.daemonClient) return this.deps.daemonClient;
    if (this.deps.daemonClientFactory) return this.deps.daemonClientFactory();
    const baseDir = this.deps.stateManager.getBaseDir();
    const info = await isDaemonRunning(baseDir);
    if (!info.running) return null;
    return new DaemonClient({
      host: this.deps.host ?? "127.0.0.1",
      port: info.port,
      authToken: info.authToken,
      baseDir,
    });
  }

  private async createGoalFromRunSpec(spec: RunSpec): Promise<Goal> {
    if (spec.links.goal_id) {
      const existing = await this.deps.stateManager.loadGoal(spec.links.goal_id);
      if (existing) return existing;
    }
    const now = new Date().toISOString();
    const goal = GoalSchema.parse({
      id: `goal-runspec-${randomUUID()}`,
      parent_id: null,
      node_type: "goal",
      title: spec.objective,
      description: [
        spec.objective,
        "",
        `Source RunSpec: ${spec.id}`,
        `Original request: ${spec.source_text}`,
      ].join("\n"),
      status: "active",
      dimensions: [goalDimensionFromRunSpec(spec, now)],
      gap_aggregation: "max",
      dimension_mapping: null,
      constraints: goalConstraintsFromRunSpec(spec),
      children_ids: [],
      target_date: spec.deadline?.iso_at ?? null,
      origin: "manual",
      pace_snapshot: null,
      deadline: spec.deadline?.iso_at ?? null,
      confidence_flag: spec.confidence,
      user_override: false,
      feasibility_note: `Derived from natural-language RunSpec ${spec.id}`,
      uncertainty_weight: 1,
      created_at: now,
      updated_at: now,
    });
    await this.deps.stateManager.saveGoal(goal);
    await createRunSpecStore(this.deps.stateManager).save({
      ...spec,
      links: { ...spec.links, goal_id: goal.id },
      updated_at: now,
    });
    return goal;
  }

  private async createRunSpecBackgroundRun(spec: RunSpec, goal: Goal) {
    const sessionId = this.deps.conversationSessionId ?? spec.origin.session_id;
    const pinnedReplyTarget = normalizePinnedReplyTargetForRunSpec(
      spec.origin.reply_target
      ?? this.deps.replyTarget
      ?? null,
    );
    const input: BackgroundRunCreateInput = {
      id: `run:coreloop:${randomUUID()}`,
      kind: "coreloop_run",
      goal_id: goal.id,
      parent_session_id: sessionId ? `session:conversation:${sessionId}` : null,
      notify_policy: pinnedReplyTarget ? "done_only" : "silent",
      reply_target_source: pinnedReplyTarget ? "pinned_run" : "none",
      pinned_reply_target: pinnedReplyTarget,
      title: goal.title,
      workspace: spec.workspace?.path ?? this.deps.sessionCwd ?? null,
      source_refs: [
        ...(sessionId ? [{
          kind: "chat_session" as const,
          id: sessionId,
          path: null,
          relative_path: `chat/sessions/${sessionId}.json`,
          updated_at: null,
        }] : []),
        {
          kind: "artifact" as const,
          id: spec.id,
          path: null,
          relative_path: `run-specs/${spec.id}.json`,
          updated_at: spec.updated_at,
        },
      ],
      origin_metadata: {
        run_spec_id: spec.id,
        run_spec_origin: spec.origin,
        source_text: spec.source_text,
      },
    };
    const [primary, ...mirrors] = this.getBackgroundRunLedgers();
    const run = await primary.create(input);
    await Promise.all(mirrors.map((ledger) => ledger.create(input).catch(() => undefined)));
    return run;
  }

  private getBackgroundRunLedgers(): BackgroundRunLedger[] {
    const baseDir = this.deps.stateManager.getBaseDir();
    const configuredRuntimeRoot = resolveConfiguredDaemonRuntimeRoot(baseDir);
    return [new BackgroundRunLedger(configuredRuntimeRoot, { controlBaseDir: baseDir })];
  }

  private wasDraftCreatedInCurrentTurn(confirmation: RunSpecConfirmationSnapshot): boolean {
    if (!this.deps.currentTurnStartedAt) return false;
    const turnStarted = Date.parse(this.deps.currentTurnStartedAt);
    const draftCreated = Date.parse(confirmation.createdAt);
    if (!Number.isFinite(turnStarted) || !Number.isFinite(draftCreated)) return false;
    return draftCreated >= turnStarted;
  }
}

export function validateRunSpecStartSafety(spec: RunSpec): string | null {
  const required = spec.missing_fields.filter((field) => field.severity === "required");
  if (required.length > 0) {
    return [
      "Long-running work approved, but not started: required details are unresolved.",
      "Required long-running work details are unresolved.",
      ...required.map((field) => `- ${field.question}`),
      "Reply with the missing workspace, deadline, metric, or approval details, then approve again.",
    ].join("\n");
  }

  if (!spec.workspace?.path || spec.workspace.confidence === "low") {
    return [
      "Long-running work approved, but not started: the workspace is missing or ambiguous.",
      "Workspace is missing or ambiguous.",
      "Reply with the exact local or remote workspace path before starting background work.",
    ].join("\n");
  }

  if (spec.profile === "kaggle") {
    const workspacePolicyBlock = validateKaggleWorkspaceWritePolicy(spec.workspace.path);
    if (workspacePolicyBlock) {
      return workspacePolicyBlock;
    }
  }

  const blockedPolicies = [
    spec.approval_policy.submit === "disallowed" ? "submissions" : null,
    spec.approval_policy.publish === "disallowed" ? "publishing" : null,
    spec.approval_policy.external_action === "disallowed" ? "external action" : null,
    spec.approval_policy.irreversible_action === "disallowed" ? "irreversible action" : null,
    spec.approval_policy.secret === "disallowed" ? "secret transmission" : null,
  ].filter((value): value is string => value !== null);
  if (blockedPolicies.length > 0) {
    return [
      "Long-running work approved, but not started: a safety policy blocks the handoff.",
      `Blocked safety policy: ${blockedPolicies.join(", ")}.`,
      "PulSeed will not start a long-running handoff that requires an action the current safety policy does not allow.",
      "Revise the long-running work to remove the blocked action or require an explicit approval gate later.",
    ].join("\n");
  }

  return null;
}

function validateKaggleWorkspaceWritePolicy(workspacePath: string): string | null {
  const stateRoot = path.resolve(getPulseedDirPath());
  const workspaceRoot = path.resolve(workspacePath);
  const stateRelativeWorkspace = path.relative(stateRoot, workspaceRoot);
  const isUnderProtectedStateRoot = workspaceRoot === stateRoot
    || (!stateRelativeWorkspace.startsWith("..") && !path.isAbsolute(stateRelativeWorkspace));
  const probePath = path.join(workspaceRoot, ".pulseed-write-policy-probe");
  const validation = validateProtectedPath(probePath, {
    cwd: workspaceRoot,
    workspaceRoot,
    protectedPaths: [stateRoot],
  });
  if (validation.valid && !isUnderProtectedStateRoot) return null;
  return [
    "Long-running work approved, but not started: the Kaggle workspace is blocked by the AgentLoop write policy.",
    `Workspace: ${workspaceRoot}`,
    `Protected runtime state root: ${stateRoot}`,
    `Policy reason: ${validation.error ?? "workspace is not writable by policy"}`,
    "Move the Kaggle workspace under the PulSeed-managed workspace root, for example ~/PulSeedWorkspaces/kaggle/<competition>, then approve again.",
  ].join("\n");
}

function goalDimensionFromRunSpec(spec: RunSpec, now: string): Goal["dimensions"][number] {
  const metric = spec.metric;
  const progress = spec.progress_contract;
  const thresholdValue = metric?.target ?? metric?.target_rank_percent ?? progress.threshold;
  const direction = metric?.direction ?? "unknown";
  const threshold = typeof thresholdValue === "number"
    ? direction === "minimize"
      ? { type: "max" as const, value: thresholdValue }
      : { type: "min" as const, value: thresholdValue }
    : { type: "present" as const };
  return {
    name: progress.dimension ?? metric?.name ?? "runspec_progress",
    label: progress.semantics,
    current_value: null,
    threshold,
    confidence: spec.confidence === "high" ? 0.85 : spec.confidence === "medium" ? 0.65 : 0.4,
    observation_method: {
      type: "llm_review",
      source: "natural_language_runspec",
      schedule: null,
      endpoint: null,
      confidence_tier: "self_report",
    },
    last_updated: now,
    history: [],
    weight: 1,
    uncertainty_weight: null,
    state_integrity: "ok",
    dimension_mapping: null,
  };
}

function goalConstraintsFromRunSpec(spec: RunSpec): string[] {
  return [
    `RunSpec: ${spec.id}`,
    `Profile: ${spec.profile}`,
    `run_spec_profile:${spec.profile}`,
    ...(spec.profile === "kaggle" ? ["artifact_contract:required"] : []),
    `Workspace: ${spec.workspace?.path ?? "unresolved"}`,
    `Progress: ${spec.progress_contract.semantics}`,
    `Submit policy: ${spec.approval_policy.submit}`,
    `Publish policy: ${spec.approval_policy.publish}`,
    `External actions: ${spec.approval_policy.external_action}`,
    `Secret policy: ${spec.approval_policy.secret}`,
    `Irreversible actions: ${spec.approval_policy.irreversible_action}`,
  ];
}

function normalizePinnedReplyTargetForRunSpec(replyTarget: Record<string, unknown> | null): RuntimeReplyTarget | null {
  if (!replyTarget) return null;
  const channel = asString(replyTarget["channel"]) ?? asString(replyTarget["surface"]);
  if (!channel) return null;
  return {
    channel,
    target_id: asString(replyTarget["conversation_id"])
      ?? asString(replyTarget["identity_key"])
      ?? asString(replyTarget["response_channel"])
      ?? null,
    thread_id: asString(replyTarget["message_id"]) ?? null,
    metadata: {
      ...replyTarget,
      ...(isRecord(replyTarget["metadata"]) ? replyTarget["metadata"] : {}),
    },
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfirmation(value: RunSpecConfirmationSnapshot): RunSpecConfirmationSnapshot {
  return {
    ...value,
    spec: RunSpecSchema.parse(value.spec),
  };
}
