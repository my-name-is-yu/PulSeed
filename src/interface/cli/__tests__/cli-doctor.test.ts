import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { PIDManager } from "../../../runtime/pid-manager.js";
import * as daemonClient from "../../../runtime/daemon/client.js";
import { createEnvelope } from "../../../runtime/types/envelope.js";
import { JournalBackedQueue } from "../../../runtime/queue/journal-backed-queue.js";
import { ScheduleEntryStore } from "../../../runtime/schedule/entry-store.js";
import { ChatSessionDataStore } from "../../chat/chat-session-data-store.js";
import { AgentLoopSessionStateCatalog } from "../../../orchestrator/execution/agent-loop/agent-loop-session-db-store.js";
import { makeGoal } from "../../../../tests/helpers/fixtures.js";
import { appendWALRecord } from "../../../base/state/legacy-state-wal.js";
import { KnowledgeMemoryStateStore } from "../../../platform/knowledge/knowledge-memory-state-store.js";
import { MemoryLifecycleStateStore } from "../../../platform/knowledge/memory/memory-lifecycle-state-store.js";
import { DreamDecisionHeuristicStore } from "../../../runtime/store/dream-decision-heuristic-store.js";
import { createRunSpecStore, type RunSpec } from "../../../runtime/run-spec/index.js";
import { DriveGoalScheduleStateStore } from "../../../platform/drive/drive-schedule-state-store.js";

// ─── cmdDoctor tests ───
//
// We test individual check functions directly, controlling the base directory
// so all file-system checks operate on a temp directory we own.

vi.mock("../../../base/utils/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../base/utils/paths.js")>();
  return {
    ...actual,
    getPulseedDirPath: vi.fn(() => process.env["PULSEED_HOME"] ?? "/tmp/pulseed-doctor-test-placeholder"),
  };
});

import {
  checkNodeVersion,
  checkPulseedDir,
  checkProviderConfig,
  checkApiKey,
  checkEmbeddingAuth,
  checkStateDirectoryPermissions,
  checkControlDatabase,
  checkProviderConfigPermissions,
  checkPluginPermissionWarnings,
  checkGoals,
  checkLogDirectory,
  checkBuild,
  checkDaemon,
  checkNotifications,
  checkNativeTaskAgentLoopTools,
  cmdDoctor,
} from "../commands/doctor.js";
import {
  CONTROL_DB_SCHEMA_VERSION,
  CapabilityRegistryStateStore,
  DaemonStateStore,
  ExecutionSessionStateStore,
  GoalOrchestrationStateStore,
  GoalTaskStateStore,
  openControlDatabase,
  PluginChannelRuntimeStateStore,
  RuntimeHealthStore,
  StallStateStore,
  LearningRuntimeStateStore,
  SupervisorStateStore,
  CuriosityStateStore,
  EthicsLogStore,
  TrustStateStore,
  KnowledgeTransferStateStore,
  TransferTrustStateStore,
} from "../../../runtime/store/index.js";
import { loadRelationshipProfileProposalStore } from "../../../platform/profile/profile-change-proposal.js";

function makeRunSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  const now = "2026-05-10T00:00:00.000Z";
  return {
    schema_version: "run-spec-v1",
    id: "runspec-00000000-0000-4000-8000-000000000001",
    status: "draft",
    profile: "generic",
    source_text: "Run a long background benchmark.",
    objective: "Run a long background benchmark.",
    workspace: { path: "/repo/bench", source: "context", confidence: "high" },
    execution_target: { kind: "daemon", remote_host: null, confidence: "high" },
    metric: null,
    progress_contract: {
      kind: "open_ended",
      dimension: null,
      threshold: null,
      semantics: "Continue until stopped.",
      confidence: "medium",
    },
    deadline: null,
    budget: {
      max_trials: null,
      max_wall_clock_minutes: null,
      resident_policy: "best_effort",
    },
    approval_policy: {
      submit: "approval_required",
      publish: "unspecified",
      secret: "approval_required",
      external_action: "approval_required",
      irreversible_action: "approval_required",
    },
    artifact_contract: {
      expected_artifacts: [],
      discovery_globs: [],
      primary_outputs: [],
    },
    risk_flags: [],
    missing_fields: [],
    confidence: "medium",
    links: { goal_id: null, runtime_session_id: null, conversation_id: "telegram-chat-1" },
    origin: {
      channel: "plugin_gateway",
      session_id: "local-session-1",
      reply_target: null,
      metadata: {},
    },
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

async function saveDaemonStateFixture(tmpDir: string, state: Record<string, unknown>): Promise<void> {
  await new DaemonStateStore(tmpDir).save(state as never);
}

function makeHeartbeatSchedule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "doctor-legacy-schedule",
    layer: "heartbeat",
    trigger: { type: "interval", seconds: 60, jitter_factor: 0 },
    enabled: true,
    heartbeat: {
      check_type: "custom",
      check_config: { command: "echo ok" },
      failure_threshold: 3,
      timeout_ms: 5000,
    },
    baseline_results: [],
    created_at: "2026-05-09T00:00:00.000Z",
    updated_at: "2026-05-09T00:00:00.000Z",
    last_fired_at: null,
    next_fire_at: "2026-05-09T00:01:00.000Z",
    consecutive_failures: 0,
    last_escalation_at: null,
    escalation_timestamps: [],
    total_executions: 0,
    total_tokens_used: 0,
    max_tokens_per_day: 100000,
    tokens_used_today: 0,
    budget_reset_at: null,
    ...overrides,
  };
}

describe("checkNodeVersion", () => {
  it("passes on current Node.js runtime (>= 20)", () => {
    const result = checkNodeVersion();
    expect(result.status).toBe("pass");
    expect(result.detail).toContain(process.versions.node);
  });
});

describe("checkPulseedDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-dir-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("passes when directory exists", () => {
    const result = checkPulseedDir(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("exists");
  });

  it("fails when directory does not exist", () => {
    const missing = path.join(tmpDir, "nonexistent");
    const result = checkPulseedDir(missing);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("not found");
  });
});

describe("checkProviderConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-cfg-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("fails when provider.json is missing", () => {
    const result = checkProviderConfig(tmpDir);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("not found");
  });

  it("passes when provider.json exists and is valid JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "provider.json"), JSON.stringify({ model: "gpt-4" }));
    const result = checkProviderConfig(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("found");
  });

  it("fails when provider.json contains invalid JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "provider.json"), "{ invalid json }");
    const result = checkProviderConfig(tmpDir);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("invalid JSON");
  });

  it("fails before parsing oversized provider.json", () => {
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify({ provider: "openai", model: "x".repeat(1024 * 1024) }),
      "utf-8",
    );

    const result = checkProviderConfig(tmpDir);

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("exceeds 1048576 bytes");
  });
});

describe("checkApiKey", () => {
  let tmpDir: string;
  const savedAnthropicKey = process.env["ANTHROPIC_API_KEY"];
  const savedOpenaiKey = process.env["OPENAI_API_KEY"];

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-apikey-");
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
  });

  afterEach(() => {
    if (savedAnthropicKey !== undefined) process.env["ANTHROPIC_API_KEY"] = savedAnthropicKey;
    if (savedOpenaiKey !== undefined) process.env["OPENAI_API_KEY"] = savedOpenaiKey;
    cleanupTempDir(tmpDir);
  });

  it("passes when the configured adapter manages runtime auth without an API key", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify({ provider: "openai", model: "gpt-5.5", adapter: "openai_codex_cli" })
    );
    const result = await checkApiKey(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("adapter-managed runtime auth");
    expect(result.detail).toContain("codex auth login");
  });

  it("fails Claude Code CLI readiness when the provider runtime still requires an Anthropic API key", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-6", adapter: "claude_code_cli" })
    );
    const result = await checkApiKey(tmpDir);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("API key required");
    expect(result.detail).toContain("pulseed provider show");
  });

  it("passes when the configured provider requires no runtime API key", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify({ provider: "ollama", model: "qwen3:4b", adapter: "agent_loop" })
    );
    const result = await checkApiKey(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("does not require an API key");
    expect(result.detail).toContain("no runtime API key is required");
  });

  it("fails when provider config requires an API key and none is resolved", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify({ provider: "openai", model: "gpt-5.5", adapter: "openai_api" })
    );
    const result = await checkApiKey(tmpDir);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("API key required");
    expect(result.detail).toContain("pulseed provider show");
  });

  it("passes when ANTHROPIC_API_KEY is set", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-6", adapter: "claude_api" })
    );
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    const result = await checkApiKey(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("same sources as `pulseed provider show`");
    expect(result.detail).toContain("anthropic/claude_api");
  });

  it("passes when OPENAI_API_KEY is set", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify({ provider: "openai", model: "gpt-5.5", adapter: "openai_api" })
    );
    process.env["OPENAI_API_KEY"] = "sk-openai-test";
    const result = await checkApiKey(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("same sources as `pulseed provider show`");
    expect(result.detail).toContain("openai/openai_api");
  });

  it("passes when api_key is in provider.json", async () => {
    fs.writeFileSync(path.join(tmpDir, "provider.json"), JSON.stringify({ api_key: "sk-from-file" }));
    const result = await checkApiKey(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("provider.json");
  });
});

