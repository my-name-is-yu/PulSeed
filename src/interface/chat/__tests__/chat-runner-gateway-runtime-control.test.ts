import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { ChatRunner } from "../chat-runner.js";
import type { ChatRunnerDeps } from "../chat-runner-contracts.js";
import { CrossPlatformChatSessionManager } from "../cross-platform-session.js";
import { ChatSessionCatalog } from "../chat-session-store.js";
import { StateManager } from "../../../base/state/state-manager.js";
import type { IAdapter, AgentResult } from "../../../orchestrator/execution/adapter-layer.js";
import type { EscalationHandler, EscalationResult } from "../escalation.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import type { ChatAgentLoopRunner } from "../../../orchestrator/execution/agent-loop/chat-agent-loop-runner.js";
import { RuntimeControlService } from "../../../runtime/control/index.js";
import { createRuntimeSessionRegistry } from "../../../runtime/session-registry/index.js";
import { RuntimeOperationStore } from "../../../runtime/store/runtime-operation-store.js";
import type { Goal } from "../../../base/types/goal.js";
import type { Task } from "../../../base/types/task.js";
import type { ChatEvent } from "../chat-events.js";
import type { ChatIngressMessage, SelectedChatRoute } from "../ingress-router.js";
import type { TelegramSetupStatus } from "../gateway-setup-status.js";
import { clearIdentityCache } from "../../../base/config/identity-loader.js";
import type { ProcessSessionSnapshot } from "../../../tools/system/ProcessSessionTool/ProcessSessionTool.js";
import { RuntimeOperatorHandoffStore } from "../../../runtime/store/operator-handoff-store.js";
import { createRunSpecHandoffTools } from "../../../tools/runtime/RunSpecHandoffTools.js";
import { createSetupRuntimeControlTools } from "../../../tools/runtime/SetupRuntimeControlTools.js";
import type { ApprovalRequest, ToolCallContext } from "../../../tools/types.js";
import { createMockLLMClient, createSingleMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { createTextUserInput } from "../user-input.js";
// Mock context-provider so tests don't walk the real filesystem
vi.mock("../../../platform/observation/context-provider.js", () => ({
  resolveGitRoot: (cwd: string) => cwd,
  buildChatContext: (_task: string, cwd: string) => Promise.resolve(`Working directory: ${cwd}`),
}));

const CANNED_RESULT: AgentResult = {
  success: true,
  output: "Task completed successfully.",
  error: null,
  exit_code: 0,
  elapsed_ms: 50,
  stopped_reason: "completed",
};

function makeMockAdapter(result: AgentResult = CANNED_RESULT): IAdapter {
  return {
    adapterType: "mock",
    execute: vi.fn().mockResolvedValue(result),
  } as unknown as IAdapter;
}

function makeMockStateManager(): StateManager {
  return {
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
  } as unknown as StateManager;
}

function makeIngress(text: string): ChatIngressMessage {
  return {
    channel: "plugin_gateway",
    platform: "telegram",
    identity_key: "telegram:user-1",
    conversation_id: "chat-1",
    message_id: "message-1",
    text,
    userInput: createTextUserInput(text),
    actor: {
      surface: "gateway",
      identity_key: "telegram:user-1",
    },
    runtimeControl: {
      allowed: false,
      approvalMode: "disallowed",
    },
    metadata: {},
    replyTarget: {
      surface: "gateway",
      channel: "plugin_gateway",
      identity_key: "telegram:user-1",
      conversation_id: "chat-1",
      deliveryMode: "reply",
    },
  };
}

function adapterRoute(): SelectedChatRoute {
  return {
    kind: "adapter",
    reason: "adapter_fallback",
    replyTargetPolicy: "turn_reply_target",
    eventProjectionPolicy: "turn_only",
    concurrencyPolicy: "session_serial",
  };
}

type TelegramSetupStatusOverrides = Partial<Omit<TelegramSetupStatus, "daemon" | "config">> & {
  daemon?: Partial<TelegramSetupStatus["daemon"]>;
  config?: Partial<TelegramSetupStatus["config"]>;
};

function makeTelegramSetupStatus(overrides: TelegramSetupStatusOverrides = {}): TelegramSetupStatus {
  const base: TelegramSetupStatus = {
    channel: "telegram",
    state: "unconfigured",
    configPath: "/tmp/pulseed/gateway/channels/telegram-bot/config.json",
    daemon: {
      running: true,
      port: 41700,
    },
    gateway: {
      loadState: "unknown",
    },
    config: {
      exists: false,
      hasBotToken: false,
      hasHomeChat: false,
      allowAll: false,
      allowedUserCount: 0,
      runtimeControlAllowedUserCount: 0,
      identityKeyConfigured: false,
    },
  };
  return {
    ...base,
    ...overrides,
    daemon: { ...base.daemon, ...(overrides.daemon ?? {}) },
    gateway: { ...base.gateway, ...(overrides.gateway ?? {}) },
    config: { ...base.config, ...(overrides.config ?? {}) },
  };
}

function makeTelegramStatusProvider(status: TelegramSetupStatus): NonNullable<ChatRunnerDeps["gatewaySetupStatusProvider"]> {
  return {
    getTelegramStatus: vi.fn().mockResolvedValue(status),
  };
}

function telegramConfigureRoute(): SelectedChatRoute {
  return {
    kind: "configure",
    reason: "freeform_semantic_route",
    intent: {
      kind: "configure",
      confidence: 0.95,
      configure_target: "telegram_gateway",
      rationale: "test configure route",
    },
    replyTargetPolicy: "turn_reply_target",
    eventProjectionPolicy: "turn_only",
    concurrencyPolicy: "session_serial",
  };
}

function makeDeps(overrides: Partial<ChatRunnerDeps> = {}): ChatRunnerDeps {
  return {
    stateManager: makeMockStateManager(),
    adapter: makeMockAdapter(),
    ...overrides,
  };
}

function interruptDecision(kind: "diff" | "review" | "summary" | "background" | "redirect" | "unknown", confidence = 0.93): string {
  return JSON.stringify({ kind, confidence, rationale: `test ${kind}` });
}

function runSpecDraftDecision(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    decision: "run_spec_request",
    confidence: 0.92,
    profile: "kaggle",
    objective: "Kaggle score 0.98を超えるまで長期で改善する",
    execution_target: { kind: "daemon", remote_host: null, confidence: "medium" },
    metric: {
      name: "kaggle_score",
      direction: "maximize",
      target: 0.98,
      target_rank_percent: null,
      datasource: "kaggle_leaderboard",
      confidence: "high",
    },
    progress_contract: {
      kind: "metric_target",
      dimension: "kaggle_score",
      threshold: 0.98,
      semantics: "Kaggle score exceeds 0.98.",
      confidence: "high",
    },
    deadline: {
      raw: "until score exceeds 0.98",
      iso_at: null,
      timezone: null,
      finalization_buffer_minutes: null,
      confidence: "medium",
    },
    budget: { max_trials: null, max_wall_clock_minutes: null, resident_policy: "best_effort" },
    approval_policy: {
      submit: "approval_required",
      publish: "unspecified",
      secret: "approval_required",
      external_action: "approval_required",
      irreversible_action: "approval_required",
    },
    missing_fields: [],
    ...overrides,
  });
}

