import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../../types.js";
import { execFileNoThrow } from "../../../base/utils/execFileNoThrow.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, MAX_OUTPUT_CHARS, PERMISSION_LEVEL } from "./constants.js";
import { resolveWorkspaceCwd, resolveWorkspacePath } from "../../workspace-scope.js";

export const TEST_RUNNER_TIMEOUT_DEFAULT_MS = 60_000;
export const TEST_RUNNER_TIMEOUT_MAX_MS = 1_800_000;

export const TestRunnerInputSchema = z.object({
  command: z.string().default("npx vitest run"),
  cwd: z.string().optional(),
  pattern: z.string().optional(),
  timeout: z.number().int().min(1).max(TEST_RUNNER_TIMEOUT_MAX_MS).default(TEST_RUNNER_TIMEOUT_DEFAULT_MS),
});

export type TestRunnerInput = z.infer<typeof TestRunnerInputSchema>;

export interface TestRunnerOutput {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  success: boolean;
  duration?: number;
  failedTests?: string[];
  rawOutput: string;
}

const MAX_RAW_OUTPUT = 10_000;
const NON_NEGATIVE_INTEGER_TOKEN = /^\d+$/;
const NON_NEGATIVE_DECIMAL_TOKEN = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

function parseSafeCount(token: string): number | undefined {
  if (!NON_NEGATIVE_INTEGER_TOKEN.test(token)) return undefined;
  const value = Number(token);
  return Number.isSafeInteger(value) ? value : undefined;
}

function parseDurationMs(token: string, multiplier: number): number | undefined {
  if (!NON_NEGATIVE_DECIMAL_TOKEN.test(token)) return undefined;
  const value = Number(token);
  if (!Number.isFinite(value)) return undefined;
  const duration = Math.round(value * multiplier);
  return Number.isSafeInteger(duration) ? duration : undefined;
}

function assignParsedCount(
  result: Partial<TestRunnerOutput>,
  key: "passed" | "failed" | "skipped" | "total",
  match: RegExpMatchArray | null
): void {
  if (!match?.[1]) return;
  const value = parseSafeCount(match[1]);
  if (value !== undefined) result[key] = value;
}

/** Parse vitest summary: "Tests  5 passed | 2 failed | 1 skipped (8)" */
function parseVitest(output: string): Partial<TestRunnerOutput> {
  const result: Partial<TestRunnerOutput> = {};

  // vitest "Tests  X passed (Y)" or "Tests  X passed | Z failed (N)"
  const testsLine = output.match(/Tests\s+(.+)/);
  if (testsLine) {
    const passedM = testsLine[1].match(/(?:^|\s)(\S+)\s+passed(?:\s|$)/);
    const failedM = testsLine[1].match(/(?:^|\s)(\S+)\s+failed(?:\s|$)/);
    const skippedM = testsLine[1].match(/(?:^|\s)(\S+)\s+skipped(?:\s|$)/);
    const totalM = testsLine[1].match(/\((\S+)\)/);
    assignParsedCount(result, "passed", passedM);
    assignParsedCount(result, "failed", failedM);
    assignParsedCount(result, "skipped", skippedM);
    assignParsedCount(result, "total", totalM);
  }

  // Duration: "Duration  1.23s"
  const durM = output.match(/Duration\s+(\S+)s/);
  if (durM?.[1]) result.duration = parseDurationMs(durM[1], 1000);

  // Collect failed test names from vitest output: " FAIL src/..." or "× test name"
  const failedTests: string[] = [];
  for (const line of output.split("\n")) {
    if (/^\s*×\s/.test(line)) {
      failedTests.push(line.replace(/^\s*×\s*/, "").trim());
    }
  }
  if (failedTests.length > 0) result.failedTests = failedTests;

  return result;
}

/** Parse jest summary: "Tests: 5 passed, 2 failed, 7 total" */
function parseJest(output: string): Partial<TestRunnerOutput> {
  const result: Partial<TestRunnerOutput> = {};
  const testsLine = output.match(/Tests:\s+(.+)/);
  if (testsLine) {
    const passedM = testsLine[1].match(/(?:^|\s)(\S+)\s+passed(?:,|\s|$)/);
    const failedM = testsLine[1].match(/(?:^|\s)(\S+)\s+failed(?:,|\s|$)/);
    const skippedM = testsLine[1].match(/(?:^|\s)(\S+)\s+skipped(?:,|\s|$)/);
    const totalM = testsLine[1].match(/(?:^|\s)(\S+)\s+total(?:,|\s|$)/);
    assignParsedCount(result, "passed", passedM);
    assignParsedCount(result, "failed", failedM);
    assignParsedCount(result, "skipped", skippedM);
    assignParsedCount(result, "total", totalM);
  }
  const timeM = output.match(/Time:\s+(\S+)\s*s/);
  if (timeM?.[1]) result.duration = parseDurationMs(timeM[1], 1000);
  return result;
}

