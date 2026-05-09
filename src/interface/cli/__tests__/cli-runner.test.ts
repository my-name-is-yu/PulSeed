/**
 * CLIRunner tests — Stage 6
 *
 * CLIRunner API (src/cli-runner.ts):
 *   class CLIRunner {
 *     constructor(baseDir?: string)
 *     run(argv: string[]): Promise<number>   // argv is pure subcommand args (no "node"/"pulseed" prefix)
 *     stop(): void
 *   }
 *
 * argv format: ["run", "--goal", "<id>"] (pure subcommand args)
 *
 * Subcommands:
 *   pulseed run --goal <id>
 *   pulseed goal add "<description>"
 *   pulseed goal list
 *   pulseed status --goal <id>
 *   pulseed report --goal <id>
 *
 * Exit codes: 0 success, 1 error, 2 stall escalation
 *
 * Strategy:
 * - run() returns exit code directly — no process.exit() interception needed
 * - Mock StateManager to inject a temp-directory instance
 * - Mock CoreLoop and GoalNegotiator to avoid real LLM calls
 * - Capture console.log output where needed
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { RuntimeBudgetStore } from "../../../runtime/store/budget-store.js";
import { SupervisorStateStore } from "../../../runtime/store/supervisor-state-store.js";

// ─── Module mocks ───────────────────────────────────────────────────────────
//
// These must be declared before any imports of the mocked modules.

// StateManager is NOT mocked — we use real instances pointing to tmpDir.
// CLIRunner(tmpDir) creates a real StateManager(tmpDir) internally.

vi.mock("../../../base/llm/provider-factory.js", () => ({
  buildLLMClient: vi.fn().mockResolvedValue({
    sendMessage: vi.fn().mockResolvedValue({ content: "mock" }),
    parseJSON: vi.fn().mockResolvedValue({}),
  }),
  buildAdapterRegistry: vi.fn().mockResolvedValue({
    register: vi.fn(),
    getAdapterCapabilities: vi.fn().mockReturnValue([]),
    resolve: vi.fn(),
  }),
}));

vi.mock("../../../base/utils/pulseed-meta.js", () => ({
  getPulseedVersion: vi.fn().mockReturnValue("9.8.7"),
}));

vi.mock("../ensure-api-key.js", () => ({
  ensureProviderConfig: vi.fn().mockResolvedValue({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    adapter: "claude_code_cli",
    api_key: "test-api-key",
  }),
}));

vi.mock("../../../orchestrator/loop/durable-loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../orchestrator/loop/durable-loop.js")>();
  return {
    ...actual,
    CoreLoop: vi.fn(),
  };
});

vi.mock("../../../orchestrator/goal/goal-negotiator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../orchestrator/goal/goal-negotiator.js")>();
  return {
    ...actual,
    GoalNegotiator: vi.fn(),
  };
});

vi.mock("../../../orchestrator/goal/goal-refiner.js", () => ({
  GoalRefiner: vi.fn().mockImplementation(function() { return {
    refine: vi.fn().mockResolvedValue({
      goal: { id: "goal_refine_default", title: "Refined Goal", status: "active", dimensions: [], description: "" },
      leaf: true,
      children: null,
      feasibility: null,
      tokensUsed: 100,
      reason: "measurable",
    }),
  }; }),
  collectLeafGoalIds: vi.fn().mockImplementation((result: { leaf: boolean; goal: { id: string }; children?: unknown[] | null }) => {
    if (result.leaf) return [result.goal.id];
    if (!result.children) return [result.goal.id];
    return [result.goal.id];
  }),
}));

vi.mock("../../../base/llm/llm-client.js", () => ({
  LLMClient: vi.fn().mockImplementation(function() { return {}; }),
  MockLLMClient: vi.fn(),
}));

vi.mock("../src/trust-manager.js", () => ({
  TrustManager: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../src/drive-system.js", () => ({
  DriveSystem: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../../../platform/observation/observation-engine.js", () => ({
  ObservationEngine: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../src/stall-detector.js", () => ({
  StallDetector: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../src/satisficing-judge.js", () => ({
  SatisficingJudge: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../src/ethics-gate.js", () => ({
  EthicsGate: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../../../orchestrator/execution/session-manager.js", () => ({
  SessionManager: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../src/strategy-manager.js", () => ({
  StrategyManager: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../../../orchestrator/execution/adapter-layer.js", () => ({
  AdapterRegistry: vi.fn().mockImplementation(function() { return {
    register: vi.fn(),
    getAdapterCapabilities: vi.fn().mockReturnValue([]),
  }; }),
}));

vi.mock("../../../adapters/agents/claude-code-cli.js", () => ({
  ClaudeCodeCLIAdapter: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../../../adapters/agents/claude-api.js", () => ({
  ClaudeAPIAdapter: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../../../orchestrator/execution/task/task-lifecycle.js", () => ({
  TaskLifecycle: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../../../reporting/reporting-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../reporting/reporting-engine.js")>();
  return {
    ...actual,
    ReportingEngine: vi.fn().mockImplementation(function(...args: ConstructorParameters<typeof actual.ReportingEngine>) { return new actual.ReportingEngine(...args); }),
  };
});

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { CLIRunner } from "../cli-runner.js";
import { StateManager } from "../../../base/state/state-manager.js";
import { ApprovalStore } from "../../../runtime/store/approval-store.js";
import { ApprovalRecordSchema } from "../../../runtime/store/runtime-schemas.js";
import { CoreLoop } from "../../../orchestrator/loop/durable-loop.js";
import { GoalNegotiator, EthicsRejectedError } from "../../../orchestrator/goal/goal-negotiator.js";
import { GoalRefiner } from "../../../orchestrator/goal/goal-refiner.js";
import { getPulseedVersion } from "../../../base/utils/pulseed-meta.js";
import { ensureProviderConfig } from "../ensure-api-key.js";
import { dispatchCommand } from "../cli-command-registry.js";
import { CharacterConfigManager } from "../../../platform/traits/character-config.js";
import { DaemonClient } from "../../../runtime/daemon/client.js";
import { ScheduleEngine } from "../../../runtime/schedule-engine.js";
import { ProactiveInterventionStore } from "../../../runtime/store/proactive-intervention-store.js";
import { createRelationshipProfileChangeProposal } from "../../../platform/profile/profile-change-proposal.js";
import { resolveTaskWorkspacePath } from "../../../orchestrator/execution/task/task-workspace.js";
import type { LoopResult } from "../../../orchestrator/loop/durable-loop.js";
import type { Goal } from "../../../base/types/goal.js";
import type { Task } from "../../../base/types/task.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { makeDimension, makeGoal } from "../../../../tests/helpers/fixtures.js";

function makeLoopResult(overrides: Partial<LoopResult> = {}): LoopResult {
  const now = new Date().toISOString();
  return {
    goalId: "goal-1",
    totalIterations: 3,
    finalStatus: "completed",
    iterations: [],
    startedAt: now,
    completedAt: now,
    ...overrides,
  };
}

function makeNegotiationResult(goal: Goal) {
  return {
    goal,
    response: {
      type: "accept" as const,
      message: "Goal registered successfully.",
      counter_target: null,
    },
    log: {
      goal_id: goal.id,
      timestamp: new Date().toISOString(),
      is_renegotiation: false,
      renegotiation_trigger: null,
    },
  };
}

function makeApproval(overrides: Record<string, unknown> = {}) {
  return ApprovalRecordSchema.parse({
    approval_id: "approval-1",
    goal_id: "goal-1",
    request_envelope_id: "msg-1",
    correlation_id: "corr-1",
    state: "pending",
    created_at: 1,
    expires_at: 2,
    payload: { prompt: "approve?" },
    response_channel: "chat",
    ...overrides,
  });
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["dim"],
    primary_dimension: "dim",
    work_description: "test task",
    rationale: "test rationale",
    approach: "test approach",
    success_criteria: [
      {
        description: "Tests pass",
        verification_method: "npx vitest run",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["module A"],
      out_of_scope: ["module B"],
      blast_radius: "low",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 2, unit: "hours" },
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// No argv wrapper needed — run() accepts pure subcommand args directly.
// No ExitError needed — run() returns exit code as Promise<number>.

// ─── Setup / Teardown ────────────────────────────────────────────────────────

let tmpDir: string;
let stateManager: StateManager;
let origApiKey: string | undefined;

beforeEach(() => {
  tmpDir = makeTempDir();

  // Create a real StateManager pointing to tmpDir for test setup (saving goals, etc.).
  // CLIRunner(tmpDir) will create its own StateManager(tmpDir) internally,
  // sharing the same filesystem directory.
  stateManager = new StateManager(tmpDir);

  // Provide a dummy API key so requireApiKey() passes by default.
  origApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-api-key";
  process.env.PULSEED_LLM_PROVIDER = "anthropic";
});

afterEach(() => {
  if (origApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = origApiKey;
  }
  delete process.env.PULSEED_LLM_PROVIDER;

  try { fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 }); } catch { /* ENOTEMPTY on Node 20 CI — ignore */ }
  vi.clearAllMocks();
});

// ─── Helper: run CLI and capture exit code ───────────────────────────────────

async function runCLI(...args: string[]): Promise<number> {
  const runner = new CLIRunner(tmpDir);
  return runner.run(args);
}

// ─── Construction ─────────────────────────────────────────────────────────────

