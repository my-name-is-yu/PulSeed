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
    `);

    const result = runCheck(tmpDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("database-first legacy store check failed");
    expect(result.stderr).toContain("JournalBackedQueue SQLite queue table");
    expect(result.stderr).toContain("PluginChannelRuntimeStateStore");
  });

  it("allows explicit migration boundaries and file-backed config surfaces", () => {
    writeFile(tmpDir, "src/runtime/store/sample-migration.ts", `
      export const legacyPluginState = "state.json";
      export const legacyChannelHealth = "health.json";
    `);
    writeFile(tmpDir, "src/runtime/channel-config.ts", `
      export const configPath = "gateway/channels/telegram-bot/config.json";
      export const pluginManifest = "plugin.json";
    `);

    const result = runCheck(tmpDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("database-first legacy store check passed");
  });
});

function runCheck(rootDir: string): { status: number; stdout: string; stderr: string } {
  const scriptPath = path.resolve("scripts/check-database-first-legacy-stores.mjs");
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, rootDir], {
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