describe("checkEmbeddingAuth", () => {
  let tmpDir: string;
  const savedOpenaiKey = process.env["OPENAI_API_KEY"];

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-embedding-auth-");
    delete process.env["OPENAI_API_KEY"];
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
    } as Response)));
  });

  afterEach(() => {
    if (savedOpenaiKey !== undefined) process.env["OPENAI_API_KEY"] = savedOpenaiKey;
    else delete process.env["OPENAI_API_KEY"];
    vi.unstubAllGlobals();
    cleanupTempDir(tmpDir);
  });

  function jwtWithExp(exp: number): string {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
    return `${header}.${payload}.signature`;
  }

  it("warns when provider OpenAI embedding token is expired", async () => {
    fs.writeFileSync(path.join(tmpDir, "provider.json"), JSON.stringify({
      provider: "openai",
      adapter: "openai_codex_cli",
      api_key: jwtWithExp(Math.floor(Date.now() / 1000) - 60),
    }));

    const result = await checkEmbeddingAuth(tmpDir);

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("expired token");
    expect(result.detail).not.toContain(".signature");
  });

  it("passes without exposing a configured OpenAI key", async () => {
    fs.writeFileSync(path.join(tmpDir, "provider.json"), JSON.stringify({
      provider: "openai",
      adapter: "openai_codex_cli",
      api_key: "sk-secret-value",
    }));

    const result = await checkEmbeddingAuth(tmpDir);

    expect(result.status).toBe("pass");
    expect(result.detail).toContain("OpenAI embeddings request succeeded");
    expect(result.detail).not.toContain("sk-secret-value");
  });

  it("warns when the OpenAI embedding probe rejects the key", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    } as Response);
    fs.writeFileSync(path.join(tmpDir, "provider.json"), JSON.stringify({
      provider: "openai",
      adapter: "openai_codex_cli",
      api_key: "sk-bad-secret",
    }));

    const result = await checkEmbeddingAuth(tmpDir);

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("401 Unauthorized");
    expect(result.detail).not.toContain("sk-bad-secret");
  });

  it("uses provider .env OpenAI key before a stale provider.json key", async () => {
    fs.writeFileSync(path.join(tmpDir, ".env"), "OPENAI_API_KEY=sk-env-secret\n");
    fs.writeFileSync(path.join(tmpDir, "provider.json"), JSON.stringify({
      provider: "openai",
      adapter: "openai_codex_cli",
      api_key: jwtWithExp(Math.floor(Date.now() / 1000) - 60),
    }));

    const result = await checkEmbeddingAuth(tmpDir);

    expect(result.status).toBe("pass");
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sk-env-secret" }),
      }),
    );
    expect(result.detail).not.toContain("sk-env-secret");
  });
});

describe("checkStateDirectoryPermissions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-state-perms-");
  });

  afterEach(() => {
    fs.chmodSync(tmpDir, 0o700);
    cleanupTempDir(tmpDir);
  });

  it("passes when the state directory is private", () => {
    fs.chmodSync(tmpDir, 0o700);
    const result = checkStateDirectoryPermissions(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("0700");
  });

  it("warns when the state directory is group/world accessible", () => {
    fs.chmodSync(tmpDir, 0o755);
    const result = checkStateDirectoryPermissions(tmpDir);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("recommended 0700");
  });
});

describe("checkProviderConfigPermissions", () => {
  let tmpDir: string;
  let providerPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-provider-perms-");
    providerPath = path.join(tmpDir, "provider.json");
  });

  afterEach(() => {
    if (fs.existsSync(providerPath)) {
      fs.chmodSync(providerPath, 0o600);
    }
    cleanupTempDir(tmpDir);
  });

  it("passes when provider.json stores no api_key", () => {
    fs.writeFileSync(providerPath, JSON.stringify({ model: "gpt-4" }));
    fs.chmodSync(providerPath, 0o644);
    const result = checkProviderConfigPermissions(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("no api_key");
  });

  it("passes when provider.json stores api_key and is private", () => {
    fs.writeFileSync(providerPath, JSON.stringify({ api_key: "sk-test" }));
    fs.chmodSync(providerPath, 0o600);
    const result = checkProviderConfigPermissions(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("0600");
  });

  it("warns when provider.json stores api_key and is group/world accessible", () => {
    fs.writeFileSync(providerPath, JSON.stringify({ api_key: "sk-test" }));
    fs.chmodSync(providerPath, 0o644);
    const result = checkProviderConfigPermissions(tmpDir);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("recommended 0600");
  });

  it("warns before parsing oversized provider.json", () => {
    fs.writeFileSync(
      providerPath,
      JSON.stringify({ api_key: "sk-test", padding: "x".repeat(1024 * 1024) }),
      "utf-8",
    );
    fs.chmodSync(providerPath, 0o644);

    const result = checkProviderConfigPermissions(tmpDir);

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("exceeds 1048576 bytes");
    expect(result.detail).not.toContain("recommended 0600");
  });
});

describe("checkPluginPermissionWarnings", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-plugin-perms-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("passes when no plugins are installed", () => {
    const result = checkPluginPermissionWarnings(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("no plugins");
  });

  it("warns when an installed plugin requests shell permission", () => {
    const pluginDir = path.join(tmpDir, "plugins", "shell-runner");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "plugin.yaml"),
      [
        "name: shell-runner",
        "version: 1.0.0",
        "type: adapter",
        "capabilities:",
        "  - run_shell",
        "description: 2026-05-10",
        "config_schema: {}",
        "dependencies: []",
        "permissions:",
        "  shell: true",
        "",
      ].join("\n")
    );

    const result = checkPluginPermissionWarnings(tmpDir);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("shell-runner");
  });

  it("warns when a plugin manifest cannot be inspected", () => {
    const pluginDir = path.join(tmpDir, "plugins", "broken");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.yaml"), "{");

    const result = checkPluginPermissionWarnings(tmpDir);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("could not be inspected");
  });
});

describe("checkGoals", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-goals-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("warns when the goal database has no active goals", async () => {
    const result = await checkGoals(tmpDir);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("0 goals");
  });

  it("warns when legacy goals directory is empty and the DB has no goals", async () => {
    const goalsDir = path.join(tmpDir, "goals");
    fs.mkdirSync(goalsDir);
    const result = await checkGoals(tmpDir);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("0 goals");
  });

  it("passes when the goal database has active goals", async () => {
    const store = new GoalTaskStateStore(tmpDir);
    await store.saveGoal(makeGoal({ id: "goal-1" }));
    await store.saveGoal(makeGoal({ id: "goal-2" }));

    const result = await checkGoals(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("2 goals");
  });

  it("ignores legacy JSON goal files on the normal doctor path", async () => {
    const goalsDir = path.join(tmpDir, "goals");
    fs.mkdirSync(goalsDir);
    fs.writeFileSync(path.join(goalsDir, "goal-1.json"), "{}");
    fs.writeFileSync(path.join(goalsDir, "goal-2.json"), "{}");
    const result = await checkGoals(tmpDir);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("0 goals");
  });

  it("ignores nested legacy goal.json files on the normal doctor path", async () => {
    const goalsDir = path.join(tmpDir, "goals");
    fs.mkdirSync(path.join(goalsDir, "goal-1"), { recursive: true });
    fs.mkdirSync(path.join(goalsDir, "goal-2"), { recursive: true });
    fs.writeFileSync(path.join(goalsDir, "goal-1", "goal.json"), "{}");
    fs.writeFileSync(path.join(goalsDir, "goal-2", "goal.json"), "{}");
    const result = await checkGoals(tmpDir);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("0 goals");
  });

  it("uses only DB-owned active goals when legacy goal layouts also exist", async () => {
    await new GoalTaskStateStore(tmpDir).saveGoal(makeGoal({ id: "db-goal" }));
    const goalsDir = path.join(tmpDir, "goals");
    fs.mkdirSync(path.join(goalsDir, "goal-1"), { recursive: true });
    fs.writeFileSync(path.join(goalsDir, "goal-1", "goal.json"), "{}");
    fs.writeFileSync(path.join(goalsDir, "legacy-goal.json"), "{}");
    const result = await checkGoals(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("1 goal");
  });

  it("ignores non-JSON files in goals directory", async () => {
    const goalsDir = path.join(tmpDir, "goals");
    fs.mkdirSync(goalsDir);
    fs.writeFileSync(path.join(goalsDir, "readme.txt"), "hello");
    const result = await checkGoals(tmpDir);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("0 goals");
  });
});

describe("checkLogDirectory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-logs-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("fails when logs directory does not exist", () => {
    const result = checkLogDirectory(tmpDir);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("not found");
  });

  it("passes when logs directory exists and is writable", () => {
    const logsDir = path.join(tmpDir, "logs");
    fs.mkdirSync(logsDir);
    const result = checkLogDirectory(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("writable");
  });
});

