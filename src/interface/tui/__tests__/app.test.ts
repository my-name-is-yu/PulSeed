import React, { act } from "react";
import { Writable } from "node:stream";
import { render } from "ink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../../../runtime/daemon/client.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { TuiChatSurface } from "../chat-surface.js";
import { ChatRunner } from "../../chat/chat-runner.js";
import type { AgentResult, IAdapter } from "../../../orchestrator/execution/adapter-layer.js";
import type { ChatAgentLoopRunner } from "../../../orchestrator/execution/agent-loop/chat-agent-loop-runner.js";
import { App, DASHBOARD_REFRESH_INTERVAL_MS, formatDaemonConnectionState } from "../app.js";
import { createMockLLMClient, createSingleMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import type { TelegramSetupStatus } from "../../chat/gateway-setup-status.js";
import { createSetupRuntimeControlTools } from "../../../tools/runtime/SetupRuntimeControlTools.js";
import type { ToolCallContext } from "../../../tools/types.js";
import { ToolExecutor } from "../../../tools/executor.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { ToolPermissionManager } from "../../../tools/permission.js";
import { ConcurrencyController } from "../../../tools/concurrency.js";
import { ShellTool } from "../../../tools/system/ShellTool/ShellTool.js";
import type { ExecutionPolicy } from "../../../orchestrator/execution/agent-loop/execution-policy.js";
import type { Goal } from "../../../base/types/goal.js";
import * as execMod from "../../../base/utils/execFileNoThrow.js";

const testState = vi.hoisted(() => ({
  lastChatProps: null as null | { onSubmit: (value: string) => Promise<void> },
  lastChatMessages: [] as Array<{ role: string; text: string; messageType?: string }>,
  lastDashboardProps: null as null | Record<string, unknown>,
  runtimeSessionSnapshots: [] as Array<Record<string, unknown>>,
  runtimeSessionSnapshotCalls: 0,
  summarizedRunIds: [] as string[],
  runtimeEvidenceSummaries: {} as Record<string, unknown>,
}));

vi.mock("ink", async () => {
  const actual = await vi.importActual<typeof import("ink")>("ink");
  return {
    ...actual,
    useInput: vi.fn(),
    useStdout: () => ({ stdout: { columns: 80, rows: 24 } }),
  };
});

vi.mock("../chat.js", async () => {
  return {
    Chat: (props: Record<string, unknown>) => {
      testState.lastChatProps = props as any;
      testState.lastChatMessages = (props.messages as Array<{ role: string; text: string; messageType?: string }>) ?? [];
      return null;
    },
  };
});

vi.mock("../fullscreen-chat.js", async () => {
  return {
    FullscreenChat: (props: Record<string, unknown>) => {
      testState.lastChatProps = props as any;
      testState.lastChatMessages = (props.messages as Array<{ role: string; text: string; messageType?: string }>) ?? [];
      return null;
    },
  };
});

vi.mock("../dashboard.js", async () => {
  const actual = await vi.importActual<typeof import("../dashboard.js")>("../dashboard.js");
  return {
    ...actual,
    Dashboard: (props: Record<string, unknown>) => {
      testState.lastDashboardProps = props;
      return null;
    },
    statusLabel: (status: string) => status,
  };
});

vi.mock("../../../runtime/session-registry/index.js", () => ({
  createRuntimeSessionRegistry: () => ({
    snapshot: vi.fn(async () => {
      const index = Math.min(
        testState.runtimeSessionSnapshotCalls,
        Math.max(0, testState.runtimeSessionSnapshots.length - 1),
      );
      testState.runtimeSessionSnapshotCalls += 1;
      return testState.runtimeSessionSnapshots[index] ?? null;
    }),
  }),
}));

vi.mock("../../../runtime/store/health-store.js", () => ({
  RuntimeHealthStore: class {
    loadSnapshot = vi.fn(async () => null);
  },
}));

vi.mock("../../../runtime/store/evidence-ledger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../runtime/store/evidence-ledger.js")>();
  return {
    ...actual,
    RuntimeEvidenceLedger: class {
    summarizeRun = vi.fn(async (runId: string) => {
      testState.summarizedRunIds.push(runId);
      return testState.runtimeEvidenceSummaries[runId] ?? null;
    });
    },
  };
});

vi.mock("../help-overlay.js", () => ({ HelpOverlay: () => null }));
vi.mock("../settings-overlay.js", () => ({ SettingsOverlay: () => null }));
vi.mock("../report-view.js", () => ({ ReportView: () => null }));

function createDaemonClientMock() {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    handlers,
    isConnected: vi.fn(() => true),
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
    }),
    off: vi.fn((event: string) => {
      handlers.delete(event);
    }),
    connect: vi.fn(),
    disconnect: vi.fn(),
    startGoal: vi.fn(async () => {}),
    stopGoal: vi.fn(async () => {}),
    chat: vi.fn(async () => {}),
  };
}

function createCapturedStdout(): NodeJS.WriteStream & { readOutput: () => string } {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  }) as NodeJS.WriteStream & { readOutput: () => string };
  stream.columns = 80;
  stream.rows = 24;
  stream.isTTY = true;
  stream.readOutput = () => output;
  return stream;
}

function makeTuiGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-anchor",
    parent_id: null,
    node_type: "goal",
    title: "Improve daily UX",
    description: "",
    status: "active",
    dimensions: [],
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
    loop_status: "running",
    created_at: "2026-05-09T00:00:00.000Z",
    updated_at: "2026-05-09T00:05:00.000Z",
    ...overrides,
  };
}

function createStateManagerMock() {
  return {
    listGoalIds: vi.fn(async () => [] as string[]),
    loadGoal: vi.fn(async (_id: string) => null),
    getBaseDir: vi.fn(() => "/tmp/pulseed-tui-test"),
    writeRaw: vi.fn(async () => undefined),
    readRaw: vi.fn(async () => null),
  };
}

