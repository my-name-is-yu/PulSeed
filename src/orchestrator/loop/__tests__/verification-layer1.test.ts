import { describe, it, expect, vi } from "vitest";
import { verifyWithTools } from "../verification-layer1.js";
import type { Criterion } from "../../../orchestrator/execution/types/task.js";
import type { ToolExecutor } from "../../../tools/executor.js";
import type { ToolCallContext, ToolResult } from "../../../tools/types.js";

// ─── Fixtures ───

const baseContext: ToolCallContext = {
  cwd: "/tmp",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: true,
  approvalFn: async () => true,
};

function makeCriterion(
  verification_method: string,
  is_blocking = true,
): Criterion {
  return { description: "test criterion", verification_method, is_blocking };
}

function passResult(): ToolResult {
  return { success: true, data: ["matched"], summary: "found", durationMs: 5 };
}

function failResult(): ToolResult {
  return { success: false, data: null, summary: "not found", error: "no match", durationMs: 5 };
}

function makeExecutor(results: ToolResult[]): ToolExecutor {
  let callCount = 0;
  return {
    execute: vi.fn().mockImplementation(() => Promise.resolve(results[callCount++ % results.length])),
    executeBatch: vi.fn().mockResolvedValue(results),
  } as unknown as ToolExecutor;
}

// ─── verifyWithTools ───

