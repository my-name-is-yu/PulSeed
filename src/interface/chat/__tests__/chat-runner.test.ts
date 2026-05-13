import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { ChatRunner } from "../chat-runner.js";
import type { ChatRunnerDeps } from "../chat-runner-contracts.js";
import { CrossPlatformChatSessionManager } from "../cross-platform-session.js";
import { ChatSessionCatalog } from "../chat-session-store.js";
import { ChatSessionDataStore } from "../chat-session-data-store.js";
import { resolveChatStateBaseDir } from "../chat-state-base-dir.js";
import { importLegacyChatAgentLoopSessionState } from "../chat-agentloop-state-migration.js";
import type { ChatSession } from "../chat-history.js";
import { StateManager } from "../../../base/state/state-manager.js";
import type { IAdapter, AgentResult } from "../../../orchestrator/execution/adapter-layer.js";
import type { EscalationHandler, EscalationResult } from "../escalation.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import type { ChatAgentLoopRunner } from "../../../orchestrator/execution/agent-loop/chat-agent-loop-runner.js";
import { SqliteAgentLoopSessionStateStore } from "../../../orchestrator/execution/agent-loop/agent-loop-session-db-store.js";
import type { GoalNegotiator } from "../../../orchestrator/goal/goal-negotiator.js";
import { BackgroundRunLedger } from "../../../runtime/store/background-run-store.js";
import { createRunSpecStore } from "../../../runtime/run-spec/index.js";
import type { RunSpec } from "../../../runtime/run-spec/index.js";
import { RuntimeBudgetStore } from "../../../runtime/store/budget-store.js";
import { ScheduleHistoryStore, ScheduleRunHistoryRecordSchema } from "../../../runtime/schedule/history.js";
import { SupervisorStateStore } from "../../../runtime/store/supervisor-state-store.js";
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

const originalPulseedHome = process.env["PULSEED_HOME"];
let testPulseedHome: string | null = null;

async function storedRunSpecs(baseDir: string): Promise<RunSpec[]> {
  const store = createRunSpecStore({ getBaseDir: () => baseDir });
  return store.list();
}

async function onlyStoredRunSpec(baseDir: string): Promise<RunSpec> {
  const specs = await storedRunSpecs(baseDir);
  expect(specs).toHaveLength(1);
  return specs[0]!;
}

beforeEach(() => {
  testPulseedHome = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-runner-home-"));
  process.env["PULSEED_HOME"] = testPulseedHome;
});

afterEach(() => {
  if (originalPulseedHome === undefined) {
    delete process.env["PULSEED_HOME"];
  } else {
    process.env["PULSEED_HOME"] = originalPulseedHome;
  }
  if (testPulseedHome) {
    fs.rmSync(testPulseedHome, { recursive: true, force: true });
    testPulseedHome = null;
  }
});

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
    listTasks: vi.fn().mockResolvedValue([]),
  } as unknown as StateManager;
}

function makeRepeatingMockLLMClient(response = "Task completed successfully."): ILLMClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      content: response,
      usage: {
        input_tokens: 10,
        output_tokens: response.length,
      },
      stop_reason: "end_turn",
    }),
    parseJSON: vi.fn((content: string, schema: z.ZodSchema<unknown>) => schema.parse(JSON.parse(content))),
  } as unknown as ILLMClient;
}

function makeMockStateManagerWithBaseDir(): StateManager {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-mock-state-"));
  return {
    getBaseDir: vi.fn().mockReturnValue(baseDir),
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
    listTasks: vi.fn().mockResolvedValue([]),
  } as unknown as StateManager;
}

async function writeJsonFixture(baseDir: string, relativePath: string, value: unknown): Promise<void> {
  const filePath = path.join(baseDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

async function loadPersistedChatSession(stateManager: StateManager, sessionId: string): Promise<ChatSession | null> {
  return new ChatSessionDataStore(resolveChatStateBaseDir(stateManager)).load(sessionId);
}

async function listPersistedChatSessions(stateManager: StateManager): Promise<ChatSession[]> {
  const catalog = new ChatSessionCatalog(stateManager);
  const sessions = await catalog.listSessions();
  const loaded = await Promise.all(sessions.map((session) => loadPersistedChatSession(stateManager, session.id)));
  return loaded.filter((session): session is ChatSession => session !== null);
}

async function latestPersistedChatSession(stateManager: StateManager): Promise<ChatSession | null> {
  return (await listPersistedChatSessions(stateManager))[0] ?? null;
}

async function findPersistedChatSession(
  stateManager: StateManager,
  predicate: (session: ChatSession) => boolean,
): Promise<ChatSession | null> {
  return (await listPersistedChatSessions(stateManager)).find(predicate) ?? null;
}

async function saveSupervisorFixture(
  baseDir: string,
  workers: Array<{
    workerId: string;
    goalId: string;
    startedAt: number;
    iterations?: number;
    backgroundRunId?: string;
    sessionId?: string;
    parentSessionId?: string;
  }>,
  updatedAt = Date.parse("2026-04-25T00:30:00.000Z")
): Promise<void> {
  await new SupervisorStateStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir }).save({
    workers: workers.map((worker) => ({
      ...worker,
      iterations: worker.iterations ?? 0,
    })),
    crashCounts: {},
    suspendedGoals: [],
    updatedAt,
  });
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
    kind: "gateway_model_loop",
    reason: "direct_model_tool_loop",
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
    reason: "setup_secret_intake",
    configureTarget: "telegram_gateway",
    replyTargetPolicy: "turn_reply_target",
    eventProjectionPolicy: "turn_only",
    concurrencyPolicy: "session_serial",
  };
}

