import { describe, it, expect, vi, afterEach } from "vitest";
import { toToolDefinition } from "../../../tool-definition-adapter.js";
import { ShellInputSchema, ShellTool } from "../ShellTool.js";
import type { ToolCallContext } from "../../../types.js";
import * as execMod from "../../../../base/utils/execFileNoThrow.js";

const makeContext = (cwd = "/tmp"): ToolCallContext => ({
  cwd,
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
  sessionId: "session-1",
  dryRun: false,
});

describe("ShellTool", () => {
  const tool = new ShellTool();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("metadata", () => {
    it("has correct name", () => {
      expect(tool.metadata.name).toBe("shell");
    });

    it("has read_metrics permission level", () => {
      expect(tool.metadata.permissionLevel).toBe("read_metrics");
    });

    it("is not read-only", () => {
      expect(tool.metadata.isReadOnly).toBe(false);
    });
  });

  describe("input schema", () => {
    it("rejects invalid timeout controls", () => {
      expect(ShellInputSchema.safeParse({ command: "echo ok", timeoutMs: 120_000 }).success).toBe(true);

      for (const timeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY, 600_001]) {
        expect(ShellInputSchema.safeParse({ command: "echo ok", timeoutMs }).success).toBe(false);
      }
    });

    it("exports timeout bounds to model-facing tool definitions", () => {
      const parameters = toToolDefinition(tool).function.parameters as {
        properties?: Record<string, unknown>;
      };

      expect(parameters.properties?.timeoutMs).toMatchObject({
        type: "integer",
        minimum: 1,
        maximum: 600_000,
      });
    });
  });

  describe("checkPermissions", () => {
    it("allows safe command: ls", async () => {
      const result = await tool.checkPermissions({ command: "ls -la", timeoutMs: 120_000 });
      expect(result.status).toBe("allowed");
    });

    it("allows safe command: echo", async () => {
      const result = await tool.checkPermissions({ command: "echo hello", timeoutMs: 120_000 });
      expect(result.status).toBe("allowed");
    });

    it("allows git status", async () => {
      const result = await tool.checkPermissions({ command: "git status", timeoutMs: 120_000 });
      expect(result.status).toBe("allowed");
    });

    it("denies rm command", async () => {
      const result = await tool.checkPermissions({ command: "rm foo.txt", timeoutMs: 120_000 });
      expect(result.status).toBe("denied");
      if (result.status === "denied") {
        expect(result.reason).toContain("Denied");
      }
    });

    it("denies git push", async () => {
      const result = await tool.checkPermissions({ command: "git push origin main", timeoutMs: 120_000 });
      expect(result.status).toBe("denied");
    });

    it("denies compound command with rm", async () => {
      const result = await tool.checkPermissions({ command: "ls && rm foo", timeoutMs: 120_000 });
      expect(result.status).toBe("denied");
    });

    it("requires approval for compound commands with local writes", async () => {
      const result = await tool.checkPermissions({ command: "ls ; mkdir newdir", timeoutMs: 120_000 });
      expect(result.status).toBe("needs_approval");
    });

    it("needs_approval for unknown command", async () => {
      const result = await tool.checkPermissions({ command: "ps aux", timeoutMs: 120_000 });
      expect(result.status).toBe("needs_approval");
    });

    it("requires approval for output redirection", async () => {
      const result = await tool.checkPermissions({ command: "echo hello > file.txt", timeoutMs: 120_000 });
      expect(result.status).toBe("needs_approval");
    });

    it("denies multiline rewrites with immediate typed-tool guidance", async () => {
      const result = await tool.checkPermissions({
        command: "python - <<'PY'\nprint('rewrite')\nPY",
        timeoutMs: 120_000,
      });
      expect(result.status).toBe("denied");
      if (result.status === "denied") {
        expect(result.executionReason).toBe("policy_blocked");
        expect(result.reason).toContain("unsupported multiline syntax");
        expect(result.reason).toContain("Use apply_patch for edits");
        expect(result.reason).toContain("Do not retry with heredocs");
      }
    });

    describe("trusted mode", () => {
      const trustedCtx = {
        cwd: process.cwd(),
        goalId: "test",
        trustBalance: 0,
        preApproved: false,
        approvalFn: async () => false,
        trusted: true,
      };

      it("does not bypass approval for local writes when trusted", async () => {
        const result = await tool.checkPermissions(
          { command: "npm run build", timeoutMs: 120_000 },
          trustedCtx,
        );
        expect(result.status).toBe("needs_approval");
      });

      it("does not bypass destructive denial when trusted", async () => {
        const result = await tool.checkPermissions(
          { command: "git push origin main", timeoutMs: 120_000 },
          trustedCtx,
        );
        expect(result.status).toBe("denied");
      });

      it("still requires approval for redirect operators when trusted", async () => {
        const result = await tool.checkPermissions(
          { command: "echo hello > file.txt", timeoutMs: 120_000 },
          trustedCtx,
        );
        expect(result.status).toBe("needs_approval");
      });

      it("still routes pipe writes to approval even when trusted", async () => {
        const result = await tool.checkPermissions(
          { command: "cat foo | tee bar", timeoutMs: 120_000 },
          trustedCtx,
        );
        expect(result.status).toBe("needs_approval");
      });

      it("still requires approval without trusted flag", async () => {
        const result = await tool.checkPermissions(
          { command: "npm run build", timeoutMs: 120_000 },
        );
        expect(result.status).toBe("needs_approval");
      });
    });
  });

  describe("isConcurrencySafe", () => {
    it("returns true for ls", () => {
      expect(tool.isConcurrencySafe({ command: "ls", timeoutMs: 120_000 })).toBe(true);
    });

    it("returns true for cat", () => {
      expect(tool.isConcurrencySafe({ command: "cat file.txt", timeoutMs: 120_000 })).toBe(true);
    });

    it("returns true for git status", () => {
      expect(tool.isConcurrencySafe({ command: "git status", timeoutMs: 120_000 })).toBe(true);
    });

    it("returns true for rg pattern", () => {
      expect(tool.isConcurrencySafe({ command: "rg TODO src/", timeoutMs: 120_000 })).toBe(true);
    });

    it("returns false for unknown command", () => {
      expect(tool.isConcurrencySafe({ command: "ps aux", timeoutMs: 120_000 })).toBe(false);
    });

    it("returns true for typed read-only npm metadata", () => {
      expect(tool.isConcurrencySafe({ command: "npm ls", timeoutMs: 120_000 })).toBe(true);
    });
  });

  describe("call", () => {
    it("executes echo command successfully", async () => {
      const result = await tool.call({ command: "echo hello", timeoutMs: 5_000 }, makeContext());
      expect(result.success).toBe(true);
      expect((result.data as { stdout: string }).stdout.trim()).toBe("hello");
      expect((result.data as { exitCode: number }).exitCode).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("returns exitCode 0 for pwd", async () => {
      const result = await tool.call({ command: "pwd", timeoutMs: 5_000 }, makeContext("/tmp"));
      expect(result.success).toBe(true);
      expect((result.data as { exitCode: number }).exitCode).toBe(0);
    });

    it("captures stderr and non-zero exit code", async () => {
      const result = await tool.call({ command: "ls /nonexistent_dir_xyz_abc", timeoutMs: 5_000 }, makeContext());
      expect(result.success).toBe(false);
      expect((result.data as { exitCode: number }).exitCode).not.toBe(0);
    });

    it("runs shell commands in a process group for operator abort cleanup", async () => {
      const controller = new AbortController();
      const spy = vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      });

      await tool.call({ command: "echo ok", timeoutMs: 5_000 }, { ...makeContext(), abortSignal: controller.signal });

      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        ["-c", "echo ok"],
        expect.objectContaining({ signal: controller.signal, killProcessGroup: true })
      );
    });

    it("includes contextModifier on success", async () => {
      const result = await tool.call({ command: "echo test_output", timeoutMs: 5_000 }, makeContext());
      expect(result.contextModifier).toBeDefined();
      expect(result.contextModifier).toContain("Shell output:");
    });

    it("uses cwd from input when provided", async () => {
      const result = await tool.call({ command: "pwd", cwd: "/tmp", timeoutMs: 5_000 }, makeContext("/usr"));
      expect(result.success).toBe(true);
      expect((result.data as { stdout: string }).stdout.trim()).toMatch(/^(\/private)?\/tmp$/);
    });
  });

  describe("description", () => {
    it("returns a non-empty string", () => {
      expect(tool.description()).toBeTruthy();
    });
  });
});
