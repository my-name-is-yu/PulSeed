import { describe, it, expect, vi, afterEach } from "vitest";
import { ProcessStatusTool, ProcessStatusInputSchema } from "../ProcessStatusTool.js";
import type { ToolCallContext } from "../../../types.js";
import * as execMod from "../../../../base/utils/execFileNoThrow.js";
import { toToolDefinition } from "../../../tool-definition-adapter.js";

const makeContext = (cwd = "/tmp"): ToolCallContext => ({
  goalId: "goal-1",
  cwd,
  trustBalance: 0,
  preApproved: false,
  approvalFn: async () => false,
});

describe("ProcessStatusTool", () => {
  const tool = new ProcessStatusTool();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("metadata", () => {
    it("has correct name", () => {
      expect(tool.metadata.name).toBe("process-status");
    });

    it("has read_metrics permission level", () => {
      expect(tool.metadata.permissionLevel).toBe("read_metrics");
    });

    it("is read-only", () => {
      expect(tool.metadata.isReadOnly).toBe(true);
    });

    it("is not destructive", () => {
      expect(tool.metadata.isDestructive).toBe(false);
    });
  });

  describe("inputSchema validation", () => {
    it("accepts port only", () => {
      expect(() => ProcessStatusInputSchema.parse({ port: 3000 })).not.toThrow();
    });

    it("accepts processName only", () => {
      expect(() => ProcessStatusInputSchema.parse({ processName: "node" })).not.toThrow();
    });

    it("accepts pid only", () => {
      expect(() => ProcessStatusInputSchema.parse({ pid: 1234 })).not.toThrow();
    });

    it("rejects empty object (no fields)", () => {
      expect(() => ProcessStatusInputSchema.parse({})).toThrow();
    });

    it("rejects port out of range", () => {
      expect(() => ProcessStatusInputSchema.parse({ port: 0 })).toThrow();
      expect(() => ProcessStatusInputSchema.parse({ port: 65536 })).toThrow();
    });

    it("rejects pid < 1", () => {
      expect(() => ProcessStatusInputSchema.parse({ pid: 0 })).toThrow();
    });

    it("rejects unsafe pid integers", () => {
      expect(() => ProcessStatusInputSchema.parse({ pid: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    });

    it("exports the direct pid bounds to model-facing tool schema", () => {
      const definition = toToolDefinition(tool);
      const parameters = definition.function.parameters as {
        properties?: Record<string, unknown>;
      };
      const pidSchema = parameters.properties?.["pid"] as Record<string, unknown>;

      expect(pidSchema).toMatchObject({
        type: "integer",
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      });
    });
  });

  describe("checkPermissions", () => {
    it("always allows", async () => {
      const result = await tool.checkPermissions({ port: 3000 });
      expect(result.status).toBe("allowed");
    });
  });

  describe("isConcurrencySafe", () => {
    it("returns true", () => {
      expect(tool.isConcurrencySafe({ port: 3000 })).toBe(true);
    });
  });

  describe("description", () => {
    it("returns non-empty string", () => {
      expect(tool.description()).toBeTruthy();
    });
  });

  describe("call – pid check", () => {
    it("returns alive=true when signal 0 succeeds", async () => {
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const execSpy = vi.spyOn(execMod, "execFileNoThrow");
      const result = await tool.call({ pid: 1234 }, makeContext());
      expect(result.success).toBe(true);
      const data = result.data as { alive: boolean; pid?: number };
      expect(data.alive).toBe(true);
      expect(data.pid).toBe(1234);
      expect(killSpy).toHaveBeenCalledWith(1234, 0);
      expect(execSpy).not.toHaveBeenCalled();
    });

    it("returns alive=false when signal 0 reports a missing process", async () => {
      const err = new Error("no such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw err;
      });
      const result = await tool.call({ pid: 99999 }, makeContext());
      expect(result.success).toBe(true);
      const data = result.data as { alive: boolean };
      expect(data.alive).toBe(false);
    });

    it("returns alive=true when signal 0 reports a permission boundary", async () => {
      const err = new Error("permission denied") as NodeJS.ErrnoException;
      err.code = "EPERM";
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw err;
      });
      const result = await tool.call({ pid: 1234 }, makeContext());
      expect(result.success).toBe(true);
      const data = result.data as { alive: boolean; pid?: number };
      expect(data.alive).toBe(true);
      expect(data.pid).toBe(1234);
    });
  });

  describe("call – port check", () => {
    it("returns alive=true when lsof finds output", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: "COMMAND  PID  USER\nnode     1234 user  TCP *:3000 (LISTEN)",
        stderr: "",
        exitCode: 0,
      });
      const result = await tool.call({ port: 3000 }, makeContext());
      expect(result.success).toBe(true);
      const data = result.data as { alive: boolean; pid?: number };
      expect(data.alive).toBe(true);
      expect(data.pid).toBe(1234);
      expect(result.summary).toContain("3000");
    });

    it("does not expose partial numeric lsof PID tokens", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: "COMMAND  PID  USER\nnode     1234abc user  TCP *:3000 (LISTEN)",
        stderr: "",
        exitCode: 0,
      });
      const result = await tool.call({ port: 3000 }, makeContext());
      expect(result.success).toBe(true);
      const data = result.data as { alive: boolean; pid?: number };
      expect(data.alive).toBe(true);
      expect(data.pid).toBeUndefined();
      expect(result.summary).toBe("Port 3000 is in use");
    });

    it("returns alive=false when lsof finds nothing", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: "", stderr: "", exitCode: 1,
      });
      const result = await tool.call({ port: 9999 }, makeContext());
      expect(result.success).toBe(true);
      const data = result.data as { alive: boolean };
      expect(data.alive).toBe(false);
    });

    it("returns failure when the lsof probe fails", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: "",
        stderr: "lsof unavailable",
        exitCode: 2,
      });
      const result = await tool.call({ port: 9999 }, makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain("lsof failed");
      expect(result.error).toContain("lsof unavailable");
      const data = result.data as { alive: boolean };
      expect(data.alive).toBe(false);
    });
  });

  describe("call – processName check", () => {
    it("returns alive=true when pgrep finds processes", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: "5678 node --inspect",
        stderr: "",
        exitCode: 0,
      });
      const result = await tool.call({ processName: "node" }, makeContext());
      expect(result.success).toBe(true);
      const data = result.data as { alive: boolean; pid?: number };
      expect(data.alive).toBe(true);
      expect(data.pid).toBe(5678);
    });

    it("does not expose partial numeric pgrep PID tokens", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: "5678abc node --inspect",
        stderr: "",
        exitCode: 0,
      });
      const result = await tool.call({ processName: "node" }, makeContext());
      expect(result.success).toBe(true);
      const data = result.data as { alive: boolean; pid?: number };
      expect(data.alive).toBe(true);
      expect(data.pid).toBeUndefined();
      expect(result.summary).toBe('Process "node" is running');
    });

    it("returns alive=false when pgrep finds nothing", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: "", stderr: "", exitCode: 1,
      });
      const result = await tool.call({ processName: "nonexistent_proc" }, makeContext());
      expect(result.success).toBe(true);
      const data = result.data as { alive: boolean };
      expect(data.alive).toBe(false);
    });

    it("returns failure when the pgrep probe fails", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: null,
      });
      const result = await tool.call({ processName: "node" }, makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toBe("pgrep failed: exit unknown");
      const data = result.data as { alive: boolean };
      expect(data.alive).toBe(false);
    });
  });

  describe("call – error handling", () => {
    it("returns success=false on unexpected error", async () => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw new Error("unexpected process error");
      });
      const result = await tool.call({ pid: 1 }, makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain("unexpected process error");
    });
  });
});