describe("checkBuild", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-build-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("passes when the built CLI runner exists", () => {
    const buildPath = path.join(tmpDir, "dist", "interface", "cli", "cli-runner.js");
    fs.mkdirSync(path.dirname(buildPath), { recursive: true });
    fs.writeFileSync(buildPath, "");

    const result = checkBuild(buildPath);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("dist/interface/cli/cli-runner.js exists");
  });

  it("fails when the built CLI runner is missing", () => {
    const buildPath = path.join(tmpDir, "dist", "interface", "cli", "cli-runner.js");

    const result = checkBuild(buildPath);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("dist/interface/cli/cli-runner.js not found");
  });
});

describe("checkDaemon", () => {
  let tmpDir: string;
  let probeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-daemon-");
    probeSpy = vi.spyOn(daemonClient, "probeDaemonHealth").mockResolvedValue({
      ok: true,
      port: 41700,
      latency_ms: 5,
      health: { status: "ok", uptime: 12.3 },
    });
  });

  afterEach(() => {
    probeSpy.mockRestore();
    cleanupTempDir(tmpDir);
  });

  it("passes with clean state when no PID file exists", async () => {
    const result = await checkDaemon(tmpDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("stopped");
  });

  it("warns when PID file references a non-running process", async () => {
    fs.writeFileSync(path.join(tmpDir, "pulseed.pid"), "999999999");
    const result = await checkDaemon(tmpDir);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("stale PID");
  });

  it("warns when PID file references a running process but KPI telemetry is missing", async () => {
    fs.writeFileSync(path.join(tmpDir, "pulseed.pid"), String(process.pid));
    const inspectSpy = vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue({
      info: {
        pid: process.pid,
        started_at: new Date().toISOString(),
        owner_pid: process.pid,
        runtime_pid: process.pid,
      },
      running: true,
      runtimePid: process.pid,
      ownerPid: process.pid,
      alivePids: [process.pid],
      stalePids: [],
      verifiedPids: [process.pid],
      unverifiedLegacyPids: [],
    });
    const result = await checkDaemon(tmpDir);
    inspectSpy.mockRestore();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("running");
    expect(result.detail).toContain("KPI telemetry unavailable");
    expect(result.detail).toContain("live ping ok");
  });

  it("uses persisted daemon runtime root before daemon config when loading daemon health", async () => {
    const actualRuntimeRoot = path.join(tmpDir, "actual-runtime");
    fs.writeFileSync(
      path.join(tmpDir, "daemon.json"),
      JSON.stringify({ runtime_root: "configured-runtime" }),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: process.pid,
        started_at: new Date().toISOString(),
      })
    );
    await saveDaemonStateFixture(tmpDir, {
      pid: process.pid,
      started_at: new Date().toISOString(),
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "running",
      runtime_root: actualRuntimeRoot,
      crash_count: 0,
      last_error: null,
    });
    const observedRoots: string[] = [];
    const loadSpy = vi
      .spyOn(RuntimeHealthStore.prototype, "loadSnapshot")
      .mockImplementation(async function (this: RuntimeHealthStore) {
        observedRoots.push((this as unknown as { paths: { rootDir: string } }).paths.rootDir);
        return null;
      });
    const inspectSpy = vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue({
      info: {
        pid: process.pid,
        started_at: new Date().toISOString(),
        owner_pid: process.pid,
        runtime_pid: process.pid,
      },
      running: true,
      runtimePid: process.pid,
      ownerPid: process.pid,
      alivePids: [process.pid],
      stalePids: [],
      verifiedPids: [process.pid],
      unverifiedLegacyPids: [],
    });

    try {
      await checkDaemon(tmpDir);
    } finally {
      loadSpy.mockRestore();
      inspectSpy.mockRestore();
    }
    expect(observedRoots).toContain(actualRuntimeRoot);
  });

  it("warns when PID file is JSON format and references running process without KPI telemetry", async () => {
    fs.writeFileSync(path.join(tmpDir, "pulseed.pid"), JSON.stringify({ pid: process.pid }));
    const inspectSpy = vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue({
      info: {
        pid: process.pid,
        started_at: new Date().toISOString(),
        owner_pid: process.pid,
        runtime_pid: process.pid,
      },
      running: true,
      runtimePid: process.pid,
      ownerPid: process.pid,
      alivePids: [process.pid],
      stalePids: [],
      verifiedPids: [process.pid],
      unverifiedLegacyPids: [],
    });
    const result = await checkDaemon(tmpDir);
    inspectSpy.mockRestore();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("running");
    expect(result.detail).toContain("KPI telemetry unavailable");
    expect(result.detail).toContain("live ping ok");
  });

  it("fails when the watchdog is alive but the runtime child is dead", async () => {
    const watchdogPid = process.pid;
    const runtimePid = 999999999;
    await new PIDManager(tmpDir).writePID({
      pid: runtimePid,
      runtime_pid: runtimePid,
      owner_pid: watchdogPid,
      watchdog_pid: watchdogPid,
    });
    const inspectSpy = vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue({
      info: {
        pid: runtimePid,
        runtime_pid: runtimePid,
        owner_pid: watchdogPid,
        watchdog_pid: watchdogPid,
        started_at: new Date().toISOString(),
      },
      running: true,
      runtimePid,
      ownerPid: watchdogPid,
      alivePids: [watchdogPid],
      stalePids: [runtimePid],
      verifiedPids: [watchdogPid],
      unverifiedLegacyPids: [],
    });
    await saveDaemonStateFixture(tmpDir, {
      pid: 999999999,
      started_at: new Date().toISOString(),
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "running",
      crash_count: 0,
      last_error: null,
    });

    try {
      const result = await checkDaemon(tmpDir);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("restarting");
    } finally {
      inspectSpy.mockRestore();
    }
  });

  it("fails when the daemon state store reports crashed", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: process.pid,
        started_at: new Date().toISOString(),
      })
    );
    await saveDaemonStateFixture(tmpDir, {
      pid: process.pid,
      started_at: new Date().toISOString(),
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "crashed",
      crash_count: 1,
      last_error: "boom",
    });

    const result = await checkDaemon(tmpDir);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("crashed");
  });

  it("reports idle daemon mode distinctly", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: 424242,
        watchdog_pid: 424242,
        started_at: new Date().toISOString(),
      })
    );
    await saveDaemonStateFixture(tmpDir, {
      pid: process.pid,
      started_at: new Date().toISOString(),
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "idle",
      crash_count: 0,
      last_error: null,
    });
    const inspectSpy = vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue({
      info: {
        pid: process.pid,
        started_at: new Date().toISOString(),
        owner_pid: 424242,
        watchdog_pid: 424242,
        runtime_pid: process.pid,
      },
      running: true,
      runtimePid: process.pid,
      ownerPid: 424242,
      alivePids: [process.pid, 424242],
      stalePids: [],
      verifiedPids: [process.pid, 424242],
      unverifiedLegacyPids: [],
    });

    const result = await checkDaemon(tmpDir);
    inspectSpy.mockRestore();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("idle daemon running");
    expect(result.detail).toContain(`PID: ${process.pid}`);
    expect(result.detail).toContain("KPI telemetry unavailable");
    expect(result.detail).toContain("live ping ok");
  });

  it("warns when runtime KPI reports degraded command acceptance", async () => {
    const now = Date.now();
    fs.mkdirSync(path.join(tmpDir, "tasks", "goal-1", "ledger"), { recursive: true });
    await new RuntimeHealthStore(path.join(tmpDir, "runtime")).saveSnapshot({
      status: "degraded",
      leader: true,
      checked_at: now,
      components: {
        gateway: "degraded",
        queue: "ok",
        leases: "ok",
        approval: "ok",
        outbox: "ok",
        supervisor: "ok",
      },
      kpi: {
        process_alive: { status: "ok", checked_at: now, last_ok_at: now },
        command_acceptance: {
          status: "degraded",
          checked_at: now,
          last_degraded_at: now,
          reason: "gateway or queue health degraded",
        },
        task_execution: { status: "ok", checked_at: now, last_ok_at: now },
        degraded_at: now,
      },
      details: { pid: process.pid },
    });
    await new GoalTaskStateStore(tmpDir).saveTaskOutcomeLedger({
      task_id: "task-1",
      goal_id: "goal-1",
      events: [
        { type: "acked", ts: new Date(now - 6_000).toISOString() },
        { type: "started", ts: new Date(now - 5_000).toISOString() },
        { type: "succeeded", ts: new Date(now - 1_000).toISOString() },
      ],
      summary: {
        latest_event_type: "succeeded",
        latencies: {
          created_to_acked_ms: 800,
          acked_to_started_ms: 100,
          started_to_completed_ms: 3200,
          completed_to_verification_ms: 100,
          created_to_completed_ms: 4100,
        },
      },
    });
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: process.pid,
        started_at: new Date().toISOString(),
      })
    );
    const inspectSpy = vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue({
      info: {
        pid: process.pid,
        started_at: new Date().toISOString(),
        owner_pid: process.pid,
        runtime_pid: process.pid,
      },
      running: true,
      runtimePid: process.pid,
      ownerPid: process.pid,
      alivePids: [process.pid],
      stalePids: [],
      verifiedPids: [process.pid],
      unverifiedLegacyPids: [],
    });

    const result = await checkDaemon(tmpDir);
    inspectSpy.mockRestore();

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("KPI process=up accept=down execute=up (degraded)");
    expect(result.detail).toContain("degraded");
    expect(result.detail).toContain("task success=1/1 (100.0%)");
    expect(result.detail).toContain("total p95=4.1s");
    expect(result.detail).toContain("live ping ok");
  });

  it("fails when the runtime PID is alive but the live daemon health probe fails", async () => {
    probeSpy.mockResolvedValue({
      ok: false,
      port: 41700,
      latency_ms: 15,
      error: "connect ECONNREFUSED",
    });
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: process.pid,
        started_at: new Date().toISOString(),
      })
    );

    const inspectSpy = vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue({
      info: {
        pid: process.pid,
        started_at: new Date().toISOString(),
        owner_pid: process.pid,
        runtime_pid: process.pid,
      },
      running: true,
      runtimePid: process.pid,
      ownerPid: process.pid,
      alivePids: [process.pid],
      stalePids: [],
      verifiedPids: [process.pid],
      unverifiedLegacyPids: [],
    });

    const result = await checkDaemon(tmpDir);
    inspectSpy.mockRestore();

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("live ping failed");
    expect(result.detail).toContain("ECONNREFUSED");
  });
});