/** Parse mocha summary: "5 passing (200ms)" / "2 failing" */
function parseMocha(output: string): Partial<TestRunnerOutput> {
  const result: Partial<TestRunnerOutput> = {};
  const passM = output.match(/(?:^|\s)(\S+)\s+passing(?:\s|\(|$)/);
  const failM = output.match(/(?:^|\s)(\S+)\s+failing(?:\s|$)/);
  const pendM = output.match(/(?:^|\s)(\S+)\s+pending(?:\s|$)/);
  assignParsedCount(result, "passed", passM);
  assignParsedCount(result, "failed", failM);
  assignParsedCount(result, "skipped", pendM);
  if (result.passed !== undefined || result.failed !== undefined) {
    result.total = (result.passed ?? 0) + (result.failed ?? 0) + (result.skipped ?? 0);
  }
  const timeM = output.match(/passing\s+\((\S+)ms\)/);
  if (timeM?.[1]) result.duration = parseDurationMs(timeM[1], 1);
  return result;
}

function parseOutput(output: string): Partial<TestRunnerOutput> {
  if (/Tests\s+\d+/.test(output)) return parseVitest(output);
  if (/Tests:\s+\d+/.test(output)) return parseJest(output);
  if (/\d+\s+passing/.test(output)) return parseMocha(output);
  return {};
}

function buildTestCommand(command: string, pattern?: string): { cmd: string; args: string[] } {
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);
  if (pattern) args.push(pattern);
  return { cmd, args };
}