// NOTE: All significant dependencies are replaced with vi.fn() mocks.
// These tests verify argument parsing, exit-code routing, and DI wiring
// call patterns, but cannot detect bugs in actual dependency implementations.
// For integration coverage, see cli-runner-integration.test.ts

describe("CLIRunner construction", () => {
  it("can be instantiated", () => {
    const runner = new CLIRunner(tmpDir);
    expect(runner).toBeDefined();
  });

  it("exposes a run() method", () => {
    const runner = new CLIRunner(tmpDir);
    expect(typeof runner.run).toBe("function");
  });
});

describe("CLIRunner schedule command exit codes", () => {
  it("returns 1 and does not persist when schedule add integer input is invalid", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCLI("schedule", "add", "--name", "invalid", "--interval", "60s");

    const engine = new ScheduleEngine({ baseDir: tmpDir });
    await engine.loadEntries();
    expect(code).toBe(1);
    expect(engine.getEntries()).toHaveLength(0);
    expect(errSpy).toHaveBeenCalledWith("Error: --interval must be a positive integer");
  });
});

// ─── Goal argument errors ────────────────────────────────────────────────────

describe("CLIRunner goal argument errors", () => {
  it("names pulseed run and shows usage when --goal is missing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCLI("run");

    expect(code).toBe(1);
    const output = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Error: --goal <id> is required for pulseed run.");
    expect(output).toContain("Usage: pulseed run --goal <id>");

    errorSpy.mockRestore();
  });

  it("prints current status guidance when --goal is missing for pulseed status", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCLI("status");

    expect(code).toBe(0);
    const output = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("No active goals found.");
    expect(output).toContain("Describe what you want PulSeed to work on");

    consoleSpy.mockRestore();
  });

  it("names pulseed run and shows usage when multiple goals are provided", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCLI("run", "--goal", "goal-a", "--goal", "goal-b");

    expect(code).toBe(1);
    const output = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Error: only one --goal is supported per pulseed run.");
    expect(output).toContain("Usage: pulseed run --goal <id>");

    errorSpy.mockRestore();
  });
});

// ─── Unknown subcommand ───────────────────────────────────────────────────────

describe("unknown subcommand", async () => {
  it("prints the package version and exits 0 for --version", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const initSpy = vi.spyOn(StateManager.prototype, "init");

    const code = await runCLI("--version");

    expect(code).toBe(0);
    expect(consoleSpy).toHaveBeenCalledWith("9.8.7");
    expect(initSpy).not.toHaveBeenCalled();
    expect(ensureProviderConfig).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
    initSpy.mockRestore();
  });

  it("prints the package version and exits 0 for -v", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const initSpy = vi.spyOn(StateManager.prototype, "init");
    vi.mocked(getPulseedVersion).mockReturnValueOnce("9.8.7");

    const code = await runCLI("-v");

    expect(code).toBe(0);
    expect(consoleSpy).toHaveBeenCalledWith("9.8.7");
    expect(initSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
    initSpy.mockRestore();
  });

  it("exits with code 1 for an unknown subcommand", async () => {
    const code = await runCLI("unknown-command");
    expect(code).toBe(1);
  });

  // No-argument case now launches TUI (feat/default-tui), cannot test in vitest

  it("exits with code 0 for --help", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const initSpy = vi.spyOn(StateManager.prototype, "init");
    const code = await runCLI("--help");
    const output = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(code).toBe(0);
    expect(output).toContain("pulseed daemon ping");
    expect(output).toContain("pulseed approval list");
    expect(output).toContain('pulseed goal add "<description>" --no-refine          Register a goal without refinement');
    expect(output).toContain("--no-refine                         Skip GoalRefiner and use the negotiation path directly");
    expect(output).not.toContain("legacy LLM negotiation");
    expect(output).not.toContain("legacy negotiate()");
    expect(initSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
    initSpy.mockRestore();
  });

  it("exits with code 0 for help with global flags before state initialization", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const initSpy = vi.spyOn(StateManager.prototype, "init");

    const firstCode = await runCLI("--yes", "--help");
    const secondCode = await runCLI("help", "--dev");

    const output = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(firstCode).toBe(0);
    expect(secondCode).toBe(0);
    expect(output).toContain("pulseed daemon ping");
    expect(initSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
    initSpy.mockRestore();
  });

  it("preserves setup-specific help before state initialization", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const initSpy = vi.spyOn(StateManager.prototype, "init");

    const setupCode = await runCLI("setup", "--help");
    const telegramCode = await runCLI("telegram", "setup", "--help");
    const gatewayCode = await runCLI("gateway", "setup", "--help");

    const output = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(setupCode).toBe(0);
    expect(telegramCode).toBe(0);
    expect(gatewayCode).toBe(0);
    expect(output).toContain("Usage: pulseed setup [options]");
    expect(output).toContain("Usage: pulseed telegram setup");
    expect(output).toContain("Usage: pulseed gateway setup");
    expect(output).toContain("--provider <name>");
    expect(output).not.toContain("pulseed daemon ping");
    expect(initSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
    initSpy.mockRestore();
  });

  it("exits with code 0 for help subcommand", async () => {
    const initSpy = vi.spyOn(StateManager.prototype, "init");
    const code = await runCLI("help");
    expect(code).toBe(0);
    expect(initSpy).not.toHaveBeenCalled();
    initSpy.mockRestore();
  });

  it("prints usage when default TUI launch cannot initialize local runtime state", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const initSpy = vi
      .spyOn(StateManager.prototype, "init")
      .mockRejectedValue(new Error("Control DB migration checksum mismatch for version 7."));
    vi.mocked(ensureProviderConfig).mockClear();

    const defaultCode = await runCLI();
    const globalFlagCode = await runCLI("--dev");
    const explicitTuiCode = await runCLI("tui");

    const usageOutput = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    const errorOutput = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(defaultCode).toBe(1);
    expect(globalFlagCode).toBe(1);
    expect(explicitTuiCode).toBe(1);
    expect(initSpy).toHaveBeenCalledTimes(3);
    expect(ensureProviderConfig).not.toHaveBeenCalled();
    expect(usageOutput).toContain("PulSeed — lifelong personal agent");
    expect(errorOutput).toContain("could not open local runtime state");
    expect(errorOutput).toContain("Control DB migration checksum mismatch");
    consoleSpy.mockRestore();
    errorSpy.mockRestore();
    initSpy.mockRestore();
  });

  it("dispatches daemon ping through the registry", async () => {
    fs.writeFileSync(path.join(tmpDir, "daemon.json"), JSON.stringify({ event_server_port: 43123 }));
    vi.spyOn(DaemonClient.prototype, "getHealth").mockResolvedValue({
      status: "ok",
      uptime: 5,
    });

    const code = await runCLI("daemon", "ping");

    expect(code).toBe(0);
  });
});

// ─── `approval list` subcommand ──────────────────────────────────────────────