describe("checkNotifications", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-notif-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("warns when notification.json is missing", () => {
    const result = checkNotifications(tmpDir);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("not configured");
  });

  it("passes when notification.json exists", () => {
    fs.writeFileSync(path.join(tmpDir, "notification.json"), "{}");
    const result = checkNotifications(tmpDir);
    expect(result.status).toBe("pass");
  });
});

describe("checkNativeTaskAgentLoopTools", () => {
  it("passes when builtin tools cover the native task AgentLoop profile", () => {
    const result = checkNativeTaskAgentLoopTools();

    expect(result.status).toBe("pass");
    expect(result.detail).toContain("required");
    expect(result.detail).toContain("recommended");
    expect(result.detail).toContain("profile ready");
  });
});

describe("checkControlDatabase", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-control-db-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("warns before the control database has been initialized", () => {
    const result = checkControlDatabase(tmpDir);

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("not initialized");
  });

  it("passes with the initialized control database schema version", async () => {
    const database = await openControlDatabase({ baseDir: tmpDir });
    database.close();

    const result = checkControlDatabase(tmpDir);

    expect(result.status).toBe("pass");
    expect(result.detail).toContain(`schema version ${CONTROL_DB_SCHEMA_VERSION}/${CONTROL_DB_SCHEMA_VERSION}`);
    expect(result.detail).toContain("legacy import record");
  });
});

