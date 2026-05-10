import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("database-first legacy store check", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".database-first-check-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fails new normal-path durable JSON runtime stores", () => {
    writeFile(tmpDir, "src/runtime/bad-store.ts", `
      import * as path from "node:path";
      export const queuePath = (root: string) => path.join(root, "queue.json");
      export const queueLogPath = (root: string) => path.join(root, "queue.jsonl");
      export const cachePath = (root: string) => path.join(root, "cache.json");
      export const runtimeStatePath = (root: string) => path.join(root, "runtime/state.json");
      export const arbitraryStatePath = (root: string, key: string) => \`state/\${key}.json\`;
      export const pluginStatePath = (pluginDir: string) => path.join(pluginDir, "state.json");
      export const sessionIndex = "sessions/index.json";
      export const wal = "wal.jsonl";
      export const currentGap = "gaps/goal-1/current.json";
    `);

    const result = runCheck(tmpDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("database-first legacy store check failed");
    expect(result.stderr).toContain("JournalBackedQueue SQLite queue table");
    expect(result.stderr).toContain("PluginChannelRuntimeStateStore or another typed runtime state store");
    expect(result.stderr).toContain("ExecutionSessionStateStore / control DB execution session tables");
    expect(result.stderr).toContain("Goal WAL control DB ownership");
    expect(result.stderr).toContain("StateManager typed gap history/current gap APIs");
    expect(result.stderr).toContain("direct filesystem runtime state must be typed SQLite/Soil or explicitly categorized");
    expect(result.stderr).toContain("Unclassified legacy store references must be moved to typed stores");
  });

  it("fails unclassified direct file owners for runtime cache, queue, and state directories", () => {
    writeFile(tmpDir, "src/runtime/unclassified-direct-file-owner.ts", `
      import * as path from "node:path";
      import * as fsp from "node:fs/promises";
      export async function persist(root: string, key: string, value: unknown) {
        const stateDir = path.join(root, "state");
        await fsp.mkdir(stateDir, { recursive: true });
        await fsp.writeFile(path.join(root, "cache.json"), JSON.stringify(value));
        await fsp.writeFile(path.join(root, "queue.jsonl"), JSON.stringify(value) + "\\n");
        await fsp.writeFile(path.join(stateDir, \`\${key}.json\`), JSON.stringify(value));
      }
    `);

    const result = runCheck(tmpDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/runtime/unclassified-direct-file-owner.ts");
    expect(result.stderr).toContain("[unclassified-direct-runtime-json-state] direct filesystem runtime state must be typed SQLite/Soil or explicitly categorized");
  });

  it("classifies reflection reports as direct typed-store debt", () => {
    writeFile(tmpDir, "src/reflection/reflection-utils.ts", `
      const reflectionsDir = "reflections";
      export const morning = \`morning-\${date}.json\`;
    `);

    const result = runCheck(tmpDir, ["--json"]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      allowlistReport: Array<{ id: string; category: string; nextSlice: number | null; matchCount: number }>;
      debtReport: Array<{ id: string; category: string; nextSlice: number | null; matchCount: number }>;
    };
    expect(parsed.allowlistReport).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "reflection-report-file-state",
        category: "typed-store migrate now",
        nextSlice: 7,
        matchCount: 2,
      }),
    ]));
    expect(parsed.debtReport).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "reflection-report-file-state",
        category: "typed-store migrate now",
        nextSlice: 7,
        matchCount: 2,
      }),
    ]));
  });


  it("allows explicit migration boundaries and file-backed config surfaces", () => {
    writeFile(tmpDir, "src/runtime/store/sample-migration.ts", `
      export const legacyPluginState = "state.json";
      export const legacyChannelHealth = "health.json";
    `);
    writeFile(tmpDir, "src/base/state/legacy-state-wal.ts", `
      export const legacyWalPath = "wal.jsonl";
    `);
    writeFile(tmpDir, "src/runtime/store/execution-session-state-migration.ts", `
      export const legacySessionIndex = "sessions/index.json";
      export const legacySessionPath = (sessionId: string) => \`sessions/\${sessionId}.json\`;
    `);
    writeFile(tmpDir, "src/runtime/channel-config.ts", `
      export const configPath = "gateway/channels/telegram-bot/config.json";
      export const pluginManifest = "plugin.json";
    `);

    const result = runCheck(tmpDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("database-first legacy store check passed");
  });

  it("fails path-shaped execution session owners outside the migration boundary", () => {
    writeFile(tmpDir, "src/orchestrator/execution/session-manager.ts", `
      export const sessionIndex = "sessions/index.json";
      export const sessionPath = (sessionId: string) => \`sessions/\${sessionId}.json\`;
    `);

    const result = runCheck(tmpDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/orchestrator/execution/session-manager.ts");
    expect(result.stderr).toContain("[execution-session-json] ExecutionSessionStateStore / control DB execution session tables");
    expect(result.stderr).toContain("Unclassified legacy store references must be moved to typed stores");
  });

  it("fails legacy DriveSystem schedule JSON owners outside the explicit repair boundary", () => {
    writeFile(tmpDir, "src/platform/drive/drive-system.ts", `
      import * as path from "node:path";
      import * as fsp from "node:fs/promises";
      export async function persistLegacySchedule(root: string, goalId: string, value: unknown) {
        const scheduleDir = path.join(root, "schedule");
        await fsp.mkdir(scheduleDir, { recursive: true });
        await fsp.writeFile(path.join(scheduleDir, \`\${goalId}.json\`), JSON.stringify(value));
      }
    `);

    const result = runCheck(tmpDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/platform/drive/drive-system.ts");
    expect(result.stderr).toContain("[drive-schedule-json-state] DriveSystem schedule typed control DB table");
    expect(result.stderr).toContain("Unclassified legacy store references must be moved to typed stores");
  });

  it("allows legacy DriveSystem schedule JSON only through the explicit repair import boundary", () => {
    writeFile(tmpDir, "src/platform/drive/drive-schedule-state-migration.ts", `
      export const legacyScheduleDir = "schedule";
      export const legacySchedulePath = "schedule/<goalId>.json";
    `);

    const result = runCheck(tmpDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("database-first legacy store check passed");
  });

  it("fails path-shaped goal task, checkpoint, pipeline, and wait metadata stores", () => {
    writeFile(tmpDir, "src/orchestrator/execution/legacy-normal-paths.ts", `
      export const taskPath = (goalId: string, taskId: string) => \`tasks/\${goalId}/\${taskId}.json\`;
      export const taskHistoryPath = (goalId: string) => \`tasks/\${goalId}/task-history.json\`;
      export const ledgerPath = (goalId: string, taskId: string) => \`tasks/\${goalId}/ledger/\${taskId}.json\`;
      export const pipelinePath = (taskId: string) => \`pipelines/\${taskId}.json\`;
      export const checkpointIndexPath = (goalId: string) => \`checkpoints/\${goalId}/index.json\`;
      export const checkpointPath = (goalId: string, checkpointId: string) => \`checkpoints/\${goalId}/\${checkpointId}.json\`;
      export const waitMetaPath = (goalId: string, strategyId: string) => \`strategies/\${goalId}/wait-meta/\${strategyId}.json\`;
    `);

    const result = runCheck(tmpDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[goal-task-json-state] GoalTaskStateStore");
    expect(result.stderr).toContain("[strategy-dream-json-state] StrategyDreamStateStore / runtime evidence DB stores");
    expect(result.stderr).toContain("Unclassified legacy store references must be moved to typed stores");
  });

  it("fails AgentLoop path-shaped resume and JSON/JSONL store owners outside migration tests", () => {
    writeFile(tmpDir, "src/orchestrator/execution/agent-loop/legacy-normal-session.ts", `
      export class JsonAgentLoopSessionStateStore {}
      export class JsonlAgentLoopTraceStore {}
      export const resume = (input: { resumeStatePath?: string }) => input.resumeStatePath;
    `);

    const result = runCheck(tmpDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/orchestrator/execution/agent-loop/legacy-normal-session.ts");
    expect(result.stderr).toContain("[agentloop-json-store-class] AgentLoop database session and trace stores");
    expect(result.stderr).toContain("[agentloop-path-shaped-resume] AgentLoop database session id resume contract");
    expect(result.stderr).toContain("Unclassified legacy store references must be moved to typed stores");
  });

  it("fails unclassified StateManager raw fallback callers even when the durable path is dynamic", () => {
    writeFile(tmpDir, "src/runtime/new-runtime-owner.ts", `
      export async function persist(stateManager: { readRaw(path: string): Promise<unknown>; writeRaw(path: string, value: unknown): Promise<void> }, key: string) {
        const existing = await stateManager.readRaw(key);
        await stateManager.writeRaw(key, { existing });
      }
    `);

    const result = runCheck(tmpDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/runtime/new-runtime-owner.ts");
    expect(result.stderr).toContain("[state-manager-raw-call] StateManager raw fallback boundary / typed store APIs");
    expect(result.stderr).toContain("Unclassified legacy store references must be moved to typed stores");
  });

  it("fails unclassified StateManager raw fallback callers even for config-shaped JSON names", () => {
    writeFile(tmpDir, "src/runtime/config-shaped-raw-owner.ts", `
      export async function persist(stateManager: { readRaw(path: string): Promise<unknown>; writeRaw(path: string, value: unknown): Promise<void> }) {
        const existing = await stateManager.readRaw("mcp-servers.json");
        await stateManager.writeRaw("config.json", { existing });
      }
    `);

    const result = runCheck(tmpDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/runtime/config-shaped-raw-owner.ts");
    expect(result.stderr).toContain("[state-manager-raw-call] StateManager raw fallback boundary / typed store APIs");
    expect(result.stderr).toContain("Unclassified legacy store references must be moved to typed stores");
  });

  it("fails completed raw fallback closure slices if raw callers are reintroduced", () => {
    writeFile(tmpDir, "src/orchestrator/goal/goal-negotiator.ts", `
      export async function load(stateManager: { readRaw(path: string): Promise<unknown> }, goalId: string) {
        return stateManager.readRaw(\`goals/\${goalId}/negotiation-log.json\`);
      }
      export async function save(stateManager: { writeRaw(path: string, value: unknown): Promise<void> }, goalId: string, log: unknown) {
        await stateManager.writeRaw(\`goals/\${goalId}/negotiation-log.json\`, log);
      }
    `);
    writeFile(tmpDir, "src/platform/traits/character-config.ts", `
      const CHARACTER_CONFIG_PATH = "character-config.json";
      export async function loadConfig(stateManager: { readRaw(path: string): Promise<unknown> }) {
        return stateManager.readRaw(CHARACTER_CONFIG_PATH);
      }
    `);

    const result = runCheck(tmpDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/orchestrator/goal/goal-negotiator.ts");
    expect(result.stderr).toContain("[state-manager-raw-call] StateManager raw fallback boundary / typed store APIs");
    expect(result.stderr).toContain("[goal-negotiation-log-json-state] Goal negotiation typed store / control DB negotiation log table");
    expect(result.stderr).toContain("Unclassified legacy store references must be moved to typed stores");
    expect(result.stderr).not.toContain("src/platform/traits/character-config.ts");
  });

  it("fails unexpected legacy store classes inside classified follow-up files", () => {
    writeFile(tmpDir, "src/orchestrator/execution/session-manager.ts", `
      export const wal = "wal.jsonl";
    `);

    const result = runCheck(tmpDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/orchestrator/execution/session-manager.ts");
    expect(result.stderr).toContain("[goal-wal-jsonl] Goal WAL control DB ownership");
    expect(result.stderr).toContain("Unclassified legacy store references must be moved to typed stores");
  });

  it("emits machine-readable final boundary report without treating artifacts as debt", () => {
    writeFile(tmpDir, "src/platform/dream/dream-consolidator/fs-metrics.ts", `
      export const diagnosticSessionLog = "session-logs.jsonl";
    `);

    const result = runCheck(tmpDir, ["--json"]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      allowlistReport: Array<{ id: string; category: string; nextSlice: number | null; matchCount: number }>;
      debtReport: Array<{ id: string; category: string; nextSlice: number | null; matchCount: number }>;
      directFileOwnerReport: Array<{ id: string; category: string; nextSlice: number | null; debt: boolean }>;
      directFileDebtReport: Array<{ id: string; category: string; nextSlice: number | null; debt: boolean }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.debtReport).toEqual([]);
    expect(parsed.directFileOwnerReport).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "run-spec-store" }),
    ]));
    expect(parsed.directFileOwnerReport).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "drive-system-event-spool",
        category: "bounded IPC/spool",
        nextSlice: 4,
        debt: false,
      }),
      expect.objectContaining({
        id: "config-setup-plugin-gateway-channel-files",
        category: "config/secret",
        nextSlice: 8,
        debt: false,
      }),
      expect.objectContaining({
        id: "reflection-reports",
        category: "typed-store migrate now",
        nextSlice: 7,
        debt: true,
      }),
    ]));
    expect(parsed.directFileDebtReport).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "run-spec-store" }),
    ]));
    expect(parsed.allowlistReport).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "dream-filesystem-metrics",
        category: "debug/export output",
        nextSlice: null,
        matchCount: 1,
      }),
    ]));
  });
});

function runCheck(rootDir: string, args: string[] = []): { status: number; stdout: string; stderr: string } {
  const scriptPath = path.resolve("scripts/check-database-first-legacy-stores.mjs");
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args, rootDir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const execError = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: execError.status ?? 1,
      stdout: execError.stdout ?? "",
      stderr: execError.stderr ?? "",
    };
  }
}

function writeFile(rootDir: string, relativePath: string, content: string): void {
  const filePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}