function runSpecConfirmationDecision(decision: "approve" | "cancel" | "unknown" | "revise", overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    decision,
    confidence: 0.93,
    ...overrides,
  });
}

function freeformRouteDecision(kind: "assist" | "configure" | "execute" | "run_spec" | "clarify", confidence = 0.93): string {
  return JSON.stringify({ kind, confidence, rationale: `test ${kind}` });
}

function freeformExecuteDecision(): string {
  return freeformRouteDecision("execute");
}

function makeInterruptibleAgentLoopRunner() {
  let capturedSignal: AbortSignal | undefined;
  let resolveActive: ((value: AgentResult) => void) | undefined;
  const runner = {
    execute: vi.fn().mockImplementation((input: { abortSignal?: AbortSignal }) => {
      capturedSignal = input.abortSignal;
      return new Promise<AgentResult>((resolve) => {
        resolveActive = resolve;
        input.abortSignal?.addEventListener("abort", () => {
          resolve({
            success: false,
            output: "cancelled",
            error: "cancelled",
            exit_code: null,
            elapsed_ms: 10,
            stopped_reason: "error",
          });
        }, { once: true });
      });
    }),
  } as unknown as ChatAgentLoopRunner;
  return {
    runner,
    getSignal: () => capturedSignal,
    resolveActive: (result: AgentResult = {
      success: false,
      output: "cancelled by test",
      error: null,
      exit_code: null,
      elapsed_ms: 1,
      stopped_reason: "error",
    }) => resolveActive?.(result),
  };
}