function createChatRunnerMock() {
  return {
    startSession: vi.fn(),
    execute: vi.fn(async () => ({ success: true, output: "", elapsed_ms: 0 })),
    interruptAndRedirect: vi.fn(async () => ({ success: true, output: "", elapsed_ms: 0 })),
    executeIngressMessage: vi.fn(async () => ({ success: true, output: "", elapsed_ms: 0 })),
    getConversationId: vi.fn(() => "tui-conversation-test"),
    onEvent: undefined,
  };
}

function createShellToolExecutor(): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(new ShellTool());
  return new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({}),
    concurrency: new ConcurrencyController(),
  });
}

function createShellExecutionPolicy(workspaceRoot = "/tmp/pulseed-tui-shell-test", overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    executionProfile: "consumer",
    sandboxMode: "workspace_write",
    approvalPolicy: "on_request",
    networkAccess: true,
    workspaceRoot,
    protectedPaths: [],
    trustProjectInstructions: true,
    ...overrides,
  };
}

const CANNED_AGENT_RESULT: AgentResult = {
  success: true,
  output: "Task completed successfully.",
  error: null,
  exit_code: 0,
  elapsed_ms: 50,
  stopped_reason: "completed",
};

function createAdapterMock(result: AgentResult = CANNED_AGENT_RESULT): IAdapter {
  return {
    adapterType: "mock",
    execute: vi.fn().mockResolvedValue(result),
  } as unknown as IAdapter;
}

function nonEvidenceResponse(): string {
  return JSON.stringify({
    decision: "not_runtime_evidence_question",
    topics: [],
    confidence: 0.95,
  });
}

function runSpecResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    decision: "run_spec_request",
    confidence: 0.92,
    profile: "kaggle",
    objective: "Run Kaggle competition until review time",
    metric: {
      name: "leaderboard_rank_percentile",
      direction: "minimize",
      target: null,
      target_rank_percent: 15,
      datasource: "kaggle_leaderboard",
      confidence: "high",
    },
    progress_contract: {
      kind: "rank_percentile",
      dimension: "leaderboard_rank_percentile",
      threshold: 15,
      semantics: "Reach a leaderboard rank percentile at or below 15.",
      confidence: "high",
    },
    deadline: {
      raw: "tomorrow morning",
      iso_at: "2026-05-03T00:00:00.000Z",
      timezone: "Asia/Tokyo",
      finalization_buffer_minutes: 60,
      confidence: "medium",
    },
    budget: {
      max_trials: null,
      max_wall_clock_minutes: null,
      resident_policy: "until_deadline",
    },
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

function confirmationResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    decision: "approve",
    confidence: 0.94,
    ...overrides,
  });
}

