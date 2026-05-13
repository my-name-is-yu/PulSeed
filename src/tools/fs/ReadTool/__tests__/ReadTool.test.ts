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

  it("reads file with line numbers", async () => {
    const result = await tool.call({ file_path: testFile, limit: 2000 }, makeContext(tmpDir));
    expect(result.success).toBe(true);
    const data = result.data as string;
    expect(data).toContain("1\tLine 1");
    expect(data).toContain("20\tLine 20");
  });

  it("respects limit parameter", async () => {
    const result = await tool.call({ file_path: testFile, limit: 5 }, makeContext(tmpDir));
    expect(result.success).toBe(true);
    const data = result.data as string;
    const lines = data.split("\n");
    expect(lines.length).toBe(5);
    expect(lines[0]).toBe("1\tLine 1");
    expect(lines[4]).toBe("5\tLine 5");
  });

  it("respects offset parameter", async () => {
    const result = await tool.call({ file_path: testFile, offset: 5, limit: 3 }, makeContext(tmpDir));
    expect(result.success).toBe(true);
    const data = result.data as string;
    expect(data).toContain("6\tLine 6");
    expect(data).toContain("8\tLine 8");
    expect(data).not.toContain("Line 5");
    expect(data).not.toContain("Line 9");
  });

  it("returns an empty window when offset is beyond EOF", async () => {
    const result = await tool.call({ file_path: testFile, offset: 50, limit: 3 }, makeContext(tmpDir));

    expect(result.success).toBe(true);
    expect(result.data).toBe("");
    expect(result.summary).toContain("Read 0 lines");
    expect(result.summary).toContain("starting at line 51");
    expect(result.summary).not.toContain("Read -");
  });

  it("resolves relative paths using context.cwd", async () => {
    const result = await tool.call({ file_path: "test.txt", limit: 2000 }, makeContext(tmpDir));
    expect(result.success).toBe(true);
    expect((result.data as string)).toContain("1\tLine 1");
  });

  it("returns error for missing file", async () => {
    const result = await tool.call(
      { file_path: path.join(tmpDir, "nonexistent.txt"), limit: 2000 },
      makeContext(tmpDir)
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("summary includes filename and line range", async () => {
    const result = await tool.call({ file_path: testFile, limit: 5 }, makeContext(tmpDir));
    expect(result.summary).toContain("test.txt");
    expect(result.summary).toContain("lines 1-5");
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

  it("checkPermissions flags .env files", async () => {
    const result = await tool.checkPermissions({ file_path: ".env", limit: 2000 });
    expect(result.status).toBe("needs_approval");
  });

  it("checkPermissions flags credentials files", async () => {
    const result = await tool.checkPermissions({ file_path: "/path/to/credentials.json", limit: 2000 });
    expect(result.status).toBe("needs_approval");
  });

  it("checkPermissions allows normal files", async () => {
    const result = await tool.checkPermissions({ file_path: "config.json", limit: 2000 });
    expect(result.status).toBe("allowed");
  });

  it("checkPermissions requires approval for files outside cwd", async () => {
    const result = await tool.checkPermissions(
      { file_path: "../outside.txt", limit: 2000 },
      makeContext(tmpDir)
    );
    expect(result.status).toBe("needs_approval");
  });

});