function makeAgentLoopState(overrides: Partial<{
  sessionId: string;
  status: "running" | "completed" | "failed";
  updatedAt: string;
}> = {}) {
  return {
    sessionId: overrides.sessionId ?? "agent-session-a",
    traceId: "trace-a",
    turnId: "turn-a",
    goalId: "goal-a",
    cwd: "/repo",
    modelRef: "native:test",
    messages: [],
    modelTurns: 1,
    toolCalls: 0,
    compactions: 0,
    completionValidationAttempts: 0,
    calledTools: [],
    lastToolLoopSignature: null,
    repeatedToolLoopCount: 0,
    finalText: "",
    status: overrides.status ?? "running",
    updatedAt: overrides.updatedAt ?? "2026-04-25T00:12:00.000Z",
  };
}

function makeProcessSnapshot(overrides: Partial<ProcessSessionSnapshot> = {}): ProcessSessionSnapshot {
  return {
    session_id: overrides.session_id ?? "proc-1",
    label: overrides.label ?? "training",
    command: overrides.command ?? "node",
    args: overrides.args ?? ["train.js"],
    cwd: overrides.cwd ?? "/repo",
    pid: overrides.pid ?? 12345,
    running: overrides.running ?? true,
    exitCode: overrides.exitCode ?? null,
    signal: overrides.signal ?? null,
    startedAt: overrides.startedAt ?? "2026-04-25T00:00:00.000Z",
    ...(overrides.exitedAt ? { exitedAt: overrides.exitedAt } : {}),
    bufferedChars: overrides.bufferedChars ?? 0,
    metadataRelativePath: overrides.metadataRelativePath ?? `runtime/process-sessions/${overrides.session_id ?? "proc-1"}.json`,
    artifactRefs: overrides.artifactRefs ?? [],
  };
}

