import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { buildLLMClient } from "../../../base/llm/provider-factory.js";
import { loadProviderConfig, type ProviderConfig } from "../../../base/llm/provider-config.js";
import { getPulseedDirPath } from "../../../base/utils/paths.js";
import { writeJsonFileAtomic } from "../../../base/utils/json-io.js";
import type { Task } from "../../../base/types/task.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { createBuiltinTools } from "../../../tools/builtin/index.js";
import { ToolPermissionManager } from "../../../tools/permission.js";
import { ToolExecutor } from "../../../tools/executor.js";
import { ConcurrencyController } from "../../../tools/concurrency.js";
import { createNativeTaskAgentLoopRunner } from "./task-agent-loop-factory.js";
import type { AgentLoopResult } from "./agent-loop-result.js";
import type { TaskAgentLoopOutput } from "./task-agent-loop-result.js";
import {
  runTaskAgentLoopDogfoodBenchmark,
  type TaskAgentLoopDogfoodBenchmarkSummary,
  type TaskAgentLoopDogfoodCase,
} from "./agent-loop-dogfood-benchmark.js";

interface RealDogfoodCaseSpec {
  name: string;
  seed: (repoDir: string) => Promise<void>;
  task: Task;
  expectations: TaskAgentLoopDogfoodCase["expectations"];
}

interface RealDogfoodReport {
  status: "passed" | "failed" | "skipped";
  skippedReason?: string;
  provider: Pick<ProviderConfig, "provider" | "model" | "adapter" | "base_url"> & { has_api_key: boolean };
  outputDir: string;
  traceBaseDir: string;
  worktreeBaseDir: string;
  startedAt: string;
  completedAt: string;
  summary?: TaskAgentLoopDogfoodBenchmarkSummary;
  cases: Array<{ name: string; repoDir?: string }>;
}

interface RealDogfoodOptions {
  outputDir?: string;
  keepWorkspaces: boolean;
  caseLimit?: number;
  maxModelTurns?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
}

const SAFE_AGENT_LOOP_TOOLS = [
  "read",
  "grep",
  "glob",
  "list_dir",
  "apply_patch",
  "file_write",
  "file_edit",
  "shell_command",
  "git_diff",
  "json_query",
  "update_plan",
  "tool_search",
] as const;

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  const options = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(
    options.outputDir
    ?? process.env["PULSEED_AGENTLOOP_DOGFOOD_DIR"]
    ?? path.join(getPulseedDirPath(), "dogfood", "agentloop-real", timestampForPath(startedAt)),
  );
  const traceBaseDir = path.join(outputDir, "trace");
  const worktreeBaseDir = path.join(outputDir, "worktrees");
  const providerConfig = await loadProviderConfig();
  const cases: Array<{ name: string; repoDir?: string }> = [];

  await fsp.mkdir(outputDir, { recursive: true });

  const skipReason = skipReasonForProvider(providerConfig);
  if (skipReason) {
    await writeReport(outputDir, {
      status: "skipped",
      skippedReason: skipReason,
      provider: reportProvider(providerConfig),
      outputDir,
      traceBaseDir,
      worktreeBaseDir,
      startedAt,
      completedAt: new Date().toISOString(),
      cases,
    });
    console.log(`AgentLoop real dogfood skipped: ${skipReason}`);
    console.log(`Report: ${path.join(outputDir, "report.json")}`);
    return 0;
  }

  const llmClient = await buildLLMClient();
  const toolRegistry = new ToolRegistry();
  for (const tool of createBuiltinTools({ registry: toolRegistry })) {
    if (!toolRegistry.get(tool.metadata.name)) {
      toolRegistry.register(tool);
    }
  }
  const toolExecutor = new ToolExecutor({
    registry: toolRegistry,
    permissionManager: new ToolPermissionManager({
      allowRules: [{
        toolName: "shell_command",
        inputMatcher: isAllowedDogfoodShellCommand,
        reason: "AgentLoop real dogfood runs only focused local verification commands in temporary repos.",
      }],
    }),
    concurrency: new ConcurrencyController(),
  });
  const runner = createNativeTaskAgentLoopRunner({
    llmClient,
    providerConfig,
    toolRegistry,
    toolExecutor,
    traceBaseDir,
    defaultBudget: {
      maxModelTurns: options.maxModelTurns ?? 10,
      maxToolCalls: options.maxToolCalls ?? 16,
      maxWallClockMs: options.timeoutMs ?? 180_000,
      maxCompletionValidationAttempts: 2,
    },
    defaultToolPolicy: {
      allowedTools: SAFE_AGENT_LOOP_TOOLS,
      includeDeferred: false,
    },
    defaultWorktreePolicy: {
      enabled: true,
      baseDir: worktreeBaseDir,
      cleanupPolicy: options.keepWorkspaces ? "never" : "always",
      keepForDebug: options.keepWorkspaces,
    },
  });

  const specs = makeCaseSpecs().slice(0, options.caseLimit ?? 3);
  const benchmarkCases: TaskAgentLoopDogfoodCase[] = [];
  for (const spec of specs) {
    const repoDir = await createGitRepo(spec.name);
    await spec.seed(repoDir);
    await run("git", ["add", "."], repoDir);
    await run("git", ["commit", "-m", "seed"], repoDir);
    cases.push({ name: spec.name, repoDir });
    benchmarkCases.push({
      name: spec.name,
      expectations: spec.expectations,
      run: () => runTaskSafely(spec.name, () => runner.runTask({
          task: spec.task,
          cwd: repoDir,
          workspaceContext: "This is a temporary dogfood repository. Keep changes focused to the task. Use tools for file changes and verification.",
        })),
    });
  }

  const summary = await runTaskAgentLoopDogfoodBenchmark(benchmarkCases);
  const status = summary.ready ? "passed" : "failed";
  await writeReport(outputDir, {
    status,
    provider: reportProvider(providerConfig),
    outputDir,
    traceBaseDir,
    worktreeBaseDir,
    startedAt,
    completedAt: new Date().toISOString(),
    summary,
    cases,
  });

  console.log(`AgentLoop real dogfood ${status}: ${summary.passedCases}/${summary.totalCases} passed (${(summary.passRate * 100).toFixed(1)}%)`);
  if (summary.reasons.length > 0) {
    console.log(`Reasons: ${summary.reasons.join(" | ")}`);
  }
  console.log(`Report: ${path.join(outputDir, "report.json")}`);
  console.log(`Traces: ${path.join(traceBaseDir, "traces", "agentloop", "task")}`);
  return summary.ready ? 0 : 1;
}

