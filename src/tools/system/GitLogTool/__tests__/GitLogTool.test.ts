import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { toToolDefinition } from "../../../tool-definition-adapter.js";
import { GitLogInputSchema, GitLogTool } from "../GitLogTool.js";
import type { ToolCallContext } from "../../../types.js";

function makeContext(cwd = "/tmp"): ToolCallContext {
  return {
    cwd,
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

let repoDir: string;

beforeAll(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-git-log-tool-"));
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });

  for (let index = 1; index <= 3; index += 1) {
    fs.writeFileSync(path.join(repoDir, `file-${index}.txt`), `content ${index}\n`);
    execFileSync("git", ["add", `file-${index}.txt`], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", `commit ${index}`], { cwd: repoDir, stdio: "ignore" });
  }
});

afterAll(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe("GitLogTool", () => {
  const tool = new GitLogTool();

  describe("metadata", () => {
    it("has correct name", () => {
      expect(tool.metadata.name).toBe("git_log");
    });

    it("is read_only", () => {
      expect(tool.metadata.permissionLevel).toBe("read_only");
    });

    it("isReadOnly is true", () => {
      expect(tool.metadata.isReadOnly).toBe(true);
    });

    it("is not destructive", () => {
      expect(tool.metadata.isDestructive).toBe(false);
    });
  });

  describe("description", () => {
    it("includes the cwd", () => {
      const desc = tool.description({ cwd: "/some/path" });
      expect(desc).toContain("/some/path");
    });

    it("returns a non-empty string without context", () => {
      expect(tool.description()).toBeTruthy();
    });
  });

  describe("checkPermissions", () => {
    it("always returns allowed", async () => {
      const result = await tool.checkPermissions({ maxCount: 5, format: "oneline" }, makeContext());
      expect(result.status).toBe("allowed");
    });
  });

  describe("input schema", () => {
    it("rejects invalid maxCount values", () => {
      expect(GitLogInputSchema.safeParse({ maxCount: 20 }).success).toBe(true);

      for (const maxCount of [0, -1, 1.5, Number.POSITIVE_INFINITY, 1_001]) {
        expect(GitLogInputSchema.safeParse({ maxCount }).success).toBe(false);
      }
    });

    it("exports maxCount bounds to model-facing tool definitions", () => {
      const parameters = toToolDefinition(tool).function.parameters as {
        properties?: Record<string, unknown>;
      };

      expect(parameters.properties?.maxCount).toMatchObject({
        type: "integer",
        minimum: 1,
        maximum: 1_000,
      });
    });
  });

  describe("isConcurrencySafe", () => {
    it("returns true", () => {
      expect(tool.isConcurrencySafe({ maxCount: 5, format: "oneline" })).toBe(true);
    });
  });

  describe("call", () => {
    it("returns commits in oneline format", async () => {
      const result = await tool.call({ maxCount: 5, format: "oneline" }, makeContext(repoDir));
      expect(result.success).toBe(true);
      const lines = result.data as string[];
      expect(Array.isArray(lines)).toBe(true);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.length).toBeLessThanOrEqual(5);
    });

    it("returns commits in full format with structured fields", async () => {
      const result = await tool.call({ maxCount: 3, format: "full" }, makeContext(repoDir));
      expect(result.success).toBe(true);
      const entries = result.data as Array<{ hash: string; author: string; date: string; message: string }>;
      expect(Array.isArray(entries)).toBe(true);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.hash).toBeTruthy();
        expect(entry.author).toBeTruthy();
        expect(entry.date).toBeTruthy();
        expect(typeof entry.message).toBe("string");
      }
    });

    it("respects maxCount", async () => {
      const result = await tool.call({ maxCount: 2, format: "oneline" }, makeContext(repoDir));
      expect(result.success).toBe(true);
      const lines = result.data as string[];
      expect(lines.length).toBeLessThanOrEqual(2);
    });

    it("returns empty array for non-git directory", async () => {
      const result = await tool.call({ maxCount: 5, format: "oneline" }, makeContext("/tmp"));
      expect(result.success).toBe(false);
      expect(result.data).toEqual([]);
    });

    it("uses cwd from input over context", async () => {
      const result = await tool.call({ cwd: repoDir, maxCount: 3, format: "oneline" }, makeContext("/tmp"));
      expect(result.success).toBe(true);
    });

    it("summary mentions commit count", async () => {
      const result = await tool.call({ maxCount: 5, format: "oneline" }, makeContext(repoDir));
      expect(result.summary).toContain("commit");
    });
  });
});