describe("approval list subcommand", async () => {
  it("lists pending approvals from runtime storage", async () => {
    const approvalStore = new ApprovalStore(path.join(tmpDir, "runtime"));
    await approvalStore.ensureReady();
    await approvalStore.savePending(
      makeApproval({
        approval_id: "approval-pending",
        goal_id: "goal-pending",
        expires_at: Date.now() + 3_600_000,
      })
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCLI("approval", "list");
    const output = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");

    expect(code).toBe(0);
    expect(output).toContain("approval-pe...");
    expect(output).toContain("goal-pending");
    expect(output).toContain("pending");
    consoleSpy.mockRestore();
  });

  it("lists resolved approvals when --resolved is set", async () => {
    const approvalStore = new ApprovalStore(path.join(tmpDir, "runtime"));
    await approvalStore.ensureReady();
    await approvalStore.saveResolved(
      makeApproval({
        approval_id: "approval-resolved",
        goal_id: "goal-resolved",
        state: "approved",
        resolved_at: Date.now(),
        response_channel: "daemon",
      })
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCLI("approval", "list", "--resolved");
    const output = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");

    expect(code).toBe(0);
    expect(output).toContain("approval-re...");
    expect(output).toContain("goal-resolved");
    expect(output).toContain("approved");
    consoleSpy.mockRestore();
  });

  it("ignores malformed legacy approval files without crashing", async () => {
    const approvalStore = new ApprovalStore(path.join(tmpDir, "runtime"));
    await approvalStore.ensureReady();
    await fs.promises.mkdir(path.join(tmpDir, "runtime", "approvals", "pending"), { recursive: true });
    await fs.promises.writeFile(
      path.join(tmpDir, "runtime", "approvals", "pending", "bad.json"),
      "{not-json",
      "utf-8"
    );
    await approvalStore.savePending(
      makeApproval({
        approval_id: "approval-valid",
        goal_id: "goal-valid",
        created_at: 10,
        expires_at: Date.now() + 3_600_000,
      })
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const code = await runCLI("approval", "list");
    const output = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    const warnings = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");

    expect(code).toBe(0);
    expect(output).toContain("approval-valid");
    expect(output).toContain("goal-valid");
    expect(output).not.toContain("bad.json");
    expect(warnings).toBe("");
    warnSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it("normalizes long and odd approval fields for table output", async () => {
    const approvalStore = new ApprovalStore(path.join(tmpDir, "runtime"));
    await approvalStore.ensureReady();
    await approvalStore.savePending(
      makeApproval({
        approval_id: "approval-with-a-very-long-id-and-newline\nsuffix",
        goal_id: undefined,
        created_at: 20,
        expires_at: Date.now() + 3_600_000,
        response_channel: "chat\nwith\todd whitespace and a very long channel name",
      })
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCLI("approval", "list");
    const output = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");

    expect(code).toBe(0);
    expect(output).toContain("approval-wi...");
    expect(output).toContain("pending");
    expect(output).toContain(" - ");
    expect(output).toContain("chat with odd whitesp...");
    expect(output).not.toContain("approval-with-a-very-long-id-and-newline\nsuffix");
    expect(output).not.toContain("chat\nwith");
    consoleSpy.mockRestore();
  });
});

// ─── `run` subcommand ─────────────────────────────────────────────────────────

describe("run subcommand", async () => {
  it("exits with code 1 when --goal is missing", async () => {
    const code = await runCLI("run");
    expect(code).toBe(1);
  });

  it("exits with code 1 when goal is not found in state", async () => {
    // stateManager has no goals stored
    const code = await runCLI("run", "--goal", "nonexistent-id");
    expect(code).toBe(1);
  });

  it("calls CoreLoop.run() with the correct goalId", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-abc" }));

    const mockRun = vi.fn().mockResolvedValue(makeLoopResult({ goalId: "goal-abc" }));
    vi.mocked(CoreLoop).mockImplementation(
      function() { return { run: mockRun, stop: vi.fn(), setTimeHorizonEngine: vi.fn() } as unknown as CoreLoop; }
    );

    await runCLI("run", "--goal", "goal-abc");

    expect(mockRun).toHaveBeenCalledWith("goal-abc", {
      abortSignal: expect.any(AbortSignal),
    });
  });

  it("persists run --workspace as an absolute path before later workspace resolution", async () => {
    const launchDir = fs.mkdtempSync(path.join(tmpDir, "launch-"));
    const daemonDir = fs.mkdtempSync(path.join(tmpDir, "daemon-"));
    const workspaceDir = path.join(launchDir, "relative-workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    await stateManager.saveGoal(makeGoal({ id: "g-relative-workspace" }));
    const characterConfigManager = new CharacterConfigManager(stateManager);

    const mockRun = vi.fn().mockImplementation(async () => {
      const savedGoal = await stateManager.loadGoal("g-relative-workspace");
      expect(savedGoal?.constraints).toContain(`workspace_path:${workspaceDir}`);

      const resolved = await resolveTaskWorkspacePath({
        stateManager,
        task: makeTask({ goal_id: "g-relative-workspace" }),
        fallbackCwd: daemonDir,
      });
      expect(resolved).toBe(workspaceDir);
      return makeLoopResult({ goalId: "g-relative-workspace" });
    });
    vi.mocked(CoreLoop).mockImplementation(
      function() { return { run: mockRun, stop: vi.fn(), setTimeHorizonEngine: vi.fn() } as unknown as CoreLoop; }
    );

    const code = await dispatchCommand(
      ["run", "--goal", "g-relative-workspace", "--workspace", "relative-workspace"],
      false,
      stateManager,
      characterConfigManager,
      { value: null },
      launchDir,
    );

    expect(code).toBe(0);
    expect(mockRun).toHaveBeenCalledWith("g-relative-workspace", {
      abortSignal: expect.any(AbortSignal),
    });
  });

  it("exits with code 0 when finalStatus is completed", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-completed" }));

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult({ finalStatus: "completed" })),
      stop: vi.fn(),
      setTimeHorizonEngine: vi.fn(),
    } as unknown as CoreLoop; });

    const code = await runCLI("run", "--goal", "g-completed");
    expect(code).toBe(0);
  });

  it("exits with code 0 when finalStatus is max_iterations", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-max" }));

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult({ finalStatus: "max_iterations" })),
      stop: vi.fn(),
      setTimeHorizonEngine: vi.fn(),
    } as unknown as CoreLoop; });

    const code = await runCLI("run", "--goal", "g-max");
    expect(code).toBe(0);
  });

  it("exits with code 0 when finalStatus is stopped", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-stopped" }));

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult({ finalStatus: "stopped" })),
      stop: vi.fn(),
      setTimeHorizonEngine: vi.fn(),
    } as unknown as CoreLoop; });

    const code = await runCLI("run", "--goal", "g-stopped");
    expect(code).toBe(0);
  });

  it("exits with code 2 when finalStatus is stalled", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-stalled" }));

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult({ finalStatus: "stalled" })),
      stop: vi.fn(),
      setTimeHorizonEngine: vi.fn(),
    } as unknown as CoreLoop; });

    const code = await runCLI("run", "--goal", "g-stalled");
    expect(code).toBe(2);
  });

  it("exits with code 1 when finalStatus is error", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-error" }));

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult({ finalStatus: "error" })),
      stop: vi.fn(),
      setTimeHorizonEngine: vi.fn(),
    } as unknown as CoreLoop; });

    const code = await runCLI("run", "--goal", "g-error");
    expect(code).toBe(1);
  });

  it("exits with code 1 when CoreLoop.run() throws an error", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-throw" }));

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockRejectedValue(new Error("Unexpected LLM failure")),
      stop: vi.fn(),
      setTimeHorizonEngine: vi.fn(),
    } as unknown as CoreLoop; });

    const code = await runCLI("run", "--goal", "g-throw");
    expect(code).toBe(1);
  });

  it("exits with code 1 when ANTHROPIC_API_KEY is not set", async () => {
    vi.mocked(ensureProviderConfig).mockRejectedValueOnce(
      new Error("No API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable")
    );
    await stateManager.saveGoal(makeGoal({ id: "g-nokey" }));

    const code = await runCLI("run", "--goal", "g-nokey");
    expect(code).toBe(1);
  });

  it("prints goal title before starting the loop", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-print", title: "My Test Goal" }));

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult()),
      stop: vi.fn(),
      setTimeHorizonEngine: vi.fn(),
    } as unknown as CoreLoop; });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("run", "--goal", "g-print");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("My Test Goal");
    consoleSpy.mockRestore();
  });

  it("forwards --max-iterations to CoreLoop as maxIterations number", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-maxiter" }));

    vi.mocked(CoreLoop).mockImplementation(
      function(_deps: unknown, config: unknown) { return {
          run: vi.fn().mockResolvedValue(makeLoopResult()),
          stop: vi.fn(),
          _capturedConfig: config,
          setTimeHorizonEngine: vi.fn(),
        } as unknown as CoreLoop; }
    );

    await runCLI("run", "--goal", "g-maxiter", "--max-iterations", "5");

    expect(vi.mocked(CoreLoop)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        maxIterations: 5,
        runPolicy: { mode: "bounded", maxIterations: 5 },
      })
    );
  });

  it.each(["5abc", "1.5", "0", ""])("rejects malformed --max-iterations value %j before CoreLoop construction", async (value) => {
    await stateManager.saveGoal(makeGoal({ id: "g-maxiter-invalid" }));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runCLI("run", "--goal", "g-maxiter-invalid", "--max-iterations", value);
    errorSpy.mockRestore();

    expect(code).toBe(1);
    expect(vi.mocked(CoreLoop)).not.toHaveBeenCalled();
  });

  it("rejects bare --max-iterations before CoreLoop construction", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-maxiter-bare" }));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runCLI("run", "--goal", "g-maxiter-bare", "--max-iterations");
    errorSpy.mockRestore();

    expect(code).toBe(1);
    expect(vi.mocked(CoreLoop)).not.toHaveBeenCalled();
  });

  it("does not persist workspace constraints for invalid --max-iterations", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-maxiter-no-mutation", constraints: [] }));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runCLI("run", "--goal", "g-maxiter-no-mutation", "--max-iterations", "5abc");
    errorSpy.mockRestore();

    const savedGoal = await stateManager.loadGoal("g-maxiter-no-mutation");
    expect(code).toBe(1);
    expect(savedGoal?.constraints).toEqual([]);
    expect(vi.mocked(CoreLoop)).not.toHaveBeenCalled();
  });

  it("forwards --resident to CoreLoop as an unbounded resident policy", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-resident" }));

    vi.mocked(CoreLoop).mockImplementation(
      function(_deps: unknown, config: unknown) { return {
          run: vi.fn().mockResolvedValue(makeLoopResult()),
          stop: vi.fn(),
          _capturedConfig: config,
          setTimeHorizonEngine: vi.fn(),
        } as unknown as CoreLoop; }
    );

    await runCLI("run", "--goal", "g-resident", "--resident");

    expect(vi.mocked(CoreLoop)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        maxIterations: null,
        runPolicy: { mode: "resident", maxIterations: null },
      })
    );
  });

  it("reconciles interrupted task records before resident CoreLoop.run starts", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-resident-recover" }));
    const runningTask = makeTask({
      id: "task-resident-recover",
      goal_id: "g-resident-recover",
      status: "running",
      started_at: new Date(Date.now() - 5_000).toISOString(),
    });
    await stateManager.writeRaw(`tasks/${runningTask.goal_id}/${runningTask.id}.json`, runningTask);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockRun = vi.fn().mockImplementation(async () => {
      const taskAtLoopStart = await stateManager.readRaw(`tasks/${runningTask.goal_id}/${runningTask.id}.json`) as Task;
      expect(taskAtLoopStart.status).toBe("cancelled");
      expect(taskAtLoopStart.execution_output).toContain("[RECOVERED]");
      return makeLoopResult({ goalId: "g-resident-recover" });
    });
    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: mockRun,
      stop: vi.fn(),
      setTimeHorizonEngine: vi.fn(),
    } as unknown as CoreLoop; });

    const code = await runCLI("run", "--goal", "g-resident-recover", "--resident", "--yes");

    expect(code).toBe(0);
    expect(mockRun).toHaveBeenCalledWith("g-resident-recover", {
      abortSignal: expect.any(AbortSignal),
    });
    const output = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Recovered interrupted task executions for 1 goal(s) before resident loop startup.");

    const history = await stateManager.readRaw(`tasks/${runningTask.goal_id}/task-history.json`) as Array<Record<string, unknown>>;
    expect(history.at(-1)).toMatchObject({
      task_id: "task-resident-recover",
      status: "cancelled",
      recovery_source: "resident_cli_startup",
      recovery_reason: "task execution interrupted before resident CLI startup",
      retry_intent: "resident CLI startup preserved task for retry",
    });
    const ledger = await stateManager.readRaw(`tasks/${runningTask.goal_id}/ledger/${runningTask.id}.json`) as {
      events: Array<{ type: string; action?: string; reason?: string; stopped_reason?: string }>;
    };
    expect(ledger.events.map((event) => event.type)).toEqual(["failed"]);
    expect(ledger.events[0]).toMatchObject({
      reason: "task execution interrupted before resident CLI startup",
      stopped_reason: "cancelled",
    });
    consoleSpy.mockRestore();
  });

  it("reconciles running task records after resident CoreLoop.run exits", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-resident-shutdown-recover" }));
    const runningTask = makeTask({
      id: "task-resident-shutdown",
      goal_id: "g-resident-shutdown-recover",
      status: "running",
      started_at: new Date(Date.now() - 5_000).toISOString(),
    });
    const mockRun = vi.fn().mockImplementation(async () => {
      await stateManager.writeRaw(`tasks/${runningTask.goal_id}/${runningTask.id}.json`, runningTask);
      return makeLoopResult({ goalId: "g-resident-shutdown-recover" });
    });
    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: mockRun,
      stop: vi.fn(),
      setTimeHorizonEngine: vi.fn(),
    } as unknown as CoreLoop; });

    const code = await runCLI("run", "--goal", "g-resident-shutdown-recover", "--resident", "--yes");

    expect(code).toBe(0);
    const task = await stateManager.readRaw(`tasks/${runningTask.goal_id}/${runningTask.id}.json`) as Record<string, unknown>;
    expect(task.status).toBe("cancelled");
    expect(String(task.execution_output)).toContain("[STOPPED]");
    const history = await stateManager.readRaw(`tasks/${runningTask.goal_id}/task-history.json`) as Array<Record<string, unknown>>;
    expect(history.at(-1)).toMatchObject({
      task_id: "task-resident-shutdown",
      status: "cancelled",
      recovery_source: "resident_cli_shutdown",
      recovery_reason: "task execution interrupted during resident CLI shutdown; no live worker remains attached",
    });
    const ledger = await stateManager.readRaw(`tasks/${runningTask.goal_id}/ledger/${runningTask.id}.json`) as {
      events: Array<{ type: string; reason?: string; stopped_reason?: string }>;
    };
    expect(ledger.events.map((event) => event.type)).toEqual(["failed"]);
    expect(ledger.events[0]).toMatchObject({
      reason: "task execution interrupted during resident CLI shutdown; no live worker remains attached",
      stopped_reason: "cancelled",
    });
  });
});