function makeDeps(overrides: Partial<ChatRunnerDeps> = {}): ChatRunnerDeps {
  return {
    stateManager: makeMockStateManager(),
    adapter: makeMockAdapter(),
    llmClient: makeRepeatingMockLLMClient(),
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

function unusedModelDecision(): string {
  return JSON.stringify({ unused: true });
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
    metadataRef: overrides.metadataRef ?? `control-db://process-sessions/${encodeURIComponent(overrides.session_id ?? "proc-1")}`,
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

describe("ChatRunner", () => {
  describe("normal execution", () => {
    it("redacts setup secrets through the production ingress entrypoint before persistence, events, and adapter prompts", async () => {
      const telegramToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
      const stateManager = makeMockStateManagerWithBaseDir();
      const adapter = makeMockAdapter();
      const events: ChatEvent[] = [];
      const runner = new ChatRunner(makeDeps({
        stateManager,
        adapter,
        onEvent: (event) => {
          events.push(event);
        },
      }));

      await runner.executeIngressMessage(
        makeIngress(`telegram setup token ${telegramToken}`),
        "/repo",
        30_000,
        adapterRoute()
      );

      const persistedSession = await latestPersistedChatSession(stateManager);
      expect(JSON.stringify(persistedSession)).not.toContain(telegramToken);
      expect(persistedSession?.messages[0]?.content).toContain("[REDACTED:telegram_bot_token:setup_secret_1]");
      expect(persistedSession?.messages[0]?.setupSecretIntake).toEqual([
        expect.objectContaining({
          id: "setup_secret_1",
          kind: "telegram_bot_token",
          redaction: "[REDACTED:telegram_bot_token:setup_secret_1]",
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain(telegramToken);
      expect(JSON.stringify((adapter.execute as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(telegramToken);
    });

    it("redacts non-Telegram setup secret shapes through the production chat entrypoint", async () => {
      const apiKey = "sk-proj_abcdefghijklmnopqrstuvwxyz1234567890";
      const stateManager = makeMockStateManagerWithBaseDir();
      const runner = new ChatRunner(makeDeps({ stateManager }));

      await runner.execute(`provider key is ${apiKey}`, "/repo", 30_000);

      const persistedSession = await latestPersistedChatSession(stateManager);
      expect(JSON.stringify(persistedSession)).not.toContain(apiKey);
      expect(persistedSession?.messages[0]?.setupSecretIntake).toEqual([
        expect.objectContaining({ kind: "openai_api_key" }),
      ]);
    });

    it("routes token-only setup input through standalone ChatRunner typed intake", async () => {
      const telegramToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));

      const result = await runner.execute(telegramToken, "/repo", 30_000);

      expect(result.success).toBe(true);
      expect(result.output).toContain("I received a Telegram bot token");
      expect(result.output).not.toContain(telegramToken);
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("keeps supplied setup secret facts available to the configure route without persisting raw assistant echoes", async () => {
      const telegramToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
      const echoedToken = "sk-proj_echoedsecretabcdefghijklmnopqrstuvwxyz";
      const stateManager = makeMockStateManagerWithBaseDir();
      const events: ChatEvent[] = [];
      const runner = new ChatRunner(makeDeps({
        stateManager,
        onEvent: (event) => { events.push(event); },
        adapter: makeMockAdapter({
          ...CANNED_RESULT,
          output: `adapter echoed ${echoedToken}`,
        }),
      }));

      const configureResult = await runner.executeIngressMessage(
        makeIngress(`telegram setup token ${telegramToken}`),
        "/repo",
        30_000,
        telegramConfigureRoute()
      );
      await runner.execute(`regular turn ${echoedToken}`, "/repo", 30_000);

      const persistedSession = await latestPersistedChatSession(stateManager);
      expect(configureResult.output).not.toContain(telegramToken);
      expect(configureResult.output).toContain("I received a Telegram bot token");
      expect(JSON.stringify(persistedSession)).not.toContain(telegramToken);
      expect(JSON.stringify(persistedSession)).not.toContain(echoedToken);
      expect(JSON.stringify(persistedSession)).toContain("[REDACTED:openai_api_key:setup_secret_1]");
      const progressEvents = events.filter((event) => event.type === "operation_progress");
      expect(progressEvents.map((event) => event.item.kind)).toContain("awaiting_approval");
      expect(JSON.stringify(progressEvents)).not.toContain(telegramToken);
    });

    it("writes Telegram config only after explicit confirmation and approval", async () => {
      const telegramToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-telegram-"));
      const stateManager = {
        ...makeMockStateManager(),
        getBaseDir: () => baseDir,
      } as unknown as StateManager;
      const approvalFn = vi.fn().mockResolvedValue(true);
      const runner = new ChatRunner(makeDeps({
        stateManager,
        approvalFn,
        gatewaySetupStatusProvider: makeTelegramStatusProvider(makeTelegramSetupStatus({
          state: "unconfigured",
          configPath: path.join(baseDir, "gateway", "channels", "telegram-bot", "config.json"),
          daemon: { running: true, port: 41700 },
        })),
      }));

      const intakeResult = await runner.execute(telegramToken, "/repo", 30_000);
      const persistedSession = await findPersistedChatSession(
        stateManager,
        (session) => session.setupDialogue?.selectedChannel === "telegram",
      );
      const persistedDialogue = JSON.parse(JSON.stringify(persistedSession?.setupDialogue));
      const confirmResult = await runner.execute("/confirm-setup-write", "/repo", 30_000);

      const configPath = path.join(baseDir, "gateway", "channels", "telegram-bot", "config.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(intakeResult.output).toContain("/confirm-setup-write");
      expect(confirmResult.success).toBe(true);
      expect(approvalFn).toHaveBeenCalledOnce();
      expect(persistedDialogue).toMatchObject({
        state: "confirm_write",
        selectedChannel: "telegram",
        action: {
          kind: "write_gateway_config",
          channel: "telegram",
          command: "/confirm-setup-write",
          requiresApproval: true,
        },
      });
      expect(JSON.stringify(persistedDialogue)).not.toContain(telegramToken);
      expect(config.bot_token).toBe(telegramToken);
      expect(config.allow_all).toBe(false);
      expect(confirmResult.output).toContain("could not request a gateway reload");
      expect(confirmResult.output).toContain("cannot request a gateway reload yet");
      expect(confirmResult.output).not.toContain("internal gateway refresh");
      expect(confirmResult.output).not.toContain("typed runtime-control");
      expect(confirmResult.output).not.toContain("pulseed daemon restart");
      expect(confirmResult.output).toContain("Access remains closed");
      fs.rmSync(baseDir, { recursive: true, force: true });
    });

    it("requests a gateway reload after approved Telegram config write", async () => {
      const telegramToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-telegram-refresh-"));
      const stateManager = {
        ...makeMockStateManager(),
        getBaseDir: () => baseDir,
      } as unknown as StateManager;
      const approvalFn = vi.fn().mockResolvedValue(true);
      const runtimeControlService = {
        request: vi.fn(async (request: { approvalFn?: (description: string) => Promise<boolean> }) => {
          await request.approvalFn?.("Runtime control restart_gateway: Apply updated Telegram gateway config after approved setup write.");
          return {
            success: true,
            message: "gateway restart is being handled by a daemon restart because the gateway runs in-process.",
            operationId: "op-refresh-1",
            state: "acknowledged" as const,
          };
        }),
      };
      const runner = new ChatRunner(makeDeps({
        stateManager,
        approvalFn,
        runtimeControlService,
        gatewaySetupStatusProvider: makeTelegramStatusProvider(makeTelegramSetupStatus({
          state: "unconfigured",
          configPath: path.join(baseDir, "gateway", "channels", "telegram-bot", "config.json"),
          daemon: { running: true, port: 41700 },
        })),
      }));

      await runner.execute(telegramToken, "/repo", 30_000);
      const confirmResult = await runner.execute("/confirm-setup-write", "/repo", 30_000);

      expect(confirmResult.success).toBe(true);
      expect(confirmResult.output).toContain("Telegram gateway config was written");
      expect(confirmResult.output).toContain("PulSeed requested a gateway reload");
      expect(confirmResult.output).not.toContain("internal gateway refresh");
      expect(confirmResult.output).toContain("op-refresh-1");
      expect(confirmResult.output).not.toContain("Restart the daemon so the gateway loads");
      expect(runtimeControlService.request).toHaveBeenCalledWith(expect.objectContaining({
        cwd: baseDir,
        intent: {
          kind: "restart_gateway",
          reason: "Apply updated Telegram gateway config after approved setup write.",
        },
        approvalFn,
      }));
      expect(approvalFn).toHaveBeenCalledTimes(2);
      fs.rmSync(baseDir, { recursive: true, force: true });
    });

    it("reports refresh failure without shell lifecycle fallback after Telegram config write", async () => {
      const telegramToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-telegram-refresh-fail-"));
      const stateManager = {
        ...makeMockStateManager(),
        getBaseDir: () => baseDir,
      } as unknown as StateManager;
      const approvalFn = vi.fn().mockResolvedValue(true);
      const runtimeControlService = {
        request: vi.fn().mockResolvedValue({
          success: false,
          message: "Runtime control executor is not configured; operation was recorded but not started.",
          operationId: "op-refresh-failed",
          state: "failed" as const,
        }),
      };
      const runner = new ChatRunner(makeDeps({
        stateManager,
        approvalFn,
        runtimeControlService,
        gatewaySetupStatusProvider: makeTelegramStatusProvider(makeTelegramSetupStatus({
          state: "unconfigured",
          configPath: path.join(baseDir, "gateway", "channels", "telegram-bot", "config.json"),
          daemon: { running: true, port: 41700 },
        })),
      }));

      await runner.execute(telegramToken, "/repo", 30_000);
      const confirmResult = await runner.execute("/confirm-setup-write", "/repo", 30_000);

      expect(confirmResult.success).toBe(true);
      expect(confirmResult.output).toContain("PulSeed requested a gateway reload, but it failed");
      expect(confirmResult.output).toContain("Automatic gateway reload was not applied");
      expect(confirmResult.output).not.toContain("internal gateway refresh");
      expect(confirmResult.output).not.toContain("typed runtime-control");
      expect(confirmResult.output).not.toContain("pulseed daemon restart");
      expect(confirmResult.output).not.toContain("pulseed daemon status");
      expect(runtimeControlService.request).toHaveBeenCalledOnce();
      fs.rmSync(baseDir, { recursive: true, force: true });
    });

    it("uses runtime control approval for chat-assisted Telegram config confirmation", async () => {
      const telegramToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-telegram-runtime-"));
      const stateManager = {
        ...makeMockStateManager(),
        getBaseDir: () => baseDir,
      } as unknown as StateManager;
      const runtimeControlApprovalFn = vi.fn().mockResolvedValue(true);
      const runner = new ChatRunner(makeDeps({
        stateManager,
        runtimeControlApprovalFn,
        gatewaySetupStatusProvider: makeTelegramStatusProvider(makeTelegramSetupStatus({
          state: "unconfigured",
          configPath: path.join(baseDir, "gateway", "channels", "telegram-bot", "config.json"),
          daemon: { running: true, port: 41700 },
        })),
      }));

      await runner.execute(telegramToken, "/repo", 30_000);
      const confirmResult = await runner.execute("/confirm-setup-write", "/repo", 30_000);

      const configPath = path.join(baseDir, "gateway", "channels", "telegram-bot", "config.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(confirmResult.success).toBe(true);
      expect(runtimeControlApprovalFn).toHaveBeenCalledOnce();
      expect(runtimeControlApprovalFn).toHaveBeenCalledWith(expect.stringContaining("allow_all=false"));
      expect(config.bot_token).toBe(telegramToken);
      expect(config.allow_all).toBe(false);
      fs.rmSync(baseDir, { recursive: true, force: true });
    });

    it("confirms pending Telegram setup write from Japanese natural language through the production route", async () => {
      const telegramToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-telegram-ja-confirm-"));
      const stateManager = {
        ...makeMockStateManager(),
        getBaseDir: () => baseDir,
      } as unknown as StateManager;
      const approvalFn = vi.fn().mockResolvedValue(true);
      const llmClient = createMockLLMClient([
        JSON.stringify({ decision: "approve", confidence: 0.94, rationale: "user approved pending setup write" }),
      ]);
      const runner = new ChatRunner(makeDeps({
        stateManager,
        approvalFn,
        llmClient,
        gatewaySetupStatusProvider: makeTelegramStatusProvider(makeTelegramSetupStatus({
          state: "unconfigured",
          configPath: path.join(baseDir, "gateway", "channels", "telegram-bot", "config.json"),
          daemon: { running: true, port: 41700 },
        })),
      }));

      const intakeResult = await runner.execute(`このtokenで進めて ${telegramToken}`, "/repo", 30_000);
      const confirmResult = await runner.execute("設定して", "/repo", 30_000);

      const configPath = path.join(baseDir, "gateway", "channels", "telegram-bot", "config.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(intakeResult.output).toContain("approve in natural language");
      expect(confirmResult.success).toBe(true);
      expect(confirmResult.output).toContain("Telegram gateway config was written");
      expect(confirmResult.output).not.toContain(telegramToken);
      expect(JSON.stringify((stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(telegramToken);
      expect(config.bot_token).toBe(telegramToken);
      expect(approvalFn).toHaveBeenCalledOnce();
      fs.rmSync(baseDir, { recursive: true, force: true });
    });

    it("confirms pending Telegram setup write from English natural language through the production route", async () => {
      const telegramToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-telegram-en-confirm-"));
      const stateManager = {
        ...makeMockStateManager(),
        getBaseDir: () => baseDir,
      } as unknown as StateManager;
      const approvalFn = vi.fn().mockResolvedValue(true);
      const llmClient = createMockLLMClient([
        JSON.stringify({ decision: "approve", confidence: 0.95, rationale: "user approved pending setup write" }),
      ]);
      const runner = new ChatRunner(makeDeps({
        stateManager,
        approvalFn,
        llmClient,
        gatewaySetupStatusProvider: makeTelegramStatusProvider(makeTelegramSetupStatus({
          state: "unconfigured",
          configPath: path.join(baseDir, "gateway", "channels", "telegram-bot", "config.json"),
          daemon: { running: true, port: 41700 },
        })),
      }));

      const intakeResult = await runner.execute(`configure it with ${telegramToken}`, "/repo", 30_000);
      const confirmResult = await runner.execute("yes, configure it", "/repo", 30_000);

      const configPath = path.join(baseDir, "gateway", "channels", "telegram-bot", "config.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(intakeResult.output).toContain("approve in natural language");
      expect(confirmResult.success).toBe(true);
      expect(confirmResult.output).toContain("Telegram gateway config was written");
      expect(confirmResult.output).not.toContain(telegramToken);
      expect(config.bot_token).toBe(telegramToken);
      expect(approvalFn).toHaveBeenCalledOnce();
      fs.rmSync(baseDir, { recursive: true, force: true });
    });

    it("warns that confirming a new Telegram token replaces the existing configured token", async () => {
      const oldToken = "111111111:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
      const newToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-telegram-replace-"));
      const configDir = path.join(baseDir, "gateway", "channels", "telegram-bot");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
        bot_token: oldToken,
        allowed_user_ids: [],
        denied_user_ids: [],
        allowed_chat_ids: [],
        denied_chat_ids: [],
        runtime_control_allowed_user_ids: [],
        chat_goal_map: {},
        user_goal_map: {},
        allow_all: false,
        polling_timeout: 30,
      }), "utf-8");
      const stateManager = {
        ...makeMockStateManager(),
        getBaseDir: () => baseDir,
      } as unknown as StateManager;
      const approvalFn = vi.fn().mockResolvedValue(true);
      const llmClient = createMockLLMClient([
        JSON.stringify({ decision: "approve", confidence: 0.95, rationale: "user approved replacement" }),
      ]);
      const runner = new ChatRunner(makeDeps({
        stateManager,
        approvalFn,
        llmClient,
        gatewaySetupStatusProvider: makeTelegramStatusProvider(makeTelegramSetupStatus({
          state: "configured",
          configPath: path.join(configDir, "config.json"),
          daemon: { running: true, port: 41700 },
          config: { exists: true, hasBotToken: true, hasHomeChat: false },
        })),
      }));

      const intakeResult = await runner.execute(`use this new token ${newToken}`, "/repo", 30_000);
      const persistedSession = await findPersistedChatSession(
        stateManager,
        (session) => session.setupDialogue?.selectedChannel === "telegram",
      );
      const confirmResult = await runner.execute("yes, configure it", "/repo", 30_000);

      const config = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf-8"));
      expect(intakeResult.output).toContain("replace the existing configured token");
      expect(persistedSession?.setupDialogue).toMatchObject({ replacesExistingSecret: true });
      expect(approvalFn).toHaveBeenCalledWith(expect.stringContaining("replace the existing configured Telegram bot token"));
      expect(confirmResult.success).toBe(true);
      expect(config.bot_token).toBe(newToken);
      expect(JSON.stringify(persistedSession)).not.toContain(newToken);
      fs.rmSync(baseDir, { recursive: true, force: true });
    });

    it("does not let disallowed gateway ingress confirm Telegram config through global approval", async () => {
      const telegramToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-telegram-denied-"));
      const stateManager = {
        ...makeMockStateManager(),
        getBaseDir: () => baseDir,
      } as unknown as StateManager;
      const runtimeControlApprovalFn = vi.fn().mockResolvedValue(true);
      const runner = new ChatRunner(makeDeps({
        stateManager,
        runtimeControlApprovalFn,
        gatewaySetupStatusProvider: makeTelegramStatusProvider(makeTelegramSetupStatus({
          state: "unconfigured",
          configPath: path.join(baseDir, "gateway", "channels", "telegram-bot", "config.json"),
          daemon: { running: true, port: 41700 },
        })),
      }));

      await runner.execute(telegramToken, "/repo", 30_000);
      const confirmResult = await runner.executeIngressMessage(
        makeIngress("/confirm-setup-write"),
        "/repo",
        30_000,
        adapterRoute()
      );

      const configPath = path.join(baseDir, "gateway", "channels", "telegram-bot", "config.json");
      expect(confirmResult.success).toBe(false);
      expect(confirmResult.output).toContain("approval-capable chat surface");
      expect(runtimeControlApprovalFn).not.toHaveBeenCalled();
      expect(fs.existsSync(configPath)).toBe(false);
      fs.rmSync(baseDir, { recursive: true, force: true });
    });

    it("rejects stale pending setup state when the selected channel is not Telegram", async () => {
      const discordToken = "ABCDEFGHIJKLMNOPQRSTUVWX.abcdef.ABCDEFGHIJKLMNOPQRSTUVWXYZ1";
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-discord-stale-"));
      const stateManager = {
        ...makeMockStateManager(),
        getBaseDir: () => baseDir,
      } as unknown as StateManager;
      const approvalFn = vi.fn().mockResolvedValue(true);
      const runner = new ChatRunner(makeDeps({
        stateManager,
        approvalFn,
      }));

      const planResult = await runner.execute(discordToken, "/repo", 30_000);
      const confirmResult = await runner.execute("/confirm-setup-write", "/repo", 30_000);

      const persistedSession = await findPersistedChatSession(
        stateManager,
        (session) => session.setupDialogue?.selectedChannel === "discord",
      );
      const discordConfigPath = path.join(baseDir, "gateway", "channels", "discord-bot", "config.json");
      expect(planResult.output).toContain("Discord gateway setup plan");
      expect(persistedSession?.setupDialogue).toMatchObject({
        state: "blocked",
        selectedChannel: "discord",
        action: {
          kind: "adapter_plan",
          channel: "discord",
          status: "blocked",
        },
      });
      expect(JSON.stringify(persistedSession?.setupDialogue)).not.toContain(discordToken);
      expect(confirmResult.success).toBe(false);
      expect(confirmResult.output).toContain("pending setup dialogue is for discord");
      expect(approvalFn).not.toHaveBeenCalled();
      expect(fs.existsSync(discordConfigPath)).toBe(false);
      fs.rmSync(baseDir, { recursive: true, force: true });
    });

    it("preserves Telegram setup dialogue across a gateway ingress confirmation turn", async () => {
      const telegramToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-telegram-ingress-"));
      const stateManager = {
        ...makeMockStateManager(),
        getBaseDir: () => baseDir,
      } as unknown as StateManager;
      const runtimeControlApprovalFn = vi.fn().mockResolvedValue(true);
      const runner = new ChatRunner(makeDeps({
        stateManager,
        runtimeControlApprovalFn,
        gatewaySetupStatusProvider: makeTelegramStatusProvider(makeTelegramSetupStatus({
          state: "unconfigured",
          configPath: path.join(baseDir, "gateway", "channels", "telegram-bot", "config.json"),
          daemon: { running: true, port: 41700 },
        })),
      }));
      const allowedIngress = (text: string): ChatIngressMessage => ({
        ...makeIngress(text),
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
        },
      });

      const intakeResult = await runner.executeIngressMessage(
        allowedIngress(telegramToken),
        "/repo",
        30_000,
        telegramConfigureRoute()
      );
      const confirmResult = await runner.executeIngressMessage(
        allowedIngress("/confirm-setup-write"),
        "/repo",
        30_000,
        adapterRoute()
      );

      const configPath = path.join(baseDir, "gateway", "channels", "telegram-bot", "config.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(intakeResult.output).toContain("/confirm-setup-write");
      expect(confirmResult.success).toBe(true);
      expect(runtimeControlApprovalFn).toHaveBeenCalledOnce();
      expect(config.bot_token).toBe(telegramToken);
      expect(config.allow_all).toBe(false);
      fs.rmSync(baseDir, { recursive: true, force: true });
    });

    it("returns ChatRunResult from the direct model/tool loop", async () => {
      const llmClient = createSingleMockLLMClient("Task completed successfully.");
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter, llmClient }));
      const result = await runner.execute("Do something", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toBe("Task completed successfully.");
      expect(typeof result.elapsed_ms).toBe("number");
      expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
      expect(llmClient.callCount).toBe(1);
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("emits direct model-loop lifecycle activity without an intent preamble", async () => {
      const adapter = makeMockAdapter();
      const llmClient = createSingleMockLLMClient("Direct answer.");
      const events: string[] = [];
      const runner = new ChatRunner(makeDeps({
        adapter,
        llmClient,
        onEvent: (event) => {
          if (event.type === "activity") events.push(`${event.kind}:${event.message}`);
        },
      }));

      await runner.execute("Do something", "/repo");

      expect(events).toContain("lifecycle:Calling model...");
      expect(events).not.toContain("lifecycle:Calling adapter...");
      const transcript = events.join("\n");
      expect(transcript).not.toContain("I understand the request as");
      expect(transcript).not.toContain("Intent");
      expect(transcript).not.toContain("Updated plan:");
    });

    it("propagates direct model-loop failure to ChatRunResult", async () => {
      const runner = new ChatRunner(makeDeps({ llmClient: undefined }));

      const result = await runner.execute("Do something risky", "/repo");

      expect(result.success).toBe(false);
      expect(result.output).toContain("no language model client is configured");
      expect(result.output).toContain("Recovery");
      expect(result.output).toContain("Next actions");
    });
  });

  describe("slash commands", () => {
    it("/help returns help text without calling adapter", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));

      const result = await runner.execute("/help", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("/help");
      expect(result.output).toContain("/clear");
      expect(result.output).toContain("/exit");
      expect(result.output).toContain("/track");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("/help groups commands by intent", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));

      const result = await runner.execute("/help", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("Session");
      expect(result.output).toContain("Goals and tasks");
      expect(result.output).toContain("Configuration");
      expect(result.output).toContain("/usage");
      expect(result.output).toContain("Deferred");
      expect(result.output).toContain("/status [goal-id]");
      expect(result.output).toContain("/compact");
      expect(result.output).toContain("/context");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("/cleanup parses flags exactly and rejects unknown arguments before cleanup", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-cleanup-command-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await writeJsonFixture(tmpDir, "chat/sessions/old-session.json", {
          id: "old-session",
          cwd: "/repo",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T01:00:00.000Z",
          messages: [],
        });
        await importLegacyChatAgentLoopSessionState(tmpDir);

        const staleSessionPath = path.join(tmpDir, "chat", "sessions", "old-session.json");
        const runner = new ChatRunner(makeDeps({ stateManager, adapter: makeMockAdapter() }));
        runner.startSession("/repo");

        const rejected = await runner.execute("/cleanup --delete-old", "/repo");
        expect(rejected.success).toBe(false);
        expect(rejected.output).toContain("Usage: /cleanup [--dry-run]");
        expect(fs.existsSync(staleSessionPath)).toBe(true);

        const dryRun = await runner.execute("/cleanup --dry-run", "/repo");
        expect(dryRun.success).toBe(true);
        expect(dryRun.output).toContain("would remove");
        expect(fs.existsSync(staleSessionPath)).toBe(true);

        const enforced = await runner.execute("/cleanup", "/repo");
        expect(enforced.success).toBe(true);
        expect(enforced.output).toContain("removed");
        await expect(new ChatSessionCatalog(stateManager).loadSession("old-session")).resolves.toBeNull();
        expect(fs.existsSync(staleSessionPath)).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/context shows operational working context without calling adapter", async () => {
      const adapter = makeMockAdapter();
      const stateManager = makeMockStateManagerWithBaseDir();
      const runner = new ChatRunner(makeDeps({ adapter, stateManager }));
      runner.startSession("/repo");

      await runner.execute("Make a small change", "/repo");
      const result = await runner.execute("/context", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("Working context");
      expect(result.output).toContain("Session");
      expect(result.output).toContain("Turn context");
      expect(result.output).toContain("Working assumptions");
      expect(result.output).toContain("Active constraints");
      expect(result.output).toContain("Included context");
      expect(result.output).toContain("Not included");
      expect(result.output).toContain("last_selected_route: kind=gateway_model_loop");
      expect(result.output).toContain("hidden reasoning");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("/working-memory aliases the context view", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));
      runner.startSession("/repo");

      const result = await runner.execute("/working-memory", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("Working context");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("interruptAndRedirect executes normally when no turn is active", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));
      runner.startSession("/repo");

      const result = await runner.interruptAndRedirect("next request", "/repo");

      expect(result.success).toBe(true);
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("emits a typed TurnStart operation for idle user input", async () => {
      const adapter = makeMockAdapter();
      const events: ChatEvent[] = [];
      const runner = new ChatRunner(makeDeps({
        adapter,
        onEvent: (event) => {
          events.push(event);
        },
      }));
      runner.startSession("/repo");

      const result = await runner.execute("ordinary chat", "/repo");

      expect(result.success).toBe(true);
      const start = events.find((event): event is Extract<ChatEvent, { type: "lifecycle_start" }> =>
        event.type === "lifecycle_start"
      );
      expect(start).toBeDefined();
      expect(start?.operation.kind).toBe("TurnStart");
      if (start?.operation.kind !== "TurnStart") {
        throw new Error("expected TurnStart operation");
      }
      expect(start?.operation).toMatchObject({
        kind: "TurnStart",
        runId: start?.runId,
        turnId: start?.turnId,
        cwd: "/repo",
        userInput: {
          schema_version: "user-input-v1",
          rawText: "ordinary chat",
          items: [{
            kind: "text",
            text: "ordinary chat",
          }],
        },
      });
      expect(start.operation.inputId).toEqual(expect.any(String));
    });

    it("clears the active turn when an adapter turn times out", async () => {
      const adapter = {
        adapterType: "mock",
        execute: vi.fn().mockImplementation(() => new Promise(() => {})),
      } as unknown as IAdapter;
      const runner = new ChatRunner(makeDeps({ adapter }));
      runner.startSession("/repo");

      const result = await runner.execute("Make a small change", "/repo", 1);

      expect(result.success).toBe(false);
      expect(result.output).toContain("timed out");
      expect(runner.hasActiveTurn()).toBe(false);
    });

    it("/usage reports session totals and phase breakdown", async () => {
      const stateManager = makeMockStateManager();
      const llmClient = {
        sendMessage: vi.fn().mockResolvedValue({
          content: "Plain answer",
          usage: { input_tokens: 2, output_tokens: 3 },
          stop_reason: "end_turn",
        }),
        parseJSON: vi.fn(),
      } as unknown as ILLMClient;
      const runner = new ChatRunner(makeDeps({ stateManager, llmClient }));
      runner.startSession("/repo");

      await runner.execute("What is 1+1?", "/repo");
      const result = await runner.execute("/usage", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("Usage summary (session");
      expect(result.output).toContain("Session total tokens:  5");
      expect(result.output).toContain("execution: 5");
    });

    it("normalizes unsafe model usage from chat execution before session usage reporting", async () => {
      const stateManager = makeMockStateManager();
      const llmClient = {
        sendMessage: vi.fn().mockResolvedValue({
          content: "Plain answer",
          usage: { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 4 },
          stop_reason: "end_turn",
        }),
        parseJSON: vi.fn(),
      } as unknown as ILLMClient;
      const runner = new ChatRunner(makeDeps({ stateManager, llmClient }));
      runner.startSession("/repo");

      await runner.execute("What is 1+1?", "/repo");
      const result = await runner.execute("/usage", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("Session input tokens:  0");
      expect(result.output).toContain("Session output tokens: 4");
      expect(result.output).toContain("Session total tokens:  4");
      expect(result.output).toContain("execution: 4");
      expect(result.output).not.toContain(String(Number.MAX_SAFE_INTEGER + 1));
    });

    it("/usage goal <id> reads goal-level telemetry from task ledgers", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-usage-goal-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await stateManager.writeRaw("tasks/goal-usage/ledger/task-1.json", {
          task_id: "task-1",
          goal_id: "goal-usage",
          events: [{ type: "succeeded", ts: "2026-01-01T00:00:00.000Z", tokens_used: 123 }],
          summary: {
            latest_event_type: "succeeded",
            tokens_used: 123,
            latencies: {
              created_to_acked_ms: null,
              acked_to_started_ms: null,
              started_to_completed_ms: null,
              completed_to_verification_ms: null,
              created_to_completed_ms: null,
            },
          },
        });
        const runner = new ChatRunner(makeDeps({ stateManager }));

        const result = await runner.execute("/usage goal goal-usage", "/repo");

        expect(result.success).toBe(true);
        expect(result.output).toContain("Usage summary (goal scope)");
        expect(result.output).toContain("Goal: goal-usage");
        expect(result.output).toContain("Total tokens: 123");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/usage schedule [period] aggregates schedule history tokens", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-usage-schedule-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await new ScheduleHistoryStore(tmpDir).save([
          ScheduleRunHistoryRecordSchema.parse({
            id: "11111111-1111-4111-8111-111111111111",
            entry_id: "22222222-2222-4222-8222-222222222222",
            entry_name: "Daily brief",
            layer: "cron",
            status: "ok",
            duration_ms: 1200,
            fired_at: new Date().toISOString(),
            reason: "manual_run",
            attempt: 0,
            scheduled_for: null,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            retry_at: null,
            tokens_used: 88,
          }),
        ]);
        const runner = new ChatRunner(makeDeps({ stateManager }));

        const result = await runner.execute("/usage schedule 24h", "/repo");

        expect(result.success).toBe(true);
        expect(result.output).toContain("Usage summary (schedule, 24h)");
        expect(result.output).toContain("Runs: 1");
        expect(result.output).toContain("Total tokens: 88");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/clear returns cleared message without calling adapter", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));

      const result = await runner.execute("/clear", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("cleared");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("/track without escalationHandler returns 'not available' message", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));

      const result = await runner.execute("/track", "/repo");

      expect(result.success).toBe(false);
      expect(result.output).toContain("not available");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("/track with escalationHandler but no history returns 'No conversation' message", async () => {
      const escalationHandler = {
        escalateToGoal: vi.fn(),
      } as unknown as EscalationHandler;
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter, escalationHandler }));

      const result = await runner.execute("/track", "/repo");

      expect(result.success).toBe(false);
      expect(result.output).toContain("No conversation");
      expect(escalationHandler.escalateToGoal).not.toHaveBeenCalled();
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("/track with escalationHandler and history returns goal info", async () => {
      const escalationResult: EscalationResult = {
        goalId: "goal-abc-123",
        title: "My tracked goal",
        description: "My tracked goal",
      };
      const escalationHandler = {
        escalateToGoal: vi.fn().mockResolvedValue(escalationResult),
      } as unknown as EscalationHandler;
      const adapter = makeMockAdapter();
      const stateManager = makeMockStateManager();
      const runner = new ChatRunner(makeDeps({ adapter, stateManager, escalationHandler }));

      // Populate history by running a normal turn first
      runner.startSession("/repo");
      await runner.execute("What should I track?", "/repo");

      const result = await runner.execute("/track", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("goal-abc-123");
      expect(result.output).toContain("My tracked goal");
      expect(result.output).toContain("pulseed run --goal");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("/tend confirmation forwards daemon transcript events without breaking notifications", async () => {
      const notifications: string[] = [];
      const events: ChatEvent[] = [];
      const daemonClient = {
        startGoal: vi.fn().mockResolvedValue(undefined),
      };
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(
            "id: 6\n"
            + "event: notification_report\n"
            + "data: {\"goalId\":\"goal-xyz\",\"report_type\":\"daily_summary\",\"title\":\"Morning Planning\"}\n\n"
          ));
          controller.close();
        },
      });
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ approvals: [], last_outbox_seq: 5 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: stream,
        });
      vi.stubGlobal("fetch", mockFetch);

      try {
        const stateManager = {
          ...makeMockStateManager(),
          getBaseDir: vi.fn().mockReturnValue(fs.mkdtempSync(path.join(os.tmpdir(), "chat-runner-tend-"))),
          loadGoal: vi.fn().mockResolvedValue({
            id: "goal-xyz",
            title: "Tend test goal",
            description: "Exercise tend confirmation.",
            dimensions: [],
            constraints: [],
            created_at: "2026-04-25T00:00:00.000Z",
            updated_at: "2026-04-25T00:00:00.000Z",
          } as unknown as Goal),
        } as unknown as StateManager;
        const runner = new ChatRunner(makeDeps({
          stateManager,
          daemonClient: daemonClient as never,
          daemonBaseUrl: "http://localhost:9000",
          onNotification: (message) => { notifications.push(message); },
          onEvent: (event) => { events.push(event); },
        }));
        (runner as any).pendingTend = { goalId: "goal-xyz" };

        const result = await runner.execute("y", "/repo");
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(result.success).toBe(true);
        expect(result.output.startsWith("Next: ask for progress here")).toBe(true);
        expect(result.output.split("\n")[0]).toBe("Next: ask for progress here.");
        expect(result.output).toContain("Next: ask for progress here");
        expect(result.output).toContain("/status goal-xyz");
        expect(result.output).toContain("pulseed status --goal goal-xyz");
        expect(result.output).toContain("pulseed runtime run run:coreloop:");
        expect(result.output).toContain("Diagnostic details:");
        expect(result.output).not.toContain("Run 'pulseed status' to check progress.");
        expect(daemonClient.startGoal).toHaveBeenCalledWith("goal-xyz", expect.objectContaining({
          backgroundRun: expect.objectContaining({
            backgroundRunId: expect.stringMatching(/^run:coreloop:/),
          }),
        }));
        expect((mockFetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
        expect((mockFetch as ReturnType<typeof vi.fn>).mock.invocationCallOrder[1]).toBeLessThan(
          (daemonClient.startGoal as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
        );
        expect(notifications.some((message) => message.includes("Morning Planning"))).toBe(true);
        expect(events.some((event) => (
          event.type === "activity"
          && event.message.includes("Morning Planning")
          && event.transient === false
        ))).toBe(true);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("/tend <goal-id> returns valid progress commands without bare CLI status", async () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-runner-tend-direct-"));
      try {
        const daemonClient = {
          startGoal: vi.fn().mockResolvedValue(undefined),
        };
        const stateManager = {
          ...makeMockStateManager(),
          getBaseDir: vi.fn().mockReturnValue(baseDir),
          loadGoal: vi.fn().mockResolvedValue(makeGoal("goal-xyz", {
            title: "Tend test goal",
            dimensions: [],
          })),
        } as unknown as StateManager;
        const runner = new ChatRunner(makeDeps({
          stateManager,
          daemonClient: daemonClient as never,
          llmClient: createSingleMockLLMClient("unused"),
          goalNegotiator: {
            negotiate: vi.fn(),
          } as unknown as GoalNegotiator,
        }));

        const result = await runner.execute("/tend goal-xyz", "/repo");

        expect(result.success).toBe(true);
        expect(result.output.startsWith("Next: ask for progress here")).toBe(true);
        expect(result.output.split("\n")[0]).toBe("Next: ask for progress here.");
        expect(result.output).toContain("Next: ask for progress here");
        expect(result.output).toContain("/status goal-xyz");
        expect(result.output).toContain("pulseed status --goal goal-xyz");
        expect(result.output).toContain("pulseed runtime run run:coreloop:");
        expect(result.output).toContain("Diagnostic details:");
        expect(result.output).not.toContain("Run 'pulseed status' to check progress.");
        expect(daemonClient.startGoal).toHaveBeenCalledWith("goal-xyz", expect.objectContaining({
          backgroundRun: expect.objectContaining({
            backgroundRunId: expect.stringMatching(/^run:coreloop:/),
          }),
        }));
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    });

    it("/tend rejects malformed max args before daemon start", async () => {
      const adapter = makeMockAdapter();
      const daemonClient = {
        startGoal: vi.fn().mockResolvedValue(undefined),
      };
      const runner = new ChatRunner(makeDeps({
        adapter,
        llmClient: createSingleMockLLMClient("{}"),
        goalNegotiator: { negotiate: vi.fn() } as unknown as GoalNegotiator,
        daemonClient: daemonClient as never,
      }));

      const result = await runner.execute("/tend goal-xyz --max abc", "/repo");

      expect(result.success).toBe(false);
      expect(result.output).toContain("Usage: /tend [goal-id] [--max <positive-integer>]");
      expect(result.output).toContain("--max must be a positive integer");
      expect(daemonClient.startGoal).not.toHaveBeenCalled();
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("/tend rejects unsafe max args before daemon start", async () => {
      const adapter = makeMockAdapter();
      const daemonClient = {
        startGoal: vi.fn().mockResolvedValue(undefined),
      };
      const runner = new ChatRunner(makeDeps({
        adapter,
        llmClient: createSingleMockLLMClient("{}"),
        goalNegotiator: { negotiate: vi.fn() } as unknown as GoalNegotiator,
        daemonClient: daemonClient as never,
      }));

      const result = await runner.execute("/tend goal-xyz --max 9007199254740993", "/repo");

      expect(result.success).toBe(false);
      expect(result.output).toContain("--max must be a positive integer");
      expect(daemonClient.startGoal).not.toHaveBeenCalled();
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("/tend confirmation fails when durable subscription cannot be armed", async () => {
      const daemonClient = {
        startGoal: vi.fn().mockResolvedValue(undefined),
      };
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ approvals: [], last_outbox_seq: 0 }),
        })
        .mockRejectedValueOnce(new Error("stream unavailable"))
        .mockRejectedValueOnce(new Error("stream unavailable"));
      vi.stubGlobal("fetch", mockFetch);
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: any[]) => void) => {
        fn();
        return 0 as any;
      }) as typeof setTimeout);

      try {
        const runner = new ChatRunner(makeDeps({
          daemonClient: daemonClient as never,
          daemonBaseUrl: "http://localhost:9000",
        }));
        (runner as any).pendingTend = { goalId: "goal-xyz" };

        const result = await runner.execute("y", "/repo");

        expect(result.success).toBe(false);
        expect(result.output).toContain("Daemon event stream unavailable");
        expect(result.output).toContain("Goal was not started");
        expect(daemonClient.startGoal).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
      }
    });

    it("/exit returns exit message without calling adapter", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));

      const result = await runner.execute("/exit", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("Exiting");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("/retry explains safe recovery options without replaying the prior turn", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));

      const result = await runner.execute("/retry", "/repo");

      expect(result.success).toBe(false);
      expect(result.output).toContain("/retry is not supported yet");
      expect(result.output).toContain("Retry unavailable");
      expect(result.output).toContain("/review");
      expect(result.output).toContain("Continue from the latest chat");
      expect(result.output).not.toContain("/resume");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("unknown /command returns error message without calling adapter", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));

      const result = await runner.execute("/unknown-cmd", "/repo");

      expect(result.success).toBe(false);
      expect(result.output).toContain("Unknown command");
      expect(result.output).toContain("/unknown-cmd");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("keeps freeform command paraphrases on the model path", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));

      const result = await runner.execute("Can you show me the status of this repo?", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toBe("Task completed successfully.");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("slash command comparison is case-insensitive", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));

      const result = await runner.execute("/HELP", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("/help");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("/resume resumes running native agentloop state without writing a new user turn", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-resume-active-db-"));
      try {
      const stateManager = new StateManager(tmpDir);
      await stateManager.init();
      const adapter = makeMockAdapter();
      const savedState = {
        ...makeAgentLoopState({
          sessionId: "agent-session",
          status: "running",
          updatedAt: new Date().toISOString(),
        }),
        goalId: "chat",
        modelRef: "openai/gpt-5.4-mini",
        finalText: "continuing...",
      };
      await new SqliteAgentLoopSessionStateStore(tmpDir, "agent-session", "chat").save(savedState);
      const chatAgentLoopRunner = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: "Resumed successfully",
          error: null,
          exit_code: null,
          elapsed_ms: 30,
          stopped_reason: "completed",
        }),
      } as unknown as ChatAgentLoopRunner;
      const runner = new ChatRunner(makeDeps({ stateManager, adapter, chatAgentLoopRunner }));

      runner.startSessionFromLoadedSession({
        id: "chat-session",
        cwd: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        title: null,
        messages: [],
        agentLoopSessionId: "agent-session",
        agentLoopStatePath: null,
        agentLoopStatus: "running",
        agentLoopResumable: true,
        agentLoopUpdatedAt: savedState.updatedAt,
      });
      const result = await runner.execute("/resume", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toBe("Resumed successfully");
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce();
      const input = (chatAgentLoopRunner.execute as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        resumeOnly?: boolean;
        resumeState?: { sessionId: string };
        resumeSessionId?: string;
      };
      expect(input.resumeOnly).toBe(true);
      expect(input.resumeState?.sessionId).toBe("agent-session");
      expect(input.resumeSessionId).toBe("agent-session");

      const persisted = await loadPersistedChatSession(stateManager, "chat-session");
      expect(persisted?.turnContexts?.some((context) => context.schema_version === "chat-turn-context-v1")).toBe(true);
      expect(persisted?.messages.some((message) =>
        message.role === "assistant" && message.content === "Resumed successfully"
      )).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/resume refuses failed native agentloop state without replaying actionable work", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-resume-failed-db-"));
      try {
      const stateManager = new StateManager(tmpDir);
      await stateManager.init();
      const savedState = {
        ...makeAgentLoopState({
          sessionId: "agent-session",
          status: "failed",
          updatedAt: new Date().toISOString(),
        }),
        goalId: "chat",
        modelRef: "openai/gpt-5.4-mini",
        finalText: "timed out",
        stopReason: "timeout" as const,
      };
      await new SqliteAgentLoopSessionStateStore(tmpDir, "agent-session", "chat").save(savedState);
      const chatAgentLoopRunner = {
        execute: vi.fn(),
      } as unknown as ChatAgentLoopRunner;
      const runner = new ChatRunner(makeDeps({ stateManager, chatAgentLoopRunner }));

      runner.startSessionFromLoadedSession({
        id: "chat-session",
        cwd: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        title: null,
        messages: [],
        agentLoopSessionId: "agent-session",
        agentLoopStatePath: null,
        agentLoopStatus: "failed",
        agentLoopResumable: true,
        agentLoopUpdatedAt: savedState.updatedAt,
      });
      const result = await runner.execute("/resume", "/repo");

      expect(result.success).toBe(false);
      expect(result.output).toContain("The saved chat work stopped before it could safely continue");
      expect(result.output).not.toContain("agent-session");
      expect(result.output).toContain("Type: Resume failure");
      expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/resume refuses missing typed native agentloop state without replaying actionable work", async () => {
      const stateManager = makeMockStateManagerWithBaseDir();
      const chatAgentLoopRunner = {
        execute: vi.fn(),
      } as unknown as ChatAgentLoopRunner;
      const runner = new ChatRunner(makeDeps({ stateManager, chatAgentLoopRunner }));

      runner.startSessionFromLoadedSession({
        id: "chat-session",
        cwd: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        title: null,
        messages: [],
        agentLoopSessionId: "agent-session",
        agentLoopStatePath: null,
        agentLoopStatus: "running",
        agentLoopResumable: true,
        agentLoopUpdatedAt: new Date().toISOString(),
      });
      const result = await runner.execute("/resume", "/repo");

      expect(result.success).toBe(false);
      expect(result.output).toContain("I could not find a chat that can safely continue");
      expect(result.output).not.toContain("agent-session");
      expect(result.output).toContain("Type: Resume failure");
      expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
    });

    it("/resume without saved state returns recovery guidance", async () => {
      const stateManager = makeMockStateManagerWithBaseDir();
      (stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const chatAgentLoopRunner = {
        execute: vi.fn(),
      } as unknown as ChatAgentLoopRunner;
      const runner = new ChatRunner(makeDeps({ stateManager, chatAgentLoopRunner }));

      runner.startSession("/repo");
      const result = await runner.execute("/resume", "/repo");

      expect(result.success).toBe(false);
      expect(result.output).toContain("I could not find a chat that can safely continue");
      expect(result.output).toContain("Type: Resume failure");
      expect(result.output).toContain("Continue from the latest chat");
      expect(result.output).toContain("Inspect what was running");
      expect(result.output).toContain("Show recent sessions");
      expect(result.output).not.toContain("native agentloop");
      expect(result.output).not.toContain("/resume <id>");
      expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
    });

    it("/resume without chat continuation runtime returns natural recovery guidance", async () => {
      const runner = new ChatRunner(makeDeps({ adapter: makeMockAdapter() }));

      const result = await runner.execute("/resume", "/repo");

      expect(result.success).toBe(false);
      expect(result.output).toContain("Continuing a saved chat is not available in this mode");
      expect(result.output).toContain("Type: Resume failure");
      expect(result.output).toContain("Continue from the latest chat");
      expect(result.output).not.toContain("native chat agentloop runtime");
    });

    it("/resume <selector> loads the selected session before resuming native agentloop state", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-resume-selector-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await writeJsonFixture(tmpDir, "chat/sessions/saved-session.json", {
          id: "saved-session",
          cwd: "/loaded-repo",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          title: "Work Session",
          messages: [
            { role: "user", content: "continue this", timestamp: "2026-01-01T00:00:00.000Z", turnIndex: 0 },
          ],
        });
        await writeJsonFixture(tmpDir, "chat/agentloop/saved-session.state.json", {
          sessionId: "saved-session",
          traceId: "trace-1",
          turnId: "turn-1",
          goalId: "chat",
          cwd: "/loaded-repo",
          modelRef: "openai/gpt-5.4-mini",
          messages: [{ role: "assistant", content: "continuing..." }],
          modelTurns: 1,
          toolCalls: 0,
          compactions: 0,
          completionValidationAttempts: 0,
          calledTools: [],
          lastToolLoopSignature: null,
          repeatedToolLoopCount: 0,
          finalText: "continuing...",
          status: "running",
          updatedAt: "2026-01-01T00:00:02.000Z",
        });
        await importLegacyChatAgentLoopSessionState(tmpDir);
        const chatAgentLoopRunner = {
          execute: vi.fn().mockResolvedValue({
            success: true,
            output: "Resumed selected session",
            error: null,
            exit_code: null,
            elapsed_ms: 30,
            stopped_reason: "completed",
          }),
        } as unknown as ChatAgentLoopRunner;
        const runner = new ChatRunner(makeDeps({ stateManager, chatAgentLoopRunner }));

        const result = await runner.execute("/resume saved-session", "/repo");

        expect(result.success).toBe(true);
        expect(result.output).toBe("Resumed selected session");
        expect(runner.getSessionId()).toBe("saved-session");
        const input = (chatAgentLoopRunner.execute as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
          cwd?: string;
          resumeOnly?: boolean;
          resumeState?: { sessionId: string };
          resumeSessionId?: string;
        };
        expect(input.cwd).toBe("/loaded-repo");
        expect(input.resumeOnly).toBe(true);
        expect(input.resumeState?.sessionId).toBe("saved-session");
        expect(input.resumeSessionId).toBe("saved-session");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("natural-language resume continues a single latest safe chat without copied ids", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-natural-resume-one-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await writeJsonFixture(tmpDir, "chat/sessions/latest-safe-chat.json", {
          id: "latest-safe-chat",
          cwd: "/loaded-repo",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          title: "Daily writing plan",
          sessionSummary: "Draft was waiting on a final pass.",
          messages: [
            { role: "user", content: "work on the draft", timestamp: "2026-01-01T00:00:00.000Z", turnIndex: 0 },
          ],
          agentLoopStatePath: "chat/agentloop/latest-safe-chat.state.json",
          agentLoopStatus: "running",
          agentLoopResumable: true,
          agentLoopUpdatedAt: "2026-01-01T00:00:02.000Z",
        });
        await writeJsonFixture(tmpDir, "chat/agentloop/latest-safe-chat.state.json", makeAgentLoopState({
          sessionId: "agent-natural-latest",
          updatedAt: "2026-01-01T00:00:02.000Z",
        }));
        await importLegacyChatAgentLoopSessionState(tmpDir);
        const llmClient = createSingleMockLLMClient(JSON.stringify({
          kind: "continue_latest",
          confidence: 0.94,
          rationale: "The user wants to continue prior chat work.",
        }));
        const chatAgentLoopRunner = {
          execute: vi.fn().mockResolvedValue({
            success: true,
            output: "Resumed naturally",
            error: null,
            exit_code: null,
            elapsed_ms: 30,
            stopped_reason: "completed",
          }),
        } as unknown as ChatAgentLoopRunner;
        const runner = new ChatRunner(makeDeps({ stateManager, llmClient, chatAgentLoopRunner }));

        const result = await runner.execute("continue where we left off", "/repo");

        expect(result.success).toBe(true);
        expect(result.output).toBe("Resumed naturally");
        expect(runner.getSessionId()).toBe("latest-safe-chat");
        expect(llmClient.callCount).toBe(1);
        const input = (chatAgentLoopRunner.execute as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
          cwd?: string;
          resumeOnly?: boolean;
          resumeState?: { sessionId: string };
          resumeSessionId?: string;
        };
        expect(input.cwd).toBe("/loaded-repo");
        expect(input.resumeOnly).toBe(true);
        expect(input.resumeState?.sessionId).toBe("agent-natural-latest");
        expect(input.resumeSessionId).toBe("agent-natural-latest");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("natural-language resume asks numbered human-readable choices when multiple chats can continue", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-natural-resume-many-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await writeJsonFixture(tmpDir, "chat/sessions/older-safe-chat.json", {
          id: "older-safe-chat",
          cwd: "/work/older",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          title: "Budget review",
          sessionSummary: "Waiting to check the numbers.",
          messages: [],
          agentLoopStatePath: "chat/agentloop/older-safe-chat.state.json",
          agentLoopStatus: "running",
          agentLoopResumable: true,
          agentLoopUpdatedAt: "2026-01-01T00:00:02.000Z",
        });
        await writeJsonFixture(tmpDir, "chat/agentloop/older-safe-chat.state.json", makeAgentLoopState({
          sessionId: "agent-older",
          updatedAt: "2026-01-01T00:00:02.000Z",
        }));
        await writeJsonFixture(tmpDir, "chat/sessions/newer-safe-chat.json", {
          id: "newer-safe-chat",
          cwd: "/work/newer",
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:01.000Z",
          title: "Release checklist",
          sessionSummary: "Waiting on the final verification.",
          messages: [],
          agentLoopStatePath: "chat/agentloop/newer-safe-chat.state.json",
          agentLoopStatus: "running",
          agentLoopResumable: true,
          agentLoopUpdatedAt: "2026-01-02T00:00:02.000Z",
        });
        await writeJsonFixture(tmpDir, "chat/agentloop/newer-safe-chat.state.json", makeAgentLoopState({
          sessionId: "agent-newer",
          updatedAt: "2026-01-02T00:00:02.000Z",
        }));
        await importLegacyChatAgentLoopSessionState(tmpDir);
        const llmClient = createSingleMockLLMClient(JSON.stringify({
          kind: "continue_latest",
          confidence: 0.95,
          rationale: "The user wants to continue prior chat work.",
        }));
        const chatAgentLoopRunner = {
          execute: vi.fn().mockResolvedValue({
            success: true,
            output: "Resumed selected numbered choice",
            error: null,
            exit_code: null,
            elapsed_ms: 30,
            stopped_reason: "completed",
          }),
        } as unknown as ChatAgentLoopRunner;
        const runner = new ChatRunner(makeDeps({ stateManager, llmClient, chatAgentLoopRunner }));

        const clarification = await runner.execute("continue where we left off", "/repo");

        expect(clarification.success).toBe(true);
        expect(clarification.output).toContain("I found more than one chat that can continue");
        expect(clarification.output).toContain("1. Release checklist");
        expect(clarification.output).toContain("2. Budget review");
        expect(clarification.output).not.toContain("newer-safe-chat");
        expect(clarification.output).not.toContain("older-safe-chat");
        expect(clarification.output).not.toContain("agent-newer");
        expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();

        const resumed = await runner.execute("2", "/repo");

        expect(resumed.success).toBe(true);
        expect(resumed.output).toBe("Resumed selected numbered choice");
        expect(runner.getSessionId()).toBe("older-safe-chat");
        expect(llmClient.callCount).toBe(1);
        expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce();
        const input = (chatAgentLoopRunner.execute as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
          resumeOnly?: boolean;
          resumeState?: { sessionId: string };
        };
        expect(input.resumeOnly).toBe(true);
        expect(input.resumeState?.sessionId).toBe("agent-older");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("clears numbered resume choices when the next turn starts ordinary work", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-natural-resume-stale-choice-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await writeJsonFixture(tmpDir, "chat/sessions/older-safe-chat.json", {
          id: "older-safe-chat",
          cwd: "/work/older",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          title: "Budget review",
          sessionSummary: "Waiting to check the numbers.",
          messages: [],
          agentLoopStatePath: "chat/agentloop/older-safe-chat.state.json",
          agentLoopStatus: "running",
          agentLoopResumable: true,
          agentLoopUpdatedAt: "2026-01-01T00:00:02.000Z",
        });
        await writeJsonFixture(tmpDir, "chat/agentloop/older-safe-chat.state.json", makeAgentLoopState({
          sessionId: "agent-older",
          updatedAt: "2026-01-01T00:00:02.000Z",
        }));
        await writeJsonFixture(tmpDir, "chat/sessions/newer-safe-chat.json", {
          id: "newer-safe-chat",
          cwd: "/work/newer",
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:01.000Z",
          title: "Release checklist",
          sessionSummary: "Waiting on the final verification.",
          messages: [],
          agentLoopStatePath: "chat/agentloop/newer-safe-chat.state.json",
          agentLoopStatus: "running",
          agentLoopResumable: true,
          agentLoopUpdatedAt: "2026-01-02T00:00:02.000Z",
        });
        await writeJsonFixture(tmpDir, "chat/agentloop/newer-safe-chat.state.json", makeAgentLoopState({
          sessionId: "agent-newer",
          updatedAt: "2026-01-02T00:00:02.000Z",
        }));
        await importLegacyChatAgentLoopSessionState(tmpDir);
        const llmClient = createMockLLMClient([
          JSON.stringify({
            kind: "continue_latest",
            confidence: 0.95,
            rationale: "The user wants to continue prior chat work.",
          }),
          JSON.stringify({
            kind: "none",
            confidence: 0.95,
            rationale: "The user is starting ordinary work instead of choosing a saved chat.",
          }),
        ]);
        const chatAgentLoopRunner = {
          execute: vi.fn()
            .mockResolvedValueOnce({
              success: true,
              output: "Started new work",
              error: null,
              exit_code: null,
              elapsed_ms: 30,
              stopped_reason: "completed",
            })
            .mockResolvedValueOnce({
              success: true,
              output: "Handled as ordinary follow-up",
              error: null,
              exit_code: null,
              elapsed_ms: 30,
              stopped_reason: "completed",
            }),
        } as unknown as ChatAgentLoopRunner;
        const runner = new ChatRunner(makeDeps({ stateManager, llmClient, chatAgentLoopRunner }));
        const selectedRoute: SelectedChatRoute = {
          kind: "agent_loop",
          reason: "agent_loop_available",
          replyTargetPolicy: "turn_reply_target",
          eventProjectionPolicy: "turn_only",
          concurrencyPolicy: "session_serial",
        };

        const clarification = await runner.execute("continue where we left off", "/repo", 120_000, { selectedRoute });

        expect(clarification.success).toBe(true);
        expect(clarification.output).toContain("I found more than one chat that can continue");

        const started = await runner.execute("start a new attempt instead", "/repo", 120_000, { selectedRoute });

        expect(started.success).toBe(true);
        expect(started.output).toBe("Started new work");

        const followUp = await runner.execute("1", "/repo", 120_000, { selectedRoute });

        expect(followUp.success).toBe(true);
        expect(followUp.output).toBe("Handled as ordinary follow-up");
        expect(runner.getSessionId()).not.toBe("older-safe-chat");
        expect(runner.getSessionId()).not.toBe("newer-safe-chat");
        expect(chatAgentLoopRunner.execute).toHaveBeenCalledTimes(2);
        const followUpInput = (chatAgentLoopRunner.execute as ReturnType<typeof vi.fn>).mock.calls[1][0] as {
          resumeOnly?: boolean;
          resumeState?: { sessionId: string };
        };
        expect(followUpInput.resumeOnly).not.toBe(true);
        expect(followUpInput.resumeState).toBeUndefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("clears numbered resume choices before pending setup confirmation returns", async () => {
      const telegramToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-natural-resume-setup-clear-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await writeJsonFixture(tmpDir, "chat/sessions/older-safe-chat.json", {
          id: "older-safe-chat",
          cwd: "/work/older",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          title: "Budget review",
          messages: [],
          agentLoopStatePath: "chat/agentloop/older-safe-chat.state.json",
          agentLoopStatus: "running",
          agentLoopResumable: true,
          agentLoopUpdatedAt: "2026-01-01T00:00:02.000Z",
        });
        await writeJsonFixture(tmpDir, "chat/agentloop/older-safe-chat.state.json", makeAgentLoopState({
          sessionId: "agent-older",
          updatedAt: "2026-01-01T00:00:02.000Z",
        }));
        await importLegacyChatAgentLoopSessionState(tmpDir);
        const adapter = makeMockAdapter({ ...CANNED_RESULT, output: "Handled as fresh adapter work." });
        const llmClient = createMockLLMClient([
          JSON.stringify({
            decision: "cancel",
            confidence: 0.95,
            rationale: "The user cancelled the pending setup write.",
          }),
          "Handled as fresh model-loop work.",
        ]);
        const runner = new ChatRunner(makeDeps({
          stateManager,
          adapter,
          llmClient,
          gatewaySetupStatusProvider: makeTelegramStatusProvider(makeTelegramSetupStatus({
            state: "unconfigured",
            configPath: path.join(tmpDir, "gateway", "channels", "telegram-bot", "config.json"),
            daemon: { running: true, port: 41700 },
          })),
        }));

        const intake = await runner.execute(telegramToken, "/repo", 30_000);
        (runner as unknown as { pendingResumeChoices: unknown }).pendingResumeChoices = [{
          index: 2,
          sessionId: "older-safe-chat",
          title: "Budget review",
          updatedAt: "2026-01-01T00:00:02.000Z",
          cwd: "/work/older",
          summary: null,
          agentLoopStatePath: "chat/agentloop/older-safe-chat.state.json",
        }];
        const cancelledSetup = await runner.execute("cancel setup", "/repo", 30_000);
        const staleNumber = await runner.execute("2", "/repo", 30_000, { selectedRoute: adapterRoute() });

        expect(intake.output).toContain("/confirm-setup-write");
        expect(cancelledSetup.success).toBe(false);
        expect(cancelledSetup.output).toContain("cancelled");
        expect(staleNumber.success).toBe(true);
        expect(staleNumber.output).toBe("Handled as fresh model-loop work.");
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("uses a routeSelector decision before natural recovery heuristics", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-route-selector-before-recovery-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await writeJsonFixture(tmpDir, "chat/sessions/latest-safe-chat.json", {
          id: "latest-safe-chat",
          cwd: "/work/latest",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          title: "Latest work",
          messages: [],
          agentLoopStatePath: "chat/agentloop/latest-safe-chat.state.json",
          agentLoopStatus: "running",
          agentLoopResumable: true,
          agentLoopUpdatedAt: "2026-01-01T00:00:02.000Z",
        });
        await writeJsonFixture(tmpDir, "chat/agentloop/latest-safe-chat.state.json", makeAgentLoopState({
          sessionId: "agent-latest",
          updatedAt: "2026-01-01T00:00:02.000Z",
        }));
        await importLegacyChatAgentLoopSessionState(tmpDir);
        const adapter = makeMockAdapter({ ...CANNED_RESULT, output: "Handled as fresh adapter work." });
        const chatAgentLoopRunner = {
          execute: vi.fn().mockResolvedValue(CANNED_RESULT),
        } as unknown as ChatAgentLoopRunner;
        const sendMessage = vi.fn().mockResolvedValue({
          content: "Handled as fresh model-loop work.",
        });
        const llmClient = {
          sendMessage,
          parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
        } as unknown as ILLMClient;
        const runner = new ChatRunner(makeDeps({
          stateManager,
          adapter,
          chatAgentLoopRunner,
          llmClient,
        }));

        const result = await runner.execute("continue where we left off", "/repo", 30_000, {
          routeSelector: async () => adapterRoute(),
        });

        expect(result.success).toBe(true);
        expect(result.output).toBe("Handled as fresh model-loop work.");
        expect(adapter.execute).not.toHaveBeenCalled();
        expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
        expect(sendMessage).toHaveBeenCalledOnce();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("natural-language resume with no saved state offers recovery choices instead of starting work", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-natural-resume-none-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        const llmClient = createSingleMockLLMClient(JSON.stringify({
          kind: "continue_latest",
          confidence: 0.94,
          rationale: "The user wants to continue prior chat work.",
        }));
        const chatAgentLoopRunner = {
          execute: vi.fn(),
        } as unknown as ChatAgentLoopRunner;
        const runner = new ChatRunner(makeDeps({ stateManager, llmClient, chatAgentLoopRunner }));

        const result = await runner.execute("continue where we left off", "/repo");

        expect(result.success).toBe(false);
        expect(result.output).toContain("I could not find a chat that can safely continue");
        expect(result.output).toContain("Continue from the latest chat");
        expect(result.output).toContain("Inspect what was running");
        expect(result.output).toContain("Start a new attempt");
        expect(result.output).not.toContain("agent-loop");
        expect(result.output).not.toContain("/resume <id>");
        expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
        expect(llmClient.callCount).toBe(1);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("ingress natural-language resume with no saved state offers recovery choices before agent loop", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-ingress-natural-resume-none-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        const llmClient = createSingleMockLLMClient(JSON.stringify({
          kind: "continue_latest",
          confidence: 0.94,
          rationale: "The user wants to continue prior chat work.",
        }));
        const chatAgentLoopRunner = {
          execute: vi.fn(),
        } as unknown as ChatAgentLoopRunner;
        const runner = new ChatRunner(makeDeps({ stateManager, llmClient, chatAgentLoopRunner }));
        const selectedRoute: SelectedChatRoute = {
          kind: "agent_loop",
          reason: "agent_loop_available",
          replyTargetPolicy: "turn_reply_target",
          eventProjectionPolicy: "turn_only",
          concurrencyPolicy: "session_serial",
        };

        const result = await runner.executeIngressMessage(
          makeIngress("continue where we left off"),
          "/repo",
          120_000,
          selectedRoute,
        );

        expect(result.success).toBe(false);
        expect(result.output).toContain("I could not find a chat that can safely continue");
        expect(result.output).toContain("Inspect what was running");
        expect(result.output).not.toContain("agent-loop");
        expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
        expect(llmClient.callCount).toBe(1);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("natural-language resume explains that failed saved work is not safely resumable", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-natural-resume-failed-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await writeJsonFixture(tmpDir, "chat/sessions/failed-chat.json", {
          id: "failed-chat",
          cwd: "/loaded-repo",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          title: "Failed run",
          messages: [],
          agentLoopStatePath: "chat/agentloop/failed-chat.state.json",
          agentLoopStatus: "failed",
          agentLoopResumable: true,
          agentLoopUpdatedAt: "2026-01-01T00:00:02.000Z",
        });
        await writeJsonFixture(tmpDir, "chat/agentloop/failed-chat.state.json", makeAgentLoopState({
          sessionId: "agent-failed",
          status: "failed",
          updatedAt: "2026-01-01T00:00:02.000Z",
        }));
        await importLegacyChatAgentLoopSessionState(tmpDir);
        const llmClient = createSingleMockLLMClient(JSON.stringify({
          kind: "continue_latest",
          confidence: 0.94,
          rationale: "The user wants to continue prior chat work.",
        }));
        const chatAgentLoopRunner = {
          execute: vi.fn(),
        } as unknown as ChatAgentLoopRunner;
        const runner = new ChatRunner(makeDeps({ stateManager, llmClient, chatAgentLoopRunner }));

        const result = await runner.execute("continue where we left off", "/repo");

        expect(result.success).toBe(false);
        expect(result.output).toContain("I could not find a chat that can safely continue");
        expect(result.output).toContain("Inspect what was running");
        expect(result.output).toContain("Start a new attempt");
        expect(result.output).not.toContain("failed-chat");
        expect(result.output).not.toContain("agent-failed");
        expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/resume maps runtime conversation and agent ids to owning chat ids", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-resume-runtime-conversation-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await writeJsonFixture(tmpDir, "chat/sessions/chat-runtime.json", {
          id: "chat-runtime",
          cwd: "/loaded-repo",
          createdAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:10:00.000Z",
          title: "Runtime Chat",
          messages: [],
          agentLoopStatePath: "chat/agentloop/chat-runtime.state.json",
          agentLoopStatus: "running",
          agentLoopResumable: true,
        });
        await writeJsonFixture(tmpDir, "chat/agentloop/chat-runtime.state.json", makeAgentLoopState({
          sessionId: "agent-runtime",
        }));
        await importLegacyChatAgentLoopSessionState(tmpDir);
        const chatAgentLoopRunner = {
          execute: vi.fn().mockResolvedValue({
            success: true,
            output: "Resumed runtime conversation",
            error: null,
            exit_code: null,
            elapsed_ms: 30,
            stopped_reason: "completed",
          }),
        } as unknown as ChatAgentLoopRunner;
        const runner = new ChatRunner(makeDeps({ stateManager, chatAgentLoopRunner }));

        const conversation = await runner.execute("/resume session:conversation:chat-runtime", "/repo");
        const agent = await runner.execute("/resume session:agent:agent-runtime", "/repo");

        expect(conversation.success).toBe(true);
        expect(conversation.output).toBe("Resumed runtime conversation");
        expect(agent.success).toBe(true);
        expect(agent.output).toBe("Resumed runtime conversation");
        expect(runner.getSessionId()).toBe("chat-runtime");
        expect(chatAgentLoopRunner.execute).toHaveBeenCalledTimes(2);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/resume rejects non-chat runtime sessions and runs before native agentloop execution", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-resume-runtime-negative-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await saveSupervisorFixture(tmpDir, [{
          workerId: "worker-1",
          goalId: "goal-a",
          startedAt: Date.parse("2026-04-25T00:00:00.000Z"),
        }]);
        await stateManager.writeRaw("runtime/process-sessions/proc-running.json", makeProcessSnapshot({
          session_id: "proc-running",
          pid: process.pid,
          running: true,
        }));
        const chatAgentLoopRunner = {
          execute: vi.fn().mockResolvedValue({
            success: true,
            output: "should not run",
            error: null,
            exit_code: null,
            elapsed_ms: 30,
            stopped_reason: "completed",
          }),
        } as unknown as ChatAgentLoopRunner;
        const runner = new ChatRunner(makeDeps({ stateManager, chatAgentLoopRunner }));

        const coreloop = await runner.execute("/resume session:coreloop:worker-1", "/repo");
        const processRun = await runner.execute("/resume run:process:proc-running", "/repo");

        expect(coreloop.success).toBe(false);
        expect(coreloop.output).toContain("not chat-resumable");
        expect(coreloop.output).toContain("pulseed runtime session session:coreloop:worker-1");
        expect(processRun.success).toBe(false);
        expect(processRun.output).toContain("not chat-resumable");
        expect(processRun.output).toContain("pulseed runtime run run:process:proc-running");
        expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/sessions lists chat sessions with registry runtime run summaries", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-sessions-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await writeJsonFixture(tmpDir, "chat/sessions/prior-session.json", {
          id: "prior-session",
          cwd: "/repo",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          title: "Prior",
          messages: [],
          agentLoopStatePath: "chat/agentloop/prior-session.state.json",
          agentLoopStatus: "running",
          agentLoopResumable: true,
          agentLoopUpdatedAt: "2026-01-01T00:00:02.000Z",
        });
        await writeJsonFixture(tmpDir, "chat/agentloop/prior-session.state.json", makeAgentLoopState({
          sessionId: "agent-prior",
          updatedAt: "2026-01-01T00:00:02.000Z",
        }));
        await importLegacyChatAgentLoopSessionState(tmpDir);
        await saveSupervisorFixture(tmpDir, [{
          workerId: "worker-1",
          goalId: "goal-a",
          startedAt: Date.parse("2026-04-25T00:00:00.000Z"),
        }]);
        await stateManager.writeRaw("runtime/process-sessions/proc-running.json", makeProcessSnapshot({
          session_id: "proc-running",
          pid: process.pid,
          running: true,
        }));
        await new BackgroundRunLedger(path.join(tmpDir, "runtime"), { controlBaseDir: tmpDir }).create({
          id: "run:coreloop:error-leak",
          kind: "coreloop_run",
          status: "running",
          notify_policy: "silent",
          goal_id: "goal-a",
          title: "Error leak probe",
          error: "raw failure for session:agent:secret-run",
        });
        const runner = new ChatRunner(makeDeps({ stateManager }));

        const result = await runner.execute("/sessions", "/repo");
        const detailed = await runner.execute("/sessions --details", "/repo");

        expect(result.success).toBe(true);
        expect(result.output).toContain("Chat sessions:");
        expect(result.output).toContain("Prior");
        expect(result.output).toContain("Background work is running");
        expect(result.output).not.toContain("prior-session");
        expect(result.output).not.toContain("runtime session:conversation:prior-session");
        expect(result.output).not.toContain("run:agent:agent-prior");
        expect(result.output).not.toContain("session:coreloop:worker-1");
        expect(result.output).not.toContain("run:coreloop:worker-1");
        expect(result.output).not.toContain("run:process:proc-running");
        expect(result.output).not.toContain("session:agent:secret-run");
        expect(result.output).not.toContain("raw failure");
        expect(result.output).not.toContain("{");
        expect(detailed.success).toBe(true);
        expect(detailed.output).toContain("prior-session");
        expect(detailed.output).toContain("runtime session:conversation:prior-session");
        expect(detailed.output).toContain("run:agent:agent-prior");
        expect(detailed.output).toContain("session:coreloop:worker-1");
        expect(detailed.output).toContain("run:coreloop:worker-1");
        expect(detailed.output).toContain("run:process:proc-running");
        expect(detailed.output).toContain("run:coreloop:error-leak");
        expect(detailed.output).toContain("raw failure for session:agent:secret-run");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/status and /goals read goal state without calling adapter", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-goals-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await stateManager.saveGoal(makeGoal("goal-a", { title: "Daily planning" }));
        await writeJsonFixture(tmpDir, "chat/sessions/chat-runtime.json", {
          id: "chat-runtime",
          cwd: "/repo",
          createdAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:10:00.000Z",
          title: "Runtime Chat",
          messages: [],
          agentLoopStatePath: "chat/agentloop/chat-runtime.state.json",
          agentLoopStatus: "running",
          agentLoopResumable: true,
        });
        await writeJsonFixture(tmpDir, "chat/agentloop/chat-runtime.state.json", makeAgentLoopState({
          sessionId: "agent-runtime",
          updatedAt: "2026-04-25T00:12:00.000Z",
        }));
        await importLegacyChatAgentLoopSessionState(tmpDir);
        await stateManager.writeRaw("runtime/process-sessions/proc-failed.json", makeProcessSnapshot({
          session_id: "proc-failed",
          running: false,
          exitCode: 1,
          exitedAt: "2026-04-25T01:00:00.000Z",
        }));
        await stateManager.writeRaw("runtime/process-sessions/proc-lost.json", makeProcessSnapshot({
          session_id: "proc-lost",
          running: false,
          exitCode: null,
          signal: null,
        }));
        await new RuntimeOperatorHandoffStore(path.join(tmpDir, "runtime")).create({
          handoff_id: "handoff-deadline",
          goal_id: "goal-a",
          triggers: ["deadline", "finalization"],
          title: "Deadline handoff",
          summary: "Deadline finalization requires review.",
          current_status: "mode=finalization",
          recommended_action: "Review final artifact.",
          next_action: {
            label: "Review final artifact",
            approval_required: true,
          },
        });
        const budgetStore = new RuntimeBudgetStore(path.join(tmpDir, "runtime"));
        await budgetStore.create({
          budget_id: "runtime-budget:goal-a",
          scope: { goal_id: "goal-a" },
          title: "Runtime budget for goal-a",
          created_at: "2026-04-25T00:00:00.000Z",
          limits: [{
            dimension: "iterations",
            limit: 5,
            approval_at_remaining: 1,
            exhaustion_policy: "approval_required",
          }],
        });
        await budgetStore.recordTaskExecution("runtime-budget:goal-a", {
          iterations: 2,
          observed_at: "2026-04-25T00:20:00.000Z",
        });
        const adapter = makeMockAdapter();
        const runner = new ChatRunner(makeDeps({ stateManager, adapter }));

        const status = await runner.execute("/status", "/repo");
        const focused = await runner.execute("/status goal-a", "/repo");
        const focusedDetailed = await runner.execute("/status goal-a --details", "/repo");
        const goals = await runner.execute("/goals", "/repo");

        expect(status.success).toBe(true);
        expect(status.output.indexOf("Current goal")).toBeLessThan(status.output.indexOf("Active goals:"));
        expect(status.output).toContain("- Goal: Daily planning");
        expect(status.output).toContain("Background: Background work is running");
        expect(status.output).toContain("Budget: 2 of 5 iterations used (3 left)");
        expect(status.output).toContain("Needs attention: Deadline handoff");
        expect(status.output).toContain("Next safe action: Review final artifact");
        expect(status.output).toContain("Active goals");
        expect(status.output).toContain("Active work:");
        expect(status.output).toContain("Other work is active");
        expect(status.output).toContain("Background work:");
        expect(status.output).not.toContain("goal-a");
        expect(status.output).not.toContain("runtime-budget:goal-a");
        expect(status.output).not.toContain("session:agent:agent-runtime");
        expect(status.output).not.toContain("run:agent:agent-runtime");
        expect(status.output).not.toContain("run:process:proc-failed");
        expect(status.output).not.toContain("run:process:proc-lost");
        expect(status.output).not.toContain("queued/running/attention-needed");
        expect(status.output).toContain("Operator handoffs pending:");
        expect(status.output).toContain("Deadline handoff");
        expect(focused.success).toBe(true);
        expect(focused.output.indexOf("Current goal")).toBeLessThan(focused.output.indexOf("Progress signals:"));
        expect(focused.output).toContain("Goal details: Daily planning");
        expect(focused.output).toContain("Budget: 2 of 5 iterations used (3 left)");
        expect(focused.output).toContain("Progress signals:");
        expect(focused.output).not.toContain("Active work:");
        expect(focused.output).not.toContain("ID: goal-a");
        expect(focused.output).not.toContain("Status: active");
        expect(focused.output).not.toContain("runtime-budget:goal-a");
        expect(focusedDetailed.success).toBe(true);
        expect(focusedDetailed.output).toContain("Budget diagnostics: pulseed runtime budget runtime-budget:goal-a");
        expect(goals.success).toBe(true);
        expect(goals.output).toContain("Goals:");
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/status shows numbered compact summaries for multiple active goals without title matching", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-status-multiple-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await stateManager.saveGoal(makeGoal("goal-a", { title: "Improve alpha routing" }));
        await stateManager.saveGoal(makeGoal("goal-b", { title: "Improve beta routing", status: "waiting" }));
        await stateManager.saveGoal(makeGoal("goal-c", { title: "Archived old work", status: "cancelled" }));
        await saveSupervisorFixture(tmpDir, [{
          workerId: "worker-beta",
          goalId: "goal-b",
          startedAt: Date.parse("2026-04-25T00:00:00.000Z"),
        }]);
        const runner = new ChatRunner(makeDeps({ stateManager }));

        const result = await runner.execute("/status", "/repo");

        expect(result.success).toBe(true);
        expect(result.output).toContain("Current goals:");
        expect(result.output).toContain("1. Improve alpha routing");
        expect(result.output).toContain("2. Improve beta routing");
        expect(result.output).toContain("Background: Background work is running");
        expect(result.output).not.toContain("run:coreloop:worker-beta");
        expect(result.output).not.toContain("Archived old work");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/status hides raw failed background-run errors by default but preserves them in details", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-status-error-boundary-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await stateManager.saveGoal(makeGoal("goal-a", { title: "Recover background work" }));
        const ledger = new BackgroundRunLedger(path.join(tmpDir, "runtime"), { controlBaseDir: tmpDir });
        await ledger.create({
          id: "run:coreloop:raw-error",
          kind: "coreloop_run",
          status: "running",
          notify_policy: "silent",
          goal_id: "goal-a",
          title: "Recover background work",
        });
        await ledger.terminal("run:coreloop:raw-error", {
          status: "failed",
          error: "provider failed for session:agent:secret-run",
          completed_at: "2026-04-25T00:20:00.000Z",
        });
        const runner = new ChatRunner(makeDeps({ stateManager }));

        const result = await runner.execute("/status", "/repo");
        const detailed = await runner.execute("/status --details", "/repo");

        expect(result.success).toBe(true);
        expect(result.output).toContain("Needs attention: Background work needs attention.");
        expect(result.output).not.toContain("provider failed");
        expect(result.output).not.toContain("session:agent:secret-run");
        expect(detailed.success).toBe(true);
        expect(detailed.output).toContain("provider failed for session:agent:secret-run");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/status reports no current goal when every goal is terminal", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-status-no-current-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await stateManager.saveGoal(makeGoal("goal-cancelled", { status: "cancelled" }));
        const runner = new ChatRunner(makeDeps({ stateManager }));

        const result = await runner.execute("/status", "/repo");

        expect(result.success).toBe(true);
        expect(result.output).toContain("No active goals found.");
        expect(result.output).not.toContain("Current goal");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/status <goal-id> does not attach a background run from a different typed goal id", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-status-run-mismatch-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await stateManager.saveGoal(makeGoal("goal-a", { title: "Focused work" }));
        await saveSupervisorFixture(tmpDir, [{
          workerId: "worker-other",
          goalId: "goal-b",
          startedAt: Date.parse("2026-04-25T00:00:00.000Z"),
        }]);
        const runner = new ChatRunner(makeDeps({ stateManager }));

        const result = await runner.execute("/status goal-a", "/repo");

        expect(result.success).toBe(true);
        expect(result.output).toContain("Current goal");
        expect(result.output).not.toContain("run:coreloop:worker-other");
        expect(result.output).toContain("Next safe action: Describe the next outcome");
        expect(result.output).not.toContain("ID: goal-a");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/status renders automation state from typed daemon snapshot before compatibility projections", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-runtime-automation-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await stateManager.saveGoal(makeGoal("goal-a"));
        const daemonClient = {
          getSnapshot: vi.fn().mockResolvedValue({
            daemon: null,
            goals: [],
            approvals: [],
            active_workers: [],
            last_outbox_seq: 0,
            auth_sessions: [],
            guardrails: null,
            runtime_automation: {
              schema_version: "runtime-automation-snapshot-v1",
              generated_at: "2026-05-07T00:00:00.000Z",
              auth_handoffs: {
                pending: [{
                  handoff_id: "handoff-mail",
                  provider_id: "browser-auth",
                  service_key: "mail.google.com",
                  workspace: "/repo",
                  actor_key: "chat-a",
                  state: "pending_operator",
                }],
                stale: [],
                recent_terminal: [],
              },
              browser_sessions: { authenticated: [], stale: [] },
              guardrails: {
                open_breakers: [{
                  provider_id: "browser-auth",
                  service_key: "mail.google.com",
                  state: "open",
                  failure_count: 2,
                }],
              },
              backpressure: {
                active: [{ provider_id: "browser-auth", service_key: "mail.google.com", run_key: "run-1" }],
                throttled: [],
              },
              blocked_work: [{
                kind: "guardrail_open",
                provider_id: "browser-auth",
                service_key: "mail.google.com",
                reason: "guardrail:open",
                since: "2026-05-07T00:00:00.000Z",
              }],
            },
          }),
        };
        const adapter = makeMockAdapter();
        const runner = new ChatRunner(makeDeps({ stateManager, adapter, daemonClient: daemonClient as never }));

        const status = await runner.execute("/status", "/repo");
        const detailedStatus = await runner.execute("/status --details", "/repo");

        expect(status.success).toBe(true);
        expect(status.output).toContain("Auth handoffs pending:");
        expect(status.output).toContain("mail.google.com via browser-auth is waiting for operator sign-in.");
        expect(status.output).not.toContain("handoff-mail");
        expect(status.output).not.toContain("pending_operator");
        expect(status.output).toContain("Guardrails:");
        expect(status.output).toContain("browser-auth/mail.google.com is temporarily paused");
        expect(status.output).not.toContain("breaker browser-auth/mail.google.com: open");
        expect(status.output).toContain("Backpressure active: 1 browser workflow(s) in flight");
        expect(status.output).toContain("Blocked automation work:");
        expect(status.output).toContain("browser-auth/mail.google.com is waiting for the automation guardrail to clear.");
        expect(status.output).not.toContain("guardrail:open");
        expect(detailedStatus.success).toBe(true);
        expect(detailedStatus.output).toContain("handoff-mail");
        expect(detailedStatus.output).toContain("pending_operator");
        expect(detailedStatus.output).toContain("breaker browser-auth/mail.google.com: open");
        expect(detailedStatus.output).toContain("browser-auth/mail.google.com: guardrail:open");
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/status <goal-id> reads archived goals without calling adapter", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-archived-status-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await stateManager.saveGoal(makeGoal("goal-a", { title: "Archived planning" }));
        await stateManager.archiveGoal("goal-a");
        const adapter = makeMockAdapter();
        const runner = new ChatRunner(makeDeps({ stateManager, adapter }));

        const result = await runner.execute("/status goal-a", "/repo");
        const detailed = await runner.execute("/status goal-a --details", "/repo");

        expect(result.success).toBe(true);
        expect(result.output).not.toContain("Current goal");
        expect(result.output).toContain("Goal details: Archived planning");
        expect(result.output).toContain("State: Archived");
        expect(result.output).not.toContain("ID: goal-a");
        expect(result.output).not.toContain("Status: archived");
        expect(detailed.success).toBe(true);
        expect(detailed.output).toContain("ID: goal-a");
        expect(detailed.output).toContain("Status: archived");
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/tasks and /task read task state without shelling out", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-tasks-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await stateManager.saveGoal(makeGoal("goal-a"));
        await stateManager.writeRaw("tasks/goal-a/task-1.json", makeTask("task-1", "goal-a"));
        const adapter = makeMockAdapter();
        const runner = new ChatRunner(makeDeps({ stateManager, adapter }));

        const tasks = await runner.execute("/tasks", "/repo");
        const task = await runner.execute("/task task-1", "/repo");

        expect(tasks.success).toBe(true);
        expect(tasks.output).toContain("Tasks for goal goal-a");
        expect(tasks.output).toContain("task-1");
        expect(task.success).toBe(true);
        expect(task.output).toContain("Task: task-1");
        expect(task.output).toContain("Success criteria:");
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/task <task-id> searches tasks under archived goals when no goal id is provided", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-archived-task-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await stateManager.saveGoal(makeGoal("goal-a"));
        await stateManager.writeRaw("tasks/goal-a/task-1.json", makeTask("task-1", "goal-a"));
        await stateManager.archiveGoal("goal-a");
        const adapter = makeMockAdapter();
        const runner = new ChatRunner(makeDeps({ stateManager, adapter }));

        const result = await runner.execute("/task task-1", "/repo");

        expect(result.success).toBe(true);
        expect(result.output).toContain("Task: task-1");
        expect(result.output).toContain("Goal: goal-a");
        expect(result.output).toContain("Success criteria:");
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/task <task-id> searches DB-archived goals after active task files are retired", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-db-archived-task-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await stateManager.saveGoal(makeGoal("goal-a", {
          title: "Recoverable archive",
        }));
        await stateManager.writeRaw("tasks/goal-a/task-1.json", makeTask("task-1", "goal-a"));
        await stateManager.archiveGoal("goal-a");
        const adapter = makeMockAdapter();
        const runner = new ChatRunner(makeDeps({ stateManager, adapter }));

        const status = await runner.execute("/status goal-a", "/repo");
        const task = await runner.execute("/task task-1", "/repo");

        expect(status.success).toBe(true);
        expect(status.output).toContain("State: Archived");
        expect(status.output).not.toContain("Status: archived");
        expect(task.success).toBe(true);
        expect(task.output).toContain("Task: task-1");
        expect(task.output).toContain("Goal: goal-a");
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/tasks and /task ignore unmigrated legacy task JSON in normal chat paths", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-legacy-task-json-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await stateManager.saveGoal(makeGoal("goal-a"));
        fs.mkdirSync(path.join(tmpDir, "tasks", "goal-a"), { recursive: true });
        fs.writeFileSync(
          path.join(tmpDir, "tasks", "goal-a", "task-legacy.json"),
          JSON.stringify(makeTask("task-legacy", "goal-a")),
        );
        const adapter = makeMockAdapter();
        const runner = new ChatRunner(makeDeps({ stateManager, adapter }));

        const tasks = await runner.execute("/tasks goal-a", "/repo");
        const task = await runner.execute("/task task-legacy goal-a", "/repo");

        expect(tasks.success).toBe(true);
        expect(tasks.output).toContain("No tasks found");
        expect(tasks.output).not.toContain("task-legacy");
        expect(task.success).toBe(false);
        expect(task.output).toContain("Task not found: task-legacy");
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/task with an explicit goal id cannot traverse outside the state directory", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-task-traversal-"));
      const outsideDir = path.join(path.dirname(tmpDir), `${path.basename(tmpDir)}-outside`);
      try {
        fs.mkdirSync(outsideDir, { recursive: true });
        fs.writeFileSync(path.join(outsideDir, "task-1.json"), JSON.stringify(makeTask("task-1", "outside-goal")));
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        const adapter = makeMockAdapter();
        const runner = new ChatRunner(makeDeps({ stateManager, adapter }));

        const result = await runner.execute(`/task task-1 ../../${path.basename(outsideDir)}`, "/repo");

        expect(result.success).toBe(false);
        expect(result.output).toContain("Task not found: task-1");
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("/tasks asks for a goal when multiple active goals exist", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-tasks-multiple-"));
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await stateManager.saveGoal(makeGoal("goal-a"));
        await stateManager.saveGoal(makeGoal("goal-b"));
        const runner = new ChatRunner(makeDeps({ stateManager }));

        const result = await runner.execute("/tasks", "/repo");

        expect(result.success).toBe(false);
        expect(result.output).toContain("Multiple active goals");
        expect(result.output).toContain("/tasks <goal-id>");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/config, /model without arguments, and /plugins do not invoke the execution adapter", async () => {
      const adapter = makeMockAdapter();
      const pluginLoader = {
        loadAll: vi.fn().mockResolvedValue([{ name: "demo", type: "notifier", enabled: true }]),
      };
      const runner = new ChatRunner(makeDeps({ adapter, pluginLoader }));

      const config = await runner.execute("/config", "/repo");
      const model = await runner.execute("/model", "/repo");
      const plugins = await runner.execute("/plugins", "/repo");

      expect(config.success).toBe(true);
      expect(config.output).toContain("Provider configuration");
      expect(config.output).toContain("has_api_key:");
      expect(model.success).toBe(true);
      expect(model.output).toContain("Model:");
      expect(plugins.success).toBe(true);
      expect(plugins.output).toContain("demo");
      expect(pluginLoader.loadAll).toHaveBeenCalledOnce();
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("/config uses the shared provider resolver including .env values", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-config-env-"));
      const oldEnv = {
        PULSEED_PROVIDER: process.env["PULSEED_PROVIDER"],
        PULSEED_LLM_PROVIDER: process.env["PULSEED_LLM_PROVIDER"],
        PULSEED_MODEL: process.env["PULSEED_MODEL"],
        PULSEED_LIGHT_MODEL: process.env["PULSEED_LIGHT_MODEL"],
        PULSEED_ADAPTER: process.env["PULSEED_ADAPTER"],
        PULSEED_DEFAULT_ADAPTER: process.env["PULSEED_DEFAULT_ADAPTER"],
        OPENAI_API_KEY: process.env["OPENAI_API_KEY"],
        OPENAI_BASE_URL: process.env["OPENAI_BASE_URL"],
      };
      try {
        for (const key of Object.keys(oldEnv)) delete process.env[key];
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await stateManager.writeRaw("provider.json", {
          provider: "openai",
          model: "gpt-5.4",
          adapter: "openai_api",
        });
        fs.writeFileSync(
          path.join(tmpDir, ".env"),
          "OPENAI_API_KEY=sk-from-env\nOPENAI_BASE_URL=https://example.test/v1\nPULSEED_LIGHT_MODEL=gpt-env-light\n"
        );
        const adapter = makeMockAdapter();
        const runner = new ChatRunner(makeDeps({ stateManager, adapter }));

        const result = await runner.execute("/config", "/repo");

        expect(result.success).toBe(true);
        expect(result.output).toContain("Provider configuration");
        expect(result.output).toContain("provider: openai");
        expect(result.output).toContain("model: gpt-5.4");
        expect(result.output).toContain("light_model: gpt-env-light");
        expect(result.output).toContain("adapter: openai_api");
        expect(result.output).toContain("base_url: https://example.test/v1");
        expect(result.output).toContain("has_api_key: true");
        expect(result.output).not.toContain("sk-from-env");
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        for (const [key, value] of Object.entries(oldEnv)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/model reports migrated legacy provider config without saving it", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-legacy-config-"));
      const oldEnv = {
        PULSEED_PROVIDER: process.env["PULSEED_PROVIDER"],
        PULSEED_LLM_PROVIDER: process.env["PULSEED_LLM_PROVIDER"],
        PULSEED_MODEL: process.env["PULSEED_MODEL"],
        PULSEED_ADAPTER: process.env["PULSEED_ADAPTER"],
        PULSEED_DEFAULT_ADAPTER: process.env["PULSEED_DEFAULT_ADAPTER"],
      };
      try {
        delete process.env["PULSEED_PROVIDER"];
        delete process.env["PULSEED_LLM_PROVIDER"];
        delete process.env["PULSEED_MODEL"];
        delete process.env["PULSEED_ADAPTER"];
        delete process.env["PULSEED_DEFAULT_ADAPTER"];
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await stateManager.writeRaw("provider.json", {
          llm_provider: "anthropic",
          default_adapter: "claude_api",
          anthropic: {
            api_key: "sk-ant-test",
            model: "claude-haiku-4-5",
          },
        });
        const adapter = makeMockAdapter();
        const runner = new ChatRunner(makeDeps({ stateManager, adapter }));

        const result = await runner.execute("/model", "/repo");
        const raw = await stateManager.readRaw("provider.json");

        expect(result.success).toBe(true);
        expect(result.output).toContain("Model: claude-haiku-4-5");
        expect(result.output).toContain("Provider: anthropic");
        expect(result.output).toContain("Adapter: claude_api");
        expect(raw).toMatchObject({ llm_provider: "anthropic" });
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        for (const [key, value] of Object.entries(oldEnv)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/model keeps explicit provider.json model ahead of PULSEED_MODEL", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-file-model-"));
      const oldModel = process.env["PULSEED_MODEL"];
      try {
        process.env["PULSEED_MODEL"] = "gpt-4o-mini-tts";
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await stateManager.writeRaw("provider.json", {
          provider: "openai",
          model: "gpt-5.4",
          adapter: "openai_codex_cli",
        });
        const adapter = makeMockAdapter();
        const runner = new ChatRunner(makeDeps({ stateManager, adapter }));

        const result = await runner.execute("/model", "/repo");

        expect(result.success).toBe(true);
        expect(result.output).toContain("Model: gpt-5.4");
        expect(result.output).not.toContain("gpt-4o-mini-tts");
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        if (oldModel === undefined) {
          delete process.env["PULSEED_MODEL"];
        } else {
          process.env["PULSEED_MODEL"] = oldModel;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/model updates file-owned fields without persisting env-resolved secrets", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-model-edit-"));
      const oldEnv = {
        OPENAI_API_KEY: process.env["OPENAI_API_KEY"],
        OPENAI_BASE_URL: process.env["OPENAI_BASE_URL"],
        PULSEED_LIGHT_MODEL: process.env["PULSEED_LIGHT_MODEL"],
      };
      try {
        process.env["OPENAI_API_KEY"] = "sk-env-secret";
        process.env["OPENAI_BASE_URL"] = "https://env.example.test/v1";
        process.env["PULSEED_LIGHT_MODEL"] = "gpt-env-light";
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await stateManager.writeRaw("provider.json", {
          provider: "openai",
          model: "gpt-5.4-mini",
          adapter: "openai_codex_cli",
        });
        const runner = new ChatRunner(makeDeps({ stateManager, adapter: makeMockAdapter() }));

        const result = await runner.execute("/model gpt-5.5 high", "/repo");
        const raw = await stateManager.readRaw("provider.json") as Record<string, unknown>;

        expect(result.success).toBe(true);
        expect(raw).toMatchObject({
          provider: "openai",
          model: "gpt-5.5",
          adapter: "openai_codex_cli",
          reasoning_effort: "high",
        });
        expect(raw).not.toHaveProperty("api_key");
        expect(raw).not.toHaveProperty("base_url");
        expect(raw).not.toHaveProperty("light_model");
      } finally {
        for (const [key, value] of Object.entries(oldEnv)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/model does not persist env-derived model or reasoning defaults", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-model-env-runtime-"));
      const oldEnv = {
        PULSEED_MODEL: process.env["PULSEED_MODEL"],
        OPENAI_REASONING_EFFORT: process.env["OPENAI_REASONING_EFFORT"],
      };
      try {
        process.env["PULSEED_MODEL"] = "gpt-env-model";
        process.env["OPENAI_REASONING_EFFORT"] = "xhigh";
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await stateManager.writeRaw("provider.json", {
          provider: "openai",
          adapter: "openai_codex_cli",
        });
        const runner = new ChatRunner(makeDeps({ stateManager, adapter: makeMockAdapter() }));

        const reasoningResult = await runner.execute("/model high", "/repo");
        const afterReasoning = await stateManager.readRaw("provider.json") as Record<string, unknown>;
        const modelResult = await runner.execute("/model gpt-5.5", "/repo");
        const afterModel = await stateManager.readRaw("provider.json") as Record<string, unknown>;

        expect(reasoningResult.success).toBe(true);
        expect(afterReasoning).not.toHaveProperty("model");
        expect(afterReasoning["reasoning_effort"]).toBe("high");
        expect(modelResult.success).toBe(true);
        expect(afterModel["model"]).toBe("gpt-5.5");
        expect(afterModel["reasoning_effort"]).toBe("high");
      } finally {
        for (const [key, value] of Object.entries(oldEnv)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/model rejects env-only OpenAI provider overrides before saving", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-model-env-provider-"));
      const oldEnv = {
        PULSEED_PROVIDER: process.env["PULSEED_PROVIDER"],
        PULSEED_ADAPTER: process.env["PULSEED_ADAPTER"],
      };
      try {
        process.env["PULSEED_PROVIDER"] = "openai";
        process.env["PULSEED_ADAPTER"] = "openai_codex_cli";
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await stateManager.writeRaw("provider.json", {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          adapter: "anthropic_api",
          api_key: "sk-file-secret",
        });
        const runner = new ChatRunner(makeDeps({ stateManager, adapter: makeMockAdapter() }));

        const result = await runner.execute("/model gpt-5.5 high", "/repo");
        const raw = await stateManager.readRaw("provider.json") as Record<string, unknown>;

        expect(result.success).toBe(false);
        expect(result.output).toContain("file-owned OpenAI provider configuration");
        expect(raw).toMatchObject({
          provider: "anthropic",
          model: "claude-haiku-4-5",
          adapter: "anthropic_api",
        });
        expect(raw).not.toHaveProperty("reasoning_effort");
      } finally {
        for (const [key, value] of Object.entries(oldEnv)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/model keeps secret-free OpenAI API config valid when the key comes from env", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-model-env-key-"));
      const oldApiKey = process.env["OPENAI_API_KEY"];
      try {
        process.env["OPENAI_API_KEY"] = "sk-env-secret";
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        await stateManager.writeRaw("provider.json", {
          provider: "openai",
          model: "gpt-5.4-mini",
          adapter: "openai_api",
        });
        const runner = new ChatRunner(makeDeps({ stateManager, adapter: makeMockAdapter() }));

        const result = await runner.execute("/model gpt-5.5 high", "/repo");
        const raw = await stateManager.readRaw("provider.json") as Record<string, unknown>;

        expect(result.success).toBe(true);
        expect(raw).toMatchObject({
          provider: "openai",
          model: "gpt-5.5",
          adapter: "openai_api",
          reasoning_effort: "high",
        });
        expect(raw).not.toHaveProperty("api_key");
      } finally {
        if (oldApiKey === undefined) {
          delete process.env["OPENAI_API_KEY"];
        } else {
          process.env["OPENAI_API_KEY"] = oldApiKey;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("/plugins handles missing pluginLoader gracefully", async () => {
      const runner = new ChatRunner(makeDeps());

      const result = await runner.execute("/plugins", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("Plugin information is not available");
    });

    it("/compact stores the model summary and keeps latest turns", async () => {
      const stateManager = makeMockStateManager();
      const runner = new ChatRunner(makeDeps({ stateManager }));
      runner.startSession("/repo");

      await runner.execute("Turn 1", "/repo");
      await runner.execute("Turn 2", "/repo");
      await runner.execute("Turn 3", "/repo");

      const result = await runner.execute("/compact", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("LLM summary");
      expect(result.output).toContain("latest user/assistant turns were kept");
      const persisted = await loadPersistedChatSession(stateManager, runner.getSessionId()!);
      expect(persisted?.messages).toHaveLength(4);
      expect(persisted?.messages.map((message) => message.content)).toEqual([
        "Turn 2",
        "Task completed successfully.",
        "Turn 3",
        "Task completed successfully.",
      ]);
      expect(persisted?.compactionSummary).toContain("Task completed successfully.");
      expect(persisted?.compactionRecords?.[0]).toMatchObject({
        schema_version: "chat-compaction-record-v1",
        replacementHistory: {
          retainedOriginalTurnIndexes: [2, 3, 4, 5],
        },
      });
    });

    it("/compact summary is included in the next model request", async () => {
      const stateManager = makeMockStateManager();
      const adapter = makeMockAdapter();
      const llmClient = makeRepeatingMockLLMClient();
      const runner = new ChatRunner(makeDeps({ stateManager, adapter, llmClient }));
      runner.startSession("/repo");

      await runner.execute("Turn 1", "/repo");
      await runner.execute("Turn 2", "/repo");
      await runner.execute("Turn 3", "/repo");
      await runner.execute("/compact", "/repo");
      await runner.execute("Continue", "/repo");

      const finalRequest = JSON.stringify((llmClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1));
      expect(finalRequest).toContain("Compacted");
      expect(finalRequest).toContain("Task completed successfully.");
      expect(finalRequest).toContain("Continue");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("/clear removes any compacted summary from later prompts", async () => {
      const stateManager = makeMockStateManager();
      const adapter = makeMockAdapter();
      const llmClient = makeRepeatingMockLLMClient();
      const runner = new ChatRunner(makeDeps({ stateManager, adapter, llmClient }));
      runner.startSession("/repo");

      await runner.execute("Turn 1", "/repo");
      await runner.execute("Turn 2", "/repo");
      await runner.execute("Turn 3", "/repo");
      await runner.execute("/compact", "/repo");
      await runner.execute("/clear", "/repo");
      await runner.execute("Fresh start", "/repo");

      const finalRequest = JSON.stringify((llmClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1));
      expect(finalRequest).not.toContain("Compacted");
      expect(finalRequest).not.toContain("Turn 1");
      expect(finalRequest).toContain("Fresh start");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("/undo removes the last turn from journal-backed prompts", async () => {
      const stateManager = makeMockStateManager();
      const adapter = makeMockAdapter();
      const llmClient = makeRepeatingMockLLMClient();
      const runner = new ChatRunner(makeDeps({ stateManager, adapter, llmClient }));
      runner.startSession("/repo");

      await runner.execute("Turn 1", "/repo");
      await runner.execute("Turn 2", "/repo");
      await runner.execute("/undo", "/repo");
      await runner.execute("Fresh start", "/repo");

      const finalRequest = JSON.stringify((llmClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1));
      expect(finalRequest).toContain("Turn 1");
      expect(finalRequest).not.toContain("Turn 2");
      expect(finalRequest).toContain("Fresh start");
      expect(adapter.execute).not.toHaveBeenCalled();
    });
  });

  describe("history population", () => {
    it("populates history with user and assistant messages after execution", async () => {
      const stateManager = makeMockStateManager();
      const runner = new ChatRunner(makeDeps({ stateManager }));

      await runner.execute("What is 2+2?", "/repo");

      const sessions = await listPersistedChatSessions(stateManager);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    });

    it("user message is included in the session data written to stateManager", async () => {
      const stateManager = makeMockStateManager();
      const runner = new ChatRunner(makeDeps({ stateManager }));

      const userInput = "Hello from test";
      await runner.execute(userInput, "/repo");

      const persisted = await latestPersistedChatSession(stateManager);
      const userMsg = persisted?.messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      // The prompt passed to adapter may include context prefix, so check the session content
      expect(userMsg?.content).toBe(userInput);
    });

    it("persists assistant message only after streaming completes", async () => {
      const stateManager = makeMockStateManager();
      const writes: ChatSession[] = [];
      const originalSave = ChatSessionDataStore.prototype.save;
      const saveSpy = vi.spyOn(ChatSessionDataStore.prototype, "save")
        .mockImplementation(async function (this: ChatSessionDataStore, session: ChatSession) {
          writes.push(JSON.parse(JSON.stringify(session)) as ChatSession);
          return originalSave.call(this, session);
        });
      const events: string[] = [];
      const llmClient = {
        supportsToolCalling: () => true,
        sendMessageStream: vi.fn().mockImplementation(async (_messages, _options, handlers) => {
          handlers.onTextDelta?.("Hello");
          handlers.onTextDelta?.(" world");
          return {
            content: "Hello world",
            usage: { input_tokens: 1, output_tokens: 2 },
            stop_reason: "end_turn",
            tool_calls: [],
          };
        }),
      } as unknown as ILLMClient;

      const runner = new ChatRunner(makeDeps({
        stateManager,
        llmClient,
        onEvent: (event) => { events.push(event.type); },
      }));

      await runner.execute("Stream this", "/repo");
      saveSpy.mockRestore();

      expect(writes.length).toBeGreaterThanOrEqual(3);
      const firstWrite = writes.find((write) => write.messages.length === 1 && !write.turnContexts);
      const secondWrite = writes.find((write) => write.messages.length === 1 && write.turnContexts?.length === 1);
      const thirdWrite = writes.find((write) =>
        write.messages.length === 2 && write.messages[1]?.content === "Hello world"
      );
      expect(firstWrite).toBeDefined();
      expect(secondWrite).toBeDefined();
      expect(thirdWrite).toBeDefined();
      expect(firstWrite!.messages).toHaveLength(1);
      expect(secondWrite!.messages).toHaveLength(1);
      expect(secondWrite!.turnContexts).toHaveLength(1);
      expect(thirdWrite!.messages).toHaveLength(2);
      expect(thirdWrite!.messages[1]?.content).toBe("Hello world");
      expect(events).toContain("assistant_delta");
      expect(events).toContain("assistant_final");
    });

    it("does not persist a partial assistant message when streaming fails", async () => {
      const stateManager = makeMockStateManager();
      const writes: ChatSession[] = [];
      const originalSave = ChatSessionDataStore.prototype.save;
      const saveSpy = vi.spyOn(ChatSessionDataStore.prototype, "save")
        .mockImplementation(async function (this: ChatSessionDataStore, session: ChatSession) {
          writes.push(JSON.parse(JSON.stringify(session)) as ChatSession);
          return originalSave.call(this, session);
        });
      const capturedEvents: Array<{ type: string; partialText?: string }> = [];
      const llmClient = {
        supportsToolCalling: () => true,
        sendMessageStream: vi.fn().mockImplementation(async (_messages, _options, handlers) => {
          handlers.onTextDelta?.("Partial answer");
          throw new Error("stream aborted");
        }),
      } as unknown as ILLMClient;

      const runner = new ChatRunner(makeDeps({
        stateManager,
        llmClient,
        onEvent: (event) => {
          if (event.type === "lifecycle_error") {
            capturedEvents.push({ type: event.type, partialText: event.partialText });
            return;
          }
          capturedEvents.push({ type: event.type });
        },
      }));

      const result = await runner.execute("Break the stream", "/repo");
      saveSpy.mockRestore();

      expect(result.success).toBe(false);
      expect(result.output).toContain("Recovery");
      expect(result.output).toContain("Type: Runtime interruption");
      expect(writes.length).toBeGreaterThanOrEqual(2);
      const lastWrite = writes.at(-1)!;
      expect(lastWrite.messages).toHaveLength(1);
      expect(lastWrite.turnContexts).toHaveLength(1);
      expect(capturedEvents).toContainEqual({ type: "lifecycle_error", partialText: "Partial answer" });
    });

    it("uses confidence-aware fallback on the production lifecycle-error path when structured evidence is absent", async () => {
      const stateManager = makeMockStateManager();
      const capturedEvents: Array<{ type: string; recoveryKind?: string }> = [];
      const llmClient = {
        supportsToolCalling: () => true,
        sendMessageStream: vi.fn().mockImplementation(async (_messages, _options, handlers) => {
          handlers.onTextDelta?.("Partial answer");
          throw new Error("provider returned overloaded");
        }),
        sendMessage: vi.fn().mockResolvedValue({
          content: JSON.stringify({ kind: "model_provider", confidence: 0.92, rationale: "provider unavailable" }),
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
        }),
        parseJSON: vi.fn((content: string, schema: z.ZodSchema<unknown>) => schema.parse(JSON.parse(content))),
      } as unknown as ILLMClient;

      const runner = new ChatRunner(makeDeps({
        stateManager,
        llmClient,
        onEvent: (event) => {
          if (event.type === "lifecycle_error") {
            capturedEvents.push({ type: event.type, recoveryKind: event.recovery.kind });
            return;
          }
          capturedEvents.push({ type: event.type });
        },
      }));

      const result = await runner.execute("Break the provider", "/repo");

      expect(result.success).toBe(false);
      expect(result.output).toContain("Type: Model/provider failure");
      expect(capturedEvents).toContainEqual({ type: "lifecycle_error", recoveryKind: "model_provider" });
      expect(llmClient.sendMessage).toHaveBeenCalledOnce();
    });
  });

  describe("startSession / multi-turn behavior", () => {
    it("startSession initializes a session that is reused across multiple execute() calls", async () => {
      const stateManager = makeMockStateManager();
      const runner = new ChatRunner(makeDeps({ stateManager }));

      runner.startSession("/repo");
      await runner.execute("Turn 1", "/repo");
      await runner.execute("Turn 2", "/repo");

      const sessions = await listPersistedChatSessions(stateManager);
      expect(new Set(sessions.map((session) => session.id)).size).toBe(1);
    });

    it("multiple execute() calls without startSession create separate sessions", async () => {
      const stateManager = makeMockStateManager();
      const runner = new ChatRunner(makeDeps({ stateManager }));

      await runner.execute("Turn 1", "/repo");
      await runner.execute("Turn 2", "/repo");

      const sessions = await listPersistedChatSessions(stateManager);
      expect(new Set(sessions.map((session) => session.id)).size).toBe(2);
    });

    it("history accumulates across turns when session is started", async () => {
      const stateManager = makeMockStateManager();
      const runner = new ChatRunner(makeDeps({ stateManager }));

      runner.startSession("/repo");
      await runner.execute("First question", "/repo");
      await runner.execute("Second question", "/repo");

      const sessionData = await loadPersistedChatSession(stateManager, runner.getSessionId()!);
      expect(sessionData?.messages.length).toBeGreaterThanOrEqual(4);
    });

    it("execute() one-shot mode keeps ordinary turns on the direct model loop", async () => {
      const adapter = makeMockAdapter();
      const llmClient = makeRepeatingMockLLMClient();
      const runner = new ChatRunner(makeDeps({ adapter, llmClient }));

      await runner.execute("Task A", "/repo");
      await runner.execute("Task B", "/repo");

      expect(llmClient.sendMessage).toHaveBeenCalledTimes(2);
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("startSession followed by /clear still keeps the same session path", async () => {
      const stateManager = makeMockStateManager();
      const runner = new ChatRunner(makeDeps({ stateManager }));

      runner.startSession("/repo");
      await runner.execute("Before clear", "/repo");
      await runner.execute("/clear", "/repo");
      await runner.execute("After clear", "/repo");

      const sessions = await listPersistedChatSessions(stateManager);
      expect(new Set(sessions.map((session) => session.id)).size).toBe(1);
    });
  });

  describe("persist-before-execute ordering", () => {
    it("chat session state is saved before the model request", async () => {
      const callOrder: string[] = [];

      const stateManager = makeMockStateManager();
      const originalSave = ChatSessionDataStore.prototype.save;
      const saveSpy = vi.spyOn(ChatSessionDataStore.prototype, "save")
        .mockImplementation(async function (this: ChatSessionDataStore, session: ChatSession) {
          callOrder.push("chatSession.save");
          return originalSave.call(this, session);
        });

      const llmClient = {
        sendMessage: vi.fn().mockImplementation(async () => {
          callOrder.push("llm.sendMessage");
          return {
            content: "Task completed successfully.",
            usage: { input_tokens: 1, output_tokens: 1 },
            stop_reason: "end_turn",
          };
        }),
        parseJSON: vi.fn(),
      } as unknown as ILLMClient;

      const runner = new ChatRunner(makeDeps({ stateManager, llmClient }));
      await runner.execute("persist ordering check", "/repo");
      saveSpy.mockRestore();

      const writeIndex = callOrder.indexOf("chatSession.save");
      const executeIndex = callOrder.indexOf("llm.sendMessage");
      expect(writeIndex).toBeGreaterThanOrEqual(0);
      expect(executeIndex).toBeGreaterThanOrEqual(0);
      expect(writeIndex).toBeLessThan(executeIndex);
    });
  });

  describe("agent loop and native tool protocol routing", () => {
    it("routes to chatAgentLoopRunner when configured", async () => {
      const seenEvents: ChatEvent[] = [];
      const approvalFn = vi.fn().mockResolvedValue(true);
      const adapter = makeMockAdapter();
      const chatAgentLoopRunner = {
        execute: vi.fn().mockImplementation(async (input: {
          eventSink?: { emit(event: unknown): Promise<void> | void };
          approvalFn?: (request: { reason: string }) => Promise<boolean>;
        }) => {
          const base = {
            sessionId: "session-1",
            traceId: "trace-1",
            turnId: "agent-turn",
            goalId: "goal-1",
            createdAt: new Date().toISOString(),
          };
          await input.eventSink?.emit({
            ...base,
            type: "model_request",
            eventId: "model-event-1",
            model: "gpt-test",
            toolCount: 2,
          });
          await input.eventSink?.emit({
            ...base,
            type: "assistant_message",
            eventId: "commentary-event-1",
            phase: "commentary",
            contentPreview: "I will inspect the workspace first.",
            toolCallCount: 1,
          });
          await input.eventSink?.emit({
            ...base,
            type: "tool_call_started",
            eventId: "tool-start-event-1",
            callId: "call-1",
            toolName: "shell_command",
            inputPreview: "{\"command\":\"pwd\"}",
          });
          await input.eventSink?.emit({
            ...base,
            type: "plan_update",
            eventId: "plan-event-1",
            summary: "Inspect workspace, apply patch, then verify.",
          });
          await input.eventSink?.emit({
            ...base,
            type: "approval_request",
            eventId: "approval-event-1",
            callId: "call-approval",
            toolName: "apply_patch",
            reason: "needs confirmation",
            permissionLevel: "workspace-write",
            isDestructive: false,
          });
          await input.approvalFn?.({ reason: "needs confirmation" });
          await input.eventSink?.emit({
            ...base,
            type: "tool_call_finished",
            eventId: "tool-finish-event-1",
            callId: "call-1",
            toolName: "shell_command",
            success: true,
            outputPreview: "/repo",
            durationMs: 12,
          });
          await input.eventSink?.emit({
            ...base,
            type: "context_compaction",
            eventId: "compaction-event-1",
            turnId: "agent-turn",
            phase: "mid_turn",
            reason: "context_limit",
            inputMessages: 10,
            outputMessages: 4,
            summaryPreview: "Shorter context",
          });
          await input.eventSink?.emit({
            ...base,
            type: "final",
            eventId: "final-event-1",
            success: true,
            outputPreview: "Native agentloop response",
          });
          await input.eventSink?.emit({
            ...base,
            type: "stopped",
            eventId: "stopped-event-1",
            reason: "completed",
          });
          return {
            success: true,
            output: "Native agentloop response",
            error: null,
            exit_code: null,
            elapsed_ms: 42,
            stopped_reason: "completed",
          };
        }),
      } as unknown as ChatAgentLoopRunner;
      const llmClient = {
        supportsToolCalling: () => true,
        sendMessage: vi.fn().mockResolvedValue({
          content: unusedModelDecision(),
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
        }),
        parseJSON: createSingleMockLLMClient(unusedModelDecision()).parseJSON,
      };

      const runner = new ChatRunner(makeDeps({
        adapter,
        chatAgentLoopRunner,
        llmClient: llmClient as never,
        approvalFn,
        onEvent: (event) => { seenEvents.push(event); },
      }));
      const result = await runner.execute("Do something", "/repo");

      expect((chatAgentLoopRunner.execute as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
      expect(llmClient.sendMessage).not.toHaveBeenCalled();
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.output).toBe("Native agentloop response");
      expect(approvalFn).toHaveBeenCalledWith("needs confirmation");
      const eventTypes = seenEvents.map((event) => event.type);
      const firstToolIndex = eventTypes.indexOf("tool_start");
      expect(firstToolIndex).toBeGreaterThanOrEqual(0);
      expect(seenEvents.some((event) =>
        event.type === "activity" && event.presentation?.gatewayNarration?.audience === "user"
      )).toBe(false);
      const checkpointMessages = seenEvents
        .filter((event): event is Extract<ChatEvent, { type: "activity" }> =>
          event.type === "activity" && event.kind === "checkpoint"
        )
        .map((event) => event.message);
      expect(checkpointMessages).toEqual(expect.arrayContaining([
        expect.stringContaining("Plan updated"),
        expect.stringContaining("Approval requested"),
      ]));
      expect(eventTypes).toContain("tool_start");
      expect(eventTypes).toContain("tool_end");
      expect(eventTypes).toContain("tool_update");
      const timelineSourceTypes = seenEvents
        .filter((event): event is Extract<ChatEvent, { type: "agent_timeline" }> =>
          event.type === "agent_timeline"
        )
        .map((event) => event.item.sourceType);
      expect(timelineSourceTypes).toEqual(expect.arrayContaining([
        "model_request",
        "assistant_message",
        "tool_call_started",
        "tool_call_finished",
        "final",
        "stopped",
      ]));
      expect(timelineSourceTypes.indexOf("assistant_message")).toBeLessThan(timelineSourceTypes.indexOf("tool_call_started"));
      expect(timelineSourceTypes.indexOf("tool_call_finished")).toBeLessThan(timelineSourceTypes.indexOf("final"));
    });

    it("builds agent-loop requests from current TurnContext instead of stale runtime deps", async () => {
      const stateManager = makeMockStateManager();
      const adapter = makeMockAdapter();
      const chatAgentLoopRunner = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: "Agentloop from current context",
          error: null,
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "completed",
        }),
      } as unknown as ChatAgentLoopRunner;
      const runner = new ChatRunner(makeDeps({
        stateManager,
        adapter,
        chatAgentLoopRunner,
        runtimeReplyTarget: {
          surface: "gateway",
          platform: "slack",
          conversation_id: "stale-thread",
          message_id: "stale-message",
          identity_key: "stale-user",
        },
      }));

      const ingress = {
        ...makeIngress("進捗を確認して"),
        runtimeControl: {
          allowed: true,
          approvalMode: "preapproved" as const,
        },
        replyTarget: {
          ...makeIngress("").replyTarget,
          platform: "slack",
          conversation_id: "current-thread",
          message_id: "current-message",
          identity_key: "current-user",
          user_id: "U-current",
        },
      };
      const result = await runner.executeIngressMessage(ingress, "/repo", 120_000, {
        kind: "agent_loop",
        reason: "agent_loop_available",
        replyTargetPolicy: "turn_reply_target",
        eventProjectionPolicy: "turn_only",
        concurrencyPolicy: "session_serial",
      });

      expect(result.success).toBe(true);
      expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce();
      const call = (chatAgentLoopRunner.execute as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        systemPrompt?: string;
        toolCallContext?: {
          runtimeReplyTarget?: Record<string, unknown> | null;
          runtimeControlApprovalMode?: string;
        };
      };
      expect(call.systemPrompt).toContain("## Turn Context");
      expect(call.systemPrompt).toContain("current-thread");
      expect(call.systemPrompt).not.toContain("stale-thread");
      expect(call.toolCallContext?.runtimeReplyTarget).toMatchObject({
        conversation_id: "current-thread",
        message_id: "current-message",
      });
      expect(call.toolCallContext?.runtimeControlApprovalMode).toBe("preapproved");

      const persistedSession = await latestPersistedChatSession(stateManager);
      expect(persistedSession?.turnContexts).toHaveLength(1);
      const snapshotJson = JSON.stringify(persistedSession?.turnContexts?.[0]);
      expect(snapshotJson).toContain("current-thread");
      expect(snapshotJson).not.toContain("stale-thread");
      expect(snapshotJson).not.toContain("approvalFn");
    });

    it("routes simple questions through chatAgentLoopRunner when configured", async () => {
      const adapter = makeMockAdapter();
      const chatAgentLoopRunner = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: "Agentloop direct answer",
          error: null,
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "completed",
        }),
      } as unknown as ChatAgentLoopRunner;
      const llmClient = {
        supportsToolCalling: () => true,
        sendMessage: vi.fn().mockResolvedValue({
          content: unusedModelDecision(),
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
        }),
        parseJSON: createSingleMockLLMClient(unusedModelDecision()).parseJSON,
      };

      const runner = new ChatRunner(makeDeps({
        adapter,
        chatAgentLoopRunner,
        llmClient: llmClient as never,
      }));
      const result = await runner.execute("What route should answer this?", "/repo");

      expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce();
      expect(llmClient.sendMessage).not.toHaveBeenCalled();
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.output).toBe("Agentloop direct answer");
    });

    it("classifies native agent-loop lifecycle failures from structured runner and tool metadata", async () => {
      const seenEvents: ChatEvent[] = [];
      const chatAgentLoopRunner = {
        execute: vi.fn().mockImplementation(async (input: {
          eventSink?: { emit(event: unknown): Promise<void> | void };
        }) => {
          await input.eventSink?.emit({
            type: "tool_call_finished",
            callId: "call-denied",
            toolName: "shell_command",
            success: false,
            disposition: "approval_denied",
            outputPreview: "プロバイダ固有の拒否文言",
            durationMs: 1,
          });
          return {
            success: false,
            output: "localized failure text without keywords",
            error: null,
            exit_code: null,
            elapsed_ms: 42,
            stopped_reason: "error",
            agentLoop: {
              traceId: "trace-1",
              sessionId: "session-1",
              turnId: "turn-1",
              stopReason: "consecutive_tool_errors",
              modelTurns: 1,
              toolCalls: 1,
              compactions: 0,
            },
          };
        }),
      } as unknown as ChatAgentLoopRunner;

      const runner = new ChatRunner(makeDeps({
        chatAgentLoopRunner,
        onEvent: (event) => { seenEvents.push(event); },
      }));
      const result = await runner.execute("Do something requiring tools", "/repo");

      expect(result.success).toBe(false);
      const lifecycleError = seenEvents.find((event): event is Extract<ChatEvent, { type: "lifecycle_error" }> =>
        event.type === "lifecycle_error"
      );
      expect(lifecycleError?.recovery.kind).toBe("permission");
      expect(result.output).toContain("Type: Permission failure");
    });

    it("uses native runner typed failure reason instead of provider text for runtime interruption recovery", async () => {
      const seenEvents: ChatEvent[] = [];
      const chatAgentLoopRunner = {
        execute: vi.fn().mockResolvedValue({
          success: false,
          output: "モデルからの非英語エラー",
          error: null,
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "error",
          agentLoop: {
            traceId: "trace-1",
            sessionId: "session-1",
            turnId: "turn-1",
            stopReason: "fatal_error",
            failureReason: "model_request_timeout",
            modelTurns: 1,
            toolCalls: 0,
            compactions: 0,
          },
        }),
      } as unknown as ChatAgentLoopRunner;

      const runner = new ChatRunner(makeDeps({
        chatAgentLoopRunner,
        onEvent: (event) => { seenEvents.push(event); },
      }));
      const result = await runner.execute("Please inspect the repo", "/repo");

      expect(result.success).toBe(false);
      const lifecycleError = seenEvents.find((event): event is Extract<ChatEvent, { type: "lifecycle_error" }> =>
        event.type === "lifecycle_error"
      );
      expect(lifecycleError?.recovery.kind).toBe("runtime_interruption");
      expect(result.output).toContain("Type: Runtime interruption");
    });

    it("leaves broad continue and finish prompts on the agent loop even when runtime control is wired", async () => {
      const adapter = makeMockAdapter();
      const chatAgentLoopRunner = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: "Agentloop keeps the conversational turn",
          error: null,
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "completed",
        }),
      } as unknown as ChatAgentLoopRunner;
      const runtimeControlService = {
        request: vi.fn().mockResolvedValue({
          success: true,
          message: "runtime control should not run",
        }),
      };
      const runner = new ChatRunner(makeDeps({
        adapter,
        chatAgentLoopRunner,
        llmClient: createMockLLMClient([
          JSON.stringify({ intent: "none", reason: "ordinary continuation" }),
          unusedModelDecision(),
          JSON.stringify({ intent: "none", reason: "ordinary implementation finish request" }),
          unusedModelDecision(),
        ]),
        runtimeControlService,
      }));

      const continueResult = await runner.execute("続けて", "/repo");
      const finishResult = await runner.execute("finish the implementation", "/repo");

      expect(continueResult.success).toBe(true);
      expect(finishResult.success).toBe(true);
      expect(chatAgentLoopRunner.execute).toHaveBeenCalledTimes(2);
      expect(runtimeControlService.request).not.toHaveBeenCalled();
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("keeps explicit non-gateway runtime-control context ahead of the agent loop", async () => {
      const adapter = makeMockAdapter();
      const approvalFn = vi.fn().mockResolvedValue(true);
      const chatAgentLoopRunner = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: "Agent loop should not receive explicit runtime control",
          error: null,
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "completed",
        }),
      } as unknown as ChatAgentLoopRunner;
      const runtimeControlService = {
        request: vi.fn().mockResolvedValue({
          success: true,
          message: "pause queued",
          operationId: "op-cli-pause",
          state: "running",
        }),
      };
      const runner = new ChatRunner(makeDeps({
        adapter,
        chatAgentLoopRunner,
        llmClient: createSingleMockLLMClient(JSON.stringify({
          intent: "pause_run",
          reason: "Pause the current CLI runtime turn.",
        })),
        runtimeControlService,
      }));

      const result = await runner.execute("Pause the current run.", "/repo", 120_000, {
        runtimeControlContext: {
          actor: {
            surface: "cli",
            identity_key: "cli-owner",
            user_id: "user-1",
          },
          replyTarget: {
            surface: "cli",
            channel: "cli",
            identity_key: "cli-owner",
            user_id: "user-1",
          },
          approvalFn,
          allowed: true,
          approvalMode: "interactive",
          explicit: true,
        },
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe("pause queued");
      expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(runtimeControlService.request).toHaveBeenCalledWith(expect.objectContaining({
        intent: expect.objectContaining({ kind: "pause_run" }),
        requestedBy: expect.objectContaining({ surface: "cli", identity_key: "cli-owner" }),
        replyTarget: expect.objectContaining({ surface: "cli", channel: "cli" }),
        approvalFn,
      }));
    });

    it("leaves long-running natural-language handoff to chatAgentLoopRunner tools", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-coreloop-tool-route-"));
      try {
        const adapter = makeMockAdapter();
        const chatAgentLoopRunner = {
          execute: vi.fn().mockResolvedValue({
            success: true,
            output: "Agentloop handles handoff",
            error: null,
            exit_code: null,
            elapsed_ms: 42,
            stopped_reason: "completed",
          }),
        } as unknown as ChatAgentLoopRunner;
        const llmClient = {
          supportsToolCalling: () => true,
          sendMessage: vi.fn().mockResolvedValue({
            content: unusedModelDecision(),
            usage: { input_tokens: 10, output_tokens: 12 },
            stop_reason: "stop",
          }),
          parseJSON: createSingleMockLLMClient(unusedModelDecision()).parseJSON,
        };
        const goal = makeGoal("goal-long", {
          title: "Reach the long-running score target",
          description: "Improve the task until score target is reached.",
        });
        const goalNegotiator = {
          negotiate: vi.fn().mockResolvedValue({ goal }),
        };
        const daemonClient = {
          startGoal: vi.fn().mockResolvedValue(undefined),
        };
        const stateManager = {
          ...makeMockStateManager(),
          getBaseDir: vi.fn().mockReturnValue(tmpDir),
        } as unknown as StateManager;
        const runner = new ChatRunner(makeDeps({
          adapter,
          stateManager,
          chatAgentLoopRunner,
          llmClient: llmClient as never,
          goalNegotiator: goalNegotiator as never,
          daemonClient: daemonClient as never,
        }));
        runner.startSession("/repo");

        const result = await runner.execute("coreloopの方でscore0.98超えるまで色々やってほしい", "/repo");

        expect(result.success).toBe(true);
        expect(result.output).toBe("Agentloop handles handoff");
        expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce();
        expect(adapter.execute).not.toHaveBeenCalled();
        expect(llmClient.sendMessage).not.toHaveBeenCalled();
        expect(goalNegotiator.negotiate).not.toHaveBeenCalled();
        expect(daemonClient.startGoal).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("interruptAndRedirect aborts an active native agent loop and returns a summary", async () => {
      let capturedSignal: AbortSignal | undefined;
      const chatAgentLoopRunner = {
        execute: vi.fn().mockImplementation((input: { abortSignal?: AbortSignal }) => {
          capturedSignal = input.abortSignal;
          return new Promise((resolve) => {
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
      const events: ChatEvent[] = [];
      const runner = new ChatRunner(makeDeps({
        stateManager: makeMockStateManager(),
        chatAgentLoopRunner,
        onEvent: (event) => {
          events.push(event);
        },
      }));
      runner.startSession("/repo");

      const active = runner.execute("Implement a feature", "/repo");
      await vi.waitFor(() => expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce());

      const interrupted = await runner.interruptAndRedirect(
        "stop and summarize",
        "/stale-repo",
        30_000,
        { userInput: createTextUserInput("stop and summarize") },
      );

      expect(capturedSignal?.aborted).toBe(true);
      expect(interrupted.success).toBe(true);
      expect(interrupted.output).toContain("Interrupted the active turn");
      expect(interrupted.output).toContain("Activity before interruption");
      const steer = events.find((event): event is Extract<ChatEvent, { type: "turn_steer" }> =>
        event.type === "turn_steer"
      );
      expect(steer).toBeDefined();
      expect(steer?.operation).toMatchObject({
        kind: "TurnSteer",
        runId: steer?.runId,
        turnId: steer?.turnId,
        activeTurn: {
          cwd: "/repo",
        },
        userInput: {
          schema_version: "user-input-v1",
          rawText: "stop and summarize",
          items: [{
            kind: "text",
            text: "stop and summarize",
          }],
        },
      });
      expect(steer?.operation.steerInputId).toEqual(expect.any(String));
      const steerLifecycleStart = events.find((event): event is Extract<ChatEvent, { type: "lifecycle_start" }> =>
        event.type === "lifecycle_start" && event.operation.kind === "TurnSteer"
      );
      expect(steerLifecycleStart?.operation).toMatchObject({
        kind: "TurnSteer",
        steerInputId: steer?.operation.steerInputId,
      });
      expect(steerLifecycleStart?.runId).toBe(steer?.operation.runId);
      expect(steerLifecycleStart?.turnId).toBe(steer?.operation.turnId);
      await active;
    });

    it("does not abort the active turn for unsupported background redirect requests", async () => {
      const interruptible = makeInterruptibleAgentLoopRunner();
      const events: ChatEvent[] = [];
      const runner = new ChatRunner(makeDeps({
        stateManager: makeMockStateManager(),
        chatAgentLoopRunner: interruptible.runner,
        llmClient: createMockLLMClient([interruptDecision("background")]),
        onEvent: (event) => {
          events.push(event);
        },
      }));
      runner.startSession("/repo");

      const active = runner.execute("Implement a feature", "/repo");
      await vi.waitFor(() => expect(interruptible.runner.execute).toHaveBeenCalledOnce(), { timeout: 5_000 });
      expect(runner.getActiveSeedyPresence()).toMatchObject({
        phase: "acting",
        expected_next: "progress",
      });

      const redirected = await runner.interruptAndRedirect("continúa esto en segundo plano", "/repo");

      expect(interruptible.getSignal()?.aborted).toBe(false);
      expect(redirected.success).toBe(true);
      expect(redirected.output).toContain("background is not available yet");
      expect(runner.hasActiveTurn()).toBe(true);
      expect(runner.getActiveSeedyPresence()).toMatchObject({
        phase: "acting",
        expected_next: "progress",
      });
      expect(events.filter((event) => event.type === "assistant_final")).toHaveLength(0);
      expect(events.filter((event) => event.type === "lifecycle_end")).toHaveLength(0);

      interruptible.resolveActive();
      await active;
      expect(runner.hasActiveTurn()).toBe(false);
      expect(runner.getActiveSeedyPresence()).toBeNull();
    });

    it("emits a typed waiting heartbeat from active turn activity age", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-10T05:00:00.000Z"));
      try {
        let resolveStarted!: () => void;
        let resolveActive!: (value: AgentResult) => void;
        let capturedEventSink: { emit(event: unknown): Promise<void> | void } | undefined;
        const started = new Promise<void>((resolve) => {
          resolveStarted = resolve;
        });
        const chatAgentLoopRunner = {
          execute: vi.fn().mockImplementation((input: {
            eventSink?: { emit(event: unknown): Promise<void> | void };
          }) => {
            capturedEventSink = input.eventSink;
            resolveStarted();
            return new Promise<AgentResult>((resolve) => {
              resolveActive = resolve;
            });
          }),
        } as unknown as ChatAgentLoopRunner;
        const events: ChatEvent[] = [];
        const runner = new ChatRunner(makeDeps({
          stateManager: makeMockStateManager(),
          chatAgentLoopRunner,
          onEvent: (event) => {
            events.push(event);
          },
        }));
        runner.startSession("/repo");

        const active = runner.execute("Implement a feature", "/repo");
        await started;

        expect(events.filter((event) => event.type === "presence_update").map((event) => event.presence.phase))
          .not.toContain("waiting");

        await vi.advanceTimersByTimeAsync(30_000);

        const waiting = events
          .filter((event): event is Extract<ChatEvent, { type: "presence_update" }> =>
            event.type === "presence_update" && event.presence.phase === "waiting"
          )
          .at(-1);
        expect(waiting?.presence).toMatchObject({
          phase: "waiting",
          importance: "status",
          expected_next: "progress",
          last_activity_at: "2026-05-10T05:00:00.000Z",
          last_activity_label: "Taking action",
        });
        expect(runner.getActiveSeedyTurnStatus()).toMatchObject({
          active: true,
          phase: "waiting",
          waiting: true,
          elapsed_since_last_activity_ms: 30_000,
        });
        expect(runner.formatActiveSeedyTurnStatus())
          .toBe("I'm still checking this. I don't have a more specific visible update yet.");

        await capturedEventSink?.emit({
          type: "tool_call_started",
          eventId: "tool-event-1",
          sessionId: "agent-session-1",
          traceId: "trace-1",
          turnId: "agent-turn-1",
          goalId: "goal-1",
          createdAt: new Date().toISOString(),
          callId: "tool-call-1",
          toolName: "read_file",
          inputPreview: "{}",
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(events
          .filter((event): event is Extract<ChatEvent, { type: "presence_update" }> =>
            event.type === "presence_update"
          )
          .at(-1)?.presence).toMatchObject({
            phase: "acting",
            expected_next: "progress",
          });
        expect(runner.getActiveSeedyTurnStatus()).toMatchObject({
          active: true,
          phase: "acting",
          waiting: false,
        });

        resolveActive({
          success: true,
          output: "done",
          error: null,
          exit_code: 0,
          elapsed_ms: 30_000,
          stopped_reason: "completed",
        });
        await active;
        expect(runner.getActiveSeedyTurnStatus()).toMatchObject({ active: false });
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears waiting heartbeat timers for fast turns", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-10T05:00:00.000Z"));
      try {
        const events: ChatEvent[] = [];
        const runner = new ChatRunner(makeDeps({
          stateManager: makeMockStateManager(),
          adapter: makeMockAdapter({
            success: true,
            output: "Fast result",
            error: null,
            exit_code: 0,
            elapsed_ms: 5,
            stopped_reason: "completed",
          }),
          onEvent: (event) => {
            events.push(event);
          },
        }));
        runner.startSession("/repo");

        await runner.execute("quick task", "/repo", 30_000, { selectedRoute: adapterRoute() });
        await vi.advanceTimersByTimeAsync(60_000);

        expect(events.filter((event) => event.type === "presence_update").map((event) => event.presence.phase))
          .not.toContain("waiting");
        expect(runner.getActiveSeedyTurnStatus()).toMatchObject({ active: false });
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses structured interrupt intent classification for multilingual diff redirects", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-interrupt-diff-"));
      try {
        execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
        fs.writeFileSync(path.join(tmpDir, "changed.txt"), "hello\n");
        const interruptible = makeInterruptibleAgentLoopRunner();
        const runner = new ChatRunner(makeDeps({
          stateManager: makeMockStateManager(),
          chatAgentLoopRunner: interruptible.runner,
          llmClient: createMockLLMClient([interruptDecision("diff")]),
        }));
        runner.startSession(tmpDir);

        const active = runner.execute("Implement a feature", tmpDir);
        await vi.waitFor(() => expect(interruptible.runner.execute).toHaveBeenCalledOnce(), { timeout: 5_000 });

        const interrupted = await runner.interruptAndRedirect("変更点を見せてから止めて", tmpDir);

        expect(interruptible.getSignal()?.aborted).toBe(true);
        expect(interrupted.output).toContain("Current diff is shown above");
        await active;
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("uses structured interrupt intent classification for multilingual review redirects", async () => {
      const interruptible = makeInterruptibleAgentLoopRunner();
      const reviewAgentLoopRunner = {
        execute: vi.fn(async () => ({ success: true, output: "read-only review result", review: null })),
      };
      const runner = new ChatRunner(makeDeps({
        stateManager: makeMockStateManager(),
        chatAgentLoopRunner: interruptible.runner,
        reviewAgentLoopRunner,
        llmClient: createMockLLMClient([interruptDecision("review")]),
      }));
      runner.startSession("/repo");

      const active = runner.execute("Implement a feature", "/repo");
      await vi.waitFor(() => expect(interruptible.runner.execute).toHaveBeenCalledOnce(), { timeout: 5_000 });

      const interrupted = await runner.interruptAndRedirect("passe en revue sans modifier", "/repo");

      expect(interruptible.getSignal()?.aborted).toBe(true);
      expect(reviewAgentLoopRunner.execute).toHaveBeenCalledOnce();
      expect(interrupted.output).toContain("review-only mode");
      expect(interrupted.output).toContain("read-only review result");
      await active;
    });

    it("uses structured interrupt intent classification for multilingual summary redirects", async () => {
      const interruptible = makeInterruptibleAgentLoopRunner();
      const runner = new ChatRunner(makeDeps({
        stateManager: makeMockStateManager(),
        chatAgentLoopRunner: interruptible.runner,
        llmClient: createMockLLMClient([interruptDecision("summary")]),
      }));
      runner.startSession("/repo");

      const active = runner.execute("Implement a feature", "/repo");
      await vi.waitFor(() => expect(interruptible.runner.execute).toHaveBeenCalledOnce(), { timeout: 5_000 });

      const interrupted = await runner.interruptAndRedirect("bitte kurz zusammenfassen und stoppen", "/repo");

      expect(interruptible.getSignal()?.aborted).toBe(true);
      expect(interrupted.output).toContain("Interrupted the active turn");
      expect(interrupted.output).toContain("Activity before interruption");
      await active;
    });

    it("falls back to safe summary interruption for ambiguous interrupt text without keyword fallback", async () => {
      const interruptible = makeInterruptibleAgentLoopRunner();
      const runner = new ChatRunner(makeDeps({
        stateManager: makeMockStateManager(),
        chatAgentLoopRunner: interruptible.runner,
        llmClient: createMockLLMClient([interruptDecision("unknown", 0.3)]),
      }));
      runner.startSession("/repo");

      const active = runner.execute("Implement a feature", "/repo");
      await vi.waitFor(() => expect(interruptible.runner.execute).toHaveBeenCalledOnce(), { timeout: 5_000 });

      const interrupted = await runner.interruptAndRedirect("looks good maybe", "/repo");

      expect(interruptible.getSignal()?.aborted).toBe(true);
      expect(interrupted.output).toContain("Interrupted the active turn");
      expect(interrupted.output).not.toContain("background is not available yet");
      await active;
    });

    it("does not apply stale interrupt classification after the active turn finishes", async () => {
      let releaseClassification!: () => void;
      let sendMessageCount = 0;
      const llmClient = {
        sendMessage: vi.fn(async () => {
          sendMessageCount += 1;
          if (sendMessageCount === 1) {
            await new Promise<void>((resolve) => {
              releaseClassification = resolve;
            });
            return {
              content: interruptDecision("diff"),
              usage: { input_tokens: 1, output_tokens: 1 },
              stop_reason: "end_turn" as const,
            };
          }
          return {
            content: unusedModelDecision(),
            usage: { input_tokens: 1, output_tokens: 1 },
            stop_reason: "end_turn" as const,
          };
        }),
        parseJSON: createSingleMockLLMClient(interruptDecision("diff")).parseJSON,
      };
      let finishActive!: () => void;
      const chatAgentLoopRunner = {
        execute: vi.fn()
          .mockImplementationOnce(() => new Promise<AgentResult>((resolve) => {
            finishActive = () => resolve(CANNED_RESULT);
          }))
          .mockResolvedValueOnce({
            success: true,
            output: "fresh request executed",
            error: null,
            exit_code: 0,
            elapsed_ms: 5,
            stopped_reason: "completed",
          } satisfies AgentResult),
      } as unknown as ChatAgentLoopRunner;
      const runner = new ChatRunner(makeDeps({
        stateManager: makeMockStateManager(),
        chatAgentLoopRunner,
        llmClient: llmClient as never,
      }));
      runner.startSession("/repo");

      const active = runner.execute("Implement a feature", "/repo");
      await vi.waitFor(() => expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce());
      const redirected = runner.interruptAndRedirect("muéstrame los cambios", "/repo");
      await vi.waitFor(() => expect(llmClient.sendMessage).toHaveBeenCalledOnce());
      finishActive();
      await active;
      releaseClassification();

      await expect(redirected).resolves.toMatchObject({
        success: true,
        output: "fresh request executed",
      });
      expect(chatAgentLoopRunner.execute).toHaveBeenCalledTimes(2);
    });

    it("grounds native chat agentloop through systemPrompt instead of injecting workspace context into the message", async () => {
      const adapter = makeMockAdapter();
      const stateManager = {
        ...makeMockStateManager(),
        listGoalIds: vi.fn().mockResolvedValue([]),
        loadGoal: vi.fn().mockResolvedValue(null),
      } as unknown as StateManager;
      const chatAgentLoopRunner = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: "Agentloop answer",
          error: null,
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "completed",
        }),
      } as unknown as ChatAgentLoopRunner;

      const runner = new ChatRunner(makeDeps({ adapter, stateManager, chatAgentLoopRunner }));
      await runner.execute("Inspect the repo layout", "/repo");

      const input = vi.mocked(chatAgentLoopRunner.execute).mock.calls[0]?.[0] as {
        message: string;
        systemPrompt?: string;
      };
      expect(input.message).toBe("Inspect the repo layout");
      expect(input.message).not.toContain("Working directory: /repo");
      expect(input.systemPrompt).toContain("## Workspace Facts");
      expect(input.systemPrompt).toContain("Working directory: /repo");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("surfaces native agentloop failures through the chat path", async () => {
      const adapter = makeMockAdapter();
      const chatAgentLoopRunner = {
        execute: vi.fn().mockResolvedValue({
          success: false,
          output: "Agent loop stopped: model request timed out. Narrow broad repo-wide searches or increase `codex_timeout_ms` if this workload is expected.",
          error: "LLM timeout while waiting for the provider response",
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "timeout",
        }),
      } as unknown as ChatAgentLoopRunner;

      const runner = new ChatRunner(makeDeps({ adapter, chatAgentLoopRunner }));
      const result = await runner.execute("Please inspect the repo and report the issue.", "/repo");

      expect(result.success).toBe(false);
      expect(result.output).toContain("timed out");
      expect(result.output).toContain("codex_timeout_ms");
      expect(result.output).not.toContain("[interrupted:");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("passes compacted chat summary to native chat agentloop", async () => {
      const adapter = makeMockAdapter();
      const chatAgentLoopRunner = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: "Agentloop response",
          error: null,
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "completed",
        }),
      } as unknown as ChatAgentLoopRunner;
      const runner = new ChatRunner(makeDeps({ adapter, chatAgentLoopRunner }));
      runner.startSession("/repo");

      await runner.execute("Turn 1", "/repo");
      await runner.execute("Turn 2", "/repo");
      await runner.execute("Turn 3", "/repo");
      await runner.execute("/compact", "/repo");
      await runner.execute("Continue", "/repo");

      const finalInput = (chatAgentLoopRunner.execute as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
        message: string;
        systemPrompt?: string;
      };
      expect(finalInput.message).toContain("Continue");
      expect(finalInput.systemPrompt).toContain("Compacted Chat Summary");
      expect(finalInput.systemPrompt).toContain("Task completed successfully.");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("keeps internal route details out of the user-facing output", async () => {
      const adapter = makeMockAdapter();
      const llmClient = {
        sendMessage: vi.fn().mockResolvedValue({
          content: "Plain answer",
          usage: { input_tokens: 2, output_tokens: 3 },
          stop_reason: "end_turn",
        }),
        parseJSON: vi.fn(),
      };

      const runner = new ChatRunner(makeDeps({ adapter, llmClient: llmClient as never }));
      const result = await runner.execute("How should the tool route behave?", "/repo");

      expect(result.output).toBe("Plain answer");
      expect(result.output).not.toContain("tool_loop");
    });

    it("answers Japanese self-identity questions through model-grounded chat instead of host phrase matching", async () => {
      const pulseedHome = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-identity-"));
      const previousHome = process.env["PULSEED_HOME"];
      process.env["PULSEED_HOME"] = pulseedHome;
      clearIdentityCache();
      fs.writeFileSync(path.join(pulseedHome, "SEED.md"), "# Sprout\n\nCustom identity.\n", "utf-8");
      const adapter = makeMockAdapter();
      const llmClient = createMockLLMClient([
        "Sprout is the configured PulSeed identity.",
      ]);

      try {
        const sendSpy = vi.spyOn(llmClient, "sendMessage");
        const runner = new ChatRunner(makeDeps({ adapter, llmClient }));
        const result = await runner.execute("あなたは誰？", "/repo");

        expect(result.success).toBe(true);
        expect(result.output).toContain("Sprout");
        expect(result.output).toContain("PulSeed");
        expect(sendSpy).toHaveBeenCalledOnce();
        const assistOptions = sendSpy.mock.calls[0]?.[1] as { system?: string } | undefined;
        expect(assistOptions?.system).toContain("Sprout");
        expect(assistOptions?.system).toContain("configured agent identity running PulSeed");
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        if (previousHome === undefined) {
          delete process.env["PULSEED_HOME"];
        } else {
          process.env["PULSEED_HOME"] = previousHome;
        }
        clearIdentityCache();
        fs.rmSync(pulseedHome, { recursive: true, force: true });
      }
    });

    it("grounds self-identity chat from the ChatRunner stateManager base dir", async () => {
      const pulseedHome = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-identity-"));
      const previousHome = process.env["PULSEED_HOME"];
      delete process.env["PULSEED_HOME"];
      clearIdentityCache();
      fs.writeFileSync(path.join(pulseedHome, "SEED.md"), "# BaseDirSeed\n\nCustom identity.\n", "utf-8");
      const stateManager = {
        ...makeMockStateManager(),
        getBaseDir: () => pulseedHome,
      } as unknown as StateManager;
      const adapter = makeMockAdapter();
      const llmClient = createMockLLMClient([
        "BaseDirSeed is the configured PulSeed identity.",
      ]);

      try {
        const sendSpy = vi.spyOn(llmClient, "sendMessage");
        const runner = new ChatRunner(makeDeps({ adapter, stateManager, llmClient }));
        const result = await runner.execute("あなたは誰？", "/repo");

        expect(result.success).toBe(true);
        expect(result.output).toContain("BaseDirSeed");
        expect(result.output).toContain("PulSeed");
        expect(sendSpy).toHaveBeenCalledOnce();
        const assistOptions = sendSpy.mock.calls[0]?.[1] as { system?: string } | undefined;
        expect(assistOptions?.system).toContain("BaseDirSeed");
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        if (previousHome === undefined) {
          delete process.env["PULSEED_HOME"];
        } else {
          process.env["PULSEED_HOME"] = previousHome;
        }
        clearIdentityCache();
        fs.rmSync(pulseedHome, { recursive: true, force: true });
      }
    });

    it("builds tool-loop static grounding from the ChatRunner stateManager base dir", async () => {
      const pulseedHome = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-identity-"));
      const previousHome = process.env["PULSEED_HOME"];
      delete process.env["PULSEED_HOME"];
      clearIdentityCache();
      fs.writeFileSync(path.join(pulseedHome, "SEED.md"), "# StaticPromptSeed\n\nCustom identity.\n", "utf-8");
      const stateManager = {
        ...makeMockStateManager(),
        getBaseDir: () => pulseedHome,
      } as unknown as StateManager;
      const adapter = makeMockAdapter();
      const llmClient = {
        sendMessage: vi.fn().mockResolvedValue({
          content: "Plain answer",
          usage: { input_tokens: 2, output_tokens: 3 },
          stop_reason: "end_turn",
        }),
        parseJSON: vi.fn(),
      };
      const events: ChatEvent[] = [];

      try {
        const runner = new ChatRunner(makeDeps({
          adapter,
          stateManager,
          llmClient: llmClient as never,
          onEvent: (event) => { events.push(event); },
        }));
        const result = await runner.execute("What is this route?", "/repo");

        expect(result.success).toBe(true);
        expect(result.output).toBe("Plain answer");
        expect(llmClient.sendMessage).toHaveBeenCalledOnce();
        const modelIndex = events.findIndex((event) =>
          event.type === "activity" && event.sourceId === "lifecycle:model"
        );
        expect(events.some((event) =>
          event.type === "activity" && event.presentation?.gatewayNarration?.audience === "user"
        )).toBe(false);
        expect(modelIndex).toBeGreaterThanOrEqual(0);
        const options = llmClient.sendMessage.mock.calls[0]?.[1] as { system?: string } | undefined;
        expect(options?.system).toContain("StaticPromptSeed");
        expect(options?.system).toContain("configured agent identity running PulSeed");
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        if (previousHome === undefined) {
          delete process.env["PULSEED_HOME"];
        } else {
          process.env["PULSEED_HOME"] = previousHome;
        }
        clearIdentityCache();
        fs.rmSync(pulseedHome, { recursive: true, force: true });
      }
    });

    it("routes natural TUI ingress through the production selector", async () => {
      const adapter = makeMockAdapter({
        success: false,
        output: "",
        error: "adapter path must not be called",
        exit_code: 1,
        elapsed_ms: 1,
        stopped_reason: "error",
      });
      const llmClient = {
        sendMessage: vi.fn().mockResolvedValue({
          content: "TUI answer",
          usage: { input_tokens: 2, output_tokens: 3 },
          stop_reason: "end_turn",
        }),
        parseJSON: vi.fn(),
      };

      const manager = new CrossPlatformChatSessionManager(makeDeps({ adapter, llmClient: llmClient as never }));
      const result = await manager.execute("What is this route?", {
        channel: "tui",
        platform: "local_tui",
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
        },
        cwd: "/repo",
        timeoutMs: 120_000,
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe("TUI answer");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("requires selectedRoute when executeIngressMessage is called directly", async () => {
      const runner = new ChatRunner(makeDeps({}));

      await expect(
        (runner.executeIngressMessage as any)({
          text: "PulSeed を再起動して",
          channel: "tui",
          platform: "local_tui",
          actor: {
            surface: "tui",
            platform: "local_tui",
          },
          replyTarget: {
            surface: "tui",
            platform: "local_tui",
            metadata: {},
          },
          runtimeControl: {
            allowed: false,
            approvalMode: "disallowed",
          },
          metadata: {},
        }, "/repo")
      ).rejects.toThrow("executeIngressMessage requires selectedRoute");
    });

    it("supports routed ingress execution with explicit route", async () => {
      const chatAgentLoopRunner = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: "Agentloop from explicit route",
          error: null,
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "completed",
        }),
      } as unknown as ChatAgentLoopRunner;
      const runner = new ChatRunner(makeDeps({ chatAgentLoopRunner }));

      const result = await runner.executeIngressMessage({
        text: "PulSeed を再起動して",
        userInput: createTextUserInput("PulSeed を再起動して"),
        channel: "tui",
        platform: "local_tui",
        actor: {
          surface: "tui",
          platform: "local_tui",
        },
        replyTarget: {
          surface: "tui",
          platform: "local_tui",
          metadata: {},
        },
        runtimeControl: {
          allowed: false,
          approvalMode: "disallowed",
        },
        metadata: {},
      }, "/repo", 120_000, {
        kind: "agent_loop",
        reason: "agent_loop_available",
        replyTargetPolicy: "turn_reply_target",
        eventProjectionPolicy: "turn_only",
        concurrencyPolicy: "session_serial",
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe("Agentloop from explicit route");
      expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce();
    });

    it("does not route repository confirmation questions through the direct path", async () => {
      const adapter = makeMockAdapter();
      const chatAgentLoopRunner = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: "Agentloop checked it",
          error: null,
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "completed",
        }),
      } as unknown as ChatAgentLoopRunner;
      const llmClient = {
        supportsToolCalling: () => true,
        sendMessage: vi.fn().mockResolvedValue({
          content: JSON.stringify({ kind: "execute", confidence: 0.91, rationale: "needs repository inspection" }),
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
        }),
        parseJSON: vi.fn((content: string, schema: z.ZodType) => schema.parse(JSON.parse(content))),
      };

      const runner = new ChatRunner(makeDeps({
        adapter,
        chatAgentLoopRunner,
        llmClient: llmClient as never,
      }));
      const result = await runner.execute("What files changed?", "/repo");

      expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce();
      expect(llmClient.sendMessage).not.toHaveBeenCalled();
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.output).toBe("Agentloop checked it");
    });

    it("does not route explicit confirmation requests through the direct path", async () => {
      const adapter = makeMockAdapter();
      const chatAgentLoopRunner = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: "Confirmed with tools",
          error: null,
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "completed",
        }),
      } as unknown as ChatAgentLoopRunner;
      const llmClient = {
        supportsToolCalling: () => true,
        sendMessage: vi.fn().mockResolvedValue({
          content: JSON.stringify({ kind: "execute", confidence: 0.9, rationale: "requires verification" }),
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
        }),
        parseJSON: vi.fn((content: string, schema: z.ZodType) => schema.parse(JSON.parse(content))),
      };

      const runner = new ChatRunner(makeDeps({
        adapter,
        chatAgentLoopRunner,
        llmClient: llmClient as never,
      }));
      const result = await runner.execute("Can you confirm whether this is safe?", "/repo");

      expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce();
      expect(llmClient.sendMessage).not.toHaveBeenCalled();
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.output).toBe("Confirmed with tools");
    });

    it("routes Japanese Telegram setup requests to typed guidance before agent-loop execution", async () => {
      const events: ChatEvent[] = [];
      const stateManager = makeMockStateManager();
      const chatAgentLoopRunner = {
        execute: vi.fn().mockImplementation(async (input: { toolCallContext?: ToolCallContext }) => {
          const guidanceTool = createSetupRuntimeControlTools({
            stateManager,
            gatewaySetupStatusProvider: makeTelegramStatusProvider(makeTelegramSetupStatus()),
          }).find((tool) => tool.metadata.name === "prepare_gateway_setup_guidance")!;
          const result = await guidanceTool.call({
            channel: "telegram",
            request: "telegram繋げたい",
            language: "ja",
          }, input.toolCallContext!);
          return {
            success: result.success,
            output: result.summary,
            error: null,
            exit_code: null,
            elapsed_ms: 1,
            stopped_reason: "completed",
          };
        }),
      } as unknown as ChatAgentLoopRunner;
      const runner = new ChatRunner(makeDeps({
        stateManager,
        chatAgentLoopRunner,
        llmClient: createMockLLMClient([]),
        onEvent: (event) => { events.push(event); },
      }));

      const result = await runner.execute("telegram繋げたい", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("Telegram gateway status");
      expect(result.output).toContain("pulseed daemon status");
      expect(result.output).toContain("If you prefer chat-assisted setup");
      expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce();
      expect(events.some((event) =>
        event.type === "activity" && event.presentation?.gatewayNarration?.audience === "user"
      )).toBe(false);
      expect(events.map((event) => event.type === "activity" ? event.message : "").join("\n"))
        .not.toContain("このリクエスト");
      expect(JSON.stringify(events)).not.toContain("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi");
    });

    it("routes English Telegram setup paraphrases to guidance before agent-loop execution", async () => {
      const stateManager = makeMockStateManager();
      const chatAgentLoopRunner = {
        execute: vi.fn().mockImplementation(async (input: { toolCallContext?: ToolCallContext }) => {
          const guidanceTool = createSetupRuntimeControlTools({
            stateManager,
            gatewaySetupStatusProvider: makeTelegramStatusProvider(makeTelegramSetupStatus()),
          }).find((tool) => tool.metadata.name === "prepare_gateway_setup_guidance")!;
          const result = await guidanceTool.call({
            channel: "telegram",
            request: "I want to talk to Seedy from Telegram.",
            language: "en",
          }, input.toolCallContext!);
          return {
            success: result.success,
            output: result.summary,
            error: null,
            exit_code: null,
            elapsed_ms: 1,
            stopped_reason: "completed",
          };
        }),
      } as unknown as ChatAgentLoopRunner;
      const runner = new ChatRunner(makeDeps({
        stateManager,
        chatAgentLoopRunner,
        llmClient: createMockLLMClient([]),
      }));

      const result = await runner.execute("I want to talk to Seedy from Telegram.", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("Telegram gateway status");
      expect(result.output).toContain("pulseed daemon status");
      expect(result.output).toContain("If you prefer chat-assisted setup");
      expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce();
    });

    it("asks for clarification on ambiguous freeform input instead of editing code", async () => {
      const events: ChatEvent[] = [];
      const chatAgentLoopRunner = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: "Please give me one more detail.",
          error: null,
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "completed",
        }),
      } as unknown as ChatAgentLoopRunner;
      const runner = new ChatRunner(makeDeps({
        chatAgentLoopRunner,
        llmClient: createMockLLMClient([]),
        onEvent: (event) => { events.push(event); },
      }));

      const result = await runner.execute("いい感じにして", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("one more detail");
      expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce();
      expect(events.some((event) =>
        event.type === "activity" && event.presentation?.gatewayNarration?.audience === "user"
      )).toBe(false);
      expect(events.map((event) => event.type === "activity" ? event.message : "").join("\n"))
        .not.toContain("resume the saved agent loop state");
    });

    it("continues explicit implementation requests into the coding agent-loop", async () => {
      const events: ChatEvent[] = [];
      const chatAgentLoopRunner = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: "Implementation done",
          error: null,
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "completed",
        }),
      } as unknown as ChatAgentLoopRunner;
      const llmClient = createMockLLMClient([
        JSON.stringify({
          kind: "execute",
          confidence: 0.96,
          rationale: "explicit code implementation request",
        }),
      ]);
      const runner = new ChatRunner(makeDeps({
        chatAgentLoopRunner,
        llmClient,
        onEvent: (event) => { events.push(event); },
      }));

      const result = await runner.execute("Implement the failing tests fix in this repo.", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toBe("Implementation done");
      expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce();
      expect(events.some((event) =>
        event.type === "activity" && event.presentation?.gatewayNarration?.audience === "user"
      )).toBe(false);
    });

    it("routes direct assist without agent-loop resume intent copy", async () => {
      const events: ChatEvent[] = [];
      const llmClient = createMockLLMClient([
      ]);
      const chatAgentLoopRunner = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: "Here is the explanation.",
          error: null,
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "completed",
        }),
      } as unknown as ChatAgentLoopRunner;
      const runner = new ChatRunner(makeDeps({
        chatAgentLoopRunner,
        llmClient,
        onEvent: (event) => { events.push(event); },
      }));

      const result = await runner.execute("Explain how this works.", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toBe("Here is the explanation.");
      expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce();
      expect(events.some((event) =>
        event.type === "activity" && event.presentation?.gatewayNarration?.audience === "user"
      )).toBe(false);
      expect(events.map((event) => event.type === "activity" ? event.message : "").join("\n"))
        .not.toContain("resume the saved agent loop state");
    });

    it("keeps non-native-tool clients on the local LLM/tool loop instead of the adapter fallback", async () => {
      const adapter = makeMockAdapter();
      const readTool = {
        metadata: {
          name: "read",
          aliases: [],
          permissionLevel: "read_only" as const,
          isReadOnly: true,
          isDestructive: false,
          shouldDefer: false,
          alwaysLoad: false,
          maxConcurrency: 0,
          maxOutputChars: 1000,
          tags: ["test"],
        },
        inputSchema: z.object({}),
        description: () => "Read a file.",
        checkPermissions: vi.fn().mockResolvedValue({ status: "allowed" }),
        call: vi.fn().mockResolvedValue({ success: true, summary: "read README", data: { content: "hello" } }),
        isConcurrencySafe: () => true,
      };
      const registry = {
        listAll: () => [readTool],
        get: (name: string) => name === "read" ? readTool : undefined,
      };
      const llmClient = {
        supportsToolCalling: () => false,
        sendMessage: vi.fn()
          .mockResolvedValueOnce({
            content: '{ "tool_calls": [{ "name": "read", "input": {} }] }',
            usage: { input_tokens: 5, output_tokens: 5 },
            stop_reason: "end_turn",
          })
          .mockResolvedValueOnce({
            content: "Prompted loop response",
            usage: { input_tokens: 5, output_tokens: 5 },
            stop_reason: "end_turn",
          }),
        parseJSON: vi.fn(),
      };

      const runner = new ChatRunner(makeDeps({ adapter, llmClient: llmClient as never, registry: registry as never }));
      const result = await runner.execute("Do something", "/repo");

      expect(llmClient.sendMessage).toHaveBeenCalledTimes(2);
      expect(readTool.call).toHaveBeenCalledOnce();
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.output).toBe("Prompted loop response");
    });

    it("routes to executeWithTools (calls sendMessage) when supportsToolCalling is absent", async () => {
      const adapter = makeMockAdapter();
      const llmClient = {
        // no supportsToolCalling method
        sendMessage: vi.fn().mockResolvedValue({
          content: "Tool-aware response",
          usage: { input_tokens: 5, output_tokens: 5 },
          stop_reason: "end_turn",
        }),
        parseJSON: vi.fn(),
      };

      const runner = new ChatRunner(makeDeps({ adapter, llmClient: llmClient as never }));
      const result = await runner.execute("Do something", "/repo");

      expect(llmClient.sendMessage).toHaveBeenCalled();
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.output).toBe("Tool-aware response");
    });
  });

  describe("RunSpec gateway direct-loop boundaries", () => {
    it("keeps gateway RunSpec text on the default model loop instead of precomputing a draft route", async () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-gateway-runspec-"));
      const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
      const llmClient = createSingleMockLLMClient("Default loop will use tools when a RunSpec handoff is needed.");
      const runner = new ChatRunner(makeDeps({
        stateManager,
        llmClient,
      }));
      const ingress = {
        ...makeIngress("Please keep improving this Kaggle run until score exceeds 0.98."),
        cwd: "/repo/kaggle",
        runtimeControl: { allowed: true, approvalMode: "interactive" as const },
        metadata: { routed_goal_id: "goal-current", gateway_message: true },
        replyTarget: {
          ...makeIngress("").replyTarget,
          response_channel: "telegram-chat-1",
          metadata: { gateway_message: true },
        },
      };

      const selectedRoute = await (runner as unknown as {
        resolveRouteFromIngress(message: ChatIngressMessage): Promise<SelectedChatRoute>;
      }).resolveRouteFromIngress(ingress);
      expect(selectedRoute.kind).toBe("gateway_model_loop");
      const result = await runner.executeIngressMessage(ingress, "/repo/kaggle", 120_000, selectedRoute);

      expect(result.success).toBe(true);
      expect(result.output).toBe("Default loop will use tools when a RunSpec handoff is needed.");
      await expect(storedRunSpecs(baseDir)).resolves.toHaveLength(0);
    });

    it("preserves gateway reply target metadata when AgentLoop drafts RunSpec through a model-visible tool", async () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-gateway-runspec-tool-"));
      const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
      const llmClient = createMockLLMClient([
        JSON.stringify({ kind: "none", confidence: 0.94, rationale: "This is new work, not recovery." }),
        runSpecDraftDecision({
          objective: "Continue Kaggle optimization until score exceeds 0.98",
        }),
      ]);
      const chatAgentLoopRunner = {
        execute: vi.fn().mockImplementation(async (input: { toolCallContext?: ToolCallContext }) => {
          const [draftTool] = createRunSpecHandoffTools({
            stateManager,
            llmClient,
            daemonClient: { startGoal: vi.fn() } as never,
          });
          const toolResult = await draftTool.call({
            request: "DurableloopのほうでKaggleのタスクに取り組んで",
          }, input.toolCallContext!);
          return {
            success: toolResult.success,
            output: toolResult.summary,
            error: null,
            exit_code: null,
            elapsed_ms: 1,
            stopped_reason: "completed",
          };
        }),
      } as unknown as ChatAgentLoopRunner;
      const runner = new ChatRunner(makeDeps({
        stateManager,
        llmClient,
        chatAgentLoopRunner,
      }));
      const ingress = {
        ...makeIngress("DurableloopのほうでKaggleのタスクに取り組んで"),
        cwd: "/repo/kaggle",
        runtimeControl: { allowed: true, approvalMode: "interactive" as const },
        replyTarget: {
          ...makeIngress("").replyTarget,
          response_channel: "telegram-chat-1",
          metadata: { gateway_message: true },
        },
      };
      const selectedRoute: SelectedChatRoute = {
        kind: "agent_loop",
        reason: "agent_loop_available",
        replyTargetPolicy: "turn_reply_target",
        eventProjectionPolicy: "turn_only",
        concurrencyPolicy: "session_serial",
      };

      const result = await runner.executeIngressMessage(ingress, "/repo/kaggle", 120_000, selectedRoute);

      expect(result.success).toBe(true);
      expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce();
      const stored = await onlyStoredRunSpec(baseDir);
      expect(stored.origin.channel).toBe("agent_loop");
      expect(stored.origin.reply_target).toMatchObject({
        conversation_id: "chat-1",
        response_channel: "telegram-chat-1",
      });
      const session = await new ChatSessionCatalog(stateManager).loadSession(runner.getSessionId()!);
      expect(session?.runSpecConfirmation).toMatchObject({
        state: "pending",
        spec: { id: stored.id },
      });
    });

  });

  describe("setup and runtime-control AgentLoop tools", () => {
    it("routes natural-language runtime session inspection through the chat AgentLoop path", async () => {
      const chatAgentLoopRunner = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: "I inspected the background sessions with sessions_list.",
          error: null,
          exit_code: null,
          elapsed_ms: 1,
          stopped_reason: "completed",
        }),
      } as unknown as ChatAgentLoopRunner;
      const runner = new ChatRunner(makeDeps({
        chatAgentLoopRunner,
        llmClient: createMockLLMClient([]),
      }));

      const result = await runner.execute("Can you inspect the background sessions from this chat?", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("sessions_list");
      expect(chatAgentLoopRunner.execute).toHaveBeenCalledWith(expect.objectContaining({
        message: "Can you inspect the background sessions from this chat?",
        toolCallContext: expect.objectContaining({
          conversationSessionId: expect.any(String),
        }),
      }));
    });

    it("lets AgentLoop produce Telegram setup guidance without host-side configure routing", async () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-agentloop-setup-tool-"));
      const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
      const gatewaySetupStatusProvider = makeTelegramStatusProvider(makeTelegramSetupStatus({
        state: "unconfigured",
        daemon: { running: false, port: 41700 },
        config: { exists: false, hasBotToken: false, hasHomeChat: false },
      }));
      const llmClient = createMockLLMClient([]);
      const chatAgentLoopRunner = {
        execute: vi.fn().mockImplementation(async (input: { message: string; toolCallContext?: ToolCallContext }) => {
          const guidanceTool = createSetupRuntimeControlTools({
            stateManager,
            gatewaySetupStatusProvider,
          }).find((tool) => tool.metadata.name === "prepare_gateway_setup_guidance")!;
          const toolResult = await guidanceTool.call({
            channel: "telegram",
            request: input.message,
            language: "ja",
          }, input.toolCallContext!);
          return {
            success: toolResult.success,
            output: toolResult.summary,
            error: null,
            exit_code: null,
            elapsed_ms: 1,
            stopped_reason: "completed",
          };
        }),
      } as unknown as ChatAgentLoopRunner;
      const runner = new ChatRunner(makeDeps({
        stateManager,
        llmClient,
        chatAgentLoopRunner,
        gatewaySetupStatusProvider,
      }));
      const selectedRoute: SelectedChatRoute = {
        kind: "agent_loop",
        reason: "agent_loop_available",
        replyTargetPolicy: "turn_reply_target",
        eventProjectionPolicy: "turn_only",
        concurrencyPolicy: "session_serial",
      };

      const result = await runner.executeIngressMessage(
        makeIngress("telegramからseedyと会話できるようにしたい"),
        "/repo",
        120_000,
        selectedRoute,
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("Telegram gateway status");
      expect(result.output).toContain("pulseed telegram setup");
      expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce();
    });

    it("keeps setup secrets redacted before AgentLoop while tools can prepare protected writes", async () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-agentloop-setup-secret-tool-"));
      const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
      const rawToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
      const gatewaySetupStatusProvider = makeTelegramStatusProvider(makeTelegramSetupStatus({
        state: "unconfigured",
        config: { exists: false, hasBotToken: false, hasHomeChat: false },
      }));
      const llmClient = createMockLLMClient([]);
      let pendingAfterTool: unknown = null;
      const chatAgentLoopRunner = {
        execute: vi.fn().mockImplementation(async (input: { message: string; toolCallContext?: ToolCallContext }) => {
          expect(input.message).not.toContain(rawToken);
          expect(input.message).toContain("[REDACTED:telegram_bot_token:setup_secret_1]");
          const prepareTool = createSetupRuntimeControlTools({
            stateManager,
            gatewaySetupStatusProvider,
          }).find((tool) => tool.metadata.name === "prepare_gateway_config_write")!;
          const toolResult = await prepareTool.call({ channel: "telegram" }, input.toolCallContext!);
          pendingAfterTool = await input.toolCallContext!.setupDialogue?.get();
          expect(toolResult.summary).not.toContain(rawToken);
          expect(JSON.stringify(toolResult.data)).not.toContain(rawToken);
          return {
            success: toolResult.success,
            output: toolResult.summary,
            error: null,
            exit_code: null,
            elapsed_ms: 1,
            stopped_reason: "completed",
          };
        }),
      } as unknown as ChatAgentLoopRunner;
      const runner = new ChatRunner(makeDeps({
        stateManager,
        llmClient,
        chatAgentLoopRunner,
        gatewaySetupStatusProvider,
      }));
      const selectedRoute: SelectedChatRoute = {
        kind: "agent_loop",
        reason: "agent_loop_available",
        replyTargetPolicy: "turn_reply_target",
        eventProjectionPolicy: "turn_only",
        concurrencyPolicy: "session_serial",
      };

      const result = await runner.execute(`telegram setup token ${rawToken}`, "/repo", 120_000, { selectedRoute });

      expect(result.success).toBe(true);
      expect(result.output).not.toContain(rawToken);
      expect(pendingAfterTool).toMatchObject({
        publicState: {
          state: "confirm_write",
          pendingSecret: { kind: "telegram_bot_token" },
        },
      });
      const session = await new ChatSessionCatalog(stateManager).loadSession(runner.getSessionId()!);
      expect(JSON.stringify(session)).not.toContain(rawToken);
      expect(session?.setupDialogue).toMatchObject({
        state: "confirm_write",
        pendingSecret: { kind: "telegram_bot_token" },
      });
    });

    it("passes approved runtime-control metadata through the AgentLoop tool path", async () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-agentloop-runtime-tool-"));
      const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
      const runtimeControlService = { request: vi.fn().mockResolvedValue({
        success: true,
        message: "gateway restart requested",
        operationId: "op-runtime",
        state: "approved",
      }) };
      const chatAgentLoopRunner = {
        execute: vi.fn().mockImplementation(async (input: {
          approvalFn?: (request: ApprovalRequest) => Promise<boolean>;
          toolCallContext?: ToolCallContext;
        }) => {
          const approved = await input.approvalFn?.({
            toolName: "request_runtime_control",
            input: { operation: "restart_gateway" },
            reason: "runtime control permission gate",
            permissionLevel: "write_local",
            isDestructive: false,
            reversibility: "reversible",
          });
          expect(approved).toBe(true);
          const runtimeTool = createSetupRuntimeControlTools({
            stateManager,
            runtimeControlService,
          }).find((tool) => tool.metadata.name === "request_runtime_control")!;
          const toolResult = await runtimeTool.call({
            operation: "restart_gateway",
            reason: "operator approved gateway restart",
          }, input.toolCallContext!);
          return {
            success: toolResult.success,
            output: toolResult.summary,
            error: null,
            exit_code: null,
            elapsed_ms: 1,
            stopped_reason: "completed",
          };
        }),
      } as unknown as ChatAgentLoopRunner;
      const runner = new ChatRunner(makeDeps({
        stateManager,
        llmClient: createMockLLMClient([]),
        chatAgentLoopRunner,
        runtimeControlService: runtimeControlService as never,
        approvalFn: vi.fn().mockResolvedValue(false),
      }));
      const ingress = {
        ...makeIngress("gatewayを再起動して"),
        runtimeControl: { allowed: true, approvalMode: "preapproved" as const },
        metadata: { runtime_control_approved: true },
        replyTarget: {
          ...makeIngress("").replyTarget,
          response_channel: "telegram-chat-1",
          metadata: { runtime_control_approved: true },
        },
      };
      const selectedRoute: SelectedChatRoute = {
        kind: "agent_loop",
        reason: "agent_loop_available",
        replyTargetPolicy: "turn_reply_target",
        eventProjectionPolicy: "turn_only",
        concurrencyPolicy: "session_serial",
      };

      const result = await runner.executeIngressMessage(ingress, "/repo", 120_000, selectedRoute);

      expect(result.success).toBe(true);
      expect(runtimeControlService.request).toHaveBeenCalledWith(expect.objectContaining({
        intent: expect.objectContaining({ kind: "restart_gateway" }),
        requestedBy: expect.objectContaining({ surface: "gateway", identity_key: "telegram:user-1" }),
        replyTarget: expect.objectContaining({
          conversation_id: "chat-1",
          response_channel: "telegram-chat-1",
          metadata: { runtime_control_approved: true },
        }),
      }));
    });
  });
});
