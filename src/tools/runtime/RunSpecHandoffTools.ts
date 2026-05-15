import { z } from "zod/v3";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { DaemonClient } from "../../runtime/daemon/client.js";
import {
  RunSpecHandoffService,
  type RunSpecConfirmationSnapshot,
} from "../../runtime/run-spec/index.js";
import { RunSpecSafeNonnegativeIntSchema } from "../../runtime/run-spec/types.js";
import { ChatSessionSchema } from "../../interface/chat/chat-history.js";
import { ChatSessionDataStore } from "../../interface/chat/chat-session-data-store.js";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../types.js";

const DraftRunSpecToolInputSchema = z.object({
  request: z.string().min(1),
  cwd: z.string().min(1).optional(),
  channel: z.string().min(1).optional(),
  conversation_id: z.string().min(1).optional(),
  origin_metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
type DraftRunSpecToolInput = z.infer<typeof DraftRunSpecToolInputSchema>;

const UpdateRunSpecDraftToolInputSchema = z.object({
  run_spec_id: z.string().min(1).optional(),
  workspace_path: z.string().min(1).optional(),
  deadline: z.object({
    raw: z.string().min(1),
    iso_at: z.string().nullable().optional(),
    timezone: z.string().nullable().optional(),
    finalization_buffer_minutes: RunSpecSafeNonnegativeIntSchema.nullable().optional(),
    confidence: z.enum(["high", "medium", "low"]).optional(),
  }).optional(),
  metric_direction: z.enum(["maximize", "minimize"]).optional(),
  timezone: z.string().min(1).optional(),
}).strict().refine((input) => input.workspace_path || input.deadline || input.metric_direction, {
  message: "workspace_path, deadline, or metric_direction is required",
});
type UpdateRunSpecDraftToolInput = z.infer<typeof UpdateRunSpecDraftToolInputSchema>;

const RunSpecIdToolInputSchema = z.object({
  run_spec_id: z.string().min(1).optional(),
}).strict();
type RunSpecIdToolInput = z.infer<typeof RunSpecIdToolInputSchema>;

const ObservedRunSpecInputSchema = z.object({
  run_spec_id: z.string().min(1),
  observed_run_spec_epoch: z.string().min(1),
}).strict();
type ObservedRunSpecInput = z.infer<typeof ObservedRunSpecInputSchema>;

export interface RunSpecHandoffToolDeps {
  stateManager: StateManager;
  llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">;
  daemonClient?: Pick<DaemonClient, "startGoal">;
  daemonClientFactory?: () => Promise<Pick<DaemonClient, "startGoal">>;
}

export function createRunSpecHandoffTools(deps: RunSpecHandoffToolDeps): ITool[] {
  return [
    new DraftRunSpecTool(deps),
    new UpdateRunSpecDraftTool(deps),
    new CancelRunSpecDraftTool(deps),
    new StartDurableRunTool(deps),
    new RunSpecProposeTool(deps),
    new RunSpecConfirmTool(deps),
    new RunStartTool(deps),
  ];
}

class DraftRunSpecTool implements ITool<DraftRunSpecToolInput> {
  readonly metadata = makeMetadata("draft_run_spec", "write_local");
  readonly inputSchema = DraftRunSpecToolInputSchema;

  constructor(private readonly deps: RunSpecHandoffToolDeps) {}

  description(context?: ToolDescriptionContext): string {
    return [
      "Draft and persist a typed long-running RunSpec from the current user request.",
      "Use this for autonomous daemon-backed DurableLoop handoff requests such as background Kaggle, benchmark, monitoring, or long-running optimization work.",
      "This only creates a pending draft and never starts the daemon run.",
      context?.cwd ? `Current cwd: ${context.cwd}.` : "",
    ].filter(Boolean).join(" ");
  }

  async call(input: DraftRunSpecToolInput, context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    const service = createService(this.deps, context);
    const result = await service.draft({
      text: input.request,
      cwd: input.cwd ?? context.cwd,
      channel: input.channel ?? "agent_loop",
      conversationId: input.conversation_id ?? context.conversationSessionId ?? null,
      sessionId: context.conversationSessionId ?? input.conversation_id ?? null,
      replyTarget: context.runtimeReplyTarget ?? null,
      originMetadata: {
        tool_name: this.metadata.name,
        ...(input.origin_metadata ?? {}),
      },
    });
    return toolResult(result.success, result.data ?? null, result.message, started);
  }

  checkPermissions(): Promise<PermissionCheckResult> {
    return Promise.resolve({ status: "allowed" });
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

class UpdateRunSpecDraftTool implements ITool<UpdateRunSpecDraftToolInput> {
  readonly metadata = makeMetadata("update_run_spec_draft", "write_local");
  readonly inputSchema = UpdateRunSpecDraftToolInputSchema;

  constructor(private readonly deps: RunSpecHandoffToolDeps) {}

  description(): string {
    return "Update the pending RunSpec draft with typed clarification fields. Does not start a daemon run.";
  }

  async call(input: UpdateRunSpecDraftToolInput, context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    const result = await createService(this.deps, context).updatePendingDraft({
      runSpecId: input.run_spec_id,
      workspacePath: input.workspace_path,
      deadline: input.deadline,
      metricDirection: input.metric_direction,
      timezone: input.timezone,
    });
    return toolResult(result.success, result.data ?? null, result.message, started);
  }

  checkPermissions(): Promise<PermissionCheckResult> {
    return Promise.resolve({ status: "allowed" });
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

class CancelRunSpecDraftTool implements ITool<RunSpecIdToolInput> {
  readonly metadata = makeMetadata("cancel_run_spec_draft", "write_local");
  readonly inputSchema = RunSpecIdToolInputSchema;

  constructor(private readonly deps: RunSpecHandoffToolDeps) {}

  description(): string {
    return "Cancel the pending RunSpec draft for this chat session. Never starts a daemon run.";
  }

  async call(input: RunSpecIdToolInput, context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    const result = await createService(this.deps, context).cancelPendingDraft(input.run_spec_id);
    return toolResult(result.success, result.data ?? null, result.message, started);
  }

  checkPermissions(): Promise<PermissionCheckResult> {
    return Promise.resolve({ status: "allowed" });
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

class StartDurableRunTool implements ITool<ObservedRunSpecInput> {
  readonly metadata = makeMetadata("start_durable_run", "write_local");
  readonly inputSchema = ObservedRunSpecInputSchema;

  constructor(private readonly deps: RunSpecHandoffToolDeps) {}

  description(): string {
    return [
      "Confirm the pending validated RunSpec draft and start the daemon-backed DurableLoop run.",
      "Only use after the operator explicitly approves the pending draft.",
      "This rejects missing required fields, low-confidence workspace, disallowed safety policy, stale IDs, and cancelled drafts.",
    ].join(" ");
  }

  async call(input: ObservedRunSpecInput, context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    const freshness = await validateObservedRunSpec(this.deps, context, input);
    if (!freshness.ok) {
      return toolResult(false, freshness.data, freshness.message, started, {
        status: "not_executed",
        reason: "stale_state",
        message: freshness.message,
      });
    }
    const result = await createService(this.deps, context).startPendingDraft(input.run_spec_id);
    return toolResult(result.success, result.data ?? null, result.message, started);
  }

  async checkPermissions(_input: ObservedRunSpecInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    return context.preApproved
      ? { status: "allowed" }
      : { status: "needs_approval", reason: "start_durable_run starts daemon-backed DurableLoop work" };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

class RunSpecProposeTool implements ITool<DraftRunSpecToolInput> {
  readonly metadata = makeMetadata("runspec_propose", "write_local");
  readonly inputSchema = DraftRunSpecToolInputSchema;

  constructor(private readonly deps: RunSpecHandoffToolDeps) {}

  description(context?: ToolDescriptionContext): string {
    return [
      "Propose and persist a typed long-running RunSpec from the current user request.",
      "This only creates a pending draft and returns observed_run_spec_epoch for a later runspec_confirm or run_start call.",
      context?.cwd ? `Current cwd: ${context.cwd}.` : "",
    ].filter(Boolean).join(" ");
  }

  async call(input: DraftRunSpecToolInput, context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    const result = await createService(this.deps, context).draft({
      text: input.request,
      cwd: input.cwd ?? context.cwd,
      channel: input.channel ?? "agent_loop",
      conversationId: input.conversation_id ?? context.conversationSessionId ?? null,
      sessionId: context.conversationSessionId ?? input.conversation_id ?? null,
      replyTarget: context.runtimeReplyTarget ?? null,
      originMetadata: {
        tool_name: this.metadata.name,
        ...(input.origin_metadata ?? {}),
      },
    });
    return toolResult(result.success, {
      ...(result.data ?? {}),
      ...(result.spec ? { observed_run_spec_epoch: result.spec.updated_at } : {}),
    }, result.message, started);
  }

  checkPermissions(): Promise<PermissionCheckResult> {
    return Promise.resolve({ status: "allowed" });
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

class RunSpecConfirmTool implements ITool<ObservedRunSpecInput> {
  readonly metadata = makeMetadata("runspec_confirm", "write_local");
  readonly inputSchema = ObservedRunSpecInputSchema;

  constructor(private readonly deps: RunSpecHandoffToolDeps) {}

  description(): string {
    return "Confirm the pending typed RunSpec by exact run_spec_id and observed_run_spec_epoch, then start the daemon-backed run when policy and safety gates allow it.";
  }

  async call(input: ObservedRunSpecInput, context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    const freshness = await validateObservedRunSpec(this.deps, context, input);
    if (!freshness.ok) {
      return toolResult(false, freshness.data, freshness.message, started, {
        status: "not_executed",
        reason: "stale_state",
        message: freshness.message,
      });
    }
    const result = await createService(this.deps, context).startPendingDraft(input.run_spec_id);
    return toolResult(result.success, result.data ?? null, result.message, started);
  }

  async checkPermissions(_input: ObservedRunSpecInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    return context.preApproved
      ? { status: "allowed" }
      : { status: "needs_approval", reason: "runspec_confirm starts daemon-backed DurableLoop work" };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

class RunStartTool implements ITool<ObservedRunSpecInput> {
  readonly metadata = makeMetadata("run_start", "write_local");
  readonly inputSchema = ObservedRunSpecInputSchema;

  constructor(private readonly deps: RunSpecHandoffToolDeps) {}

  description(): string {
    return "Start a pending typed RunSpec as a daemon-backed runtime run using exact run_spec_id and observed_run_spec_epoch.";
  }

  async call(input: ObservedRunSpecInput, context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    const freshness = await validateObservedRunSpec(this.deps, context, input);
    if (!freshness.ok) {
      return toolResult(false, freshness.data, freshness.message, started, {
        status: "not_executed",
        reason: "stale_state",
        message: freshness.message,
      });
    }
    const result = await createService(this.deps, context).startPendingDraft(input.run_spec_id);
    return toolResult(result.success, result.data ?? null, result.message, started);
  }

  async checkPermissions(_input: ObservedRunSpecInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    return context.preApproved
      ? { status: "allowed" }
      : { status: "needs_approval", reason: "run_start starts daemon-backed DurableLoop work" };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

function createService(deps: RunSpecHandoffToolDeps, context: ToolCallContext): RunSpecHandoffService {
  return new RunSpecHandoffService({
    stateManager: deps.stateManager,
    llmClient: deps.llmClient,
    daemonClient: deps.daemonClient,
    daemonClientFactory: deps.daemonClientFactory,
    conversationSessionId: context.conversationSessionId ?? null,
    sessionCwd: context.cwd,
    replyTarget: context.runtimeReplyTarget ?? null,
    currentTurnStartedAt: context.runSpecConfirmation?.currentTurnStartedAt ?? null,
    getPendingConfirmation: async () => getPendingConfirmation(deps.stateManager, context),
    setPendingConfirmation: async (confirmation) => setPendingConfirmation(deps.stateManager, context, confirmation),
  });
}

async function validateObservedRunSpec(
  deps: RunSpecHandoffToolDeps,
  context: ToolCallContext,
  input: ObservedRunSpecInput,
): Promise<
  | { ok: true }
  | { ok: false; message: string; data: Record<string, unknown> }
> {
  const pending = await getPendingConfirmation(deps.stateManager, context);
  if (!pending || pending.state !== "pending") {
    return {
      ok: false,
      message: "No matching pending RunSpec is available; refusing to reuse stale RunSpec state.",
      data: {
        status: "stale_state",
        run_spec_id: input.run_spec_id,
      },
    };
  }
  if (pending.spec.id !== input.run_spec_id) {
    return {
      ok: false,
      message: `Pending RunSpec mismatch: expected ${pending.spec.id}, received ${input.run_spec_id}.`,
      data: {
        status: "stale_state",
        expected_run_spec_id: pending.spec.id,
        received_run_spec_id: input.run_spec_id,
        current_run_spec_epoch: pending.updatedAt,
        observed_run_spec_epoch: input.observed_run_spec_epoch,
      },
    };
  }
  if (pending.updatedAt !== input.observed_run_spec_epoch && pending.spec.updated_at !== input.observed_run_spec_epoch) {
    return {
      ok: false,
      message: `RunSpec ${input.run_spec_id} changed since it was observed; refusing to start from stale state.`,
      data: {
        status: "stale_state",
        run_spec_id: input.run_spec_id,
        current_run_spec_epoch: pending.updatedAt,
        current_spec_updated_at: pending.spec.updated_at,
        observed_run_spec_epoch: input.observed_run_spec_epoch,
      },
    };
  }
  return { ok: true };
}

async function getPendingConfirmation(
  stateManager: StateManager,
  context: ToolCallContext,
): Promise<RunSpecConfirmationSnapshot | null> {
  const bridged = await context.runSpecConfirmation?.get();
  if (bridged) return bridged as RunSpecConfirmationSnapshot;
  if (!context.conversationSessionId) return null;
  const session = await new ChatSessionDataStore(stateManager.getBaseDir()).load(context.conversationSessionId);
  if (!session) return null;
  return session.runSpecConfirmation ?? null;
}

async function setPendingConfirmation(
  stateManager: StateManager,
  context: ToolCallContext,
  confirmation: RunSpecConfirmationSnapshot | null,
): Promise<void> {
  if (context.runSpecConfirmation) {
    await context.runSpecConfirmation.set(confirmation);
    return;
  }
  if (!context.conversationSessionId) return;
  const store = new ChatSessionDataStore(stateManager.getBaseDir());
  const session = await store.load(context.conversationSessionId);
  if (!session) return;
  const next = confirmation
    ? ChatSessionSchema.parse({ ...session, runSpecConfirmation: confirmation })
    : ChatSessionSchema.parse(omitKey(session, "runSpecConfirmation"));
  await store.save(next);
}

function omitKey<T extends Record<string, unknown>>(value: T, key: string): T {
  const next = { ...value };
  delete next[key];
  return next;
}

function makeMetadata(name: string, permissionLevel: ToolMetadata["permissionLevel"]): ToolMetadata {
  return {
    name,
    aliases: [],
    permissionLevel,
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 12000,
    tags: ["agentloop", "runspec", "durableloop"],
  };
}

function toolResult(
  success: boolean,
  data: unknown,
  summary: string,
  started: number,
  execution?: ToolResult["execution"],
): ToolResult {
  return {
    success,
    data,
    summary,
    ...(success ? {} : { error: summary }),
    ...(execution ? { execution } : {}),
    durationMs: Date.now() - started,
  };
}