// ─── `--yes` flag position independence ──────────────────────────────────────

describe("--yes flag position independence", async () => {
  // The mock CoreLoop never calls approvalFn, so we cannot observe "Auto-approved"
  // in console output. Instead we verify that:
  //   (a) routing succeeds (exit code 0, not "unknown subcommand")
  //   (b) CoreLoop.run() is called with the correct goalId
  // This confirms --yes is correctly stripped before subcommand dispatch.

  it("honours --yes placed before the subcommand (pulseed --yes run --goal <id>)", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-yes-before" }));

    const mockRun = vi.fn().mockResolvedValue(makeLoopResult({ goalId: "g-yes-before" }));
    vi.mocked(CoreLoop).mockImplementation(
      function() { return { run: mockRun, stop: vi.fn(), setTimeHorizonEngine: vi.fn() } as unknown as CoreLoop; }
    );

    // --yes appears BEFORE the subcommand — previously this was treated as an
    // unknown subcommand and returned exit code 1.
    const code = await runCLI("--yes", "run", "--goal", "g-yes-before");

    expect(code).toBe(0);
    expect(mockRun).toHaveBeenCalledWith("g-yes-before", {
      abortSignal: expect.any(AbortSignal),
    });
  });

  it("honours --yes placed after --goal (pulseed run --goal <id> --yes)", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-yes-after" }));

    const mockRun = vi.fn().mockResolvedValue(makeLoopResult({ goalId: "g-yes-after" }));
    vi.mocked(CoreLoop).mockImplementation(
      function() { return { run: mockRun, stop: vi.fn(), setTimeHorizonEngine: vi.fn() } as unknown as CoreLoop; }
    );

    // --yes appears after the subcommand — the original behaviour must still work.
    const code = await runCLI("run", "--goal", "g-yes-after", "--yes");

    expect(code).toBe(0);
    expect(mockRun).toHaveBeenCalledWith("g-yes-after", {
      abortSignal: expect.any(AbortSignal),
    });
  });

  it("honours -y shorthand placed before the subcommand", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-y-before" }));

    const mockRun = vi.fn().mockResolvedValue(makeLoopResult({ goalId: "g-y-before" }));
    vi.mocked(CoreLoop).mockImplementation(
      function() { return { run: mockRun, stop: vi.fn(), setTimeHorizonEngine: vi.fn() } as unknown as CoreLoop; }
    );

    const code = await runCLI("-y", "run", "--goal", "g-y-before");

    expect(code).toBe(0);
    expect(mockRun).toHaveBeenCalledWith("g-y-before", {
      abortSignal: expect.any(AbortSignal),
    });
  });

  it("--yes before subcommand does not break exit-code when loop fails", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-yes-fail" }));

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult({ finalStatus: "stalled" })),
      stop: vi.fn(),
      setTimeHorizonEngine: vi.fn(),
    } as unknown as CoreLoop; });

    const code = await runCLI("--yes", "run", "--goal", "g-yes-fail");

    // stalled → exit 2, same as without --yes
    expect(code).toBe(2);
  });

  it("--yes before 'goal archive' skips confirmation for non-completed goals", async () => {
    // A goal that is NOT completed — without --yes/--force this should return exit 1
    await stateManager.saveGoal(makeGoal({ id: "g-archive-yes", status: "active" }));

    // Without --yes: should fail (status not completed, no force flag)
    const codeNoYes = await runCLI("goal", "archive", "g-archive-yes");
    expect(codeNoYes).toBe(1);

    // Save the goal again since archiving may have side effects on first call
    await stateManager.saveGoal(makeGoal({ id: "g-archive-yes2", status: "active" }));

    // With global --yes before subcommand: should succeed (confirmation skipped)
    const codeWithYes = await runCLI("--yes", "goal", "archive", "g-archive-yes2");
    expect(codeWithYes).toBe(0);
  });
});

// ─── `goal add` subcommand ───────────────────────────────────────────────────