function createEvidenceSummary(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "runtime-evidence-summary-v1",
    generated_at: "2026-05-02T00:00:00.000Z",
    scope: { run_id: "run-evidence" },
    total_entries: 1,
    latest_strategy: null,
    best_evidence: null,
    metric_trends: [{
      metric_key: "balanced_accuracy",
      direction: "maximize",
      trend: "breakthrough",
      latest_value: 0.91,
      latest_observed_at: "2026-05-02T00:00:00.000Z",
      best_value: 0.91,
      best_observed_at: "2026-05-02T00:00:00.000Z",
      observation_count: 3,
      recent_slope_per_observation: 0.03,
      best_delta: 0.08,
      last_meaningful_improvement_delta: 0.04,
      last_breakthrough_delta: 0.08,
      time_since_last_meaningful_improvement_ms: 0,
      improvement_threshold: 0.01,
      breakthrough_threshold: 0.05,
      noise_band: 0.005,
      confidence: 1,
      source_refs: [],
      summary: "balanced_accuracy breakthrough",
    }],
    evaluator_summary: {
      local_best: null,
      external_best: null,
      gap: null,
      budgets: [],
      calibration: [],
      approval_required_actions: [],
      observations: [],
    },
    research_memos: [],
    dream_checkpoints: [],
    divergent_exploration: [],
    candidate_lineages: [],
    recommended_candidate_portfolio: [],
    candidate_selection_summary: {
      primary_metric: null,
      raw_best: null,
      robust_best: null,
      ranked: [],
      final_portfolio: { safe: null, aggressive: null, diverse: null },
    },
    near_miss_candidates: [],
    artifact_retention: {
      schema_version: "runtime-artifact-retention-summary-v1",
      total_artifacts: 0,
      total_size_bytes: 0,
      unknown_size_count: 0,
      protected_count: 0,
      by_retention_class: {
        final_deliverable: 0,
        best_candidate: 0,
        robust_candidate: 0,
        near_miss: 0,
        reproducibility_critical: 0,
        evidence_report: 0,
        low_value_smoke: 0,
        cache_intermediate: 0,
        duplicate_superseded: 0,
        other: 0,
      },
      cleanup_plan: {
        mode: "plan_only",
        destructive_actions_default: "approval_required",
        actions: [],
      },
    },
    recent_failed_attempts: [],
    failed_lineages: [],
    recent_entries: [],
    warnings: [],
    ...overrides,
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function createTelegramSetupStatus(): TelegramSetupStatus {
  return {
    channel: "telegram",
    state: "unconfigured",
    configPath: "/tmp/pulseed-tui-test/gateways/telegram-bot/config.json",
    daemon: {
      running: false,
      port: 49876,
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
}

describe("formatDaemonConnectionState", () => {
  it("renders connected, connecting, and disconnected labels", () => {
    expect(formatDaemonConnectionState("connected")).toBe("  [daemon connected]");
    expect(formatDaemonConnectionState("connecting")).toBe("  [daemon connecting]");
    expect(formatDaemonConnectionState("disconnected")).toBe("  [daemon disconnected]");
  });

  it("omits the badge when no daemon state is available", () => {
    expect(formatDaemonConnectionState(undefined)).toBeUndefined();
  });
});

describe("TUI natural empty states", () => {
  beforeEach(() => {
    testState.lastChatProps = null;
    testState.lastChatMessages = [];
    testState.lastDashboardProps = null;
    testState.runtimeSessionSnapshots = [];
    testState.runtimeSessionSnapshotCalls = 0;
    testState.summarizedRunIds = [];
    testState.runtimeEvidenceSummaries = {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts with natural-language examples before command help", async () => {
    const screen = render(React.createElement(App, {
      stateManager: createStateManagerMock() as unknown as StateManager,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    const text = testState.lastChatMessages[0]?.text ?? "";

    expect(text).toContain("Describe what you want PulSeed to help with.");
    expect(text).toContain("Examples:");
    expect(text.indexOf("Describe")).toBeLessThan(text.indexOf("/help"));
    expect(text).not.toContain("available commands");

    screen.unmount();
  });
});

describe("TUI shell execution", () => {
  beforeEach(() => {
    testState.lastChatProps = null;
    testState.lastChatMessages = [];
    testState.runtimeSessionSnapshots = [];
    testState.runtimeSessionSnapshotCalls = 0;
    testState.summarizedRunIds = [];
    testState.runtimeEvidenceSummaries = {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes safe read-only bang commands through the typed tool executor", async () => {
    const stateManager = createStateManagerMock();
    const execSpy = vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
      stdout: "/tmp\n",
      stderr: "",
      exitCode: 0,
    });
    const shellApprovalFn = vi.fn(async () => false);

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "/tmp",
      gitBranch: "main",
      providerName: "claude",
      toolExecutor: createShellToolExecutor(),
      shellApprovalFn,
      shellExecutionPolicy: createShellExecutionPolicy("/tmp"),
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("!pwd");
    await flush();

    expect(execSpy).toHaveBeenCalledOnce();
    expect(shellApprovalFn).not.toHaveBeenCalled();
    expect(testState.lastChatMessages.map((message) => message.text).join("\n")).toContain("$ pwd");

    screen.unmount();
  });

  it("keeps bang shell writes approval-denied and not executed", async () => {
    const stateManager = createStateManagerMock();
    const execSpy = vi.spyOn(execMod, "execFileNoThrow").mockResolvedValue({
      stdout: "should-not-run",
      stderr: "",
      exitCode: 0,
    });
    const shellApprovalFn = vi.fn(async () => false);

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "/tmp",
      gitBranch: "main",
      providerName: "claude",
      toolExecutor: createShellToolExecutor(),
      shellApprovalFn,
      shellExecutionPolicy: createShellExecutionPolicy("/tmp"),
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("!echo ok > denied.txt");
    await flush();

    expect(shellApprovalFn).toHaveBeenCalledOnce();
    expect(execSpy).not.toHaveBeenCalled();
    expect(testState.lastChatMessages.map((message) => message.text).join("\n")).toContain("User denied approval");

    screen.unmount();
  });

  it("blocks quoted command substitution in bang shell commands before execution", async () => {
    const stateManager = createStateManagerMock();
    const execSpy = vi.spyOn(execMod, "execFileNoThrow").mockResolvedValue({
      stdout: "should-not-run",
      stderr: "",
      exitCode: 0,
    });
    const shellApprovalFn = vi.fn(async () => true);

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "/tmp",
      gitBranch: "main",
      providerName: "claude",
      toolExecutor: createShellToolExecutor(),
      shellApprovalFn,
      shellExecutionPolicy: createShellExecutionPolicy("/tmp"),
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("!echo \"$(touch denied.txt)\"");
    await flush();

    expect(execSpy).not.toHaveBeenCalled();
    expect(shellApprovalFn).not.toHaveBeenCalled();
    expect(testState.lastChatMessages.map((message) => message.text).join("\n")).toContain("unsupported command substitution syntax");

    screen.unmount();
  });
});

describe("standalone slash command routing", () => {
  beforeEach(() => {
    testState.lastChatProps = null;
    testState.lastChatMessages = [];
    testState.runtimeSessionSnapshots = [];
    testState.runtimeSessionSnapshotCalls = 0;
    testState.summarizedRunIds = [];
    testState.runtimeEvidenceSummaries = {};
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("routes /permissions to ChatRunner instead of standalone intent handlers", async () => {
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const intentRecognizer = {
      recognize: vi.fn(async () => ({ intent: "unknown", raw: "/permissions" })),
    };
    const actionHandler = {
      handle: vi.fn(async () => ({ messages: ["unexpected"] })),
    };

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      intentRecognizer: intentRecognizer as any,
      actionHandler: actionHandler as any,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("/permissions workspace-write");

    expect(chatRunner.execute).toHaveBeenCalledWith("/permissions workspace-write", "~/workspace");
    expect(intentRecognizer.recognize).not.toHaveBeenCalled();
    expect(actionHandler.handle).not.toHaveBeenCalled();

    screen.unmount();
  });

  it("routes /status to ChatRunner instead of standalone intent handlers", async () => {
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const intentRecognizer = {
      recognize: vi.fn(async () => ({ intent: "status", raw: "/status" })),
    };
    const actionHandler = {
      handle: vi.fn(async () => ({ messages: ["unexpected"] })),
    };

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      intentRecognizer: intentRecognizer as any,
      actionHandler: actionHandler as any,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("/status");

    expect(chatRunner.execute).toHaveBeenCalledWith("/status", "~/workspace");
    expect(intentRecognizer.recognize).not.toHaveBeenCalled();
    expect(actionHandler.handle).not.toHaveBeenCalled();

    screen.unmount();
  });

  it("routes ChatRunner-only slash commands from the TUI surface", async () => {
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const intentRecognizer = {
      recognize: vi.fn(async () => ({ intent: "unknown", raw: "/tasks" })),
    };
    const actionHandler = {
      handle: vi.fn(async () => ({ messages: ["unexpected"] })),
    };

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      intentRecognizer: intentRecognizer as any,
      actionHandler: actionHandler as any,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("/tasks goal-1");
    await testState.lastChatProps!.onSubmit("/config");

    expect(chatRunner.execute).toHaveBeenNthCalledWith(1, "/tasks goal-1", "~/workspace");
    expect(chatRunner.execute).toHaveBeenNthCalledWith(2, "/config", "~/workspace");
    expect(intentRecognizer.recognize).not.toHaveBeenCalled();
    expect(actionHandler.handle).not.toHaveBeenCalled();

    screen.unmount();
  });

  it("keeps bare command-like natural text on the freeform caller path", async () => {
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const intentRecognizer = {
      recognize: vi.fn(async () => ({ intent: "loop_start", raw: "run" })),
    };
    const actionHandler = {
      handle: vi.fn(async () => ({ messages: ["unexpected"] })),
    };

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      intentRecognizer: intentRecognizer as any,
      actionHandler: actionHandler as any,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("run");
    await testState.lastChatProps!.onSubmit("estado actual del trabajo");

    expect(chatRunner.execute).toHaveBeenNthCalledWith(1, "run", "~/workspace");
    expect(chatRunner.execute).toHaveBeenNthCalledWith(2, "estado actual del trabajo", "~/workspace");
    expect(intentRecognizer.recognize).not.toHaveBeenCalled();
    expect(actionHandler.handle).not.toHaveBeenCalled();

    screen.unmount();
  });

  it("routes long-running freeform requests through ChatRunner for AgentLoop RunSpec tools", async () => {
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const llmClient = createMockLLMClient([
      nonEvidenceResponse(),
      runSpecResponse(),
      confirmationResponse(),
    ]);

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      llmClient,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "/work/kaggle",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("Run this Kaggle competition until tomorrow morning and aim for top 15%. Keep submissions approval-gated.");

    expect(chatRunner.execute).toHaveBeenCalledWith(
      "Run this Kaggle competition until tomorrow morning and aim for top 15%. Keep submissions approval-gated.",
      "/work/kaggle",
    );
    expect(chatRunner.executeIngressMessage).not.toHaveBeenCalled();

    screen.unmount();
  });

  it("leaves workspace derivation to ChatRunner instead of creating a TUI RunSpec draft", async () => {
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const llmClient = createMockLLMClient([
      nonEvidenceResponse(),
      runSpecResponse({
        workspace: {
          path: "/work/explicit-kaggle",
          source: "user",
          confidence: "high",
        },
      }),
      confirmationResponse(),
    ]);

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      llmClient,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "/work/stale-tui-cwd",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("Run the Kaggle competition in /work/explicit-kaggle until tomorrow morning.");
    await flush();

    expect(chatRunner.execute).toHaveBeenCalledWith(
      "Run the Kaggle competition in /work/explicit-kaggle until tomorrow morning.",
      "/work/stale-tui-cwd",
    );
    expect(chatRunner.executeIngressMessage).not.toHaveBeenCalled();

    screen.unmount();
  });

  it("does not pre-agent confirm a long-running run when no TUI RunSpec draft is pending", async () => {
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const llmClient = createMockLLMClient([
      nonEvidenceResponse(),
      runSpecResponse({
        deadline: null,
      }),
      confirmationResponse(),
    ]);

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      llmClient,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "/work/kaggle",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("Run this Kaggle competition and aim for top 15%. Keep submissions approval-gated.");
    await flush();
    await testState.lastChatProps!.onSubmit("confirm");

    expect(chatRunner.execute).toHaveBeenNthCalledWith(
      1,
      "Run this Kaggle competition and aim for top 15%. Keep submissions approval-gated.",
      "/work/kaggle",
    );
    expect(chatRunner.execute).toHaveBeenNthCalledWith(2, "confirm", "/work/kaggle");
    expect(chatRunner.executeIngressMessage).not.toHaveBeenCalled();

    screen.unmount();
  });

  it.each([
    ["Japanese", "明日のレビューまでコンペの改善を進めて、提出は承認制にして"],
    ["Spanish", "Sigue trabajando en la competición hasta la revisión y no envíes nada sin aprobación."],
  ])("routes %s long-running caller-path phrasing through ChatRunner", async (_label, requestText) => {
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const llmClient = createMockLLMClient([
      nonEvidenceResponse(),
      runSpecResponse(),
    ]);

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      llmClient,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "/work/kaggle",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit(requestText);
    await flush();

    expect(chatRunner.execute).toHaveBeenCalledWith(requestText, "/work/kaggle");
    expect(chatRunner.executeIngressMessage).not.toHaveBeenCalled();
    expect(llmClient.callCount).toBe(1);

    screen.unmount();
  });

  it("answers natural-language run progress questions from runtime evidence before ChatRunner", async () => {
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const llmClient = createSingleMockLLMClient(JSON.stringify({
      decision: "runtime_evidence_question",
      topics: ["progress", "metric"],
      confidence: 0.93,
    }));
    testState.runtimeSessionSnapshots = [{
      schema_version: "runtime-session-registry-v1",
      generated_at: "2026-05-02T00:00:00.000Z",
      sessions: [],
      background_runs: [{
        schema_version: "background-run-v1",
        id: "run-evidence",
        kind: "coreloop_run",
        parent_session_id: null,
        child_session_id: null,
        process_session_id: null,
        status: "running",
        notify_policy: "done_only",
        reply_target_source: "none",
        pinned_reply_target: null,
        title: "Evidence run",
        workspace: "/repo",
        created_at: "2026-05-02T00:00:00.000Z",
        started_at: "2026-05-02T00:00:00.000Z",
        updated_at: "2026-05-02T00:00:00.000Z",
        completed_at: null,
        summary: "Kaggle run is executing",
        error: null,
        artifacts: [],
        source_refs: [],
      }],
      warnings: [],
    }];
    testState.runtimeEvidenceSummaries = {
      "run-evidence": createEvidenceSummary(),
    };

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      llmClient,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "/work/kaggle",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("Progress?");
    await flush();

    expect(chatRunner.execute).not.toHaveBeenCalled();
    expect(chatRunner.executeIngressMessage).not.toHaveBeenCalled();
    expect(llmClient.callCount).toBe(1);
    expect(testState.lastChatMessages.map((message) => message.text).join("\n")).toContain("Runtime evidence answer for run run-evidence");
    expect(testState.lastChatMessages.map((message) => message.text).join("\n")).toContain("balanced_accuracy");

    screen.unmount();
  });

  it("does not let fuzzy runtime labels block TUI evidence answers as missing exact runs", async () => {
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const llmClient = createSingleMockLLMClient(JSON.stringify({
      decision: "runtime_evidence_question",
      topics: ["progress", "metric", "blocker"],
      confidence: 0.93,
      targetRunId: "durableloop",
    }));
    testState.runtimeSessionSnapshots = [{
      schema_version: "runtime-session-registry-v1",
      generated_at: "2026-05-02T00:00:00.000Z",
      sessions: [],
      background_runs: [{
        schema_version: "background-run-v1",
        id: "run-evidence",
        kind: "coreloop_run",
        parent_session_id: null,
        child_session_id: null,
        process_session_id: null,
        status: "running",
        notify_policy: "done_only",
        reply_target_source: "none",
        pinned_reply_target: null,
        title: "Kaggle DurableLoop run",
        workspace: "/repo",
        created_at: "2026-05-02T00:00:00.000Z",
        started_at: "2026-05-02T00:00:00.000Z",
        updated_at: "2026-05-02T00:00:00.000Z",
        completed_at: null,
        summary: "Kaggle run is executing",
        error: null,
        artifacts: [],
        source_refs: [],
      }],
      warnings: [],
    }];
    testState.runtimeEvidenceSummaries = {
      "run-evidence": createEvidenceSummary(),
    };

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      llmClient,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "/work/kaggle",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("kaggleタスクdurableloopの方で回す準備できてる？このまま回し始めても大丈夫？");
    await flush();

    const visibleText = testState.lastChatMessages.map((message) => message.text).join("\n");
    expect(chatRunner.execute).not.toHaveBeenCalled();
    expect(chatRunner.executeIngressMessage).not.toHaveBeenCalled();
    expect(testState.summarizedRunIds).toEqual(["run-evidence"]);
    expect(visibleText).toContain("Runtime evidence answer for run run-evidence");
    expect(visibleText).toContain("balanced_accuracy");
    expect(visibleText).toContain("Requested target \"durableloop\" did not match");
    expect(visibleText).not.toContain("requested run was not found");

    screen.unmount();
  });

  it("routes non-evidence multilingual chat through ChatRunner when classifier says not evidence", async () => {
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const llmClient = createMockLLMClient([
      JSON.stringify({
        decision: "not_runtime_evidence_question",
        topics: [],
        confidence: 0.96,
        rationale: "asks for an explanation, not persisted runtime evidence",
      }),
      JSON.stringify({
        decision: "not_run_spec_request",
        confidence: 0.95,
        missing_fields: [],
      }),
    ]);

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      llmClient,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "/work/kaggle",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("このタスクの進め方を説明して");
    await flush();

    expect(llmClient.callCount).toBe(1);
    expect(chatRunner.execute).toHaveBeenCalledWith("このタスクの進め方を説明して", "/work/kaggle");
    expect(chatRunner.executeIngressMessage).not.toHaveBeenCalled();

    screen.unmount();
  });

  it("routes Telegram setup freeform input through the production TUI ChatRunner path", async () => {
    const stateManager = createStateManagerMock();
    const adapter = createAdapterMock();
    const statusLookupCanFinish = createDeferred();
    const gatewaySetupStatusProvider = {
      getTelegramStatus: vi.fn(async () => {
        await statusLookupCanFinish.promise;
        return createTelegramSetupStatus();
      }),
    };
    const chatAgentLoopRunner = {
      execute: vi.fn().mockImplementation(async (input: { toolCallContext?: ToolCallContext }) => {
        const guidanceTool = createSetupRuntimeControlTools({
          stateManager: stateManager as unknown as StateManager,
          gatewaySetupStatusProvider,
        }).find((tool) => tool.metadata.name === "prepare_gateway_setup_guidance")!;
        const result = await guidanceTool.call({
          channel: "telegram",
          request: "telegramからseedyと会話できるようにしたい",
          language: "ja",
        }, input.toolCallContext!);
        return {
          success: result.success,
          output: result.summary,
          error: null,
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "completed",
        };
      }),
    } as unknown as ChatAgentLoopRunner;
    let tuiEventHandler: TuiChatSurface["onEvent"];
    const realRunner = new ChatRunner({
      stateManager: stateManager as unknown as StateManager,
      adapter,
      chatAgentLoopRunner,
      gatewaySetupStatusProvider,
      llmClient: createSingleMockLLMClient(JSON.stringify({
        kind: "configure",
        configure_target: "telegram_gateway",
        confidence: 0.97,
        rationale: "user wants Telegram chat setup",
      })) as never,
      onEvent: (event) => tuiEventHandler?.(event),
    });
    let chatRunnerOutput = "";
    const chatRunner = {
      startSession: vi.fn(),
      execute: vi.fn(async (input: string, cwd: string) => {
        const result = await realRunner.execute(input, cwd);
        chatRunnerOutput = result.output;
        return result;
      }),
      interruptAndRedirect: vi.fn(async () => ({ success: true, output: "", elapsed_ms: 0 })),
      executeIngressMessage: vi.fn(async () => ({ success: true, output: "", elapsed_ms: 0 })),
      getConversationId: vi.fn(() => "tui-conversation-test"),
      get onEvent() {
        return tuiEventHandler;
      },
      set onEvent(handler) {
        tuiEventHandler = handler;
      },
    };
    const llmClient = createMockLLMClient([
      JSON.stringify({
        decision: "not_runtime_evidence_question",
        topics: [],
        confidence: 0.98,
        rationale: "setup request, not runtime evidence",
      }),
      JSON.stringify({
        decision: "not_run_spec_request",
        confidence: 0.95,
        missing_fields: [],
      }),
    ]);

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      llmClient,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "/work/pulseed",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    const submit = testState.lastChatProps!.onSubmit("telegramからseedyと会話できるようにしたい");
    await vi.waitFor(() => {
      const visibleText = testState.lastChatMessages.map((message) => message.text).join("\n");
      expect(visibleText).toContain("Working turn started");
      expect(visibleText).not.toContain("pulseed telegram setup");
    });
    statusLookupCanFinish.resolve();
    await submit;
    await flush();

    expect(chatRunner.execute).toHaveBeenCalledWith("telegramからseedyと会話できるようにしたい", "/work/pulseed");
    expect(chatRunner.executeIngressMessage).not.toHaveBeenCalled();
    expect(gatewaySetupStatusProvider.getTelegramStatus).toHaveBeenCalledWith("/tmp/pulseed-tui-test");
    await vi.waitFor(() => expect(chatRunnerOutput).toContain("pulseed telegram setup"));
    expect(chatRunnerOutput).toContain("pulseed telegram setup");
    expect(chatRunnerOutput).toContain("pulseed gateway setup");
    await vi.waitFor(() => {
      const visibleText = testState.lastChatMessages.map((message) => message.text).join("\n");
      expect(visibleText).toContain("pulseed telegram setup");
      expect(visibleText).toContain("I understand the request");
      expect(visibleText).toContain("Next I will");
      expect(visibleText).toContain("This is needed");
      expect(visibleText).not.toContain("このリクエスト");
      expect(visibleText).not.toContain("resume the saved agent loop state");
    });
    expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce();
    expect(adapter.execute).not.toHaveBeenCalled();

    screen.unmount();
  });

  it("routes natural-language runtime control through ChatRunner from the TUI freeform input", async () => {
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const llmClient = createMockLLMClient([
      JSON.stringify({
        decision: "not_runtime_evidence_question",
        topics: [],
        confidence: 0.97,
        rationale: "runtime-control request, not evidence Q&A",
      }),
      JSON.stringify({
        decision: "not_run_spec_request",
        confidence: 0.95,
        missing_fields: [],
      }),
    ]);

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      llmClient,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "/work/kaggle",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("この実行を一時停止して");
    await flush();

    expect(chatRunner.execute).toHaveBeenCalledWith("この実行を一時停止して", "/work/kaggle");
    expect(chatRunner.executeIngressMessage).not.toHaveBeenCalled();
    expect(llmClient.callCount).toBe(1);

    screen.unmount();
  });

  it("routes input during processing to ChatRunner interrupt redirect", async () => {
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    let resolveExecute: () => void = () => {};
    chatRunner.execute = vi.fn(() => new Promise((resolve) => {
      resolveExecute = () => resolve({ success: true, output: "", elapsed_ms: 0 });
    }));

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    const firstSubmit = testState.lastChatProps!.onSubmit("long running task");
    await flush();
    await testState.lastChatProps!.onSubmit("show me the diff first");

    expect(chatRunner.execute).toHaveBeenCalledWith("long running task", "~/workspace");
    expect(chatRunner.interruptAndRedirect).toHaveBeenCalledWith("show me the diff first", "~/workspace");

    resolveExecute();
    await firstSubmit;
    screen.unmount();
  });
});

describe("daemon-mode chat routing", () => {
  beforeEach(() => {
    testState.lastChatProps = null;
    testState.lastChatMessages = [];
    testState.lastDashboardProps = null;
    testState.runtimeSessionSnapshots = [];
    testState.runtimeSessionSnapshotCalls = 0;
    testState.summarizedRunIds = [];
    testState.runtimeEvidenceSummaries = {};
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses ChatRunner when daemon mode has no active goal", async () => {
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();

    const screen = render(React.createElement(App, {
      daemonClient: daemonClient as unknown as DaemonClient,
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();

    expect(chatRunner.startSession).toHaveBeenCalledWith("~/workspace");
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("free form question");

    expect(chatRunner.execute).toHaveBeenCalledWith("free form question", "~/workspace");
    expect(chatRunner.executeIngressMessage).not.toHaveBeenCalled();
    expect(daemonClient.chat).not.toHaveBeenCalled();

    screen.unmount();
  });

  it("falls back to natural-language no-active-goal guidance when chat is unavailable", async () => {
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();

    const screen = render(React.createElement(App, {
      daemonClient: daemonClient as unknown as DaemonClient,
      stateManager: stateManager as unknown as StateManager,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("please help with this project");
    await flush();
    const text = testState.lastChatMessages.map((message) => message.text).join("\n");

    expect(text).toContain("No active goal is running.");
    expect(text).toContain("Describe what you want to work on");
    expect(text).not.toContain("/start <goal-id>");
    expect(daemonClient.chat).not.toHaveBeenCalled();

    screen.unmount();
  });

  it("shows a compact current-goal anchor in the always-visible status area", async () => {
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const stdout = createCapturedStdout();
    vi.mocked(stateManager.loadGoal).mockImplementation(async (id) =>
      id === "goal-anchor" ? makeTuiGoal() as never : null
    );

    const screen = render(React.createElement(App, {
      daemonClient: daemonClient as unknown as DaemonClient,
      stateManager: stateManager as unknown as StateManager,
      noFlicker: false,
      controlStream: stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      debug: true,
      stdout,
      stderr: process.stderr,
    });

    await flush();
    await act(async () => {
      daemonClient.handlers.get("daemon_status")?.({
        activeGoals: ["goal-anchor"],
        status: "running",
        loopCount: 2,
      });
    });
    await flush();

    expect(stateManager.loadGoal).toHaveBeenCalledWith("goal-anchor");
    const output = stdout.readOutput();
    expect(output).toContain("Current: Improve daily UX");
    expect(output).toContain("In progress; working");

    screen.unmount();
  });

  it("shows numbered compact summaries when daemon reports multiple active goals", async () => {
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const stdout = createCapturedStdout();
    vi.mocked(stateManager.loadGoal).mockImplementation(async (id) => {
      if (id === "goal-a") return makeTuiGoal({ id: "goal-a", title: "Improve alpha UX" }) as never;
      if (id === "goal-b") return makeTuiGoal({ id: "goal-b", title: "Improve beta UX", status: "waiting" }) as never;
      return null;
    });

    const screen = render(React.createElement(App, {
      daemonClient: daemonClient as unknown as DaemonClient,
      stateManager: stateManager as unknown as StateManager,
      noFlicker: false,
      controlStream: stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      debug: true,
      stdout,
      stderr: process.stderr,
    });

    await flush();
    await act(async () => {
      daemonClient.handlers.get("daemon_status")?.({
        activeGoals: ["goal-a", "goal-b"],
        status: "running",
        loopCount: 2,
      });
    });
    await flush();

    const output = stdout.readOutput();
    expect(stateManager.loadGoal).toHaveBeenCalledWith("goal-a");
    expect(stateManager.loadGoal).toHaveBeenCalledWith("goal-b");
    expect(output).toContain("Current goals: 1. Improve alpha UX");
    expect(output).toContain("2. Improve beta UX");

    screen.unmount();
  });

  it("surfaces operator handoffs from daemon events through the approval overlay", async () => {
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();

    const screen = render(React.createElement(App, {
      daemonClient: daemonClient as unknown as DaemonClient,
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();

    expect(daemonClient.on).toHaveBeenCalledWith("operator_handoff_required", expect.any(Function));
    daemonClient.handlers.get("operator_handoff_required")?.({
      handoff_id: "handoff-1",
      goal_id: "goal-a",
      title: "Deadline handoff",
      summary: "Deadline finalization requires review.",
      recommended_action: "Review final artifact.",
      triggers: ["deadline"],
      created_at: "2026-05-01T00:00:00.000Z",
    });
    await flush();

    expect(testState.lastChatMessages.some((message) =>
      message.text.includes("Approval required.")
      && message.text.includes("Deadline handoff")
      && message.text.includes("originating conversation channel")
    )).toBe(true);
    expect("approve" in daemonClient).toBe(false);
    screen.unmount();
  });

  it("routes approval-looking freeform text through ChatRunner instead of resolving mechanically", async () => {
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();

    const screen = render(React.createElement(App, {
      daemonClient: daemonClient as unknown as DaemonClient,
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    daemonClient.handlers.get("operator_handoff_required")?.({
      handoff_id: "handoff-ambiguous",
      goal_id: "goal-a",
      title: "Secret handoff",
      summary: "Secret handling requires approval.",
      recommended_action: "Use the configured secret.",
      triggers: ["approval_required"],
      created_at: "2026-05-01T00:00:00.000Z",
    });
    await flush();

    await testState.lastChatProps!.onSubmit("proceda con la entrega");

    expect("approve" in daemonClient).toBe(false);
    expect(chatRunner.execute).toHaveBeenCalledWith("proceda con la entrega", "~/workspace");
    expect(chatRunner.executeIngressMessage).not.toHaveBeenCalled();
    screen.unmount();
  });

  it("keeps free-form text on ChatRunner even when a daemon goal is active", async () => {
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();

    const screen = render(React.createElement(App, {
      daemonClient: daemonClient as unknown as DaemonClient,
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();

    daemonClient.handlers.get("loop_update")?.({
      goalId: "goal-123",
      running: true,
      iteration: 1,
      status: "running",
      trustScore: 0,
    });
    await flush();

    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("question for the active goal");

    expect(chatRunner.execute).toHaveBeenCalledWith("question for the active goal", "~/workspace");
    expect(daemonClient.chat).not.toHaveBeenCalled();
    expect(chatRunner.executeIngressMessage).not.toHaveBeenCalled();

    screen.unmount();
  });

  it("routes /permissions to ChatRunner in daemon mode", async () => {
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();

    const screen = render(React.createElement(App, {
      daemonClient: daemonClient as unknown as DaemonClient,
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("/permissions read-only");

    expect(chatRunner.execute).toHaveBeenCalledWith("/permissions read-only", "~/workspace");
    expect(daemonClient.chat).not.toHaveBeenCalled();

    screen.unmount();
  });

  it("resolves daemon-mode /start numeric arguments through runnable goal indexes", async () => {
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const goals = [
      { id: "goal-alpha", title: "Improve alpha routing", status: "active" },
      { id: "goal-beta", title: "Improve beta routing", status: "active" },
    ];
    vi.mocked(stateManager.listGoalIds).mockResolvedValue(goals.map((goal) => goal.id));
    vi.mocked(stateManager.loadGoal).mockImplementation(async (id) => (goals.find((goal) => goal.id === id) ?? null) as never);

    const screen = render(React.createElement(App, {
      daemonClient: daemonClient as unknown as DaemonClient,
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("  /start 1  ");
    await flush();

    expect(daemonClient.startGoal).toHaveBeenCalledWith("goal-alpha");
    expect(testState.lastChatMessages.some((message) => message.text.includes("Improve alpha routing"))).toBe(true);

    screen.unmount();
  });

  it("preserves daemon-mode /start exact goal IDs while routing slash commands case-insensitively", async () => {
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const goals = [
      { id: "Goal-ABC", title: "Improve exact ID fallback", status: "active" },
      { id: "goal-beta", title: "Improve beta routing", status: "active" },
    ];
    vi.mocked(stateManager.listGoalIds).mockResolvedValue(goals.map((goal) => goal.id));
    vi.mocked(stateManager.loadGoal).mockImplementation(async (id) => (goals.find((goal) => goal.id === id) ?? null) as never);

    const screen = render(React.createElement(App, {
      daemonClient: daemonClient as unknown as DaemonClient,
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("/START Goal-ABC");
    await flush();

    expect(daemonClient.startGoal).toHaveBeenCalledWith("Goal-ABC");
    expect(testState.lastChatMessages.some((message) => message.text.includes("Improve exact ID fallback"))).toBe(true);

    screen.unmount();
  });

  it("does not partially parse malformed daemon-mode /start indexes", async () => {
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const goals = [
      { id: "goal-alpha", title: "Improve alpha routing", status: "active" },
      { id: "goal-beta", title: "Improve beta routing", status: "active" },
    ];
    vi.mocked(stateManager.listGoalIds).mockResolvedValue(goals.map((goal) => goal.id));
    vi.mocked(stateManager.loadGoal).mockImplementation(async (id) => (goals.find((goal) => goal.id === id) ?? null) as never);

    const screen = render(React.createElement(App, {
      daemonClient: daemonClient as unknown as DaemonClient,
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("/start 1abc");
    await flush();

    expect(daemonClient.startGoal).not.toHaveBeenCalled();
    expect(testState.lastChatMessages.some((message) => message.text.includes('No goal matching "1abc"'))).toBe(true);

    screen.unmount();
  });

  it("refreshes runtime session snapshots while the dashboard remains open", async () => {
    vi.useFakeTimers();
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    testState.runtimeSessionSnapshots = [
      {
        schema_version: "runtime-session-registry-v1",
        generated_at: "2026-05-02T00:00:00.000Z",
        sessions: [],
        background_runs: [],
        warnings: [],
      },
      {
        schema_version: "runtime-session-registry-v1",
        generated_at: "2026-05-02T00:00:05.000Z",
        sessions: [],
        background_runs: [{
          schema_version: "background-run-v1",
          id: "run-refresh",
          kind: "coreloop_run",
          parent_session_id: null,
          child_session_id: null,
          process_session_id: null,
          status: "running",
          notify_policy: "done_only",
          reply_target_source: "none",
          pinned_reply_target: null,
          title: "Refreshed work",
          workspace: "/repo",
          created_at: "2026-05-02T00:00:00.000Z",
          started_at: "2026-05-02T00:00:00.000Z",
          updated_at: "2026-05-02T00:00:05.000Z",
          completed_at: null,
          summary: null,
          error: null,
          artifacts: [],
          source_refs: [],
        }],
        warnings: [],
      },
    ];

    const screen = render(React.createElement(App, {
      daemonClient: daemonClient as unknown as DaemonClient,
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await vi.runOnlyPendingTimersAsync();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("/dashboard");
    await vi.runOnlyPendingTimersAsync();

    expect(testState.lastDashboardProps?.runtimeSessions).toMatchObject({
      generated_at: "2026-05-02T00:00:00.000Z",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DASHBOARD_REFRESH_INTERVAL_MS + 1);
    });

    expect(testState.runtimeSessionSnapshotCalls).toBeGreaterThanOrEqual(2);
    expect(testState.lastDashboardProps?.runtimeSessions).toMatchObject({
      generated_at: "2026-05-02T00:00:05.000Z",
      background_runs: [expect.objectContaining({ id: "run-refresh" })],
    });

    screen.unmount();
    vi.useRealTimers();
  });

  it("loads evidence summaries for dashboard-selected runs instead of raw snapshot head", async () => {
    vi.useFakeTimers();
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const now = new Date().toISOString();
    const completedRuns = Array.from({ length: 9 }, (_, index) => ({
      schema_version: "background-run-v1",
      id: `run-completed-${index}`,
      kind: "coreloop_run",
      parent_session_id: null,
      child_session_id: null,
      process_session_id: null,
      status: "succeeded",
      notify_policy: "done_only",
      reply_target_source: "none",
      pinned_reply_target: null,
      title: `Completed ${index}`,
      workspace: "/repo",
      created_at: now,
      started_at: now,
      updated_at: now,
      completed_at: now,
      summary: null,
      error: null,
      artifacts: [],
      source_refs: [],
    }));
    testState.runtimeSessionSnapshots = [{
      schema_version: "runtime-session-registry-v1",
      generated_at: now,
      sessions: [],
      background_runs: [
        ...completedRuns,
        {
          schema_version: "background-run-v1",
          id: "run-active-selected",
          kind: "coreloop_run",
          parent_session_id: null,
          child_session_id: null,
          process_session_id: null,
          status: "running",
          notify_policy: "done_only",
          reply_target_source: "none",
          pinned_reply_target: null,
          title: "Active selected run",
          workspace: "/repo",
          created_at: now,
          started_at: now,
          updated_at: now,
          completed_at: null,
          summary: null,
          error: null,
          artifacts: [],
          source_refs: [],
        },
      ],
      warnings: [],
    }];

    const screen = render(React.createElement(App, {
      daemonClient: daemonClient as unknown as DaemonClient,
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await vi.runOnlyPendingTimersAsync();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("/dashboard");
    await vi.runOnlyPendingTimersAsync();

    expect(testState.summarizedRunIds).toContain("run-active-selected");

    screen.unmount();
    vi.useRealTimers();
  });
});