async function runTaskSafely(
  name: string,
  run: () => Promise<AgentLoopResult<TaskAgentLoopOutput>>,
): Promise<AgentLoopResult<TaskAgentLoopOutput>> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    return {
      success: false,
      output: null,
      finalText: `case ${name} threw: ${message}`,
      stopReason: "fatal_error",
      elapsedMs: 0,
      modelTurns: 0,
      toolCalls: 0,
      compactions: 0,
      filesChanged: false,
      changedFiles: [],
      commandResults: [],
      traceId: "unavailable",
      sessionId: "unavailable",
      turnId: "unavailable",
    };
  }
}

function makeCaseSpecs(): RealDogfoodCaseSpec[] {
  return [
    {
      name: "readonly-readme-marker",
      seed: async (repoDir) => {
        await fsp.writeFile(path.join(repoDir, "README.md"), "Dogfood fixture\nmarker: readonly-ok\n", "utf-8");
      },
      task: makeTask({
        id: "dogfood-readonly",
        work_description: "Verify README.md contains the exact marker readonly-ok without changing files.",
        approach: "Inspect the file or run a focused grep command, then return the required final JSON.",
        success_criteria: [{ description: "README.md contains readonly-ok", verification_method: "grep readonly-ok README.md", is_blocking: true }],
        scope_boundary: { in_scope: ["README.md"], out_of_scope: ["all other files"], blast_radius: "low" },
      }),
      expectations: {
        mutationExpected: false,
        minSuccessfulVerificationCommands: 1,
        requireIsolatedWorkspace: true,
        maxModelTurns: 5,
        maxToolCalls: 4,
      },
    },
    {
      name: "create-marker-file",
      seed: async (repoDir) => {
        await fsp.writeFile(path.join(repoDir, "README.md"), "Dogfood fixture\n", "utf-8");
      },
      task: makeTask({
        id: "dogfood-create-file",
        work_description: "Create result.txt containing exactly one line: real-dogfood-ok",
        approach: "Use a file-editing tool, verify the marker with grep, then return the required final JSON.",
        success_criteria: [{ description: "result.txt contains real-dogfood-ok", verification_method: "grep real-dogfood-ok result.txt", is_blocking: true }],
        scope_boundary: { in_scope: ["result.txt"], out_of_scope: ["README.md"], blast_radius: "low" },
      }),
      expectations: {
        mutationExpected: true,
        expectedChangedFiles: ["result.txt"],
        minSuccessfulVerificationCommands: 1,
        requireIsolatedWorkspace: true,
        maxModelTurns: 7,
        maxToolCalls: 6,
      },
    },
    {
      name: "edit-existing-file",
      seed: async (repoDir) => {
        await fsp.writeFile(path.join(repoDir, "settings.txt"), "mode=dogfood\nenabled=false\n", "utf-8");
      },
      task: makeTask({
        id: "dogfood-edit-existing",
        work_description: "Change settings.txt so enabled=false becomes enabled=true. Leave the mode line unchanged.",
        approach: "Use a file-editing tool, verify enabled=true with grep, then return the required final JSON.",
        success_criteria: [{ description: "settings.txt contains enabled=true", verification_method: "grep enabled=true settings.txt", is_blocking: true }],
        scope_boundary: { in_scope: ["settings.txt"], out_of_scope: ["all other files"], blast_radius: "low" },
      }),
      expectations: {
        mutationExpected: true,
        expectedChangedFiles: ["settings.txt"],
        minSuccessfulVerificationCommands: 1,
        requireIsolatedWorkspace: true,
        maxModelTurns: 7,
        maxToolCalls: 6,
      },
    },
  ];
}

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "dogfood-task",
    goal_id: "agentloop-real-dogfood",
    strategy_id: null,
    target_dimensions: ["execution"],
    primary_dimension: "execution",
    work_description: "Run a real AgentLoop dogfood task.",
    rationale: "Measure native AgentLoop task execution with a real model.",
    approach: "Use tools, verify the result, and return final JSON.",
    success_criteria: [{ description: "task complete", verification_method: "grep", is_blocking: true }],
    scope_boundary: { in_scope: [], out_of_scope: [], blast_radius: "low" },
    constraints: [
      "Use only the temporary repository.",
      "Do not modify files outside the task scope.",
      "Return final output as JSON matching the required schema.",
    ],
    plateau_until: null,
    estimated_duration: { value: 5, unit: "minutes" },
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