describe("goal add subcommand", async () => {
  it("exits with code 1 when description argument is missing", async () => {
    const code = await runCLI("goal", "add");
    expect(code).toBe(1);
  });

  it("exits with code 1 when ANTHROPIC_API_KEY is not set", async () => {
    vi.mocked(ensureProviderConfig).mockRejectedValueOnce(
      new Error("No API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable")
    );

    const code = await runCLI("goal", "add", "Build a better README");
    expect(code).toBe(1);
  });

  it("calls GoalRefiner.refine() with the given description (default path)", async () => {
    const mockRefine = vi.fn().mockResolvedValue({
      goal: makeGoal({ id: "goal_refine_1" }),
      leaf: true,
      children: null,
      feasibility: null,
      tokensUsed: 200,
      reason: "measurable",
    });
    vi.mocked(GoalRefiner).mockImplementation(
      function() { return { refine: mockRefine } as unknown as GoalRefiner; }
    );

    await runCLI("goal", "add", "Build a better README");

    expect(mockRefine).toHaveBeenCalledWith(expect.any(String), { feasibilityCheck: true });
  });

  it("calls GoalNegotiator.negotiate() with the given description when --no-refine is set", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const goal = makeGoal();
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));
    vi.mocked(GoalNegotiator).mockImplementation(
      function() { return { negotiate: mockNegotiate } as unknown as GoalNegotiator; }
    );

    await runCLI("goal", "add", "Build a better README", "--no-refine");
    const output = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");

    expect(mockNegotiate).toHaveBeenCalledWith(
      "Build a better README",
      expect.objectContaining({ deadline: undefined, constraints: [] })
    );
    expect(output).toContain('Negotiating goal without refinement: "Build a better README"');
    expect(output).not.toContain("Negotiating goal (legacy)");
    consoleSpy.mockRestore();
  });

  it("exits with code 0 on successful refine (default path)", async () => {
    const goal = makeGoal();
    vi.mocked(GoalRefiner).mockImplementation(function() { return {
      refine: vi.fn().mockResolvedValue({
        goal,
        leaf: true,
        children: null,
        feasibility: null,
        tokensUsed: 100,
        reason: "measurable",
      }),
    } as unknown as GoalRefiner; });

    const code = await runCLI("goal", "add", "Improve test coverage");
    expect(code).toBe(0);
  });

  it("exits with code 1 when EthicsRejectedError is thrown via --no-refine path", async () => {
    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      negotiate: vi.fn().mockRejectedValue(
        new EthicsRejectedError({
          verdict: "reject",
          reasoning: "Harmful content",
          confidence: 1,
          category: "harmful_content",
          risks: [],
        })
      ),
    } as unknown as GoalNegotiator; });

    const code = await runCLI("goal", "add", "DDoS competitor servers", "--no-refine");
    expect(code).toBe(1);
  });

  it("exits with code 1 when negotiate errors via --no-refine path", async () => {
    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      negotiate: vi.fn().mockRejectedValue(new Error("Network error")),
    } as unknown as GoalNegotiator; });

    const code = await runCLI("goal", "add", "Write some code", "--no-refine");
    expect(code).toBe(1);
  });

  it("exits with code 0 (fallback) when refine() throws a non-ethics error", async () => {
    vi.mocked(GoalRefiner).mockImplementation(function() { return {
      refine: vi.fn().mockRejectedValue(new Error("Network error")),
    } as unknown as GoalRefiner; });

    const code = await runCLI("goal", "add", "Write some code");
    // Graceful fallback: goal stub was saved, returns 0
    expect(code).toBe(0);
  });

  it("passes --deadline option to negotiate() via --no-refine", async () => {
    const goal = makeGoal();
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));
    vi.mocked(GoalNegotiator).mockImplementation(
      function() { return { negotiate: mockNegotiate } as unknown as GoalNegotiator; }
    );

    await runCLI("goal", "add", "Refactor module", "--deadline", "2026-06-01", "--no-refine");

    expect(mockNegotiate).toHaveBeenCalledWith(
      "Refactor module",
      expect.objectContaining({ deadline: "2026-06-01" })
    );
  });

  it("passes --constraint option to negotiate() via --no-refine", async () => {
    const goal = makeGoal();
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));
    vi.mocked(GoalNegotiator).mockImplementation(
      function() { return { negotiate: mockNegotiate } as unknown as GoalNegotiator; }
    );

    await runCLI("goal", "add", "Deploy app", "--constraint", "no downtime", "--no-refine");

    expect(mockNegotiate).toHaveBeenCalledWith(
      "Deploy app",
      expect.objectContaining({ constraints: expect.arrayContaining(["no downtime"]) })
    );
  });

  it("prints goal ID after successful refine (default path)", async () => {
    const goal = makeGoal({ id: "new-goal-id", title: "Refined Title" });
    vi.mocked(GoalRefiner).mockImplementation(function() { return {
      refine: vi.fn().mockResolvedValue({
        goal,
        leaf: true,
        children: null,
        feasibility: null,
        tokensUsed: 100,
        reason: "measurable",
      }),
    } as unknown as GoalRefiner; });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("goal", "add", "Do something");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("new-goal-id");
    consoleSpy.mockRestore();
  });

  it("prints an error message when EthicsRejectedError is thrown via --no-refine", async () => {
    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      negotiate: vi.fn().mockRejectedValue(
        new EthicsRejectedError({
          verdict: "reject",
          reasoning: "Dangerous activity",
          confidence: 1,
          category: "dangerous_activity",
          risks: [],
        })
      ),
    } as unknown as GoalNegotiator; });

    const code = await runCLI("goal", "add", "Harmful goal", "--no-refine");
    expect(code).toBe(1);
  });
});

// ─── `goal add` raw mode ─────────────────────────────────────────────────────

describe("goal add raw mode", async () => {
  it("exits with code 0 for a single --dim flag", async () => {
    const code = await runCLI("goal", "add", "--title", "tsc zero", "--dim", "tsc_error_count:min:0");
    expect(code).toBe(0);
  });

  it("exits with code 0 for multiple --dim flags", async () => {
    const code = await runCLI("goal", "add", "--title", "clean code", "--dim", "todo_count:max:0", "--dim", "fixme_count:max:0");
    expect(code).toBe(0);
  });

  it("persists deadline and target_date for a raw --dim goal", async () => {
    const deadline = "2026-06-01";
    const normalizedDeadline = "2026-06-01T00:00:00.000Z";

    const code = await runCLI(
      "goal",
      "add",
      "--title",
      "raw deadline goal",
      "--dim",
      "todo_count:max:0",
      "--deadline",
      deadline
    );

    expect(code).toBe(0);
    const goalIds = await stateManager.listGoalIds();
    expect(goalIds).toHaveLength(1);
    const savedGoal = await stateManager.loadGoal(goalIds[0]!);
    expect(savedGoal?.deadline).toBe(normalizedDeadline);
    expect(savedGoal?.target_date).toBe(normalizedDeadline);
  });

  it("rejects invalid calendar datetimes for raw --dim goals", async () => {
    const code = await runCLI(
      "goal",
      "add",
      "--title",
      "invalid raw deadline goal",
      "--dim",
      "todo_count:max:0",
      "--deadline",
      "2026-02-30T00:00:00Z"
    );

    expect(code).toBe(1);
    expect(await stateManager.listGoalIds()).toEqual([]);
  });

  it("outputs Goal ID and title after successful raw add", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("goal", "add", "--title", "my raw goal", "--dim", "todo_count:max:0");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("my raw goal");
    expect(output).toContain("Goal ID:");
    consoleSpy.mockRestore();
  });

  it("exits with code 1 when --dim is provided but neither --title nor description is given", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runCLI("goal", "add", "--dim", "todo_count:max:0");
    expect(code).toBe(1);
    errorSpy.mockRestore();
  });

  it("exits with code 1 for an invalid --dim format", async () => {
    const code = await runCLI("goal", "add", "--title", "bad dim", "--dim", "badformat");
    expect(code).toBe(1);
  });

  it("does NOT call GoalNegotiator in raw mode", async () => {
    const mockNegotiate = vi.fn().mockResolvedValue({ goal: makeGoal(), response: { type: "accept", message: "ok", counter_target: null }, log: {} });
    vi.mocked(GoalNegotiator).mockImplementation(function() { return { negotiate: mockNegotiate } as unknown as GoalNegotiator; });

    await runCLI("goal", "add", "--title", "raw no llm", "--dim", "todo_count:max:0");

    expect(mockNegotiate).not.toHaveBeenCalled();
  });

  it("calls GoalRefiner.refine() when --negotiate flag is present (--negotiate is alias for refine)", async () => {
    const mockRefine = vi.fn().mockResolvedValue({
      goal: makeGoal({ id: "goal_neg_alias" }),
      leaf: true,
      children: null,
      feasibility: null,
      tokensUsed: 100,
      reason: "measurable",
    });
    vi.mocked(GoalRefiner).mockImplementation(function() { return { refine: mockRefine } as unknown as GoalRefiner; });

    await runCLI("goal", "add", "TypeScriptエラーを0にする", "--negotiate");

    expect(mockRefine).toHaveBeenCalledWith(expect.any(String), { feasibilityCheck: true });
  });
});

// ─── `goal list` subcommand ───────────────────────────────────────────────────