function makeGoal(id: string, overrides: Partial<Goal> = {}): Goal {
  return {
    id,
    parent_id: null,
    node_type: "goal",
    title: `Goal ${id}`,
    description: `Description for ${id}`,
    status: "active",
    dimensions: [{
      name: "quality",
      label: "Quality",
      current_value: 0.4,
      threshold: { type: "min", value: 0.9 },
      confidence: 0.8,
      observation_method: {
        type: "manual",
        source: "test",
        schedule: null,
        endpoint: null,
        confidence_tier: "self_report",
      },
      last_updated: null,
      history: [],
      weight: 1,
      uncertainty_weight: null,
      state_integrity: "ok",
      dimension_mapping: null,
    }],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: [],
    children_ids: [],
    target_date: null,
    origin: null,
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1,
    decomposition_depth: 0,
    specificity_score: null,
    loop_status: "idle",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function makeTask(id: string, goalId: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    goal_id: goalId,
    strategy_id: null,
    target_dimensions: ["quality"],
    primary_dimension: "quality",
    work_description: `Work for ${id}`,
    rationale: "Because it advances the goal.",
    approach: "Do the smallest useful thing.",
    success_criteria: [{
      description: "The work is complete",
      verification_method: "review",
      is_blocking: true,
    }],
    scope_boundary: {
      in_scope: ["implementation"],
      out_of_scope: [],
      blast_radius: "low",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: "2026-01-01T00:00:02.000Z",
    ...overrides,
  };
}

describe("ChatRunner gateway runtime-control routes", () => {
  describe("natural-language runtime control", () => {
    it("handles daemon restart through durable runtime control without calling the adapter", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-control-chat-"));
      try {
        const adapter = makeMockAdapter();
        const stateManager = makeMockStateManager();
        const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
        const executor = vi.fn().mockResolvedValue({
          ok: true,
          message: "restart queued",
          state: "acknowledged",
        });
        const runtimeControlService = new RuntimeControlService({
          operationStore,
          executor,
        });
        const approvalFn = vi.fn().mockResolvedValue(true);
        const runner = new ChatRunner(makeDeps({
          adapter,
          llmClient: createSingleMockLLMClient(JSON.stringify({
            intent: "restart_daemon",
            reason: "PulSeed を再起動して",
          })),
          stateManager,
          approvalFn,
          runtimeControlService,
          runtimeReplyTarget: {
            surface: "gateway",
            platform: "telegram",
            conversation_id: "chat-123",
            identity_key: "owner",
            user_id: "user-1",
          },
        }));

        const result = await runner.execute("PulSeed を再起動して", "/repo");

        expect(result.success).toBe(true);
        expect(result.output).toBe("restart queued");
        expect(adapter.execute).not.toHaveBeenCalled();
        expect(approvalFn).toHaveBeenCalledWith(
          expect.stringContaining("restart_daemon")
        );
        expect(executor).toHaveBeenCalledOnce();

        const pending = await operationStore.listPending();
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
          kind: "restart_daemon",
          state: "acknowledged",
          reason: "PulSeed を再起動して",
          requested_by: {
            surface: "gateway",
            platform: "telegram",
            conversation_id: "chat-123",
            identity_key: "owner",
            user_id: "user-1",
          },
          reply_target: {
            surface: "gateway",
            platform: "telegram",
            conversation_id: "chat-123",
            identity_key: "owner",
            user_id: "user-1",
          },
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("does not route natural-language runtime control when the LLM classifier is unavailable", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));

      const result = await runner.execute("PulSeed を再起動して", "/repo");

      expect(result.success).toBe(true);
      expect(adapter.execute).toHaveBeenCalledOnce();
    });

    it("does not claim restart started when no runtime control executor is configured", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-control-no-executor-"));
      try {
        const adapter = makeMockAdapter();
        const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
        const runtimeControlService = new RuntimeControlService({ operationStore });
        const runner = new ChatRunner(makeDeps({
          adapter,
          llmClient: createSingleMockLLMClient(JSON.stringify({
            intent: "restart_daemon",
            reason: "PulSeed を再起動して",
          })),
          approvalFn: vi.fn().mockResolvedValue(true),
          runtimeControlService,
          runtimeReplyTarget: { surface: "cli" },
        }));

        const result = await runner.execute("PulSeed を再起動して", "/repo");

        expect(result.success).toBe(false);
        expect(result.output).toContain("not configured");
        expect(result.output).not.toContain("再起動を開始します");
        expect(adapter.execute).not.toHaveBeenCalled();
        expect(await operationStore.listPending()).toHaveLength(0);
        const completed = await operationStore.listCompleted();
        expect(completed).toHaveLength(1);
        expect(completed[0]).toMatchObject({
          kind: "restart_daemon",
          state: "failed",
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("marks runtime control failed when the executor throws", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-control-executor-throws-"));
      try {
        const adapter = makeMockAdapter();
        const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
        const runtimeControlService = new RuntimeControlService({
          operationStore,
          executor: vi.fn().mockRejectedValue(new Error("daemon auth failed")),
        });
        const runner = new ChatRunner(makeDeps({
          adapter,
          llmClient: createSingleMockLLMClient(JSON.stringify({
            intent: "restart_daemon",
            reason: "PulSeed を再起動して",
          })),
          approvalFn: vi.fn().mockResolvedValue(true),
          runtimeControlService,
          runtimeReplyTarget: { surface: "cli" },
        }));

        const result = await runner.execute("PulSeed を再起動して", "/repo");

        expect(result.success).toBe(false);
        expect(result.output).toContain("daemon auth failed");
        expect(adapter.execute).not.toHaveBeenCalled();
        expect(await operationStore.listPending()).toHaveLength(0);
        const completed = await operationStore.listCompleted();
        expect(completed).toHaveLength(1);
        expect(completed[0]).toMatchObject({
          kind: "restart_daemon",
          state: "failed",
          result: {
            ok: false,
            message: "daemon auth failed",
          },
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("marks runtime control failed when approval throws", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-control-approval-throws-"));
      try {
        const adapter = makeMockAdapter();
        const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
        const executor = vi.fn().mockResolvedValue({ ok: true });
        const runtimeControlService = new RuntimeControlService({
          operationStore,
          executor,
        });
        const runner = new ChatRunner(makeDeps({
          adapter,
          llmClient: createSingleMockLLMClient(JSON.stringify({
            intent: "restart_daemon",
            reason: "PulSeed を再起動して",
          })),
          approvalFn: vi.fn().mockRejectedValue(new Error("approval store unavailable")),
          runtimeControlService,
          runtimeReplyTarget: { surface: "cli" },
        }));

        const result = await runner.execute("PulSeed を再起動して", "/repo");

        expect(result.success).toBe(false);
        expect(result.output).toContain("approval store unavailable");
        expect(adapter.execute).not.toHaveBeenCalled();
        expect(executor).not.toHaveBeenCalled();
        expect(await operationStore.listPending()).toHaveLength(0);
        const completed = await operationStore.listCompleted();
        expect(completed).toHaveLength(1);
        expect(completed[0]).toMatchObject({
          kind: "restart_daemon",
          state: "failed",
          result: {
            ok: false,
            message: "approval store unavailable",
          },
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("uses runtime-control approval without reusing general tool approval", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-control-scoped-approval-"));
      try {
        const adapter = makeMockAdapter();
        const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
        const runtimeControlService = new RuntimeControlService({
          operationStore,
          executor: vi.fn().mockResolvedValue({
            ok: true,
            state: "restarting",
            message: "restart requested",
          }),
        });
        const approvalFn = vi.fn().mockResolvedValue(false);
        const runtimeControlApprovalFn = vi.fn().mockResolvedValue(true);
        const runner = new ChatRunner(makeDeps({
          adapter,
          llmClient: createSingleMockLLMClient(JSON.stringify({
            intent: "restart_daemon",
            reason: "PulSeed を再起動して",
          })),
          approvalFn,
          runtimeControlApprovalFn,
          runtimeControlService,
          runtimeReplyTarget: { surface: "gateway", platform: "telegram" },
        }));

        const result = await runner.execute("PulSeed を再起動して", "/repo");

        expect(result.success).toBe(true);
        expect(result.output).toBe("restart requested");
        expect(runtimeControlApprovalFn).toHaveBeenCalledOnce();
        expect(approvalFn).not.toHaveBeenCalled();
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("routes approved reload_config and self_update through RuntimeControlService", async () => {
      for (const operation of ["reload_config", "self_update"] as const) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pulseed-runtime-control-${operation}-`));
        try {
          const adapter = makeMockAdapter();
          const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
          const executor = vi.fn().mockResolvedValue({
            ok: true,
            state: "verified",
            message: `${operation} requested`,
          });
          const runtimeControlService = new RuntimeControlService({
            operationStore,
            executor,
          });
          const runtimeControlApprovalFn = vi.fn().mockResolvedValue(true);
          const runner = new ChatRunner(makeDeps({
            adapter,
            llmClient: createSingleMockLLMClient(JSON.stringify({
              intent: operation,
              reason: `please ${operation}`,
            })),
            runtimeControlApprovalFn,
            runtimeControlService,
            runtimeReplyTarget: { surface: "gateway", platform: "telegram" },
          }));

          const result = await runner.execute(`please ${operation}`, "/repo");

          expect(result).toMatchObject({ success: true, output: `${operation} requested` });
          expect(runtimeControlApprovalFn).toHaveBeenCalledWith(expect.stringContaining(operation));
          expect(executor).toHaveBeenCalledWith(expect.objectContaining({ kind: operation }), expect.anything());
          expect(adapter.execute).not.toHaveBeenCalled();
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    });

    it("routes natural-language run pause to typed runtime control instead of the adapter", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-control-chat-pause-"));
      try {
        const adapter = makeMockAdapter();
        const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
        const executor = vi.fn().mockResolvedValue({
          ok: true,
          state: "running",
          message: "pause sent",
        });
        const runtimeControlService = new RuntimeControlService({
          operationStore,
          executor,
          sessionRegistry: {
            snapshot: vi.fn().mockResolvedValue({
              schema_version: "runtime-session-registry-v1",
              generated_at: "2026-05-02T00:00:00.000Z",
              sessions: [],
              background_runs: [{
                schema_version: "background-run-v1",
                id: "run:coreloop:chat",
                kind: "coreloop_run",
                parent_session_id: null,
                child_session_id: "session:coreloop:worker-1",
                process_session_id: null,
                goal_id: "goal-1",
                status: "running",
                notify_policy: "done_only",
                reply_target_source: "none",
                pinned_reply_target: null,
                title: "DurableLoop goal goal-1",
                workspace: "/repo",
                created_at: "2026-05-02T00:00:00.000Z",
                started_at: "2026-05-02T00:00:00.000Z",
                updated_at: "2026-05-02T00:00:00.000Z",
                completed_at: null,
                summary: null,
                error: null,
                artifacts: [],
                source_refs: [],
              }],
              warnings: [],
            }),
          },
        });
        const runner = new ChatRunner(makeDeps({
          adapter,
          llmClient: createSingleMockLLMClient(JSON.stringify({
            intent: "pause_run",
            reason: "この実行を一時停止して",
            targetSelector: { scope: "run", reference: "current", sourceText: "この実行" },
          })),
          runtimeControlService,
          runtimeControlApprovalFn: vi.fn().mockResolvedValue(true),
        }));

        const result = await runner.execute("この実行を一時停止して", "/repo");

        expect(result).toMatchObject({ success: true, output: "pause sent" });
        expect(adapter.execute).not.toHaveBeenCalled();
        expect(executor).toHaveBeenCalledWith(expect.objectContaining({
          kind: "pause_run",
          target: expect.objectContaining({ run_id: "run:coreloop:chat", goal_id: "goal-1" }),
        }), expect.anything());
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("blocks current runtime control when the scoped conversation has no active run", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-control-chat-current-scope-"));
      try {
        const adapter = makeMockAdapter();
        const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
        const executor = vi.fn();
        const runtimeControlService = new RuntimeControlService({
          operationStore,
          executor,
          sessionRegistry: {
            snapshot: vi.fn().mockResolvedValue({
              schema_version: "runtime-session-registry-v1",
              generated_at: "2026-05-02T00:00:00.000Z",
              sessions: [],
              background_runs: [{
                schema_version: "background-run-v1",
                id: "run:coreloop:other-chat",
                kind: "coreloop_run",
                parent_session_id: "session:conversation:other",
                child_session_id: "session:coreloop:worker-1",
                process_session_id: null,
                goal_id: "goal-other",
                status: "running",
                notify_policy: "done_only",
                reply_target_source: "none",
                pinned_reply_target: null,
                title: "DurableLoop goal goal-other",
                workspace: "/repo",
                created_at: "2026-05-02T00:00:00.000Z",
                started_at: "2026-05-02T00:00:00.000Z",
                updated_at: "2026-05-02T00:00:00.000Z",
                completed_at: null,
                summary: null,
                error: null,
                artifacts: [],
                source_refs: [],
              }],
              warnings: [],
            }),
          },
        });
        const runner = new ChatRunner(makeDeps({
          adapter,
          llmClient: createSingleMockLLMClient(JSON.stringify({
            intent: "pause_run",
            reason: "この実行を一時停止して",
            targetSelector: { scope: "run", reference: "current", sourceText: "この実行" },
          })),
          runtimeControlService,
          runtimeControlApprovalFn: vi.fn().mockResolvedValue(true),
          runtimeReplyTarget: {
            surface: "gateway",
            platform: "telegram",
            conversation_id: "chat-1",
          },
        }));

        const result = await runner.execute("この実行を一時停止して", "/repo");

        expect(result).toMatchObject({
          success: false,
          output: expect.stringContaining("refusing to reuse another conversation"),
        });
        expect(executor).not.toHaveBeenCalled();
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("resolves latest and previous natural-language run references through typed target selection", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-control-target-selector-"));
      try {
        const adapter = makeMockAdapter();
        const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
        const runtimeControlService = new RuntimeControlService({
          operationStore,
          sessionRegistry: {
            snapshot: vi.fn().mockResolvedValue({
              schema_version: "runtime-session-registry-v1",
              generated_at: "2026-05-02T00:20:00.000Z",
              sessions: [],
              background_runs: [
                {
                  schema_version: "background-run-v1",
                  id: "run:older",
                  kind: "coreloop_run",
                  parent_session_id: null,
                  child_session_id: "session:coreloop:older",
                  process_session_id: null,
                  goal_id: "goal-older",
                  status: "running",
                  notify_policy: "done_only",
                  reply_target_source: "none",
                  pinned_reply_target: null,
                  title: "older",
                  workspace: "/repo",
                  created_at: "2026-05-02T00:00:00.000Z",
                  started_at: "2026-05-02T00:00:00.000Z",
                  updated_at: "2026-05-02T00:00:00.000Z",
                  completed_at: null,
                  summary: null,
                  error: null,
                  artifacts: [],
                  source_refs: [],
                },
                {
                  schema_version: "background-run-v1",
                  id: "run:newer",
                  kind: "coreloop_run",
                  parent_session_id: null,
                  child_session_id: "session:coreloop:newer",
                  process_session_id: null,
                  goal_id: "goal-newer",
                  status: "running",
                  notify_policy: "done_only",
                  reply_target_source: "none",
                  pinned_reply_target: null,
                  title: "newer",
                  workspace: "/repo",
                  created_at: "2026-05-02T00:10:00.000Z",
                  started_at: "2026-05-02T00:10:00.000Z",
                  updated_at: "2026-05-02T00:10:00.000Z",
                  completed_at: null,
                  summary: null,
                  error: null,
                  artifacts: [],
                  source_refs: [],
                },
              ],
              warnings: [],
            }),
          },
        });
        const runner = new ChatRunner(makeDeps({
          adapter,
          llmClient: createMockLLMClient([
            JSON.stringify({
              intent: "inspect_run",
              reason: "latest session",
              targetSelector: { scope: "run", reference: "latest", sourceText: "latest session" },
            }),
            JSON.stringify({
              intent: "inspect_run",
              reason: "前のバックグラウンドジョブ",
              targetSelector: { scope: "run", reference: "previous", sourceText: "前のバックグラウンドジョブ" },
            }),
          ]),
          runtimeControlService,
          runtimeControlApprovalFn: vi.fn().mockResolvedValue(true),
        }));

        await expect(runner.execute("inspect latest session", "/repo")).resolves.toMatchObject({ success: true });
        await expect(runner.execute("前のバックグラウンドジョブを確認して", "/repo")).resolves.toMatchObject({ success: true });

        const completed = await operationStore.listCompleted();
        expect(completed.map((operation) => operation.target?.run_id).sort()).toEqual(["run:newer", "run:older"].sort());
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("routes natural-language run resume to typed runtime control or a blocked response", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-control-chat-resume-"));
      try {
        const adapter = makeMockAdapter();
        const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
        const runtimeControlService = new RuntimeControlService({
          operationStore,
          sessionRegistry: {
            snapshot: vi.fn().mockResolvedValue({
              schema_version: "runtime-session-registry-v1",
              generated_at: "2026-05-02T00:00:00.000Z",
              sessions: [],
              background_runs: [{
                schema_version: "background-run-v1",
                id: "run:process:abc",
                kind: "process_run",
                parent_session_id: null,
                child_session_id: null,
                process_session_id: "proc-1",
                goal_id: null,
                status: "running",
                notify_policy: "done_only",
                reply_target_source: "none",
                pinned_reply_target: null,
                title: "process",
                workspace: "/repo",
                created_at: "2026-05-02T00:00:00.000Z",
                started_at: "2026-05-02T00:00:00.000Z",
                updated_at: "2026-05-02T00:00:00.000Z",
                completed_at: null,
                summary: null,
                error: null,
                artifacts: [],
                source_refs: [],
              }],
              warnings: [],
            }),
          },
        });
        const runner = new ChatRunner(makeDeps({
          adapter,
          llmClient: createSingleMockLLMClient(JSON.stringify({
            intent: "resume_run",
            reason: "再開して",
          })),
          runtimeControlService,
          runtimeControlApprovalFn: vi.fn().mockResolvedValue(true),
        }));

        const result = await runner.execute("再開して", "/repo");

        expect(result).toMatchObject({
          success: false,
          output: expect.stringContaining("no typed goal/runtime bridge"),
        });
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("routes natural-language finalize to an approval-gated proposal without external execution", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-control-chat-finalize-"));
      try {
        const adapter = makeMockAdapter();
        const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
        const executor = vi.fn();
        const runtimeControlService = new RuntimeControlService({
          operationStore,
          executor,
          operatorHandoffStore: { create: vi.fn().mockResolvedValue({ handoff_id: "handoff-1" }) },
          sessionRegistry: {
            snapshot: vi.fn().mockResolvedValue({
              schema_version: "runtime-session-registry-v1",
              generated_at: "2026-05-02T00:00:00.000Z",
              sessions: [],
              background_runs: [{
                schema_version: "background-run-v1",
                id: "run:coreloop:chat",
                kind: "coreloop_run",
                parent_session_id: null,
                child_session_id: "session:coreloop:worker-1",
                process_session_id: null,
                goal_id: "goal-1",
                status: "running",
                notify_policy: "done_only",
                reply_target_source: "none",
                pinned_reply_target: null,
                title: "DurableLoop goal goal-1",
                workspace: "/repo",
                created_at: "2026-05-02T00:00:00.000Z",
                started_at: "2026-05-02T00:00:00.000Z",
                updated_at: "2026-05-02T00:00:00.000Z",
                completed_at: null,
                summary: null,
                error: null,
                artifacts: [],
                source_refs: [],
              }],
              warnings: [],
            }),
          },
        });
        const runtimeControlApprovalFn = vi.fn().mockResolvedValue(true);
        const runner = new ChatRunner(makeDeps({
          adapter,
          llmClient: createSingleMockLLMClient(JSON.stringify({
            intent: "finalize_run",
            reason: "finalize current run",
            irreversible: true,
            externalActions: ["submit"],
          })),
          runtimeControlService,
          runtimeControlApprovalFn,
        }));

        const result = await runner.execute("Finalize with the current best candidate, but do not submit externally.", "/repo");

        expect(result).toMatchObject({
          success: true,
          output: expect.stringContaining("No external submit/publish/secret/production/destructive action was executed"),
        });
        expect(runtimeControlApprovalFn).toHaveBeenCalledWith(expect.stringContaining("finalize_run"));
        expect(executor).not.toHaveBeenCalled();
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });


});