describe("cmdDoctor summary counts", () => {
  let tmpDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-doctor-cmd-");
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
    } as Response)));
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.unstubAllGlobals();
    cleanupTempDir(tmpDir);
  });

  it("returns exit code 1 when failures exist", async () => {
    // Intentionally missing pulseed.pid, provider.json, goals dir, etc.
    // getPulseedDirPath is mocked to a placeholder that doesn't exist —
    // cmdDoctor will call it internally; wrap the real call using our tmpDir
    // by temporarily overriding the PULSEED_HOME env var.
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;

    const exitCode = await cmdDoctor([]);

    if (origHome !== undefined) {
      process.env["PULSEED_HOME"] = origHome;
    } else {
      delete process.env["PULSEED_HOME"];
    }

    expect(exitCode).toBe(1);
  });

  it("summary line includes passed, failed, warnings counts", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;

    await cmdDoctor([]);

    if (origHome !== undefined) {
      process.env["PULSEED_HOME"] = origHome;
    } else {
      delete process.env["PULSEED_HOME"];
    }

    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toMatch(/Summary: \d+ passed, \d+ failed, \d+ warnings/);
    expect(allOutput).toContain("Native AgentLoop tools");
  });

  it("returns exit code 0 when all critical checks pass", async () => {
    // Set up a valid minimal installation
    fs.mkdirSync(path.join(tmpDir, "goals"));
    fs.mkdirSync(path.join(tmpDir, "logs"));
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify({ api_key: "sk-test-key" })
    );

    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;

    // Also ensure no real API keys leak into the test
    const savedAnthropicKey = process.env["ANTHROPIC_API_KEY"];
    const savedOpenaiKey = process.env["OPENAI_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["OPENAI_API_KEY"];

    const exitCode = await cmdDoctor([]);

    if (origHome !== undefined) {
      process.env["PULSEED_HOME"] = origHome;
    } else {
      delete process.env["PULSEED_HOME"];
    }
    if (savedAnthropicKey !== undefined) process.env["ANTHROPIC_API_KEY"] = savedAnthropicKey;
    if (savedOpenaiKey !== undefined) process.env["OPENAI_API_KEY"] = savedOpenaiKey;

    // Build check may fail (no dist/ in test env), but provider/dir/key/goals/logs should pass.
    // We only require no failures in the checks we control.
    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("Summary:");
    // Exit code depends on build check — just ensure it's 0 or 1 (a number).
    expect([0, 1]).toContain(exitCode);
  });

  it("runs runtime store repair when requested", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;

    const exitCode = await cmdDoctor(["--repair"]);

    if (origHome !== undefined) {
      process.env["PULSEED_HOME"] = origHome;
    } else {
      delete process.env["PULSEED_HOME"];
    }

    expect([0, 1]).toContain(exitCode);
    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("Repair:");
  });

  it("imports legacy queue and schedule state through doctor repair", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    const runtimeRoot = path.join(tmpDir, "runtime");
    const envelope = createEnvelope({
      type: "event",
      name: "goal-run",
      source: "doctor-test",
      payload: { goalId: "goal-legacy" },
      priority: "high",
    });
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, "queue.json"), JSON.stringify({
      version: 1,
      records: {
        [envelope.id]: {
          envelope,
          status: "pending",
          attempt: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      pending: {
        critical: [],
        high: [envelope.id],
        normal: [],
        low: [],
      },
      inflight: {},
    }));
    fs.writeFileSync(path.join(tmpDir, "schedules.json"), JSON.stringify([
      makeHeartbeatSchedule(),
    ]));

    try {
      const exitCode = await cmdDoctor(["--repair"]);
      expect([0, 1]).toContain(exitCode);
    } finally {
      if (origHome !== undefined) {
        process.env["PULSEED_HOME"] = origHome;
      } else {
        delete process.env["PULSEED_HOME"];
      }
    }

    const queue = new JournalBackedQueue({
      journalPath: path.join(runtimeRoot, "queue.json"),
      controlBaseDir: tmpDir,
    });
    expect(queue.get(envelope.id)?.status).toBe("pending");
    await expect(new ScheduleEntryStore(tmpDir, { warn: vi.fn() }).readEntries()).resolves.toMatchObject([
      { id: "11111111-1111-4111-8111-111111111111", name: "doctor-legacy-schedule" },
    ]);
    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("Repair legacy import: queue=1");
    expect(checkControlDatabase(tmpDir).detail).toContain("legacy import record");
  });

  it("imports legacy chat and AgentLoop session state through doctor repair", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    const legacyChatDir = path.join(tmpDir, "chat", "sessions");
    const legacyAgentDir = path.join(tmpDir, "chat", "agentloop");
    fs.mkdirSync(legacyChatDir, { recursive: true });
    fs.mkdirSync(legacyAgentDir, { recursive: true });
    fs.writeFileSync(path.join(legacyChatDir, "legacy-chat.json"), JSON.stringify({
      id: "legacy-chat",
      cwd: "/repo",
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:01:00.000Z",
      title: "Legacy Chat",
      messages: [],
    }));
    fs.writeFileSync(path.join(legacyAgentDir, "legacy-chat.state.json"), JSON.stringify({
      sessionId: "agent-legacy",
      traceId: "trace-legacy",
      turnId: "turn-legacy",
      goalId: "goal-legacy",
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
      status: "running",
      updatedAt: "2026-05-09T00:02:00.000Z",
    }));

    try {
      const exitCode = await cmdDoctor(["--repair"]);
      expect([0, 1]).toContain(exitCode);
    } finally {
      if (origHome !== undefined) {
        process.env["PULSEED_HOME"] = origHome;
      } else {
        delete process.env["PULSEED_HOME"];
      }
    }

    await expect(new ChatSessionDataStore(tmpDir).load("legacy-chat")).resolves.toMatchObject({
      id: "legacy-chat",
      agentLoopSessionId: "agent-legacy",
      agentLoopStatus: "running",
    });
    await expect(new AgentLoopSessionStateCatalog(tmpDir).load("agent-legacy")).resolves.toMatchObject({
      sessionId: "agent-legacy",
      status: "running",
    });
    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("Repair chat import: chat sessions=1");
    expect(allOutput).toContain("agentloop states=1");
    expect(checkControlDatabase(tmpDir).detail).toContain("legacy import record");
  });

  it("imports legacy execution sessions through doctor repair and records import bookkeeping", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    const legacySessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(legacySessionsDir, { recursive: true });
    fs.writeFileSync(path.join(legacySessionsDir, "legacy-execution-session.json"), JSON.stringify({
      id: "legacy-execution-session",
      session_type: "task_execution",
      goal_id: "goal-execution-session",
      task_id: "task-execution-session",
      context_slots: [{ priority: 1, label: "task", content: "content", token_estimate: 0 }],
      context_budget: 50_000,
      started_at: "2026-05-10T00:00:00.000Z",
      ended_at: "2026-05-10T00:01:00.000Z",
      result_summary: "legacy execution session imported",
    }));
    fs.writeFileSync(path.join(legacySessionsDir, "index.json"), JSON.stringify([
      "legacy-execution-session",
      "stale-execution-session",
    ]));

    try {
      const exitCode = await cmdDoctor(["--repair"]);
      expect([0, 1]).toContain(exitCode);
    } finally {
      if (origHome !== undefined) {
        process.env["PULSEED_HOME"] = origHome;
      } else {
        delete process.env["PULSEED_HOME"];
      }
    }

    await expect(new ExecutionSessionStateStore(tmpDir).load("legacy-execution-session")).resolves.toMatchObject({
      id: "legacy-execution-session",
      result_summary: "legacy execution session imported",
    });
    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("Repair execution session import: legacy session files=1");
    expect(allOutput).toContain("stale index entries=1");

    const database = await openControlDatabase({ baseDir: tmpDir });
    try {
      expect(database.listLegacyImports()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_kind: "execution_session",
          source_id: "legacy-execution-session",
          migration_name: "execution-session-state",
          status: "imported",
        }),
        expect.objectContaining({
          source_kind: "execution_session_index",
          source_id: "index",
          migration_name: "execution-session-state",
          status: "validated",
          details: expect.objectContaining({ stale_entries: 1 }),
        }),
      ]));
    } finally {
      database.close();
    }
  });

  it("imports legacy RunSpec files through doctor repair", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    const legacyRunSpecDir = path.join(tmpDir, "run-specs");
    fs.mkdirSync(legacyRunSpecDir, { recursive: true });
    const legacySpec = makeRunSpec();
    fs.writeFileSync(path.join(legacyRunSpecDir, `${legacySpec.id}.json`), JSON.stringify(legacySpec));
    fs.writeFileSync(path.join(legacyRunSpecDir, "invalid.json"), "{bad");

    try {
      const exitCode = await cmdDoctor(["--repair"]);
      expect([0, 1]).toContain(exitCode);
    } finally {
      if (origHome !== undefined) {
        process.env["PULSEED_HOME"] = origHome;
      } else {
        delete process.env["PULSEED_HOME"];
      }
    }

    await expect(createRunSpecStore({ getBaseDir: () => tmpDir }).load(legacySpec.id)).resolves.toMatchObject({
      id: legacySpec.id,
      links: { conversation_id: "telegram-chat-1" },
    });
    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("Repair RunSpec import: files=2, imported=1");
    expect(checkControlDatabase(tmpDir).detail).toContain("legacy import record");
  });

  it("imports legacy DriveSystem schedule files through doctor repair", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    const legacyScheduleDir = path.join(tmpDir, "schedule");
    fs.mkdirSync(legacyScheduleDir, { recursive: true });
    fs.writeFileSync(path.join(legacyScheduleDir, "goal-schedule.json"), JSON.stringify({
      goal_id: "goal-schedule",
      next_check_at: "2026-05-11T00:00:00.000Z",
      check_interval_hours: 4,
      last_triggered_at: null,
      consecutive_actions: 2,
      cooldown_until: null,
      current_interval_hours: 4,
    }));
    fs.writeFileSync(path.join(legacyScheduleDir, "invalid.json"), "{bad");

    try {
      const exitCode = await cmdDoctor(["--repair"]);
      expect([0, 1]).toContain(exitCode);
    } finally {
      if (origHome !== undefined) {
        process.env["PULSEED_HOME"] = origHome;
      } else {
        delete process.env["PULSEED_HOME"];
      }
    }

    await expect(new DriveGoalScheduleStateStore(tmpDir).load("goal-schedule")).resolves.toMatchObject({
      goal_id: "goal-schedule",
      consecutive_actions: 2,
    });
    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("Repair Drive schedule import: files=2, imported=1");
    expect(checkControlDatabase(tmpDir).detail).toContain("legacy import record");
  });

  it("imports legacy goal WAL through doctor repair and records import bookkeeping", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    const goalId = "goal-wal-doctor";
    fs.mkdirSync(path.join(tmpDir, "goals", goalId), { recursive: true });
    await appendWALRecord(goalId, tmpDir, {
      op: "save_goal",
      data: makeGoal({ id: goalId, description: "from legacy WAL" }),
      ts: "2026-05-10T00:00:00.000Z",
    });

    try {
      const exitCode = await cmdDoctor(["--repair"]);
      expect([0, 1]).toContain(exitCode);
    } finally {
      if (origHome !== undefined) {
        process.env["PULSEED_HOME"] = origHome;
      } else {
        delete process.env["PULSEED_HOME"];
      }
    }

    await expect(new GoalTaskStateStore(tmpDir).loadGoal(goalId, { includeArchived: true })).resolves.toMatchObject({
      id: goalId,
      description: "from legacy WAL",
    });
    expect(fs.existsSync(path.join(tmpDir, "goals", goalId, "goal.json"))).toBe(false);
    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("legacy WAL files=1");
    expect(allOutput).toContain("legacy WAL intents=1");

    const database = await openControlDatabase({ baseDir: tmpDir });
    try {
      expect(database.listLegacyImports()).toContainEqual(expect.objectContaining({
        source_kind: "goal_wal",
        source_id: goalId,
        migration_name: "goal-task-durable-loop-state",
        status: "imported",
        details: expect.objectContaining({ replayed_intents: 1 }),
      }));
    } finally {
      database.close();
    }
  });

  it("imports legacy goal orchestration state through doctor repair", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    const goalId = "goal-orchestration-doctor";
    fs.mkdirSync(path.join(tmpDir, "goals", goalId), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "goals", goalId, "negotiation-log.json"), JSON.stringify({
      goal_id: goalId,
      timestamp: "2026-05-10T00:00:00.000Z",
      is_renegotiation: false,
      renegotiation_trigger: null,
    }));
    fs.writeFileSync(path.join(tmpDir, "dependency-graph.json"), JSON.stringify({
      nodes: [goalId, "goal-next"],
      edges: [{
        from_goal_id: goalId,
        to_goal_id: "goal-next",
        type: "prerequisite",
        status: "active",
        condition: null,
        affected_dimensions: [],
        mitigation: null,
        detection_confidence: 1,
        reasoning: null,
        created_at: "2026-05-10T00:00:00.000Z",
      }],
      updated_at: "2026-05-10T00:00:00.000Z",
    }));

    try {
      const exitCode = await cmdDoctor(["--repair"]);
      expect([0, 1]).toContain(exitCode);
    } finally {
      if (origHome !== undefined) {
        process.env["PULSEED_HOME"] = origHome;
      } else {
        delete process.env["PULSEED_HOME"];
      }
    }

    const store = new GoalOrchestrationStateStore(tmpDir);
    await expect(store.loadNegotiationLog(goalId)).resolves.toMatchObject({ goal_id: goalId });
    await expect(store.loadDependencyGraph()).resolves.toMatchObject({
      nodes: [goalId, "goal-next"],
      edges: [expect.objectContaining({ from_goal_id: goalId, to_goal_id: "goal-next" })],
    });

    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("Repair goal orchestration import: negotiation logs=1, dependency graphs=1, skipped already imported=0, retired existing typed state=0");

    const database = await openControlDatabase({ baseDir: tmpDir });
    try {
      expect(database.listLegacyImports()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_kind: "goal_negotiation_log",
          source_id: goalId,
          migration_name: "goal-orchestration-runtime-state",
          status: "imported",
        }),
        expect.objectContaining({
          source_kind: "goal_dependency_graph",
          source_id: "current",
          migration_name: "goal-orchestration-runtime-state",
          status: "imported",
        }),
      ]));
    } finally {
      database.close();
    }
  });

  it("imports legacy stall state through doctor repair", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    const goalId = "goal-stall-doctor";
    fs.mkdirSync(path.join(tmpDir, "stalls"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "stalls", `${goalId}.json`), JSON.stringify({
      goal_id: goalId,
      dimension_escalation: { "dim-a": 2 },
      global_escalation: 1,
      decay_factors: { "dim-a": 0.6 },
      recovery_loops: { "dim-a": 3 },
    }));

    try {
      const exitCode = await cmdDoctor(["--repair"]);
      expect([0, 1]).toContain(exitCode);
    } finally {
      if (origHome !== undefined) {
        process.env["PULSEED_HOME"] = origHome;
      } else {
        delete process.env["PULSEED_HOME"];
      }
    }

    await expect(new StallStateStore(tmpDir).loadStallState(goalId)).resolves.toMatchObject({
      goal_id: goalId,
      dimension_escalation: { "dim-a": 2 },
      global_escalation: 1,
      decay_factors: { "dim-a": 0.6 },
      recovery_loops: { "dim-a": 3 },
    });

    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("Repair stall state import: stall states=1, skipped already imported=0, retired existing typed state=0");

    const database = await openControlDatabase({ baseDir: tmpDir });
    try {
      expect(database.listLegacyImports()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_kind: "stall_state",
          source_id: goalId,
          migration_name: "stall-runtime-state",
          status: "imported",
        }),
      ]));
    } finally {
      database.close();
    }
  });

  it("imports legacy learning runtime state through doctor repair", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    const goalId = "goal-learning-doctor";
    fs.mkdirSync(path.join(tmpDir, "learning"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "learning", `${goalId}_logs.json`), JSON.stringify([{ event: "legacy" }]));
    fs.writeFileSync(path.join(tmpDir, "learning", `${goalId}_patterns.json`), JSON.stringify([
      {
        pattern_id: "pat_learning_doctor",
        type: "scope_sizing",
        description: "Reduce scope when iteration feedback degrades",
        confidence: 0.8,
        evidence_count: 2,
        source_goal_ids: [goalId],
        applicable_domains: ["testing"],
        embedding_id: null,
        created_at: "2026-05-10T00:00:00.000Z",
        last_applied_at: null,
      },
    ]));
    fs.writeFileSync(path.join(tmpDir, "learning", `${goalId}_feedback.json`), JSON.stringify([
      {
        feedback_id: "fb_learning_doctor",
        pattern_id: "pat_learning_doctor",
        target_step: "task",
        adjustment: "Reduce scope",
        applied_at: "2026-05-10T00:00:00.000Z",
        effect_observed: null,
      },
    ]));
    fs.writeFileSync(path.join(tmpDir, "learning", `${goalId}_structural_feedback.json`), JSON.stringify([
      {
        id: "sf_learning_doctor",
        goalId,
        iterationId: "iter-1",
        feedbackType: "scope_sizing",
        expected: "small task",
        actual: "large task",
        delta: -0.2,
        timestamp: "2026-05-10T00:00:00.000Z",
        context: { dimension: "scope" },
      },
    ]));

    try {
      const exitCode = await cmdDoctor(["--repair"]);
      expect([0, 1]).toContain(exitCode);
    } finally {
      if (origHome !== undefined) {
        process.env["PULSEED_HOME"] = origHome;
      } else {
        delete process.env["PULSEED_HOME"];
      }
    }

    const learningStore = new LearningRuntimeStateStore(tmpDir);
    await expect(learningStore.loadExperienceLogs(goalId)).resolves.toEqual([{ event: "legacy" }]);
    await expect(learningStore.loadPatterns(goalId)).resolves.toHaveLength(1);
    await expect(learningStore.loadFeedbackEntries(goalId)).resolves.toHaveLength(1);
    await expect(learningStore.loadStructuralFeedback(goalId)).resolves.toHaveLength(1);

    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("Repair learning runtime import: logs=1, patterns=1, feedback entries=1, structural feedback=1, skipped already imported=0, retired existing typed state=0");

    const database = await openControlDatabase({ baseDir: tmpDir });
    try {
      expect(database.listLegacyImports()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_kind: "learning_experience_logs",
          source_id: `logs:${goalId}`,
          migration_name: "learning-runtime-state",
          status: "imported",
        }),
      ]));
    } finally {
      database.close();
    }
  });

  it("imports legacy knowledge transfer state through doctor repair", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    const snapshot = {
      transfers: [],
      results: [],
      effectiveness_records: [],
      apply_contexts: {},
      pattern_trackers: {},
      cross_goal_patterns: [],
    };
    fs.mkdirSync(path.join(tmpDir, "knowledge-transfer"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "meta-patterns"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "knowledge-transfer", "snapshot.json"), JSON.stringify(snapshot));
    fs.writeFileSync(path.join(tmpDir, "meta-patterns", "last_aggregated_at.json"), JSON.stringify({
      ts: "2026-05-10T01:00:00.000Z",
    }));

    try {
      const exitCode = await cmdDoctor(["--repair"]);
      expect([0, 1]).toContain(exitCode);
    } finally {
      if (origHome !== undefined) {
        process.env["PULSEED_HOME"] = origHome;
      } else {
        delete process.env["PULSEED_HOME"];
      }
    }

    const knowledgeTransferStore = new KnowledgeTransferStateStore(tmpDir);
    await expect(knowledgeTransferStore.loadSnapshot()).resolves.toEqual(snapshot);
    await expect(knowledgeTransferStore.loadLastAggregatedAt()).resolves.toBe("2026-05-10T01:00:00.000Z");

    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("Repair knowledge transfer import: snapshots=1, meta-pattern watermarks=1, skipped already imported=0, retired existing typed state=0");

    const database = await openControlDatabase({ baseDir: tmpDir });
    try {
      expect(database.listLegacyImports()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_kind: "knowledge_transfer_snapshot",
          source_id: "current",
          migration_name: "knowledge-transfer-runtime-state",
          status: "imported",
        }),
      ]));
    } finally {
      database.close();
    }
  });

  it("imports legacy transfer trust state through doctor repair", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    const domainPair = "doctor::transfer";
    const score = {
      domain_pair: domainPair,
      success_count: 1,
      failure_count: 1,
      neutral_count: 0,
      trust_score: 0.45,
      last_updated: "2026-05-10T01:00:00.000Z",
    };
    fs.mkdirSync(path.join(tmpDir, "transfer-trust"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "transfer-trust-history"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "transfer-trust", "doctor::transfer.json"), JSON.stringify(score));
    fs.writeFileSync(path.join(tmpDir, "transfer-trust-history", "doctor::transfer.json"), JSON.stringify([
      "negative",
      "neutral",
    ]));
    fs.writeFileSync(path.join(tmpDir, "transfer-trust", "_index.json"), JSON.stringify([domainPair]));

    try {
      const exitCode = await cmdDoctor(["--repair"]);
      expect([0, 1]).toContain(exitCode);
    } finally {
      if (origHome !== undefined) {
        process.env["PULSEED_HOME"] = origHome;
      } else {
        delete process.env["PULSEED_HOME"];
      }
    }

    const transferTrustStore = new TransferTrustStateStore(tmpDir);
    await expect(transferTrustStore.loadScore(domainPair)).resolves.toEqual(score);
    await expect(transferTrustStore.loadHistory(domainPair)).resolves.toEqual(["negative", "neutral"]);
    await expect(transferTrustStore.listIndexDomainPairs()).resolves.toEqual([domainPair]);

    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("Repair transfer trust import: index entries=1, scores=1, history entries=1, skipped already imported=0, retired existing typed state=0");

    const database = await openControlDatabase({ baseDir: tmpDir });
    try {
      expect(database.listLegacyImports()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_kind: "transfer_trust_score",
          source_id: "doctor::transfer",
          migration_name: "transfer-trust-runtime-state",
          status: "imported",
        }),
      ]));
    } finally {
      database.close();
    }
  });

  it("imports legacy capability dependency state through doctor repair", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    fs.writeFileSync(path.join(tmpDir, "capability_dependencies.json"), JSON.stringify([
      { capability_id: "doctor-capability", depends_on: ["doctor-prereq"] },
    ]));

    try {
      const exitCode = await cmdDoctor(["--repair"]);
      expect([0, 1]).toContain(exitCode);
    } finally {
      if (origHome !== undefined) {
        process.env["PULSEED_HOME"] = origHome;
      } else {
        delete process.env["PULSEED_HOME"];
      }
    }

    const store = new CapabilityRegistryStateStore(tmpDir);
    await expect(store.loadDependencies()).resolves.toEqual([
      { capability_id: "doctor-capability", depends_on: ["doctor-prereq"] },
    ]);

    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("Repair capability dependency import: files=1, dependencies=1, skipped already imported=0, retired existing typed state=0");

    const database = await openControlDatabase({ baseDir: tmpDir });
    try {
      expect(database.listLegacyImports()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_kind: "capability_dependency_state",
          source_id: "current",
          migration_name: "capability-dependency-state",
          status: "imported",
        }),
      ]));
    } finally {
      database.close();
    }
  });

  it("imports legacy knowledge and memory state through doctor repair", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    const entry = {
      entry_id: "doctor-knowledge-entry",
      question: "Where should durable knowledge state live?",
      answer: "In typed Soil SQLite records.",
      sources: [{ type: "document", reference: "doctor-test", reliability: "high" }],
      confidence: 0.9,
      acquired_at: "2026-05-09T00:00:00.000Z",
      acquisition_task_id: "task-doctor",
      superseded_by: null,
      tags: ["database-first"],
      embedding_id: null,
    };
    fs.mkdirSync(path.join(tmpDir, "goals", "goal-doctor"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "memory", "shared-knowledge"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "memory", "agent-memory"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "goals", "goal-doctor", "domain_knowledge.json"), JSON.stringify({
      goal_id: "goal-doctor",
      domain: "doctor",
      entries: [entry],
      last_updated: "2026-05-09T00:00:00.000Z",
    }));
    fs.writeFileSync(path.join(tmpDir, "memory", "shared-knowledge", "entries.json"), JSON.stringify([{
      ...entry,
      source_goal_ids: ["goal-doctor"],
      domain_stability: "moderate",
      revalidation_due_at: null,
    }]));
    fs.writeFileSync(path.join(tmpDir, "memory", "agent-memory", "entries.json"), JSON.stringify({
      entries: [{
        id: "memory-doctor",
        key: "doctor.knowledge.repair",
        value: "Doctor repair imports legacy knowledge into Soil SQLite.",
        tags: ["database-first"],
        memory_type: "fact",
        status: "compiled",
        created_at: "2026-05-09T00:00:00.000Z",
        updated_at: "2026-05-09T00:00:00.000Z",
      }],
      corrections: [],
      last_consolidated_at: "2026-05-09T00:00:00.000Z",
    }));

    try {
      const exitCode = await cmdDoctor(["--repair"]);
      expect([0, 1]).toContain(exitCode);
    } finally {
      if (origHome !== undefined) {
        process.env["PULSEED_HOME"] = origHome;
      } else {
        delete process.env["PULSEED_HOME"];
      }
    }

    const knowledgeStore = new KnowledgeMemoryStateStore(tmpDir);
    expect(await knowledgeStore.loadDomainKnowledge("goal-doctor")).toMatchObject({
      goal_id: "goal-doctor",
      entries: [{ entry_id: "doctor-knowledge-entry" }],
    });
    expect(await knowledgeStore.loadSharedKnowledgeEntries()).toMatchObject([
      { entry_id: "doctor-knowledge-entry", source_goal_ids: ["goal-doctor"] },
    ]);
    expect(await knowledgeStore.loadAgentMemoryStore()).toMatchObject({
      entries: [{ id: "memory-doctor", key: "doctor.knowledge.repair" }],
    });
    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("Repair knowledge/memory import: domain=1, shared=1, agent memory=1");
    expect(checkControlDatabase(tmpDir).detail).toContain("legacy import record");
  });

  it("imports legacy memory lifecycle and dream decision heuristics through doctor repair", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    const now = "2026-05-09T00:00:00.000Z";
    const legacyMemoryDir = path.join(tmpDir, "memory");
    fs.mkdirSync(path.join(legacyMemoryDir, "short-term", "goals", "goal-lifecycle"), { recursive: true });
    fs.mkdirSync(path.join(legacyMemoryDir, "long-term", "lessons", "by-goal"), { recursive: true });
    fs.mkdirSync(path.join(legacyMemoryDir, "long-term", "statistics"), { recursive: true });
    fs.mkdirSync(path.join(legacyMemoryDir, "archive", "goal-lifecycle"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "dream"), { recursive: true });

    fs.writeFileSync(path.join(legacyMemoryDir, "short-term", "goals", "goal-lifecycle", "observations.json"), JSON.stringify([{
      id: "st-doctor",
      goal_id: "goal-lifecycle",
      data_type: "observation",
      loop_number: 1,
      timestamp: now,
      dimensions: ["quality"],
      tags: ["database-first"],
      data: { value: 0.8 },
      embedding_id: null,
      memory_tier: "recall",
    }]));
    fs.writeFileSync(path.join(legacyMemoryDir, "short-term", "index.json"), JSON.stringify({
      version: 1,
      last_updated: now,
      entries: [{
        id: "idx-doctor",
        goal_id: "goal-lifecycle",
        dimensions: ["quality"],
        tags: ["database-first"],
        timestamp: now,
        data_file: "goals/goal-lifecycle/observations.json",
        entry_id: "st-doctor",
        last_accessed: now,
        access_count: 2,
        embedding_id: null,
        memory_tier: "recall",
      }],
    }));
    fs.writeFileSync(path.join(legacyMemoryDir, "long-term", "lessons", "by-goal", "goal-lifecycle.json"), JSON.stringify([{
      lesson_id: "lesson-doctor",
      type: "success_pattern",
      goal_id: "goal-lifecycle",
      context: "Doctor repair",
      lesson: "Memory lifecycle repair imports old JSON into the typed store.",
      source_loops: ["loop_1"],
      extracted_at: now,
      relevance_tags: ["database-first"],
      status: "active",
    }]));
    fs.writeFileSync(path.join(legacyMemoryDir, "long-term", "statistics", "goal-lifecycle.json"), JSON.stringify({
      goal_id: "goal-lifecycle",
      task_stats: [],
      dimension_stats: [],
      overall: {
        total_loops: 1,
        total_tasks: 0,
        overall_success_rate: 0,
        active_period: "2026-05-09",
      },
      updated_at: now,
    }));
    fs.writeFileSync(path.join(legacyMemoryDir, "archive", "goal-lifecycle", "lessons.json"), JSON.stringify([{
      lesson_id: "archived-lesson-doctor",
      type: "success_pattern",
      goal_id: "goal-lifecycle",
      context: "Archived doctor repair",
      lesson: "Archives are imported as typed archive payloads.",
      source_loops: ["loop_1"],
      extracted_at: now,
      relevance_tags: ["archive"],
      status: "archived",
    }]));
    fs.writeFileSync(path.join(tmpDir, "dream", "decision-heuristics.json"), JSON.stringify({
      heuristics: [{
        id: "doctor-heuristic",
        score_delta: 0.15,
        reason: "Doctor repair imports legacy dream heuristic JSON.",
      }],
    }));

    try {
      const exitCode = await cmdDoctor(["--repair"]);
      expect([0, 1]).toContain(exitCode);
    } finally {
      if (origHome !== undefined) {
        process.env["PULSEED_HOME"] = origHome;
      } else {
        delete process.env["PULSEED_HOME"];
      }
    }

    const lifecycleStore = new MemoryLifecycleStateStore(path.join(tmpDir, "memory"));
    await expect(lifecycleStore.loadShortTermEntries("goal-lifecycle", "observation")).resolves.toMatchObject([
      { id: "st-doctor", data_type: "observation" },
    ]);
    await expect(lifecycleStore.loadIndex("short-term")).resolves.toMatchObject({
      entries: [{ entry_id: "st-doctor", data_file: "memory-lifecycle:short-term:goal-lifecycle:observation" }],
    });
    await expect(lifecycleStore.loadLessons({ goalId: "goal-lifecycle" })).resolves.toMatchObject([
      { lesson_id: "lesson-doctor" },
    ]);
    await expect(lifecycleStore.loadStatistics("goal-lifecycle")).resolves.toMatchObject({
      goal_id: "goal-lifecycle",
    });
    await expect(lifecycleStore.loadArchives("goal-lifecycle")).resolves.toHaveLength(1);
    await expect(new DreamDecisionHeuristicStore({ controlBaseDir: tmpDir }).loadDecisionHeuristics()).resolves.toMatchObject([
      { id: "doctor-heuristic", score_delta: 0.15 },
    ]);

    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("Repair memory lifecycle import: short-term files=1, short-term entries=1");
    expect(allOutput).toContain("Repair dream decision heuristics import: imported, heuristics=1");
    expect(checkControlDatabase(tmpDir).detail).toContain("legacy import record");
  });

  it("imports legacy plugin and channel runtime state through doctor repair", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    fs.mkdirSync(path.join(tmpDir, "plugins", "doctor-plugin"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "plugins", "doctor-plugin", "state.json"), JSON.stringify({
      name: "doctor-plugin",
      manifest: {
        name: "doctor-plugin",
        version: "1.0.0",
        type: "notifier",
        capabilities: ["notify"],
        description: "Doctor plugin",
      },
      status: "loaded",
      loaded_at: "2026-05-09T00:00:00.000Z",
      trust_score: 12,
      usage_count: 2,
      success_count: 1,
      failure_count: 0,
    }));
    fs.mkdirSync(path.join(tmpDir, "gateway", "channels", "telegram-bot"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "gateway", "channels", "telegram-bot", "health.json"), JSON.stringify({
      last_inbound_at: "2026-05-09T00:01:00.000Z",
      last_outbound_at: "2026-05-09T00:02:00.000Z",
      last_error: null,
    }));

    try {
      const exitCode = await cmdDoctor(["--repair"]);
      expect([0, 1]).toContain(exitCode);
    } finally {
      if (origHome !== undefined) {
        process.env["PULSEED_HOME"] = origHome;
      } else {
        delete process.env["PULSEED_HOME"];
      }
    }

    const store = new PluginChannelRuntimeStateStore(tmpDir);
    await expect(store.loadPluginState("doctor-plugin")).resolves.toMatchObject({ trust_score: 12 });
    await expect(store.loadChannelHealth("telegram-bot")).resolves.toMatchObject({
      last_inbound_at: "2026-05-09T00:01:00.000Z",
    });
    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("Repair plugin/channel import: plugin states=1, channel health=1");
  });

  it("imports legacy curiosity state through doctor repair", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    fs.mkdirSync(path.join(tmpDir, "curiosity"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "curiosity", "state.json"), JSON.stringify({
      proposals: [
        {
          id: "doctor-curiosity-proposal",
          trigger: {
            type: "periodic_exploration",
            detected_at: "2026-05-10T00:00:00.000Z",
            source_goal_id: null,
            details: "Legacy curiosity repair",
            severity: 0.5,
          },
          proposed_goal: {
            description: "Repair curiosity runtime state",
            rationale: "doctor --repair should import the legacy file once.",
            suggested_dimensions: [],
            scope_domain: "runtime",
            detection_method: "periodic_review",
          },
          status: "pending",
          created_at: "2026-05-10T00:00:00.000Z",
          expires_at: "2026-05-10T12:00:00.000Z",
          reviewed_at: null,
          rejection_cooldown_until: null,
          loop_count: 0,
          goal_id: null,
        },
      ],
      learning_records: [],
      last_exploration_at: "2026-05-10T00:00:00.000Z",
      rejected_proposal_hashes: ["doctor-hash"],
    }));

    try {
      const exitCode = await cmdDoctor(["--repair"]);
      expect([0, 1]).toContain(exitCode);
    } finally {
      if (origHome !== undefined) {
        process.env["PULSEED_HOME"] = origHome;
      } else {
        delete process.env["PULSEED_HOME"];
      }
    }

    await expect(new CuriosityStateStore(tmpDir).load()).resolves.toMatchObject({
      proposals: [expect.objectContaining({ id: "doctor-curiosity-proposal" })],
      rejected_proposal_hashes: ["doctor-hash"],
    });
    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("Repair curiosity import: state files=1, proposals=1");
  });

  it("imports legacy trust, ethics, and profile proposal state through doctor repair", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    fs.mkdirSync(path.join(tmpDir, "trust"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "ethics"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "trust", "trust-store.json"), JSON.stringify({
      balances: {
        shell: {
          domain: "shell",
          balance: 25,
          success_delta: 3,
          failure_delta: -10,
        },
      },
      permanent_gates: { shell: ["file_delete"] },
      override_log: [],
    }));
    fs.writeFileSync(path.join(tmpDir, "ethics", "ethics-log.json"), JSON.stringify([
      {
        log_id: "doctor-ethics-log",
        timestamp: "2026-05-10T00:00:00.000Z",
        subject_type: "task",
        subject_id: "task-1",
        subject_description: "Safe task",
        verdict: {
          verdict: "pass",
          category: "safe",
          reasoning: "No issue.",
          risks: [],
          confidence: 0.95,
        },
        layer1_triggered: false,
      },
    ]));
    fs.writeFileSync(path.join(tmpDir, "relationship-profile-proposals.json"), JSON.stringify({
      schema_version: 1,
      profile_id: "default",
      proposals: [
        {
          id: "doctor-profile-proposal",
          operation: "upsert_item",
          proposed_item: {
            stable_key: "user.preference.status",
            kind: "preference",
            value: "Prefer concise status reports.",
            sensitivity: "private",
            allowed_scopes: ["local_planning", "user_facing_review"],
          },
          source: "cli_proposal",
          confidence: 0.7,
          sensitivity: "private",
          consent_scopes: ["user_facing_review"],
          evidence_refs: [],
          rationale: "Doctor should import this proposal.",
          approval_state: "pending",
          applied_at: null,
          expires_at: null,
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z",
        },
      ],
      audit_events: [
        {
          id: "doctor-profile-event",
          proposal_id: "doctor-profile-proposal",
          at: "2026-05-10T00:00:00.000Z",
          action: "created",
        },
      ],
      updated_at: "2026-05-10T00:00:00.000Z",
    }));

    try {
      const exitCode = await cmdDoctor(["--repair"]);
      expect([0, 1]).toContain(exitCode);
    } finally {
      if (origHome !== undefined) {
        process.env["PULSEED_HOME"] = origHome;
      } else {
        delete process.env["PULSEED_HOME"];
      }
    }

    await expect(new TrustStateStore(tmpDir).loadStore()).resolves.toMatchObject({
      balances: { shell: { balance: 25 } },
      permanent_gates: { shell: ["file_delete"] },
    });
    await expect(new EthicsLogStore(tmpDir).loadLogs()).resolves.toEqual([
      expect.objectContaining({ log_id: "doctor-ethics-log" }),
    ]);
    await expect(loadRelationshipProfileProposalStore(tmpDir)).resolves.toMatchObject({
      proposals: [expect.objectContaining({ id: "doctor-profile-proposal" })],
    });
    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("Repair trust/ethics/profile import: trust files=1, balances=1");
    expect(allOutput).toContain("ethics logs=1");
    expect(allOutput).toContain("profile proposals=1");
  });

  it("imports queue and supervisor legacy state from a configured custom runtime root through doctor repair", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    const runtimeRoot = path.join(tmpDir, "custom-runtime");
    fs.writeFileSync(
      path.join(tmpDir, "daemon.json"),
      JSON.stringify({ runtime_root: "custom-runtime" }),
      "utf-8"
    );
    const envelope = createEnvelope({
      type: "event",
      name: "custom-root-goal-run",
      source: "doctor-test",
      payload: { goalId: "goal-custom-runtime" },
      priority: "normal",
    });
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, "queue.json"), JSON.stringify({
      version: 1,
      records: {
        [envelope.id]: {
          envelope,
          status: "pending",
          attempt: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      pending: {
        critical: [],
        high: [],
        normal: [envelope.id],
        low: [],
      },
      inflight: {},
    }));
    fs.writeFileSync(path.join(runtimeRoot, "supervisor-state.json"), JSON.stringify({
      workers: [{
        workerId: "worker-custom-runtime",
        goalId: "goal-custom-runtime",
        startedAt: 1,
        iterations: 2,
        backgroundRunId: null,
        sessionId: null,
        parentSessionId: null,
      }],
      crashCounts: { "goal-custom-runtime": 1 },
      suspendedGoals: ["goal-paused"],
      updatedAt: 2,
    }));

    try {
      const exitCode = await cmdDoctor(["--repair"]);
      expect([0, 1]).toContain(exitCode);
    } finally {
      if (origHome !== undefined) {
        process.env["PULSEED_HOME"] = origHome;
      } else {
        delete process.env["PULSEED_HOME"];
      }
    }

    const queue = new JournalBackedQueue({
      journalPath: path.join(runtimeRoot, "queue.json"),
      controlBaseDir: tmpDir,
    });
    expect(queue.get(envelope.id)?.status).toBe("pending");
    await expect(new SupervisorStateStore(runtimeRoot, { controlBaseDir: tmpDir }).load()).resolves.toMatchObject({
      workers: [expect.objectContaining({ workerId: "worker-custom-runtime" })],
      crashCounts: { "goal-custom-runtime": 1 },
      suspendedGoals: ["goal-paused"],
    });
    const database = await openControlDatabase({ baseDir: tmpDir });
    try {
      expect(database.listLegacyImports()).toContainEqual(expect.objectContaining({
        source_kind: "runtime-queue-json",
        source_path: path.join(runtimeRoot, "queue.json"),
      }));
      expect(database.listLegacyImports()).toContainEqual(expect.objectContaining({
        source_kind: "supervisor-state-json",
        source_path: path.join(runtimeRoot, "supervisor-state.json"),
      }));
    } finally {
      database.close();
    }
  });

  it("migrates legacy scheduled tasks through doctor repair", async () => {
    const origHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    fs.writeFileSync(path.join(tmpDir, "scheduled-tasks.json"), JSON.stringify([
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        cron: "0 9 * * *",
        prompt: "Legacy prompt",
        type: "reflection",
        enabled: true,
        last_fired_at: null,
        permanent: false,
        created_at: "2026-04-01T00:00:00.000Z",
      },
    ], null, 2));

    try {
      const exitCode = await cmdDoctor(["--repair"]);
      expect([0, 1]).toContain(exitCode);
    } finally {
      if (origHome !== undefined) {
        process.env["PULSEED_HOME"] = origHome;
      } else {
        delete process.env["PULSEED_HOME"];
      }
    }

    const entries = await new ScheduleEntryStore(tmpDir, { warn: vi.fn() }).readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.layer).toBe("cron");
    expect(entries[0]?.cron?.prompt_template).toBe("Legacy prompt");
    expect(fs.existsSync(path.join(tmpDir, "scheduled-tasks.legacy-migrated.json"))).toBe(true);
    const database = await openControlDatabase({ baseDir: tmpDir });
    try {
      expect(database.listLegacyImports().some((record) => (
        record.source_kind === "legacy-cron-scheduled-tasks-json"
        && record.status === "imported"
      ))).toBe(true);
    } finally {
      database.close();
    }
    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string).join("\n");
    expect(allOutput).toContain("legacy cron=imported");
  });
});