describe("verifyWithTools", () => {
  describe("edge cases", () => {
    it("returns mechanicalPassed=true when criteria list is empty", async () => {
      const executor = makeExecutor([]);
      const result = await verifyWithTools([], executor, baseContext);
      expect(result.mechanicalPassed).toBe(true);
      expect(result.details).toHaveLength(0);
    });

    it("returns mechanicalPassed=true when no criteria have verifiable methods", async () => {
      const criteria = [
        makeCriterion("review the code quality"),
        makeCriterion("check with the team"),
      ];
      const executor = makeExecutor([]);
      const result = await verifyWithTools(criteria, executor, baseContext);
      expect(result.mechanicalPassed).toBe(true);
      expect(result.details).toHaveLength(0);
      expect(executor.executeBatch).not.toHaveBeenCalled();
      expect(executor.execute).not.toHaveBeenCalled();
    });
  });

  describe("shell mapping (run / execute prefix)", () => {
    it("maps \'run <cmd>\' to shell tool", async () => {
      const criterion = makeCriterion("run npx vitest");
      const executor = makeExecutor([passResult()]);
      const result = await verifyWithTools([criterion], executor, baseContext);
      expect(executor.execute).toHaveBeenCalledWith(
        "shell",
        { command: "npx vitest" },
        { ...baseContext, preApproved: false },
      );
      expect(result.details[0].toolName).toBe("shell");
    });

    it("maps \'execute <cmd>\' to shell tool", async () => {
      const criterion = makeCriterion("execute npm test");
      const executor = makeExecutor([passResult()]);
      const result = await verifyWithTools([criterion], executor, baseContext);
      expect(result.details[0].toolName).toBe("shell");
    });

    it("passes mechanicalPassed=true when shell succeeds", async () => {
      const criterion = makeCriterion("run npm test");
      const executor = makeExecutor([passResult()]);
      const result = await verifyWithTools([criterion], executor, baseContext);
      expect(result.mechanicalPassed).toBe(true);
    });

    it("passes mechanicalPassed=false when blocking shell fails", async () => {
      const criterion = makeCriterion("run npm test", true);
      const executor = makeExecutor([failResult()]);
      const result = await verifyWithTools([criterion], executor, baseContext);
      expect(result.mechanicalPassed).toBe(false);
    });

    it("passes mechanicalPassed=true when only optional criterion fails", async () => {
      const blockingCrit = makeCriterion("run npm test", true);
      const optionalCrit = makeCriterion("run npm lint", false);
      const executor = makeExecutor([passResult(), failResult()]);
      const result = await verifyWithTools([blockingCrit, optionalCrit], executor, baseContext);
      expect(result.mechanicalPassed).toBe(true);
      expect(result.details).toHaveLength(2);
      expect(result.details[0].passed).toBe(true);
      expect(result.details[1].passed).toBe(false);
    });
  });

  describe("glob mapping (check file / file exists prefix)", () => {
    it("maps \'check file <pattern>\' to glob tool", async () => {
      const criterion = makeCriterion("check file dist/index.js");
      const executor = makeExecutor([passResult()]);
      const result = await verifyWithTools([criterion], executor, baseContext);
      expect(executor.execute).toHaveBeenCalledWith(
        "glob",
        { pattern: "dist/index.js" },
        baseContext,
      );
      expect(result.details[0].toolName).toBe("glob");
    });

    it("maps \'file exists <pattern>\' to glob tool", async () => {
      const criterion = makeCriterion("file exists src/index.ts");
      const executor = makeExecutor([passResult()]);
      const result = await verifyWithTools([criterion], executor, baseContext);
      expect(result.details[0].toolName).toBe("glob");
    });
  });

  describe("read mapping (read / verify content prefix)", () => {
    it("maps \'read <path>\' to read tool", async () => {
      const criterion = makeCriterion("read README.md");
      const executor = makeExecutor([passResult()]);
      const result = await verifyWithTools([criterion], executor, baseContext);
      expect(executor.execute).toHaveBeenCalledWith(
        "read",
        { file_path: "README.md" },
        baseContext,
      );
      expect(result.details[0].toolName).toBe("read");
    });

    it("maps \'verify content <path>\' to read tool", async () => {
      const criterion = makeCriterion("verify content src/index.ts");
      const executor = makeExecutor([passResult()]);
      const result = await verifyWithTools([criterion], executor, baseContext);
      expect(result.details[0].toolName).toBe("read");
    });
  });

  describe("http_fetch mapping (fetch / check endpoint prefix)", () => {
    it("maps \'fetch <url>\' to http_fetch tool", async () => {
      const criterion = makeCriterion("fetch http://localhost:3000/health");
      const executor = makeExecutor([passResult()]);
      const result = await verifyWithTools([criterion], executor, baseContext);
      expect(executor.execute).toHaveBeenCalledWith(
        "http_fetch",
        { url: "http://localhost:3000/health", method: "GET" },
        baseContext,
      );
      expect(result.details[0].toolName).toBe("http_fetch");
    });

    it("maps \'check endpoint <url>\' to http_fetch tool", async () => {
      const criterion = makeCriterion("check endpoint https://api.example.com/v1/status");
      const executor = makeExecutor([passResult()]);
      const result = await verifyWithTools([criterion], executor, baseContext);
      expect(result.details[0].toolName).toBe("http_fetch");
    });

    it("rejects file:// scheme (SSRF protection)", async () => {
      const criterion = makeCriterion("fetch file:///etc/passwd");
      const executor = makeExecutor([passResult()]);
      const result = await verifyWithTools([criterion], executor, baseContext);
      // file:// is not verifiable — treated as non-verifiable, falls through to Layer 2
      expect(result.mechanicalPassed).toBe(true);
      expect(result.details).toHaveLength(0);
      expect(executor.execute).not.toHaveBeenCalled();
    });

    it("rejects ftp:// scheme (SSRF protection)", async () => {
      const criterion = makeCriterion("check endpoint ftp://internal.host/file");
      const executor = makeExecutor([passResult()]);
      const result = await verifyWithTools([criterion], executor, baseContext);
      expect(result.mechanicalPassed).toBe(true);
      expect(result.details).toHaveLength(0);
      expect(executor.execute).not.toHaveBeenCalled();
    });
  });

  describe("mixed criteria", () => {
    it("handles mix of verifiable and non-verifiable criteria", async () => {
      const criteria = [
        makeCriterion("run npm test"),          // verifiable
        makeCriterion("check file dist/index.js"), // verifiable
        makeCriterion("review with team"),         // not verifiable
      ];
      const executor = makeExecutor([passResult(), passResult()]);
      const result = await verifyWithTools(criteria, executor, baseContext);
      // Only 2 verifiable criteria should produce details
      expect(result.details).toHaveLength(2);
      expect(result.mechanicalPassed).toBe(true);
    });

    it("fails mechanicalPassed when one blocking criterion fails in a batch", async () => {
      const criteria = [
        makeCriterion("run npm test", true),
        makeCriterion("check file dist/index.js", true),
      ];
      const executor = makeExecutor([passResult(), failResult()]);
      const result = await verifyWithTools(criteria, executor, baseContext);
      expect(result.mechanicalPassed).toBe(false);
    });
  });

  describe("detail structure", () => {
    it("returns correct VerificationDetail fields", async () => {
      const criterion = makeCriterion("run npm test");
      const toolRes = passResult();
      const executor = makeExecutor([toolRes]);
      const result = await verifyWithTools([criterion], executor, baseContext);
      const detail = result.details[0];
      expect(detail.criterion).toBe(criterion);
      expect(detail.toolName).toBe("shell");
      expect(detail.toolResult).toEqual(toolRes);
      expect(detail.passed).toBe(true);
    });
  });
});