describe("goal list subcommand", async () => {
  it("exits with code 0 when no goals exist", async () => {
    const code = await runCLI("goal", "list");
    expect(code).toBe(0);
  });

  it("exits with code 0 when goals exist", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g1", title: "First Goal" }));
    await stateManager.saveGoal(makeGoal({ id: "g2", title: "Second Goal" }));

    const code = await runCLI("goal", "list");
    expect(code).toBe(0);
  });

  it("outputs a message indicating no goals when none are registered", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCLI("goal", "list");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n").toLowerCase();
    expect(output).toMatch(/no goals|0 goals|no registered|use.*goal add/);
    consoleSpy.mockRestore();
  });

  it("hides goal IDs by default and shows them in detailed listing output", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-alpha", title: "Alpha" }));
    await stateManager.saveGoal(makeGoal({ id: "goal-beta", title: "Beta" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("goal", "list");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Alpha");
    expect(output).toContain("Beta");
    expect(output).not.toContain("goal-alpha");
    expect(output).not.toContain("goal-beta");

    consoleSpy.mockClear();
    await runCLI("goal", "list", "--details");
    const detailedOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(detailedOutput).toContain("goal-alpha");
    expect(detailedOutput).toContain("goal-beta");
    consoleSpy.mockRestore();
  });

  it("shows goal titles in the listing output", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-xyz", title: "My Important Goal" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("goal", "list");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("My Important Goal");
    consoleSpy.mockRestore();
  });

  it("shows goal status in the listing output", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-active", title: "Active Goal", status: "active" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("goal", "list");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("In progress");
    consoleSpy.mockRestore();
  });

  it("shows DB-owned archived goal metadata without legacy archive JSON", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-archived", title: "Archived Goal", status: "completed" }));
    await stateManager.archiveGoal("goal-archived");

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("goal", "list", "--archived");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Archived Goal");
    expect(output).toContain("Archived");
    expect(output).not.toContain("(could not load)");
    consoleSpy.mockRestore();
  });

  it("shows the count of goals found", async () => {
    await stateManager.saveGoal(makeGoal({ id: "ga", title: "A" }));
    await stateManager.saveGoal(makeGoal({ id: "gb", title: "B" }));
    await stateManager.saveGoal(makeGoal({ id: "gc", title: "C" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("goal", "list");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("3");
    consoleSpy.mockRestore();
  });
});

// ─── `goal` with unknown sub-subcommand ──────────────────────────────────────

describe("goal subcommand — unknown sub-subcommand", async () => {
  it("exits with code 1 for unknown goal sub-subcommand", async () => {
    const code = await runCLI("goal", "delete");
    expect(code).toBe(1);
  });

  it("exits with code 1 when 'goal' is given with no sub-subcommand", async () => {
    const code = await runCLI("goal");
    expect(code).toBe(1);
  });

  it("prints an error message for unknown goal sub-subcommand", async () => {
    const code = await runCLI("goal", "unknown-sub");
    expect(code).toBe(1);
  });
});

// ─── `status` subcommand ──────────────────────────────────────────────────────

describe("status subcommand", async () => {
  it("prints a natural current-status empty state when --goal is missing", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCLI("status");
    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");

    expect(code).toBe(0);
    expect(output).toContain("No active goals found.");
    expect(output).toContain("Describe what you want PulSeed to work on");
    consoleSpy.mockRestore();
  });

  it("prints the current-goal summary without requiring a copied goal ID", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-current-default", title: "Current Default Goal", status: "active" }));
    const budgetStore = new RuntimeBudgetStore(path.join(tmpDir, "runtime"));
    await budgetStore.create({
      budget_id: "runtime-budget:goal-current-default",
      scope: { goal_id: "goal-current-default" },
      title: "Runtime budget for current goal",
      created_at: "2026-04-25T00:00:00.000Z",
      limits: [{
        dimension: "wall_clock_ms",
        limit: 60 * 60 * 1000,
        finalization_at_remaining: 10 * 60 * 1000,
        exhaustion_policy: "finalize",
      }],
    });
    await budgetStore.recordTaskExecution("runtime-budget:goal-current-default", {
      wall_clock_ms: 20 * 60 * 1000,
      observed_at: "2026-04-25T00:20:00.000Z",
    });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCLI("status");
    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");

    expect(code).toBe(0);
    expect(output).toContain("Current goal");
    expect(output).toContain("- Goal: Current Default Goal");
    expect(output).toContain("Budget: 20m of 1h used (40m left)");
    expect(output).not.toContain("Goal ID: goal-current-default");
    expect(output).not.toContain("runtime-budget:goal-current-default");
    expect(output).not.toContain("Error: --goal <id>");

    consoleSpy.mockClear();
    const detailCode = await runCLI("status", "--details");
    const detailOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(detailCode).toBe(0);
    expect(detailOutput).toContain("Goal ID: goal-current-default");
    expect(detailOutput).toContain("Budget diagnostics: pulseed runtime budget runtime-budget:goal-current-default");
    consoleSpy.mockRestore();
  });

  it("prints numbered current-goal summaries without requiring copied IDs", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-current-a", title: "Current Goal A", status: "active" }));
    await stateManager.saveGoal(makeGoal({ id: "goal-current-b", title: "Current Goal B", status: "waiting" }));
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCLI("status");
    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");

    expect(code).toBe(0);
    expect(output).toContain("Current goals:");
    expect(output).toContain("1. Current Goal A");
    expect(output).toContain("2. Current Goal B");
    consoleSpy.mockRestore();
  });

  it("exits with code 1 when goal does not exist", async () => {
    const code = await runCLI("status", "--goal", "no-such-goal");
    expect(code).toBe(1);
  });

  it("exits with code 0 for an existing goal with no reports", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-no-rep", title: "Goal With No Reports" }));

    const code = await runCLI("status", "--goal", "goal-no-rep");
    expect(code).toBe(0);
  });

  it("exits with code 0 for an existing goal with reports", async () => {
    const goal = makeGoal({ id: "goal-with-rep" });
    await stateManager.saveGoal(goal);

    // Write a report in the expected directory layout
    const reportDir = path.join(tmpDir, "reports", "goal-with-rep");
    fs.mkdirSync(reportDir, { recursive: true });
    const report = {
      id: "rep-001",
      report_type: "execution_summary",
      goal_id: "goal-with-rep",
      title: "Execution Summary — Loop 1",
      content: "## Progress\nAll good.",
      verbosity: "standard",
      generated_at: new Date().toISOString(),
      delivered_at: null,
      read: false,
    };
    fs.writeFileSync(path.join(reportDir, "rep-001.json"), JSON.stringify(report), "utf-8");

    const code = await runCLI("status", "--goal", "goal-with-rep");
    expect(code).toBe(0);
  });

  it("shows the latest persisted task in detailed status when the latest execution report has no task result", async () => {
    const goal = makeGoal({ id: "goal-status-recovered" });
    await stateManager.saveGoal(goal);
    await stateManager.writeRaw(
      "tasks/goal-status-recovered/task-recovered.json",
      makeTask({
        id: "task-recovered",
        goal_id: "goal-status-recovered",
        status: "completed",
        completed_at: "2026-05-08T03:18:14.915Z",
        verification_verdict: "pass",
      })
    );

    const reportDir = path.join(tmpDir, "reports", "goal-status-recovered");
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, "rep-001.json"), JSON.stringify({
      id: "rep-001",
      report_type: "execution_summary",
      goal_id: "goal-status-recovered",
      title: "Execution Summary — Loop 1",
      content: "### Task Result\n\n_No task executed this loop._",
      verbosity: "standard",
      generated_at: new Date().toISOString(),
      delivered_at: null,
      read: false,
    }), "utf-8");

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("status", "--goal", "goal-status-recovered", "--details");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Latest Task Record");
    expect(output).toContain("task-recovered");
    expect(output).toContain("completed");
    expect(output).toContain("pass");
    consoleSpy.mockRestore();
  });

  it("hides the goal ID by default and shows it in detailed status output", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-display", title: "Display Goal" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("status", "--goal", "goal-display");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Display Goal");
    expect(output).not.toContain("ID: goal-display");

    consoleSpy.mockClear();
    await runCLI("status", "--goal", "goal-display", "--details");
    const detailedOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(detailedOutput).toContain("ID: goal-display");
    consoleSpy.mockRestore();
  });

  it("displays goal status in the output", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-stat", status: "active" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("status", "--goal", "goal-stat");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("In progress");
    expect(output).not.toContain("Status: active");
    consoleSpy.mockRestore();
  });

  it("prints the compact current-goal summary before detailed dimensions", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-current", title: "Current CLI Goal", status: "active" }));
    await new SupervisorStateStore(path.join(tmpDir, "runtime"), { controlBaseDir: tmpDir }).save({
      workers: [{
        workerId: "worker-cli",
        goalId: "goal-current",
        startedAt: Date.parse("2026-04-25T00:00:00.000Z"),
        iterations: 0,
      }],
      crashCounts: {},
      suspendedGoals: [],
      updatedAt: Date.parse("2026-04-25T00:30:00.000Z"),
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("status", "--goal", "goal-current");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output.indexOf("Current goal")).toBeLessThan(output.indexOf("Progress signals:"));
    expect(output).toContain("- Goal: Current CLI Goal");
    expect(output).toContain("Background: Background work is running");
    expect(output).not.toContain("run:coreloop:worker-cli");
    expect(output).toContain("Next safe action: Ask for progress here");
    consoleSpy.mockRestore();
  });

  it("prints metric-like raw values without rounding them to one decimal", async () => {
    await stateManager.saveGoal(makeGoal({
      id: "goal-metric-precision",
      dimensions: [
        makeDimension({
          name: "best_oof_balanced_accuracy",
          label: "best OOF balanced accuracy",
          current_value: 0.9581262885420526,
          threshold: { type: "min", value: 0.99 },
        }),
      ],
    }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("status", "--goal", "goal-metric-precision", "--details");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("current=0.9581262885420526");
    expect(output).not.toContain("current=1");
    consoleSpy.mockRestore();
  });

  it("shows 'no execution reports yet' message when no reports exist", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-norep2" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("status", "--goal", "goal-norep2");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n").toLowerCase();
    expect(output).toMatch(/no execution reports|no reports/);
    consoleSpy.mockRestore();
  });

  it("prints error message for missing goal", async () => {
    const code = await runCLI("status", "--goal", "missing-goal");
    expect(code).toBe(1);
  });
});

// ─── `report` subcommand ──────────────────────────────────────────────────────

