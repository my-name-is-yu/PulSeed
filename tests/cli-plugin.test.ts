/**
 * CLIRunner — plugin subcommand tests
 *
 * Verifies that `motiva plugin list`, `motiva plugin install`, and
 * `motiva plugin remove` work correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as yaml from "js-yaml";

// ─── Module mocks (must precede imports of mocked modules) ───────────────────

vi.mock("../src/core-loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core-loop.js")>();
  return { ...actual, CoreLoop: vi.fn() };
});

vi.mock("../src/goal/goal-negotiator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/goal/goal-negotiator.js")>();
  return { ...actual, GoalNegotiator: vi.fn() };
});

vi.mock("../src/llm/llm-client.js", () => ({
  LLMClient: vi.fn().mockImplementation(() => ({})),
  MockLLMClient: vi.fn(),
}));

vi.mock("../src/trust-manager.js", () => ({
  TrustManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/drive-system.js", () => ({
  DriveSystem: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/observation/observation-engine.js", () => ({
  ObservationEngine: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/stall-detector.js", () => ({
  StallDetector: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/satisficing-judge.js", () => ({
  SatisficingJudge: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/ethics-gate.js", () => ({
  EthicsGate: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/execution/session-manager.js", () => ({
  SessionManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/strategy/strategy-manager.js", () => ({
  StrategyManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/execution/adapter-layer.js", () => ({
  AdapterRegistry: vi.fn().mockImplementation(() => ({
    register: vi.fn(),
    getAdapterCapabilities: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock("../src/adapters/claude-code-cli.js", () => ({
  ClaudeCodeCLIAdapter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/adapters/claude-api.js", () => ({
  ClaudeAPIAdapter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/execution/task-lifecycle.js", () => ({
  TaskLifecycle: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/reporting-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/reporting-engine.js")>();
  return {
    ...actual,
    ReportingEngine: vi.fn().mockImplementation((...args) => new actual.ReportingEngine(...args)),
  };
});

vi.mock("../src/llm/provider-factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/provider-factory.js")>();
  return {
    ...actual,
    buildLLMClient: vi.fn().mockReturnValue({}),
    buildAdapterRegistry: vi.fn().mockReturnValue({
      register: vi.fn(),
      getAdapterCapabilities: vi.fn().mockReturnValue([]),
    }),
  };
});

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { cmdPluginList, cmdPluginInstall, cmdPluginRemove } from "../src/cli/commands/plugin.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface ManifestOverrides {
  name?: string;
  version?: string;
  type?: string;
  capabilities?: string[];
  description?: string;
  permissions?: Record<string, boolean>;
}

function writePluginManifest(dir: string, overrides: ManifestOverrides = {}): void {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    name: overrides.name ?? "test-plugin",
    version: overrides.version ?? "1.0.0",
    type: overrides.type ?? "notifier",
    capabilities: overrides.capabilities ?? ["notify"],
    description: overrides.description ?? "A test plugin",
    permissions: overrides.permissions ?? {},
  };
  fs.writeFileSync(path.join(dir, "plugin.yaml"), yaml.dump(manifest), "utf-8");
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

let tmpDir: string;
let pluginsDir: string;
let consoleLogs: string[];
let consoleErrors: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-plugin-test-"));
  pluginsDir = path.join(tmpDir, "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  consoleLogs = [];
  consoleErrors = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    consoleLogs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// ─── cmdPluginList ────────────────────────────────────────────────────────────

describe("cmdPluginList", () => {
  it("returns 0 and shows empty message when no plugins installed", async () => {
    const exitCode = await cmdPluginList(pluginsDir);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toMatch(/no plugins/i);
  });

  it("returns 0 and shows plugin name and version when plugins exist", async () => {
    writePluginManifest(path.join(pluginsDir, "my-notifier"), {
      name: "my-notifier",
      version: "2.3.1",
      type: "notifier",
      description: "Sends notifications",
    });

    const exitCode = await cmdPluginList(pluginsDir);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("my-notifier");
    expect(allOutput).toContain("2.3.1");
  });
});

// ─── cmdPluginInstall ─────────────────────────────────────────────────────────

describe("cmdPluginInstall", () => {
  it("returns 0 and creates plugin dir on successful install", async () => {
    const sourceDir = path.join(tmpDir, "source", "my-plugin");
    writePluginManifest(sourceDir, { name: "my-plugin", version: "1.0.0" });

    const exitCode = await cmdPluginInstall(pluginsDir, [sourceDir]);

    expect(exitCode).toBe(0);
    expect(fs.existsSync(path.join(pluginsDir, "my-plugin"))).toBe(true);
  });

  it("returns 1 when plugin already exists and --force not given", async () => {
    const sourceDir = path.join(tmpDir, "source", "existing-plugin");
    writePluginManifest(sourceDir, { name: "existing-plugin" });
    // Pre-create the destination to simulate already-installed
    fs.mkdirSync(path.join(pluginsDir, "existing-plugin"), { recursive: true });

    const exitCode = await cmdPluginInstall(pluginsDir, [sourceDir]);

    expect(exitCode).toBe(1);
    const allErrors = consoleErrors.join("\n");
    expect(allErrors).toMatch(/already (installed|exists)/i);
  });

  it("returns 0 and overwrites when plugin exists with --force", async () => {
    const sourceDir = path.join(tmpDir, "source", "existing-plugin");
    writePluginManifest(sourceDir, { name: "existing-plugin", version: "2.0.0" });
    fs.mkdirSync(path.join(pluginsDir, "existing-plugin"), { recursive: true });

    const exitCode = await cmdPluginInstall(pluginsDir, [sourceDir, "--force"]);

    expect(exitCode).toBe(0);
    expect(fs.existsSync(path.join(pluginsDir, "existing-plugin"))).toBe(true);
  });

  it("returns 1 when source path has no valid manifest", async () => {
    const sourceDir = path.join(tmpDir, "source", "bad-plugin");
    fs.mkdirSync(sourceDir, { recursive: true });
    // No plugin.yaml written

    const exitCode = await cmdPluginInstall(pluginsDir, [sourceDir]);

    expect(exitCode).toBe(1);
    const allErrors = consoleErrors.join("\n");
    expect(allErrors).toMatch(/manifest|not found|invalid/i);
  });

  it("returns 0 and shows shell warning when permissions.shell is true", async () => {
    const sourceDir = path.join(tmpDir, "source", "shell-plugin");
    writePluginManifest(sourceDir, {
      name: "shell-plugin",
      permissions: { shell: true },
    });

    const exitCode = await cmdPluginInstall(pluginsDir, [sourceDir]);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toMatch(/shell|warning/i);
  });

  it("returns 1 when source path argument is missing", async () => {
    const exitCode = await cmdPluginInstall(pluginsDir, []);

    expect(exitCode).toBe(1);
    const allErrors = consoleErrors.join("\n");
    expect(allErrors).toMatch(/path|required/i);
  });
});

// ─── cmdPluginRemove ──────────────────────────────────────────────────────────

describe("cmdPluginRemove", () => {
  it("returns 0 and deletes the plugin directory", async () => {
    const pluginDir = path.join(pluginsDir, "removable-plugin");
    writePluginManifest(pluginDir, { name: "removable-plugin" });

    const exitCode = cmdPluginRemove(pluginsDir, ["removable-plugin"]);

    expect(exitCode).toBe(0);
    expect(fs.existsSync(pluginDir)).toBe(false);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("removable-plugin");
    expect(allOutput).toMatch(/removed/i);
  });

  it("returns 1 when plugin does not exist", async () => {
    const exitCode = cmdPluginRemove(pluginsDir, ["nonexistent-plugin"]);

    expect(exitCode).toBe(1);
    const allErrors = consoleErrors.join("\n");
    expect(allErrors).toMatch(/not found|nonexistent-plugin/i);
  });

  it("returns 1 when name argument is missing", async () => {
    const exitCode = cmdPluginRemove(pluginsDir, []);

    expect(exitCode).toBe(1);
    const allErrors = consoleErrors.join("\n");
    expect(allErrors).toMatch(/name|required/i);
  });
});
