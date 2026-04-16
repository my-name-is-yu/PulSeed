// src/tools/__tests__/overflow.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { z } from "zod";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { ToolPermissionManager } from "../permission.js";
import { ConcurrencyController } from "../concurrency.js";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
} from "../types.js";

// --- Mock Helpers ---

const defaultInputSchema = z.object({ value: z.string() });
type DefaultInput = z.infer<typeof defaultInputSchema>;

function createMockTool(
  overrides: Partial<ITool<DefaultInput>> & { name?: string; maxOutputChars?: number } = {},
): ITool<DefaultInput> {
  const name = overrides.name ?? "mock-tool";
  const maxOutputChars = overrides.maxOutputChars ?? 8000;
  const metadataOverrides: Partial<ITool<DefaultInput>["metadata"]> = overrides.metadata ?? {};
  const metadata: ITool<DefaultInput>["metadata"] = {
    ...metadataOverrides,
    name,
    aliases: metadataOverrides.aliases ?? [],
    permissionLevel: metadataOverrides.permissionLevel ?? "read_only",
    isReadOnly: metadataOverrides.isReadOnly ?? true,
    isDestructive: metadataOverrides.isDestructive ?? false,
    shouldDefer: metadataOverrides.shouldDefer ?? false,
    alwaysLoad: metadataOverrides.alwaysLoad ?? false,
    maxConcurrency: metadataOverrides.maxConcurrency ?? 0,
    maxOutputChars: metadataOverrides.maxOutputChars ?? maxOutputChars,
    tags: metadataOverrides.tags ?? [],
  };
  const base: ITool<DefaultInput> = {
    metadata,
    inputSchema: overrides.inputSchema ?? defaultInputSchema,
    description: () => `Mock tool: ${name}`,
    call: vi.fn().mockResolvedValue({
      success: true,
      data: { result: "ok" },
      summary: "success",
      durationMs: 10,
    } as ToolResult),
    checkPermissions: vi.fn().mockResolvedValue({ status: "allowed" } as PermissionCheckResult),
    isConcurrencySafe: vi.fn().mockReturnValue(true),
    ...overrides,
  };
  return base;
}

function createMockContext(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "goal-1",
    trustBalance: 50,
    preApproved: false,
    approvalFn: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function createExecutor(tool: ITool): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(tool);
  const permissionManager = new ToolPermissionManager({});
  const concurrency = new ConcurrencyController();
  return new ToolExecutor({ registry, permissionManager, concurrency });
}

// Track overflow files created during tests for cleanup
const createdOverflowPaths: string[] = [];
const originalPulseedHome = process.env["PULSEED_HOME"];
let tmpPulseedHome: string;

beforeEach(() => {
  tmpPulseedHome = mkdtempSync(join(tmpdir(), "pulseed-overflow-test-"));
  process.env["PULSEED_HOME"] = tmpPulseedHome;
});

afterEach(() => {
  for (const p of createdOverflowPaths) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // ignore cleanup errors
    }
  }
  createdOverflowPaths.length = 0;
  if (originalPulseedHome === undefined) {
    delete process.env["PULSEED_HOME"];
  } else {
    process.env["PULSEED_HOME"] = originalPulseedHome;
  }
  rmSync(tmpPulseedHome, { recursive: true, force: true });
});

describe("ToolExecutor overflow-to-disk", () => {
  it("does NOT create an overflow file when output is under maxOutputChars", async () => {
    const smallData = { result: "small" };
    const tool = createMockTool({
      maxOutputChars: 8000,
      call: vi.fn().mockResolvedValue({
        success: true,
        data: smallData,
        summary: "success",
        durationMs: 5,
      } as ToolResult),
    });

    const executor = createExecutor(tool);
    const result = await executor.execute("mock-tool", { value: "x" }, createMockContext());

    expect(result.success).toBe(true);
    expect(result.truncated).toBeUndefined();
  });

  it("creates an overflow file with full output when output exceeds maxOutputChars", async () => {
    // Build a string longer than maxOutputChars (100)
    const bigData = { payload: "A".repeat(200) };
    const tool = createMockTool({
      maxOutputChars: 100,
      call: vi.fn().mockResolvedValue({
        success: true,
        data: bigData,
        summary: "big output",
        durationMs: 5,
      } as ToolResult),
    });
    // Override metadata directly so maxOutputChars is respected
    (tool.metadata as { maxOutputChars: number }).maxOutputChars = 100;

    const executor = createExecutor(tool);
    const result = await executor.execute("mock-tool", { value: "x" }, createMockContext());

    expect(result.success).toBe(true);
    expect(result.truncated).toBeDefined();
    expect(result.truncated!.overflowPath).toBeDefined();

    const overflowPath = result.truncated!.overflowPath!;
    createdOverflowPaths.push(overflowPath);

    // File must exist
    expect(existsSync(overflowPath)).toBe(true);

    // File must be under PULSEED_HOME/tmp/
    const expectedDir = join(tmpPulseedHome, "tmp");
    expect(overflowPath.startsWith(expectedDir)).toBe(true);

    // File must contain valid JSON matching the original full output
    const fileContent = readFileSync(overflowPath, "utf-8");
    const parsed = JSON.parse(fileContent);
    expect(parsed).toEqual(bigData);

    // originalChars should reflect the full serialized length
    const fullSerialized = JSON.stringify(bigData);
    expect(result.truncated!.originalChars).toBe(fullSerialized.length);
  });

  it("creates the overflow directory if it does not exist and places file there", async () => {
    const bigData = { payload: "B".repeat(200) };
    const tool = createMockTool({
      maxOutputChars: 50,
      call: vi.fn().mockResolvedValue({
        success: true,
        data: bigData,
        summary: "big output",
        durationMs: 5,
      } as ToolResult),
    });
    (tool.metadata as { maxOutputChars: number }).maxOutputChars = 50;

    const executor = createExecutor(tool);
    const result = await executor.execute("mock-tool", { value: "x" }, createMockContext());

    expect(result.truncated?.overflowPath).toBeDefined();
    const overflowPath = result.truncated!.overflowPath!;
    createdOverflowPaths.push(overflowPath);

    const expectedDir = join(tmpPulseedHome, "tmp");

    // Directory must exist (created by executor)
    expect(existsSync(expectedDir)).toBe(true);

    // Overflow file must be inside the expected directory
    expect(overflowPath.startsWith(expectedDir)).toBe(true);

    // File must exist and contain valid JSON
    expect(existsSync(overflowPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(overflowPath, "utf-8"));
    expect(parsed).toEqual(bigData);
  });
});
