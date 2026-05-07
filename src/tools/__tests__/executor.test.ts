// src/tools/__tests__/executor.test.ts

import { afterEach, describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { ToolPermissionManager } from "../permission.js";
import { ConcurrencyController } from "../concurrency.js";
import { ShellTool } from "../system/ShellTool/ShellTool.js";
import {
  PermissionGrantStore,
  type PermissionGrantCreateInput,
} from "../../runtime/store/permission-grant-store.js";
import { PermissionWaitPlanStore } from "../../runtime/store/permission-wait-plan-store.js";
import type { ExecutionPolicy } from "../../orchestrator/execution/agent-loop/execution-policy.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
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
  overrides: Partial<ITool<DefaultInput>> & { name?: string } = {},
): ITool<DefaultInput> {
  const name = overrides.name ?? "mock-tool";
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
    maxOutputChars: metadataOverrides.maxOutputChars ?? 8000,
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

function createExecutionPolicy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    executionProfile: "consumer",
    sandboxMode: "workspace_write",
    approvalPolicy: "on_request",
    networkAccess: true,
    workspaceRoot: "/tmp",
    protectedPaths: [],
    trustProjectInstructions: true,
    ...overrides,
  };
}

function createExecutor(registeredTools: ITool[] = []) {
  const registry = new ToolRegistry();
  for (const tool of registeredTools) {
    registry.register(tool);
  }
  const permissionManager = new ToolPermissionManager({});
  const concurrency = new ConcurrencyController();
  const executor = new ToolExecutor({ registry, permissionManager, concurrency });
  return { executor, registry, permissionManager, concurrency };
}

const permissionGrantRuntimeRoots: string[] = [];

afterEach(() => {
  for (const runtimeRoot of permissionGrantRuntimeRoots.splice(0)) {
    cleanupTempDir(runtimeRoot);
  }
});

function createWaitPlanStore(): PermissionWaitPlanStore {
  const runtimeRoot = makeTempDir("pulseed-permission-wait-plan-");
  permissionGrantRuntimeRoots.push(runtimeRoot);
  return new PermissionWaitPlanStore(runtimeRoot, {
    createEventId: () => `event-${Math.random().toString(36).slice(2)}`,
  });
}

async function createActiveGrant(
  overrides: {
    grantId?: string;
    goalId?: string;
    sessionId?: string;
    capabilities?: Array<"write_workspace" | "run_safe_local_commands" | "run_tests">;
    excludedCapabilities?: Array<"destructive_action" | "write_remote" | "network_send" | "protected_path_mutation" | "unknown_capability">;
    origin?: Partial<PermissionGrantCreateInput["origin"]>;
    scope?: PermissionGrantCreateInput["scope"];
    duration?: PermissionGrantCreateInput["duration"];
    review?: PermissionGrantCreateInput["review"];
    stale?: boolean;
  } = {},
): Promise<PermissionGrantStore> {
  const runtimeRoot = makeTempDir("pulseed-permission-grant-evaluator-");
  permissionGrantRuntimeRoots.push(runtimeRoot);
  const store = new PermissionGrantStore(runtimeRoot);
  await store.createActive({
    grant_id: overrides.grantId ?? "grant-1",
    subject: {
      kind: "user",
      id: "user-1",
    },
    origin: {
      channel: "chat",
      session_id: overrides.sessionId ?? "session-1",
      ...overrides.origin,
    },
    source: {
      kind: "redacted_text",
      redacted_text: "[redacted] approved this scoped permission",
    },
    scope: overrides.scope ?? {
      kind: "goal",
      goal_id: overrides.goalId ?? "goal-1",
    },
    duration: overrides.duration ?? {
      kind: "until_goal_done",
    },
    ...(overrides.review ? { review: overrides.review } : {}),
    capabilities: overrides.capabilities ?? ["write_workspace"],
    excluded_capabilities: overrides.excludedCapabilities ?? [
      "destructive_action",
      "write_remote",
      "network_send",
      "protected_path_mutation",
      "unknown_capability",
    ],
  });
  if (overrides.stale) {
    await store.markStale(overrides.grantId ?? "grant-1", {
      reason: "test stale permission binding",
    });
  }
  return store;
}

// --- Tests ---

