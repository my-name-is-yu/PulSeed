import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { toToolDefinition } from "../../../tool-definition-adapter.js";
import { ReadInputSchema, ReadTool } from "../ReadTool.js";
import type { ToolCallContext } from "../../../types.js";

function makeContext(cwd: string): ToolCallContext {
  return {
    cwd,
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

describe("ReadTool", () => {
  let tmpDir: string;
  let testFile: string;
  const tool = new ReadTool();

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-test-"));
    testFile = path.join(tmpDir, "test.txt");
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
    await fs.writeFile(testFile, lines.join("\n"), "utf-8");
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads bounded line windows with stable line numbers and summaries", async () => {
    const result = await tool.call({ file_path: testFile, offset: 5, limit: 3 }, makeContext(tmpDir));
    expect(result.success).toBe(true);
    expect(result.data).toBe(["6\tLine 6", "7\tLine 7", "8\tLine 8"].join("\n"));
    expect(result.summary).toContain("test.txt");
    expect(result.summary).toContain("lines 6-8");
  });

  it("returns error for missing file", async () => {
    const result = await tool.call(
      { file_path: path.join(tmpDir, "nonexistent.txt"), limit: 2000 },
      makeContext(tmpDir)
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns an empty window when offset is beyond EOF", async () => {
    const result = await tool.call({ file_path: testFile, offset: 50, limit: 3 }, makeContext(tmpDir));

    expect(result.success).toBe(true);
    expect(result.data).toBe("");
    expect(result.summary).toContain("Read 0 lines");
    expect(result.summary).toContain("starting at line 51");
    expect(result.summary).not.toContain("Read -");
  });

  it("rejects invalid numeric read controls at schema boundaries", () => {
    expect(ReadInputSchema.safeParse({ file_path: "test.txt", offset: 0, limit: 2000 }).success).toBe(true);

    for (const input of [
      { file_path: "test.txt", offset: -1 },
      { file_path: "test.txt", offset: 1.5 },
      { file_path: "test.txt", offset: Number.POSITIVE_INFINITY },
      { file_path: "test.txt", offset: 1_000_001 },
      { file_path: "test.txt", limit: 0 },
      { file_path: "test.txt", limit: 1.5 },
      { file_path: "test.txt", limit: Number.POSITIVE_INFINITY },
      { file_path: "test.txt", limit: 10_001 },
    ]) {
      expect(ReadInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("exports numeric bounds to model-facing tool definitions", () => {
    const parameters = toToolDefinition(tool).function.parameters as {
      properties?: Record<string, unknown>;
    };

    expect(parameters.properties?.offset).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 1_000_000,
    });
    expect(parameters.properties?.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 10_000,
    });
  });

  it.each([
    { file_path: ".env", limit: 2000 },
    { file_path: "/path/to/credentials.json", limit: 2000 },
    { file_path: "../outside.txt", limit: 2000 },
  ])("checkPermissions requires approval for protected read %o", async (input) => {
    const result = await tool.checkPermissions(input, makeContext(tmpDir));
    expect(result.status).toBe("needs_approval");
  });

});
