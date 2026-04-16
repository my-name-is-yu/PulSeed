import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { ToolCallContext } from "../../../types.js";

const mockHomedir = vi.hoisted(() => vi.fn(() => ""));

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: mockHomedir };
});

function makeContext(): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

describe("WritePulseedFileTool", () => {
  let tmpHome: string;
  let pulseedDir: string;
  const originalPulseedHome = process.env["PULSEED_HOME"];

  beforeAll(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "write-pulseed-test-"));
    pulseedDir = path.join(tmpHome, ".pulseed");
    await fs.mkdir(pulseedDir, { recursive: true });
    mockHomedir.mockReturnValue(tmpHome);
  });

  afterAll(async () => {
    if (originalPulseedHome === undefined) {
      delete process.env["PULSEED_HOME"];
    } else {
      process.env["PULSEED_HOME"] = originalPulseedHome;
    }
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("writes a file to ~/.pulseed/", async () => {
    const { WritePulseedFileTool } = await import("../WritePulseedFileTool.js");
    const tool = new WritePulseedFileTool();
    const result = await tool.call({ path: "config.json", content: '{"key":"value"}' }, makeContext());
    expect(result.success).toBe(true);
    const written = await fs.readFile(path.join(pulseedDir, "config.json"), "utf-8");
    expect(written).toBe('{"key":"value"}');
  });

  it("creates parent directories as needed", async () => {
    const { WritePulseedFileTool } = await import("../WritePulseedFileTool.js");
    const tool = new WritePulseedFileTool();
    const result = await tool.call({ path: "decisions/plan-001.md", content: "# Plan" }, makeContext());
    expect(result.success).toBe(true);
    const written = await fs.readFile(path.join(pulseedDir, "decisions", "plan-001.md"), "utf-8");
    expect(written).toBe("# Plan");
  });

  it("honors PULSEED_HOME when writing files", async () => {
    const customHome = await fs.mkdtemp(path.join(os.tmpdir(), "write-pulseed-home-"));
    process.env["PULSEED_HOME"] = customHome;
    try {
      const { WritePulseedFileTool } = await import("../WritePulseedFileTool.js");
      const tool = new WritePulseedFileTool();
      const result = await tool.call({ path: "custom.json", content: "{}" }, makeContext());
      expect(result.success).toBe(true);
      await expect(fs.readFile(path.join(customHome, "custom.json"), "utf-8")).resolves.toBe("{}");
    } finally {
      delete process.env["PULSEED_HOME"];
      await fs.rm(customHome, { recursive: true, force: true });
    }
  });

  it("blocks writes through symlinks that escape PULSEED_HOME", async () => {
    const customHome = await fs.mkdtemp(path.join(os.tmpdir(), "write-pulseed-symlink-home-"));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-pulseed-symlink-outside-"));
    process.env["PULSEED_HOME"] = customHome;
    await fs.symlink(outsideDir, path.join(customHome, "link"), "dir");
    try {
      const { WritePulseedFileTool } = await import("../WritePulseedFileTool.js");
      const tool = new WritePulseedFileTool();
      const result = await tool.call({ path: "link/nested/pwned.txt", content: "pwned" }, makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain("~/.pulseed/");
      await expect(fs.stat(path.join(outsideDir, "nested"))).rejects.toThrow();
    } finally {
      delete process.env["PULSEED_HOME"];
      await fs.rm(customHome, { recursive: true, force: true });
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("summary includes byte count and path", async () => {
    const { WritePulseedFileTool } = await import("../WritePulseedFileTool.js");
    const tool = new WritePulseedFileTool();
    const result = await tool.call({ path: "hello.txt", content: "hello world" }, makeContext());
    expect(result.success).toBe(true);
    expect(result.summary).toContain("bytes");
    expect(result.summary).toContain("hello.txt");
  });

  it("blocks path traversal attack", async () => {
    const { WritePulseedFileTool } = await import("../WritePulseedFileTool.js");
    const tool = new WritePulseedFileTool();
    const result = await tool.call({ path: "../../etc/passwd", content: "evil" }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("~/.pulseed/");
  });

  it("checkPermissions returns needs_approval with reason", async () => {
    const { WritePulseedFileTool } = await import("../WritePulseedFileTool.js");
    const tool = new WritePulseedFileTool();
    const result = await tool.checkPermissions({ path: "config.json", content: "" }, makeContext());
    expect(result.status).toBe("needs_approval");
    if (result.status === "needs_approval") {
      expect(result.reason).toContain("config.json");
    }
  });

  it("isConcurrencySafe returns false", async () => {
    const { WritePulseedFileTool } = await import("../WritePulseedFileTool.js");
    const tool = new WritePulseedFileTool();
    expect(tool.isConcurrencySafe({ path: "config.json", content: "" })).toBe(false);
  });

  it("Zod rejects missing path field", async () => {
    const { WritePulseedFileInputSchema } = await import("../WritePulseedFileTool.js");
    const parsed = WritePulseedFileInputSchema.safeParse({ content: "hello" });
    expect(parsed.success).toBe(false);
  });

  it("Zod rejects missing content field", async () => {
    const { WritePulseedFileInputSchema } = await import("../WritePulseedFileTool.js");
    const parsed = WritePulseedFileInputSchema.safeParse({ path: "file.txt" });
    expect(parsed.success).toBe(false);
  });
});