describe("report subcommand", async () => {
  it("exits with code 1 when --goal is missing", async () => {
    const code = await runCLI("report");
    expect(code).toBe(1);
  });

  it("exits with code 1 when goal does not exist", async () => {
    const code = await runCLI("report", "--goal", "nonexistent");
    expect(code).toBe(1);
  });

  it("exits with code 0 when no reports exist for the goal", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-no-rep3" }));

    const code = await runCLI("report", "--goal", "goal-no-rep3");
    expect(code).toBe(0);
  });

  it("exits with code 0 when reports exist for the goal", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-rep2" }));

    const reportDir = path.join(tmpDir, "reports", "goal-rep2");
    fs.mkdirSync(reportDir, { recursive: true });
    const report = {
      id: "rep-latest",
      report_type: "execution_summary",
      goal_id: "goal-rep2",
      title: "Execution Summary — Loop 2",
      content: "## Latest Progress\nDone.",
      verbosity: "standard",
      generated_at: new Date().toISOString(),
      delivered_at: null,
      read: false,
    };
    fs.writeFileSync(path.join(reportDir, "rep-latest.json"), JSON.stringify(report), "utf-8");

    const code = await runCLI("report", "--goal", "goal-rep2");
    expect(code).toBe(0);
  });

  it("outputs a message when no reports exist", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-no-rep4" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("report", "--goal", "goal-no-rep4");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n").toLowerCase();
    expect(output).toMatch(/no reports|not found/);
    consoleSpy.mockRestore();
  });

  it("shows the goal ID in report output", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-repout" }));

    const reportDir = path.join(tmpDir, "reports", "goal-repout");
    fs.mkdirSync(reportDir, { recursive: true });
    const report = {
      id: "rep-show",
      report_type: "execution_summary",
      goal_id: "goal-repout",
      title: "Execution Summary — Loop 1",
      content: "Content here.",
      verbosity: "standard",
      generated_at: new Date().toISOString(),
      delivered_at: null,
      read: false,
    };
    fs.writeFileSync(path.join(reportDir, "rep-show.json"), JSON.stringify(report), "utf-8");

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("report", "--goal", "goal-repout");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("goal-repout");
    consoleSpy.mockRestore();
  });

  it("shows the report title in output", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-reptitle" }));

    const reportDir = path.join(tmpDir, "reports", "goal-reptitle");
    fs.mkdirSync(reportDir, { recursive: true });
    const report = {
      id: "rep-title",
      report_type: "execution_summary",
      goal_id: "goal-reptitle",
      title: "Execution Summary — Loop 5",
      content: "Progress update.",
      verbosity: "standard",
      generated_at: new Date().toISOString(),
      delivered_at: null,
      read: false,
    };
    fs.writeFileSync(path.join(reportDir, "rep-title.json"), JSON.stringify(report), "utf-8");

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("report", "--goal", "goal-reptitle");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Execution Summary — Loop 5");
    consoleSpy.mockRestore();
  });

  it("shows the latest report when multiple reports exist", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-multi-rep" }));

    const reportDir = path.join(tmpDir, "reports", "goal-multi-rep");
    fs.mkdirSync(reportDir, { recursive: true });

    const older = {
      id: "rep-old",
      report_type: "execution_summary",
      goal_id: "goal-multi-rep",
      title: "Execution Summary — Loop 1",
      content: "Old content.",
      verbosity: "standard",
      generated_at: "2026-03-01T10:00:00.000Z",
      delivered_at: null,
      read: false,
    };
    const newer = {
      id: "rep-new",
      report_type: "execution_summary",
      goal_id: "goal-multi-rep",
      title: "Execution Summary — Loop 10",
      content: "Latest content.",
      verbosity: "standard",
      generated_at: "2026-03-02T10:00:00.000Z",
      delivered_at: null,
      read: false,
    };

    fs.writeFileSync(path.join(reportDir, "rep-old.json"), JSON.stringify(older), "utf-8");
    fs.writeFileSync(path.join(reportDir, "rep-new.json"), JSON.stringify(newer), "utf-8");

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("report", "--goal", "goal-multi-rep");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Execution Summary — Loop 10");
    consoleSpy.mockRestore();
  });
});

// ─── ANTHROPIC_API_KEY ────────────────────────────────────────────────────────

describe("ANTHROPIC_API_KEY", async () => {
  it("exits with code 1 and prints error when key is missing for run", async () => {
    vi.mocked(ensureProviderConfig).mockRejectedValueOnce(
      new Error("No API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable")
    );
    await stateManager.saveGoal(makeGoal({ id: "g-nokey2" }));

    const code = await runCLI("run", "--goal", "g-nokey2");
    expect(code).toBe(1);
  });

  it("exits with code 1 and prints error when key is missing for goal add", async () => {
    vi.mocked(ensureProviderConfig).mockRejectedValueOnce(
      new Error("No API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable")
    );

    const code = await runCLI("goal", "add", "Some goal");
    expect(code).toBe(1);
  });

  it("does not require API key for goal list", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    // goal list doesn't call requireApiKey(), so it should work without a key
    const code = await runCLI("goal", "list");
    expect(code).toBe(0);
  });

  it("does not require API key for status", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await stateManager.saveGoal(makeGoal({ id: "g-nokey-status" }));

    const code = await runCLI("status", "--goal", "g-nokey-status");
    expect(code).toBe(0);
  });

  it("does not require API key for report", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await stateManager.saveGoal(makeGoal({ id: "g-nokey-report" }));

    const code = await runCLI("report", "--goal", "g-nokey-report");
    expect(code).toBe(0);
  });
});