function validateTestCommand(
  input: TestRunnerInput,
  scope?: { cwd: string; workspaceRoot: string },
): string | null {
  const command = input.command;
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Test command must not be empty.";
  if (/[;&|`$<>]/.test(command)) return "Test command contains shell control characters.";
  const [cmd, first, second] = parts;
  let argsStart: number | null = null;
  if (cmd === "npx" && first === "vitest" && ["run", "list"].includes(second ?? "run")) argsStart = second ? 3 : 2;
  if (cmd === "npx" && first === "vitest" && second === "--reporter") argsStart = 2;
  if (cmd === "npx" && first === "jest") argsStart = 2;
  if (cmd === "npm" && first === "test") argsStart = 2;
  if (cmd === "npm" && first === "run" && typeof second === "string" && /^test(?::|$)/.test(second)) argsStart = 3;
  if (cmd === "vitest" && ["run", "list"].includes(first ?? "run")) argsStart = first ? 2 : 1;
  if (cmd === "vitest" && first === "--reporter") argsStart = 1;
  if (cmd === "jest") argsStart = 1;
  if (cmd === "mocha") argsStart = 1;
  if (argsStart !== null) {
    return validateTestArgs([...parts.slice(argsStart), ...(input.pattern ? [input.pattern] : [])], scope);
  }
  return `Command is not a recognized test runner invocation: ${command.trim()}`;
}

const PATH_VALUE_OPTIONS = new Set([
  "--config",
  "-c",
  "--root",
  "--dir",
  "--project",
  "--workspace",
  "--globalSetup",
  "--setupFiles",
  "--setupFilesAfterEnv",
  "--testMatch",
  "--testRegex",
  "--testPathPattern",
  "--runTestsByPath",
  "--require",
  "-r",
  "--file",
  "--spec",
]);

function validateTestArgs(args: string[], scope?: { cwd: string; workspaceRoot: string }): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") continue;

    const equalsIndex = arg.indexOf("=");
    if (equalsIndex > 0) {
      const option = arg.slice(0, equalsIndex);
      const value = arg.slice(equalsIndex + 1);
      if (PATH_VALUE_OPTIONS.has(option) || isPathLikeArg(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        const error = validateWorkspaceArgPath(value, scope, option);
        if (error) return error;
        continue;
      }
    }

    if (PATH_VALUE_OPTIONS.has(arg)) {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) return `Test command option ${arg} requires a workspace path value.`;
      const error = validateWorkspaceArgPath(value, scope, arg);
      if (error) return error;
      i++;
      continue;
    }

    if (isPathLikeArg(arg)) {
      const error = validateWorkspaceArgPath(arg, scope, "test argument");
      if (error) return error;
    }
  }
  return null;
}

function validateWorkspaceArgPath(
  value: string,
  scope: { cwd: string; workspaceRoot: string } | undefined,
  source: string,
): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return `Test command ${source} must not be empty.`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return `Test command ${source} must be a workspace path, not a URL.`;
  }
  if (!scope) return null;
  const validation = resolveWorkspacePath(trimmed, scope.cwd, scope.workspaceRoot);
  if (validation.valid) return null;
  return `Test command ${source} escapes workspace root: ${validation.resolved}`;
}

function isPathLikeArg(arg: string): boolean {
  if (arg.startsWith("-")) return false;
  return arg.startsWith("/")
    || arg.startsWith("./")
    || arg.startsWith("../")
    || arg === ".."
    || arg.startsWith("~/")
    || arg.includes("/")
    || /\.(?:[cm]?[jt]sx?|json)$/.test(arg);
}

export class TestRunnerTool implements ITool<TestRunnerInput, TestRunnerOutput> {
  readonly metadata: ToolMetadata = {
    name: "test-runner",
    aliases: ["run-tests", "vitest", "jest"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
    activityCategory: "test",
  };

  readonly inputSchema = TestRunnerInputSchema;

  description(): string {
    return DESCRIPTION;
  }

  async call(input: TestRunnerInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const cwdValidation = resolveWorkspaceCwd(input.cwd, context);
    if (!cwdValidation.valid) {
      return {
        success: false,
        data: { passed: 0, failed: 0, skipped: 0, total: 0, success: false, rawOutput: "" },
        summary: `Test runner blocked: ${cwdValidation.error ?? "Invalid cwd"}`,
        error: cwdValidation.error ?? "Invalid cwd",
        execution: { status: "not_executed", reason: "policy_blocked", message: cwdValidation.error ?? "Invalid cwd" },
        durationMs: Date.now() - startTime,
      };
    }
    const commandError = validateTestCommand(input, {
      cwd: cwdValidation.resolved,
      workspaceRoot: cwdValidation.workspaceRoot,
    });
    if (commandError) {
      return {
        success: false,
        data: { passed: 0, failed: 0, skipped: 0, total: 0, success: false, rawOutput: "" },
        summary: `Test runner blocked: ${commandError}`,
        error: commandError,
        execution: { status: "not_executed", reason: "policy_blocked", message: commandError },
        durationMs: Date.now() - startTime,
      };
    }
    const cwd = cwdValidation.resolved;
    const { cmd, args } = buildTestCommand(input.command, input.pattern);

    try {
      const result = await execFileNoThrow(cmd, args, { cwd, timeoutMs: input.timeout, signal: context.abortSignal, killProcessGroup: true });
      const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
      const rawOutput = combined.length > MAX_RAW_OUTPUT ? combined.slice(0, MAX_RAW_OUTPUT) + "\n...[truncated]" : combined;

      const parsed = parseOutput(combined);
      const passed = parsed.passed ?? 0;
      const failed = parsed.failed ?? 0;
      const skipped = parsed.skipped ?? 0;
      const total = parsed.total ?? (passed + failed + skipped);
      const success = result.exitCode === 0 && failed === 0;

      const output: TestRunnerOutput = {
        passed,
        failed,
        skipped,
        total,
        success,
        duration: parsed.duration,
        failedTests: parsed.failedTests,
        rawOutput,
      };

      return {
        success,
        data: output,
        summary: success
          ? `Tests passed: ${passed}/${total}${parsed.duration ? ` in ${parsed.duration}ms` : ""}`
          : `Tests failed: ${failed} failed, ${passed} passed (${total} total)`,
        error: success ? undefined : `${failed} test(s) failed`,
        durationMs: Date.now() - startTime,
        contextModifier: `Test results: ${passed} passed, ${failed} failed, ${skipped} skipped out of ${total} total`,
      };
    } catch (err) {
      return {
        success: false,
        data: { passed: 0, failed: 0, skipped: 0, total: 0, success: false, rawOutput: (err as Error).message },
        summary: `Test runner error: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(input: TestRunnerInput, context?: ToolCallContext): Promise<PermissionCheckResult> {
    let scope: { cwd: string; workspaceRoot: string } | undefined;
    if (context) {
      const cwdValidation = resolveWorkspaceCwd(input.cwd, context);
      if (!cwdValidation.valid) {
        return { status: "denied", reason: cwdValidation.error ?? "Invalid cwd", executionReason: "policy_blocked" };
      }
      scope = {
        cwd: cwdValidation.resolved,
        workspaceRoot: cwdValidation.workspaceRoot,
      };
    }
    const commandError = validateTestCommand(input, scope);
    if (commandError) {
      return { status: "denied", reason: commandError, executionReason: "policy_blocked" };
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: TestRunnerInput): boolean {
    // Test runs may write to shared output files; not safe to run concurrently
    return false;
  }
}