describe("ToolExecutor", () => {
  describe("execute()", () => {
    it("returns fail result when tool is not found", async () => {
      const { executor } = createExecutor();
      const ctx = createMockContext();
      const result = await executor.execute("nonexistent", {}, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    describe("Gate 1 — Input validation", () => {
      it("rejects input that fails Zod schema", async () => {
        const tool = createMockTool();
        const { executor } = createExecutor([tool]);
        const ctx = createMockContext();
        // Missing required "value" field
        const result = await executor.execute("mock-tool", { wrong: 123 }, ctx);
        expect(result.success).toBe(false);
        expect(result.error).toContain("Input validation failed");
      });

      it("accepts valid input", async () => {
        const tool = createMockTool();
        const { executor } = createExecutor([tool]);
        const ctx = createMockContext();
        const result = await executor.execute("mock-tool", { value: "hello" }, ctx);
        expect(result.success).toBe(true);
      });
    });

    describe("Gate 2 — Semantic validation", () => {
      it("returns fail when checkPermissions returns denied", async () => {
        const tool = createMockTool({
          checkPermissions: vi.fn().mockResolvedValue({
            status: "denied",
            reason: "not allowed semantically",
          } as PermissionCheckResult),
        });
        const { executor } = createExecutor([tool]);
        const ctx = createMockContext();
        const result = await executor.execute("mock-tool", { value: "x" }, ctx);
        expect(result.success).toBe(false);
        expect(result.error).toContain("not allowed semantically");
      });

      it("proceeds when checkPermissions returns allowed", async () => {
        const tool = createMockTool({
          checkPermissions: vi.fn().mockResolvedValue({ status: "allowed" } as PermissionCheckResult),
        });
        const { executor } = createExecutor([tool]);
        const ctx = createMockContext();
        const result = await executor.execute("mock-tool", { value: "x" }, ctx);
        expect(result.success).toBe(true);
      });
    });

    describe("Gate 3 — Permission manager", () => {
      it("denies when permission manager denies via deny-list", async () => {
        const tool = createMockTool({
          name: "blocked-tool",
          metadata: {
            name: "blocked-tool",
            aliases: [],
            permissionLevel: "read_only",
            isReadOnly: false,
            isDestructive: false,
            shouldDefer: false,
            alwaysLoad: false,
            maxConcurrency: 0,
            maxOutputChars: 8000,
            tags: [],
          } as ITool["metadata"],
        });
        const registry = new ToolRegistry();
        registry.register(tool);
        const permissionManager = new ToolPermissionManager({
          denyRules: [{ toolName: "blocked-tool", reason: "blocked by policy" }],
        });
        const concurrency = new ConcurrencyController();
        const executor = new ToolExecutor({ registry, permissionManager, concurrency });
        const ctx = createMockContext();
        const result = await executor.execute("blocked-tool", { value: "x" }, ctx);
        expect(result.success).toBe(false);
        expect(result.error).toContain("blocked by policy");
      });

      it("calls approvalFn when trust balance is low for write_local", async () => {
        const tool = createMockTool({
          name: "write-tool",
          metadata: {
            name: "write-tool",
            aliases: [],
            permissionLevel: "write_local",
            isReadOnly: false,
            isDestructive: false,
            shouldDefer: false,
            alwaysLoad: false,
            maxConcurrency: 0,
            maxOutputChars: 8000,
            tags: [],
          } as ITool["metadata"],
        });
        const { executor } = createExecutor([tool]);
        const approvalFn = vi.fn().mockResolvedValue(true);
        const ctx = createMockContext({ trustBalance: -50, approvalFn });
        await executor.execute("write-tool", { value: "x" }, ctx);
        expect(approvalFn).toHaveBeenCalled();
      });

      it("returns fail when user denies approval", async () => {
        const tool = createMockTool({
          name: "write-tool2",
          metadata: {
            name: "write-tool2",
            aliases: [],
            permissionLevel: "write_local",
            isReadOnly: false,
            isDestructive: false,
            shouldDefer: false,
            alwaysLoad: false,
            maxConcurrency: 0,
            maxOutputChars: 8000,
            tags: [],
          } as ITool["metadata"],
        });
        const { executor } = createExecutor([tool]);
        const approvalFn = vi.fn().mockResolvedValue(false);
        const ctx = createMockContext({ trustBalance: -50, approvalFn });
        const result = await executor.execute("write-tool2", { value: "x" }, ctx);
        expect(result.success).toBe(false);
        expect(result.error).toContain("User denied approval");
      });

      it("stores and resumes the approved canonical permission wait plan before executing", async () => {
        const tool = createMockTool({
          name: "write-wait-tool",
          metadata: {
            name: "write-wait-tool",
            aliases: [],
            permissionLevel: "write_local",
            isReadOnly: false,
            isDestructive: false,
            shouldDefer: false,
            alwaysLoad: false,
            maxConcurrency: 0,
            maxOutputChars: 8000,
            tags: [],
          } as ITool["metadata"],
        });
        const waitPlanStore = createWaitPlanStore();
        const { executor } = createExecutor([tool]);
        const approvalFn = vi.fn().mockResolvedValue(true);
        const ctx = createMockContext({
          approvalFn,
          callId: "call-wait-1",
          sessionId: "session-1",
          runId: "run-1",
          turnId: "turn-1",
          executionPolicy: createExecutionPolicy({ approvalPolicy: "on_request" }),
          hostToolState: {
            currentEpoch: "epoch-1",
          },
          permissionWaitPlanStore: waitPlanStore,
        });

        const result = await executor.execute("write-wait-tool", { value: "x" }, ctx);

        expect(result.success).toBe(true);
        expect(tool.call).toHaveBeenCalledOnce();
        expect(approvalFn).toHaveBeenCalledWith(expect.objectContaining({
          approvalId: expect.stringMatching(/^permission-wait:/),
          permissionWaitPlanId: expect.stringMatching(/^permission-wait:/),
          canonicalPermissionPlan: expect.objectContaining({
            tool_name: "write-wait-tool",
            target: expect.objectContaining({
              session_id: "session-1",
              run_id: "run-1",
              turn_id: "turn-1",
              tool_call_id: "call-wait-1",
            }),
            state_epoch: "epoch-1",
          }),
        }));
        const waitPlans = await waitPlanStore.list();
        expect(waitPlans).toHaveLength(1);
        expect(waitPlans[0]).toMatchObject({
          state: "resumed",
          canonical_plan: {
            input: { value: "x" },
            capability_facts: {
              host_decision_status: "needs_permission",
            },
          },
          audit_events: [
            expect.objectContaining({ state: "waiting_for_permission" }),
            expect.objectContaining({ state: "approved" }),
            expect.objectContaining({ state: "resumed" }),
          ],
        });
      });

      it("keeps denied approvals as typed non-execution state", async () => {
        const tool = createMockTool({
          name: "write-wait-denied-tool",
          metadata: {
            name: "write-wait-denied-tool",
            aliases: [],
            permissionLevel: "write_local",
            isReadOnly: false,
            isDestructive: false,
            shouldDefer: false,
            alwaysLoad: false,
            maxConcurrency: 0,
            maxOutputChars: 8000,
            tags: [],
          } as ITool["metadata"],
        });
        const waitPlanStore = createWaitPlanStore();
        const { executor } = createExecutor([tool]);
        const approvalFn = vi.fn().mockResolvedValue(false);
        const ctx = createMockContext({
          approvalFn,
          callId: "call-denied-1",
          executionPolicy: createExecutionPolicy({ approvalPolicy: "on_request" }),
          permissionWaitPlanStore: waitPlanStore,
        });

        const result = await executor.execute("write-wait-denied-tool", { value: "x" }, ctx);

        expect(result.success).toBe(false);
        expect(result.execution).toMatchObject({
          status: "not_executed",
          reason: "approval_denied",
        });
        expect(tool.call).not.toHaveBeenCalled();
        expect(await waitPlanStore.list()).toEqual([
          expect.objectContaining({
            state: "denied",
            audit_events: expect.arrayContaining([
              expect.objectContaining({ state: "denied" }),
            ]),
          }),
        ]);
      });

      it("rejects resume when the state epoch changes after approval was requested", async () => {
        const tool = createMockTool({
          name: "write-wait-stale-tool",
          metadata: {
            name: "write-wait-stale-tool",
            aliases: [],
            permissionLevel: "write_local",
            isReadOnly: false,
            isDestructive: false,
            shouldDefer: false,
            alwaysLoad: false,
            maxConcurrency: 0,
            maxOutputChars: 8000,
            tags: [],
          } as ITool["metadata"],
        });
        const waitPlanStore = createWaitPlanStore();
        const { executor } = createExecutor([tool]);
        const ctx = createMockContext({
          callId: "call-stale-1",
          executionPolicy: createExecutionPolicy({ approvalPolicy: "on_request" }),
          hostToolState: {
            currentEpoch: "epoch-1",
          },
          permissionWaitPlanStore: waitPlanStore,
        });
        const approvalFn = vi.fn().mockImplementation(async () => {
          ctx.hostToolState = { currentEpoch: "epoch-2" };
          return true;
        });
        ctx.approvalFn = approvalFn;

        const result = await executor.execute("write-wait-stale-tool", { value: "x" }, ctx);

        expect(result.success).toBe(false);
        expect(result.execution).toMatchObject({
          status: "not_executed",
          reason: "stale_state",
        });
        expect(result.error).toContain("state_epoch_changed");
        expect(tool.call).not.toHaveBeenCalled();
        expect(await waitPlanStore.list()).toEqual([
          expect.objectContaining({
            state: "mismatch_rejected",
            audit_events: expect.arrayContaining([
              expect.objectContaining({
                state: "mismatch_rejected",
                mismatch_reasons: expect.arrayContaining(["state_epoch_changed"]),
              }),
            ]),
          }),
        ]);
      });

      it("does not execute escalation-required tools by ordinary approval", async () => {
        const tool = createMockTool({
          name: "execute-tool",
          metadata: {
            name: "execute-tool",
            aliases: [],
            permissionLevel: "execute",
            isReadOnly: false,
            isDestructive: true,
            shouldDefer: false,
            alwaysLoad: false,
            maxConcurrency: 0,
            maxOutputChars: 8000,
            tags: [],
          } as ITool["metadata"],
        });
        const { executor } = createExecutor([tool]);
        const approvalFn = vi.fn().mockResolvedValue(true);
        const ctx = createMockContext({
          approvalFn,
          executionPolicy: createExecutionPolicy({ approvalPolicy: "untrusted" }),
        });

        const result = await executor.execute("execute-tool", { value: "x" }, ctx);

        expect(result.success).toBe(false);
        expect(result.execution).toMatchObject({
          status: "not_executed",
          reason: "escalation_required",
        });
        expect(approvalFn).not.toHaveBeenCalled();
        expect(tool.call).not.toHaveBeenCalled();
      });

      it("returns typed sandbox-required execution for shell commands before shell-local denial", async () => {
        const shellTool = new ShellTool();
        const { executor } = createExecutor([shellTool]);
        const approvalFn = vi.fn().mockResolvedValue(true);
        const ctx = createMockContext({
          approvalFn,
          executionPolicy: createExecutionPolicy({
            sandboxMode: "read_only",
            approvalPolicy: "on_request",
          }),
        });

        const result = await executor.execute("shell", { command: "touch file.txt" }, ctx);

        expect(result.success).toBe(false);
        expect(result.execution).toMatchObject({
          status: "not_executed",
          reason: "sandbox_required",
        });
        expect(approvalFn).not.toHaveBeenCalled();
      });

      it("uses an active write_workspace PermissionGrant for the real executor permission boundary", async () => {
        const tool = createMockTool({
          name: "write-workspace-tool",
          metadata: {
            name: "write-workspace-tool",
            aliases: [],
            permissionLevel: "write_local",
            isReadOnly: false,
            isDestructive: false,
            shouldDefer: false,
            alwaysLoad: false,
            maxConcurrency: 0,
            maxOutputChars: 8000,
            tags: [],
          } as ITool["metadata"],
        });
        const store = await createActiveGrant();
        const { executor } = createExecutor([tool]);
        const approvalFn = vi.fn().mockResolvedValue(false);
        const ctx = createMockContext({
          approvalFn,
          sessionId: "session-1",
          executionPolicy: createExecutionPolicy({ approvalPolicy: "on_request" }),
          permissionGrantStore: store,
        });

        const result = await executor.execute("write-workspace-tool", { value: "x" }, ctx);

        expect(result.success).toBe(true);
        expect(approvalFn).not.toHaveBeenCalled();
        expect(await store.load("grant-1")).toMatchObject({
          usage_count: 1,
        });
      });

      it("uses a standing workspace grant across sessions only within the approving origin boundary", async () => {
        const tool = createMockTool({
          name: "standing-write-workspace-tool",
          metadata: {
            name: "standing-write-workspace-tool",
            aliases: [],
            permissionLevel: "write_local",
            isReadOnly: false,
            isDestructive: false,
            shouldDefer: false,
            alwaysLoad: false,
            maxConcurrency: 0,
            maxOutputChars: 8000,
            tags: [],
          } as ITool["metadata"],
        });
        const store = await createActiveGrant({
          sessionId: "old-session",
          origin: {
            conversation_id: "conversation-1",
            user_id: "user-1",
          },
          scope: {
            kind: "workspace",
            workspace_root: "/tmp",
          },
          duration: {
            kind: "standing",
          },
          review: {
            kind: "periodic",
            interval_ms: 30 * 24 * 60 * 60 * 1000,
            due_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
            last_reviewed_at: Date.now(),
          },
        });
        const { executor } = createExecutor([tool]);
        const approvalFn = vi.fn().mockResolvedValue(false);
        const ctx = createMockContext({
          approvalFn,
          sessionId: "new-session",
          executionPolicy: createExecutionPolicy({ approvalPolicy: "on_request", workspaceRoot: "/tmp" }),
          permissionGrantStore: store,
          runtimeReplyTarget: {
            conversation_id: "conversation-1",
            user_id: "user-1",
          },
        });

        const result = await executor.execute("standing-write-workspace-tool", { value: "x" }, ctx);

        expect(result.success).toBe(true);
        expect(approvalFn).not.toHaveBeenCalled();
        expect(await store.load("grant-1")).toMatchObject({
          usage_count: 1,
        });
      });

      it("asks again when a standing workspace grant is due for review", async () => {
        const tool = createMockTool({
          name: "standing-review-due-tool",
          metadata: {
            name: "standing-review-due-tool",
            aliases: [],
            permissionLevel: "write_local",
            isReadOnly: false,
            isDestructive: false,
            shouldDefer: false,
            alwaysLoad: false,
            maxConcurrency: 0,
            maxOutputChars: 8000,
            tags: [],
          } as ITool["metadata"],
        });
        const store = await createActiveGrant({
          origin: {
            conversation_id: "conversation-1",
            user_id: "user-1",
          },
          scope: {
            kind: "workspace",
            workspace_root: "/tmp",
          },
          duration: {
            kind: "standing",
          },
          review: {
            kind: "periodic",
            interval_ms: 1,
            due_at: 1,
            last_reviewed_at: 0,
          },
        });
        const { executor } = createExecutor([tool]);
        const approvalFn = vi.fn().mockResolvedValue(false);
        const ctx = createMockContext({
          approvalFn,
          executionPolicy: createExecutionPolicy({ approvalPolicy: "on_request", workspaceRoot: "/tmp" }),
          permissionGrantStore: store,
          runtimeReplyTarget: {
            conversation_id: "conversation-1",
            user_id: "user-1",
          },
        });

        const result = await executor.execute("standing-review-due-tool", { value: "x" }, ctx);

        expect(result.success).toBe(false);
        expect(result.execution).toMatchObject({
          status: "not_executed",
          reason: "approval_denied",
        });
        expect(approvalFn).toHaveBeenCalledOnce();
        expect(await store.load("grant-1")).toMatchObject({
          usage_count: 0,
        });
      });

      it("uses a run_safe_local_commands PermissionGrant only after shell policy classifies the command", async () => {
        const shellTool = new ShellTool();
        const store = await createActiveGrant({
          capabilities: ["run_safe_local_commands"],
        });
        const { executor } = createExecutor([shellTool]);
        const approvalFn = vi.fn().mockResolvedValue(false);
        const ctx = createMockContext({
          approvalFn,
          sessionId: "session-1",
          dryRun: true,
          executionPolicy: createExecutionPolicy({ approvalPolicy: "on_request" }),
          permissionGrantStore: store,
        });

        const result = await executor.execute("shell", { command: "touch grant-ok.txt" }, ctx);

        expect(result.success).toBe(true);
        expect(result.execution).toMatchObject({
          status: "not_executed",
          reason: "dry_run",
        });
        expect(approvalFn).not.toHaveBeenCalled();
        expect(await store.load("grant-1")).toMatchObject({
          usage_count: 1,
        });
      });

      it("uses a run_tests PermissionGrant for typed test activity", async () => {
        const tool = createMockTool({
          name: "test-runner-tool",
          metadata: {
            name: "test-runner-tool",
            aliases: [],
            permissionLevel: "execute",
            isReadOnly: false,
            isDestructive: false,
            shouldDefer: false,
            alwaysLoad: false,
            maxConcurrency: 0,
            maxOutputChars: 8000,
            tags: [],
            activityCategory: "test",
          } as ITool["metadata"],
        });
        const store = await createActiveGrant({
          capabilities: ["run_tests"],
        });
        const { executor } = createExecutor([tool]);
        const approvalFn = vi.fn().mockResolvedValue(false);
        const ctx = createMockContext({
          approvalFn,
          sessionId: "session-1",
          executionPolicy: createExecutionPolicy({ approvalPolicy: "on_request" }),
          permissionGrantStore: store,
        });

        const result = await executor.execute("test-runner-tool", { value: "x" }, ctx);

        expect(result.success).toBe(true);
        expect(approvalFn).not.toHaveBeenCalled();
        expect(await store.load("grant-1")).toMatchObject({
          usage_count: 1,
        });
      });

      it("rejects stale or previous-goal grants and asks again", async () => {
        const tool = createMockTool({
          name: "write-stale-tool",
          metadata: {
            name: "write-stale-tool",
            aliases: [],
            permissionLevel: "write_local",
            isReadOnly: false,
            isDestructive: false,
            shouldDefer: false,
            alwaysLoad: false,
            maxConcurrency: 0,
            maxOutputChars: 8000,
            tags: [],
          } as ITool["metadata"],
        });
        const store = await createActiveGrant({
          goalId: "old-goal",
          stale: true,
        });
        const { executor } = createExecutor([tool]);
        const approvalFn = vi.fn().mockResolvedValue(false);
        const ctx = createMockContext({
          approvalFn,
          goalId: "goal-1",
          sessionId: "session-1",
          executionPolicy: createExecutionPolicy({ approvalPolicy: "on_request" }),
          permissionGrantStore: store,
        });

        const result = await executor.execute("write-stale-tool", { value: "x" }, ctx);

        expect(result.success).toBe(false);
        expect(result.execution).toMatchObject({
          status: "not_executed",
          reason: "approval_denied",
        });
        expect(approvalFn).toHaveBeenCalledOnce();
        expect(tool.call).not.toHaveBeenCalled();
        expect(await store.load("grant-1")).toMatchObject({
          usage_count: 0,
        });
      });

      it("does not let a local-work grant cover excluded remote capabilities", async () => {
        const tool = createMockTool({
          name: "remote-writer",
          metadata: {
            name: "remote-writer",
            aliases: [],
            permissionLevel: "write_remote",
            isReadOnly: false,
            isDestructive: false,
            shouldDefer: false,
            alwaysLoad: false,
            maxConcurrency: 0,
            maxOutputChars: 8000,
            tags: [],
          } as ITool["metadata"],
        });
        const store = await createActiveGrant();
        const { executor } = createExecutor([tool]);
        const approvalFn = vi.fn().mockResolvedValue(false);
        const ctx = createMockContext({
          approvalFn,
          sessionId: "session-1",
          executionPolicy: createExecutionPolicy({
            approvalPolicy: "on_request",
            networkAccess: true,
          }),
          permissionGrantStore: store,
        });

        const result = await executor.execute("remote-writer", { value: "x" }, ctx);

        expect(result.success).toBe(false);
        expect(result.execution).toMatchObject({
          status: "not_executed",
          reason: "approval_denied",
        });
        expect(approvalFn).toHaveBeenCalledOnce();
        expect(approvalFn).toHaveBeenCalledWith(expect.objectContaining({
          permissionGrantDecision: expect.objectContaining({
            status: "excluded_capability",
            excludedCapabilities: ["write_remote"],
          }),
        }));
        expect(await store.load("grant-1")).toMatchObject({
          usage_count: 0,
        });
      });

      it("does not let a grant bypass shell unknown-capability classification", async () => {
        const shellTool = new ShellTool();
        const store = await createActiveGrant({
          capabilities: ["run_safe_local_commands"],
        });
        const { executor } = createExecutor([shellTool]);
        const approvalFn = vi.fn().mockResolvedValue(false);
        const ctx = createMockContext({
          approvalFn,
          sessionId: "session-1",
          dryRun: true,
          executionPolicy: createExecutionPolicy({ approvalPolicy: "on_request" }),
          permissionGrantStore: store,
        });

        const result = await executor.execute("shell", { command: "python -c 'print(1)'" }, ctx);

        expect(result.success).toBe(false);
        expect(result.execution).toMatchObject({
          status: "not_executed",
          reason: "approval_denied",
        });
        expect(approvalFn).toHaveBeenCalledOnce();
        expect(await store.load("grant-1")).toMatchObject({
          usage_count: 0,
        });
      });

      it("does not let grants bypass sandbox hard boundaries", async () => {
        const shellTool = new ShellTool();
        const store = await createActiveGrant({
          capabilities: ["run_safe_local_commands"],
        });
        const { executor } = createExecutor([shellTool]);
        const approvalFn = vi.fn().mockResolvedValue(true);
        const ctx = createMockContext({
          approvalFn,
          sessionId: "session-1",
          dryRun: true,
          executionPolicy: createExecutionPolicy({
            sandboxMode: "read_only",
            approvalPolicy: "on_request",
          }),
          permissionGrantStore: store,
        });

        const result = await executor.execute("shell", { command: "touch blocked.txt" }, ctx);

        expect(result.success).toBe(false);
        expect(result.execution).toMatchObject({
          status: "not_executed",
          reason: "sandbox_required",
        });
        expect(approvalFn).not.toHaveBeenCalled();
        expect(await store.load("grant-1")).toMatchObject({
          usage_count: 0,
        });
      });
    });

    describe("Gate 4 — Input sanitization", () => {
      it("blocks shell injection patterns for shell tool", async () => {
        const shellTool = createMockTool({
          name: "shell",
          metadata: {
            name: "shell",
            aliases: [],
            permissionLevel: "read_metrics",
            isReadOnly: false,
            isDestructive: false,
            shouldDefer: false,
            alwaysLoad: false,
            maxConcurrency: 0,
            maxOutputChars: 8000,
            tags: [],
          } as ITool["metadata"],
          inputSchema: z.object({ value: z.string(), command: z.string() }) as unknown as z.ZodType<DefaultInput>,
          checkPermissions: vi.fn().mockResolvedValue({ status: "allowed" } as PermissionCheckResult),
        });
        const registry = new ToolRegistry();
        registry.register(shellTool);
        const permissionManager = new ToolPermissionManager({
          allowRules: [{ toolName: "shell", reason: "test allow" }],
        });
        const concurrency = new ConcurrencyController();
        const executor = new ToolExecutor({ registry, permissionManager, concurrency });
        const ctx = createMockContext({ trustBalance: 100 });
        const result = await executor.execute("shell", { value: "x", command: "ls; rm -rf /" }, ctx);
        expect(result.success).toBe(false);
        expect(result.error).toContain("sanitization failed");
      });
    });

    describe("Gate 5 — Concurrency control", () => {
      it("executes tool through the concurrency controller", async () => {
        const tool = createMockTool();
        const concurrency = new ConcurrencyController();
        const runSpy = vi.spyOn(concurrency, "run");
        const registry = new ToolRegistry();
        registry.register(tool);
        const permissionManager = new ToolPermissionManager({});
        const executor = new ToolExecutor({ registry, permissionManager, concurrency });
        const ctx = createMockContext();
        await executor.execute("mock-tool", { value: "x" }, ctx);
        expect(runSpy).toHaveBeenCalledOnce();
      });
    });

    describe("Output truncation", () => {
      it("truncates oversized output and updates summary", async () => {
        const bigData = "x".repeat(500);
        const tool = createMockTool({
          metadata: {
            name: "mock-tool",
            aliases: [],
            permissionLevel: "read_only",
            isReadOnly: true,
            isDestructive: false,
            shouldDefer: false,
            alwaysLoad: false,
            maxConcurrency: 0,
            maxOutputChars: 10,
            tags: [],
          } as ITool["metadata"],
          call: vi.fn().mockResolvedValue({
            success: true,
            data: bigData,
            summary: "big result",
            durationMs: 5,
          } as ToolResult),
        });
        const { executor } = createExecutor([tool]);
        const ctx = createMockContext();
        const result = await executor.execute("mock-tool", { value: "x" }, ctx);
        expect(result.success).toBe(true);
        expect(typeof result.data).toBe("string");
        expect(result.summary).toContain("truncated");
      });

      it("does not truncate output within maxOutputChars", async () => {
        const tool = createMockTool();
        const { executor } = createExecutor([tool]);
        const ctx = createMockContext();
        const result = await executor.execute("mock-tool", { value: "x" }, ctx);
        expect(result.success).toBe(true);
        expect(result.summary).toBe("success");
      });
    });

    describe("Timeout", () => {
      it("times out when tool takes too long", async () => {
        const slowTool = createMockTool({
          call: vi.fn().mockImplementation(
            () => new Promise((resolve) => setTimeout(resolve, 500)),
          ),
        });
        const { executor } = createExecutor([slowTool]);
        const ctx = createMockContext({ timeoutMs: 50 });
        await expect(
          executor.execute("mock-tool", { value: "x" }, ctx),
        ).rejects.toThrow("timed out");
      });
    });
  });

  describe("executeBatch()", () => {
    it("returns results for all batch calls in original order", async () => {
      const tool1 = createMockTool({
        name: "tool-1",
        call: vi.fn().mockResolvedValue({
          success: true, data: 1, summary: "one", durationMs: 5,
        } as ToolResult),
      });
      const tool2 = createMockTool({
        name: "tool-2",
        call: vi.fn().mockResolvedValue({
          success: true, data: 2, summary: "two", durationMs: 5,
        } as ToolResult),
        metadata: {
          name: "tool-2",
          aliases: [],
          permissionLevel: "read_only",
          isReadOnly: true,
          isDestructive: false,
          shouldDefer: false,
          alwaysLoad: false,
          maxConcurrency: 0,
          maxOutputChars: 8000,
          tags: [],
        } as ITool["metadata"],
      });

      const { executor } = createExecutor([tool1, tool2]);
      const ctx = createMockContext();
      const results = await executor.executeBatch(
        [
          { toolName: "tool-1", input: { value: "a" } },
          { toolName: "tool-2", input: { value: "b" } },
        ],
        ctx,
      );

      expect(results).toHaveLength(2);
      expect(results[0].summary).toBe("one");
      expect(results[1].summary).toBe("two");
    });

    it("runs safe tools (isConcurrencySafe=true) and unsafe sequentially, all succeed", async () => {
      const safeTool = createMockTool({
        name: "safe-tool",
        isConcurrencySafe: vi.fn().mockReturnValue(true),
        call: vi.fn().mockResolvedValue({
          success: true, data: "safe", summary: "safe", durationMs: 5,
        } as ToolResult),
      });
      const unsafeTool = createMockTool({
        name: "unsafe-tool",
        isConcurrencySafe: vi.fn().mockReturnValue(false),
        call: vi.fn().mockResolvedValue({
          success: true, data: "unsafe", summary: "unsafe", durationMs: 5,
        } as ToolResult),
        metadata: {
          name: "unsafe-tool",
          aliases: [],
          permissionLevel: "read_only",
          isReadOnly: true,
          isDestructive: false,
          shouldDefer: false,
          alwaysLoad: false,
          maxConcurrency: 0,
          maxOutputChars: 8000,
          tags: [],
        } as ITool["metadata"],
      });

      const { executor } = createExecutor([safeTool, unsafeTool]);
      const ctx = createMockContext();
      const results = await executor.executeBatch(
        [
          { toolName: "safe-tool", input: { value: "a" } },
          { toolName: "unsafe-tool", input: { value: "b" } },
          { toolName: "safe-tool", input: { value: "c" } },
        ],
        ctx,
      );

      expect(results).toHaveLength(3);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(results[2].success).toBe(true);
    });

    it("handles missing tool in batch gracefully", async () => {
      const { executor } = createExecutor([]);
      const ctx = createMockContext();
      const results = await executor.executeBatch(
        [{ toolName: "nonexistent", input: {} }],
        ctx,
      );
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain("not found");
    });
  });

  describe("Audit logging", () => {
    it("calls logger.debug on start and success", async () => {
      const tool = createMockTool();
      const { executor } = createExecutor([tool]);
      const debugFn = vi.fn();
      const logger = { debug: debugFn, warn: vi.fn(), error: vi.fn() };
      const ctx = createMockContext({ logger, callId: "call-123", sessionId: "sess-456" });
      await executor.execute("mock-tool", { value: "x" }, ctx);
      expect(debugFn).toHaveBeenCalledWith("tool.call.start", expect.objectContaining({ tool: "mock-tool", callId: "call-123", sessionId: "sess-456" }));
      expect(debugFn).toHaveBeenCalledWith("tool.call.success", expect.objectContaining({ tool: "mock-tool", callId: "call-123" }));
    });

    it("calls logger.warn on failure (timeout throws)", async () => {
      const slowTool = createMockTool({
        call: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 500)),
        ),
      });
      const { executor } = createExecutor([slowTool]);
      const warnFn = vi.fn();
      const logger = { debug: vi.fn(), warn: warnFn, error: vi.fn() };
      const ctx = createMockContext({ timeoutMs: 50, logger, callId: "call-timeout" });
      await expect(executor.execute("mock-tool", { value: "x" }, ctx)).rejects.toThrow("timed out");
      expect(warnFn).toHaveBeenCalledWith("tool.call.failure", expect.objectContaining({ tool: "mock-tool" }));
    });

    it("works without logger (no-op)", async () => {
      const tool = createMockTool();
      const { executor } = createExecutor([tool]);
      const ctx = createMockContext(); // no logger
      const result = await executor.execute("mock-tool", { value: "x" }, ctx);
      expect(result.success).toBe(true);
    });
  });

  describe("dryRun mode", () => {
    it("skips tool.call when dryRun is true", async () => {
      const callFn = vi.fn().mockResolvedValue({ success: true, data: "real", summary: "real", durationMs: 5 });
      const tool = createMockTool({ call: callFn });
      const { executor } = createExecutor([tool]);
      const ctx = createMockContext({ dryRun: true });
      const result = await executor.execute("mock-tool", { value: "x" }, ctx);
      expect(callFn).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.summary).toContain("dry-run");
    });
  });

  describe("Retry with backoff", () => {
    it("retries transient errors for concurrency-safe tools", async () => {
      vi.useFakeTimers();
      let attempt = 0;
      const callFn = vi.fn().mockImplementation(() => {
        attempt++;
        if (attempt === 1) throw new Error("ECONNRESET: connection reset");
        return Promise.resolve({ success: true, data: "ok", summary: "ok", durationMs: 5 });
      });
      const tool = createMockTool({
        call: callFn,
        isConcurrencySafe: vi.fn().mockReturnValue(true),
      });
      const { executor } = createExecutor([tool]);
      const ctx = createMockContext();
      const promise = executor.execute("mock-tool", { value: "x" }, ctx);
      // Advance past first backoff (500ms)
      await vi.advanceTimersByTimeAsync(600);
      const result = await promise;
      expect(callFn).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
      vi.useRealTimers();
    });

    it("does not retry non-transient errors", async () => {
      const callFn = vi.fn().mockRejectedValue(new Error("Something went very wrong"));
      const tool = createMockTool({
        call: callFn,
        isConcurrencySafe: vi.fn().mockReturnValue(true),
      });
      const { executor } = createExecutor([tool]);
      const ctx = createMockContext();
      const result = await executor.execute("mock-tool", { value: "x" }, ctx);
      expect(callFn).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Something went very wrong");
    });

    it("does not retry for concurrency-unsafe tools even on transient errors", async () => {
      const callFn = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
      const tool = createMockTool({
        call: callFn,
        isConcurrencySafe: vi.fn().mockReturnValue(false),
      });
      const { executor } = createExecutor([tool]);
      const ctx = createMockContext();
      const result = await executor.execute("mock-tool", { value: "x" }, ctx);
      expect(callFn).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
    });
  });

  describe("Truncation metadata", () => {
    it("sets truncated.originalChars when output is truncated", async () => {
      const bigData = "x".repeat(500);
      const tool = createMockTool({
        metadata: {
          name: "mock-tool",
          aliases: [],
          permissionLevel: "read_only",
          isReadOnly: true,
          isDestructive: false,
          shouldDefer: false,
          alwaysLoad: false,
          maxConcurrency: 0,
          maxOutputChars: 10,
          tags: [],
        } as ITool["metadata"],
        call: vi.fn().mockResolvedValue({
          success: true,
          data: bigData,
          summary: "big result",
          durationMs: 5,
        } as ToolResult),
      });
      const { executor } = createExecutor([tool]);
      const ctx = createMockContext();
      const result = await executor.execute("mock-tool", { value: "x" }, ctx);
      expect(result.truncated).toBeDefined();
      expect(result.truncated?.originalChars).toBeGreaterThan(10);
    });

    it("does not set truncated when output fits within limit", async () => {
      const tool = createMockTool();
      const { executor } = createExecutor([tool]);
      const ctx = createMockContext();
      const result = await executor.execute("mock-tool", { value: "x" }, ctx);
      expect(result.truncated).toBeUndefined();
    });
  });

  describe("Shell sanitizer typed policy fallback", () => {
    function createShellExecutor() {
      const shellTool = createMockTool({
        name: "shell",
        metadata: {
          name: "shell",
          aliases: [],
          permissionLevel: "read_metrics",
          isReadOnly: false,
          isDestructive: false,
          shouldDefer: false,
          alwaysLoad: false,
          maxConcurrency: 0,
          maxOutputChars: 8000,
          tags: [],
        } as ITool["metadata"],
        inputSchema: z.object({ value: z.string(), command: z.string() }) as unknown as z.ZodType<DefaultInput>,
        checkPermissions: vi.fn().mockResolvedValue({ status: "allowed" } as PermissionCheckResult),
      });
      const registry = new ToolRegistry();
      registry.register(shellTool);
      const permissionManager = new ToolPermissionManager({
        allowRules: [{ toolName: "shell", reason: "test allow" }],
      });
      const concurrency = new ConcurrencyController();
      const executor = new ToolExecutor({ registry, permissionManager, concurrency });
      return { executor };
    }

    it.each([
      "ls && rm dangerous",
      "ls || sudo reboot",
      "echo $(pwd)",
      "echo `pwd`",
      "echo \"$(pwd)\"",
      "echo \"`pwd`\"",
    ])("blocks denied shell command %s", async (command) => {
      const { executor } = createShellExecutor();
      const ctx = createMockContext({ trustBalance: 100 });
      const result = await executor.execute("shell", { value: "x", command }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain("sanitization failed");
    });
  });

});