describe("profile command", () => {
  it("updates and shows relationship profile items through the production CLI entrypoint", async () => {
    const updateCode = await runCLI(
      "profile",
      "update",
      "--kind",
      "preference",
      "--key",
      "user.preference.status",
      "--value",
      "Prefer concise status reports.",
      "--scope",
      "local_planning",
      "--scope",
      "resident_behavior",
      "--confidence",
      "0.9"
    );
    expect(updateCode).toBe(0);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const showCode = await runCLI("profile", "show", "--scope", "resident_behavior");
    const output = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    consoleSpy.mockRestore();

    expect(showCode).toBe(0);
    expect(output).toContain("user.preference.status");
    expect(output).toContain("Prefer concise status reports.");
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, "relationship-profile.json"), "utf-8")).items).toHaveLength(1);
  });

  it("rejects broad JavaScript numeric forms for profile confidence", async () => {
    const code = await runCLI(
      "profile",
      "update",
      "--kind",
      "preference",
      "--key",
      "user.preference.status",
      "--value",
      "Prefer concise status reports.",
      "--scope",
      "resident_behavior",
      "--confidence",
      "0x1"
    );

    expect(code).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, "relationship-profile.json"))).toBe(false);
  });

  it("accepts exact finite exponent confidence values", async () => {
    const code = await runCLI(
      "profile",
      "update",
      "--kind",
      "preference",
      "--key",
      "user.preference.status",
      "--value",
      "Prefer concise status reports.",
      "--scope",
      "resident_behavior",
      "--confidence",
      "9e-1"
    );

    expect(code).toBe(0);
    const profile = JSON.parse(fs.readFileSync(path.join(tmpDir, "relationship-profile.json"), "utf-8")) as {
      items: Array<{ confidence: number }>;
    };
    expect(profile.items[0]?.confidence).toBe(0.9);
  });

  it("supersedes stale profile values on update", async () => {
    await runCLI(
      "profile",
      "update",
      "--kind",
      "boundary",
      "--key",
      "user.boundary.notifications",
      "--value",
      "Notify freely.",
      "--scope",
      "resident_behavior"
    );
    await runCLI(
      "profile",
      "update",
      "--kind",
      "boundary",
      "--key",
      "user.boundary.notifications",
      "--value",
      "Ask before non-urgent notifications.",
      "--scope",
      "resident_behavior",
      "--source",
      "user_correction"
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const showCode = await runCLI("profile", "show", "--scope", "resident_behavior");
    const output = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    consoleSpy.mockRestore();

    expect(showCode).toBe(0);
    expect(output).toContain("Ask before non-urgent notifications.");
    expect(output).not.toContain("Notify freely.");
  });

  it("shows review-safe user-facing profile context without leaking sensitive details", async () => {
    await runCLI(
      "profile",
      "update",
      "--kind",
      "boundary",
      "--key",
      "user.boundary.notifications",
      "--value",
      "Ask before non-urgent notifications.",
      "--scope",
      "user_facing_review"
    );
    await runCLI(
      "profile",
      "update",
      "--kind",
      "boundary",
      "--key",
      "user.boundary.health",
      "--value",
      "Do not use health context outside explicit review.",
      "--scope",
      "user_facing_review",
      "--sensitivity",
      "sensitive"
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const showCode = await runCLI("profile", "show", "--scope", "user_facing_review", "--json");
    const output = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    consoleSpy.mockRestore();

    expect(showCode).toBe(0);
    const parsed = JSON.parse(output) as { items: Array<{ stable_key: string; value: string; sensitivity: string }> };
    expect(parsed.items.map((item) => item.stable_key)).toEqual(["user.boundary.notifications"]);
    expect(parsed.items[0]?.value).toBe("Ask before non-urgent notifications.");
    expect(output).not.toContain("health context");

    const defaultConsoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const defaultShowCode = await runCLI("profile", "show", "--json");
    const defaultOutput = defaultConsoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    defaultConsoleSpy.mockRestore();

    expect(defaultShowCode).toBe(0);
    const defaultParsed = JSON.parse(defaultOutput) as { items: Array<{ stable_key: string; value: string }> };
    expect(defaultParsed.items.map((item) => item.stable_key)).toEqual(["user.boundary.notifications"]);
    expect(defaultOutput).not.toContain("health context");
  });

  it("shows history and retracts profile items through the production CLI entrypoint", async () => {
    await runCLI(
      "profile",
      "update",
      "--kind",
      "preference",
      "--key",
      "user.preference.status",
      "--value",
      "Prefer verbose status reports.",
      "--scope",
      "local_planning",
      "--scope",
      "resident_behavior",
      "--evidence-ref",
      "cli:first"
    );
    await runCLI(
      "profile",
      "update",
      "--kind",
      "preference",
      "--key",
      "user.preference.status",
      "--value",
      "Prefer concise status reports.",
      "--scope",
      "local_planning",
      "--scope",
      "resident_behavior",
      "--source",
      "user_correction",
      "--evidence-ref",
      "cli:correction"
    );

    const historySpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const historyCode = await runCLI("profile", "history", "user.preference.status", "--json");
    const historyOutput = historySpy.mock.calls.map((call) => call.join(" ")).join("\n");
    historySpy.mockRestore();

    expect(historyCode).toBe(0);
    const history = JSON.parse(historyOutput) as {
      items: Array<{ version: number; status: string; provenance: { evidence_ref?: string } }>;
      audit_events: Array<{ action: string }>;
    };
    expect(history.items.map((item) => [item.version, item.status])).toEqual([
      [1, "superseded"],
      [2, "active"],
    ]);
    expect(history.items[1]?.provenance.evidence_ref).toBe("cli:correction");
    expect(history.audit_events.map((event) => event.action)).toEqual(["seeded", "superseded", "created"]);

    const retractSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const retractCode = await runCLI(
      "profile",
      "retract",
      "--key",
      "user.preference.status",
      "--reason",
      "User said this should no longer be used.",
      "--json"
    );
    const retractOutput = retractSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    retractSpy.mockRestore();

    expect(retractCode).toBe(0);
    expect(JSON.parse(retractOutput).item.status).toBe("retracted");

    const showSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const showCode = await runCLI("profile", "show", "--scope", "resident_behavior", "--json");
    const showOutput = showSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    showSpy.mockRestore();

    expect(showCode).toBe(0);
    const scopedShow = JSON.parse(showOutput) as { items: Array<{ value: string; status: string }> };
    expect(scopedShow.items).toEqual([]);

    const afterRetractSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const afterRetractCode = await runCLI("profile", "history", "user.preference.status", "--json");
    const afterRetractOutput = afterRetractSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    afterRetractSpy.mockRestore();

    const afterRetractHistory = JSON.parse(afterRetractOutput) as {
      items: Array<{ version: number; status: string }>;
      audit_events: Array<{ action: string; reason?: string }>;
    };
    expect(afterRetractCode).toBe(0);
    expect(afterRetractHistory.items.map((item) => [item.version, item.status])).toEqual([
      [1, "superseded"],
      [2, "retracted"],
    ]);
    expect(afterRetractHistory.audit_events.at(-1)).toMatchObject({
      action: "retracted",
      reason: "User said this should no longer be used.",
    });

    const allSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const allCode = await runCLI("profile", "show", "--all", "--json");
    const allOutput = allSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    allSpy.mockRestore();

    const allProfile = JSON.parse(allOutput) as { items: Array<{ value: string; status: string }>; audit_events: unknown[] };
    expect(allCode).toBe(0);
    expect(allProfile.items.map((item) => item.status)).toEqual(["superseded", "retracted"]);
    expect(allProfile.audit_events).toHaveLength(4);
  });

  it("lists, inspects, approves, applies, and rejects profile proposals through the production CLI entrypoint", async () => {
    const applyCandidate = await createRelationshipProfileChangeProposal(tmpDir, {
      operation: "upsert_item",
      stableKey: "user.preference.status",
      kind: "preference",
      value: "Prefer concise status reports.",
      source: "cli_proposal",
      confidence: 0.9,
      sensitivity: "private",
      consentScopes: ["user_facing_review"],
      allowedScopes: ["local_planning", "memory_retrieval", "user_facing_review"],
      evidenceRefs: ["cli:proposal"],
      rationale: "Operator wants this preference governed before use.",
    });
    const rejectCandidate = await createRelationshipProfileChangeProposal(tmpDir, {
      operation: "upsert_item",
      stableKey: "user.boundary.notifications",
      kind: "boundary",
      value: "Allow every proactive notification.",
      source: "cli_proposal",
      confidence: 0.6,
      sensitivity: "private",
      consentScopes: ["user_facing_review"],
      allowedScopes: ["resident_behavior", "memory_retrieval", "user_facing_review"],
      evidenceRefs: ["cli:rejected-proposal"],
      rationale: "This proposal should not affect runtime context after rejection.",
    });

    const listSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const listCode = await runCLI("profile", "proposal", "list", "--state", "pending", "--json");
    const listOutput = listSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    listSpy.mockRestore();

    expect(listCode).toBe(0);
    expect(JSON.parse(listOutput).proposals).toHaveLength(2);

    const inspectSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const inspectCode = await runCLI("profile", "proposal", "inspect", applyCandidate.proposal.id, "--json");
    const inspectOutput = inspectSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    inspectSpy.mockRestore();

    expect(inspectCode).toBe(0);
    expect(JSON.parse(inspectOutput).proposal.proposed_item.stable_key).toBe("user.preference.status");

    const approveCode = await runCLI("profile", "proposal", "approve", applyCandidate.proposal.id, "--reason", "Approved by operator.");
    expect(approveCode).toBe(0);
    const applyCode = await runCLI("profile", "proposal", "apply", applyCandidate.proposal.id);
    expect(applyCode).toBe(0);

    const rejectCode = await runCLI("profile", "proposal", "reject", rejectCandidate.proposal.id, "--reason", "Rejected by operator.");
    expect(rejectCode).toBe(0);

    const showSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const showCode = await runCLI("profile", "show", "--scope", "memory_retrieval", "--json");
    const showOutput = showSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    showSpy.mockRestore();

    const profile = JSON.parse(showOutput) as { items: Array<{ stable_key: string; value: string }> };
    expect(showCode).toBe(0);
    expect(profile.items.map((item) => item.stable_key)).toEqual(["user.preference.status"]);
    expect(profile.items[0]?.value).toBe("Prefer concise status reports.");
    expect(showOutput).not.toContain("Allow every proactive notification.");

    const proposalStore = JSON.parse(fs.readFileSync(path.join(tmpDir, "relationship-profile-proposals.json"), "utf-8"));
    expect(proposalStore.proposals.map((proposal: { approval_state: string }) => proposal.approval_state).sort()).toEqual([
      "applied",
      "rejected",
    ]);
    const profileStore = JSON.parse(fs.readFileSync(path.join(tmpDir, "relationship-profile.json"), "utf-8"));
    expect(profileStore.audit_events.at(-1).proposal_id).toBe(applyCandidate.proposal.id);
  });

  it("rejects invalid profile proposal state filters through the production CLI entrypoint", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runCLI("profile", "proposal", "list", "--state", "pendng");
    const output = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    errorSpy.mockRestore();

    expect(code).toBe(1);
    expect(output).toContain("invalid proposal state");
  });
});

describe("runtime proactive feedback commands", () => {
  it("records typed proactive feedback through the production CLI entrypoint", async () => {
    const store = new ProactiveInterventionStore(path.join(tmpDir, "runtime"));
    await store.appendIntervention({
      activity: {
        intervention_id: "intervention-cli-feedback",
        kind: "suggestion",
        trigger: "proactive_tick",
        summary: "Suggested a follow-up.",
        recorded_at: "2026-05-02T00:00:00.000Z",
      },
    });

    const feedbackCode = await runCLI(
      "runtime",
      "proactive-feedback",
      "--intervention",
      "intervention-cli-feedback",
      "--outcome",
      "overreach",
      "--overreach-indicator",
      "too_frequent",
      "--reason",
      "Too many suggestions"
    );
    expect(feedbackCode).toBe(0);

    const proposalStore = JSON.parse(fs.readFileSync(path.join(tmpDir, "relationship-profile-proposals.json"), "utf-8"));
    expect(proposalStore.proposals[0]).toMatchObject({
      source: "proactive_feedback",
      approval_state: "pending",
      proposed_item: {
        stable_key: "user.intervention.proactivity",
        kind: "intervention_policy",
      },
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const qualityCode = await runCLI("runtime", "proactive-quality");
    const output = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    consoleSpy.mockRestore();

    expect(qualityCode).toBe(0);
    expect(output).toContain("Overreach:     1");
    expect(output).toContain("reduce_frequency");
  });
});

// ─── Directory initialisation ─────────────────────────────────────────────────

describe("directory initialisation", () => {
  it("creates base sub-directories after init()", async () => {
    // Use a fresh temp dir to verify CLIRunner triggers StateManager directory creation
    const freshDir = makeTempDir();
    try {
      const runner = new CLIRunner(freshDir);
      await runner.init();
      expect(fs.existsSync(path.join(freshDir, "goals"))).toBe(true);
      expect(fs.existsSync(path.join(freshDir, "reports"))).toBe(true);
      expect(fs.existsSync(path.join(freshDir, "events"))).toBe(true);
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
    }
  });
});

// ─── Integration: goal add then goal list ────────────────────────────────────

describe("integration: goal add then goal list", async () => {
  it("a goal added via refine() appears in goal list output", async () => {
    const goal = makeGoal({ id: "integ-goal", title: "Integration Test Goal" });
    // GoalRefiner.refine() saves the goal internally. Simulate that in the mock.
    const mockRefine = vi.fn().mockImplementation(async () => {
      await stateManager.saveGoal(goal);
      return {
        goal,
        leaf: true,
        children: null,
        feasibility: null,
        tokensUsed: 100,
        reason: "measurable",
      };
    });
    vi.mocked(GoalRefiner).mockImplementation(
      function() { return { refine: mockRefine } as unknown as GoalRefiner; }
    );

    // Add
    const addCode = await runCLI("goal", "add", "Integration test");
    expect(addCode).toBe(0);

    // List
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const runner2 = new CLIRunner(tmpDir);
    await runner2.run(["goal", "list"]);

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Integration Test Goal");
    expect(output).not.toContain("integ-goal");

    consoleSpy.mockClear();
    await runner2.run(["goal", "list", "--details"]);
    const detailedOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(detailedOutput).toContain("integ-goal");
    consoleSpy.mockRestore();
  });
});
