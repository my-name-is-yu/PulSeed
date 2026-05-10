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
    expect(result.stderr).toContain("Unclassified legacy store references must be moved to typed stores");
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
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.debtReport).toEqual([]);
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