function parseArgs(argv: string[]): RealDogfoodOptions {
  const result: RealDogfoodOptions = { keepWorkspaces: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output-dir" && argv[i + 1]) result.outputDir = argv[++i];
    else if (arg === "--keep-workspaces") result.keepWorkspaces = true;
    else if (arg === "--cases" && argv[i + 1]) result.caseLimit = parsePositiveInt(argv[++i]);
    else if (arg === "--max-model-turns" && argv[i + 1]) result.maxModelTurns = parsePositiveInt(argv[++i]);
    else if (arg === "--max-tool-calls" && argv[i + 1]) result.maxToolCalls = parsePositiveInt(argv[++i]);
    else if (arg === "--timeout-ms" && argv[i + 1]) result.timeoutMs = parsePositiveInt(argv[++i]);
  }
  return result;
}

function parsePositiveInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function skipReasonForProvider(config: ProviderConfig): string | null {
  if (config.adapter !== "agent_loop") {
    return `provider adapter is ${config.adapter}; set PULSEED_ADAPTER=agent_loop or configure provider.json adapter=agent_loop`;
  }
  if ((config.provider === "openai" || config.provider === "anthropic") && !config.api_key) {
    const envName = config.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    return `${envName} is not configured`;
  }
  return null;
}

function reportProvider(config: ProviderConfig): RealDogfoodReport["provider"] {
  return {
    provider: config.provider,
    model: config.model,
    adapter: config.adapter,
    ...(config.base_url ? { base_url: config.base_url } : {}),
    has_api_key: Boolean(config.api_key),
  };
}

function isAllowedDogfoodShellCommand(input: unknown): boolean {
  if (input === null || typeof input !== "object") return false;
  const command = (input as Record<string, unknown>)["command"];
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  if (trimmed.includes(">")) return false;
  return [
    /^grep\s+[A-Za-z0-9_.=-]+\s+[A-Za-z0-9_.\/-]+$/,
    /^grep\s+-n\s+'?\^[A-Za-z0-9_.=-]+='?\s+[A-Za-z0-9_.\/-]+$/,
    /^grep\s+-n\s+'?\^[A-Za-z0-9_.=-]+='?\s+[A-Za-z0-9_.\/-]+\s+&&\s+grep\s+-n\s+'?\^[A-Za-z0-9_.=-]+='?\s+[A-Za-z0-9_.\/-]+$/,
    /^test\s+-f\s+[A-Za-z0-9_.\/-]+$/,
    /^git\s+(status|diff|show)\b/,
    /^pwd$/,
    /^ls(\s+[A-Za-z0-9_.\/-]+)?$/,
    /^cat\s+[A-Za-z0-9_.\/-]+$/,
    /^pwd\s+&&\s+printf\s+'---\\n'\s+&&\s+cat\s+[A-Za-z0-9_.\/-]+\s+&&\s+printf\s+'---\\n'\s+&&\s+wc\s+-l\s+<\s+[A-Za-z0-9_.\/-]+$/,
  ].some((pattern) => pattern.test(trimmed));
}

async function createGitRepo(name: string): Promise<string> {
  const repoDir = await fsp.mkdtemp(path.join(os.tmpdir(), `pulseed-agentloop-${name}-`));
  await run("git", ["init"], repoDir);
  await run("git", ["config", "user.email", "dogfood@example.com"], repoDir);
  await run("git", ["config", "user.name", "AgentLoop Dogfood"], repoDir);
  return repoDir;
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd });
    let stderr = "";
    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (chunk: string) => { stderr += chunk; });
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `${command} ${args.join(" ")} failed`)));
  });
}

async function writeReport(outputDir: string, report: RealDogfoodReport): Promise<void> {
  await writeJsonFileAtomic(path.join(outputDir, "report.json"), report);
}

function timestampForPath(value: string): string {
  return value.replace(/[:.]/g, "-");
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  main().then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
