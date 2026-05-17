import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";

import type { ITool, ToolCallContext, ToolMetadata, ToolResult } from "../../src/tools/types.js";
import { ConcurrencyController, ToolExecutor, ToolPermissionManager, ToolRegistry } from "../../src/tools/index.js";
import {
  CapabilityPlane,
  admitCapabilityDescriptor,
  descriptorFromGatewayChannelAction,
  descriptorFromRuntimeControlAction,
  descriptorFromTool,
  descriptorsFromMcpServers,
  descriptorsFromPluginStates,
  fingerprintCapabilityDescriptor,
  projectCapabilityNormalSurface,
} from "../../src/runtime/capability-plane.js";
import { PluginLoader } from "../../src/runtime/plugin-loader.js";
import { NotifierRegistry } from "../../src/runtime/notifier-registry.js";
import { PluginManifestSchema } from "../../src/base/types/plugin.js";
import type { AgentResult, IAdapter } from "../../src/orchestrator/execution/adapter-layer.js";
import { executeTask, type TaskExecutorDeps } from "../../src/orchestrator/execution/task/task-executor.js";
import type { SessionManager } from "../../src/orchestrator/execution/session-manager.js";
import type { Task } from "../../src/base/types/task.js";
import { runProductGauntletScenario } from "../harness/product-gauntlet-runner.js";

describe("capability plane product gauntlet", () => {
  it("fails closed across tools, adapters, plugins, MCP, channel, runtime-control, and normal-surface projections", async () => {
    await runProductGauntletScenario("capability_plane_boundaries", async (context) => {
      const dangerousTool = new RecordingTool({
        name: "dangerous_remote_publish",
        permissionLevel: "write_remote",
        isReadOnly: false,
        isDestructive: true,
        shouldDefer: false,
        alwaysLoad: false,
        maxConcurrency: 1,
        maxOutputChars: 8000,
        tags: ["external_action"],
        requiresNetwork: true,
        activityCategory: "command",
      });
      const executor = makeToolExecutor(dangerousTool);
      const denied = await executor.execute(
        dangerousTool.metadata.name,
        { target: "prod", payload: "send" },
        makeToolContext(context.rootDir, {
          approvalFn: async () => false,
        }),
      );
      expect(denied.execution).toMatchObject({ status: "not_executed", reason: "approval_denied" });
      expect(dangerousTool.callCount).toBe(0);

      const descriptor = descriptorFromTool(dangerousTool);
      const fingerprint = fingerprintCapabilityDescriptor(
        descriptor,
        { target: "prod", payload: "send" },
        { cwd: context.rootDir, goalId: "goal:capability-plane" },
      );
      const staleApproval = admitCapabilityDescriptor({
        descriptor,
        rawInput: { target: "prod", payload: "changed-after-approval" },
        context: {
          preApproved: true,
          approvalFingerprint: fingerprint,
          cwd: context.rootDir,
          goalId: "goal:capability-plane",
        },
      });
      expect(staleApproval.status).toBe("blocked");
      expect(staleApproval.reason).toContain("fingerprint mismatch");

      const unknownTool = new RecordingTool({
        name: "unregistered_file_mutation",
        permissionLevel: "write_local",
        isReadOnly: false,
        isDestructive: false,
        shouldDefer: false,
        alwaysLoad: false,
        maxConcurrency: 1,
        maxOutputChars: 8000,
        tags: ["file"],
      });
      const unknownExecutor = makeToolExecutor(unknownTool, CapabilityPlane.fromDescriptors([]));
      const unknown = await unknownExecutor.execute(
        unknownTool.metadata.name,
        { target: "workspace", payload: "write" },
        makeToolContext(context.rootDir, { preApproved: true, approvalFn: async () => true }),
      );
      expect(unknown.execution).toMatchObject({ status: "not_executed", reason: "policy_blocked" });
      expect(unknownTool.callCount).toBe(0);

      const mcpDescriptors = descriptorsFromMcpServers([{
        id: "ops-mcp",
        command: "node",
        args: ["server.js"],
        enabled: true,
        tool_mappings: [{ tool_name: "delete_remote_ticket", dimension_pattern: "ops/*" }],
      }]);
      const mcpAdmission = admitCapabilityDescriptor({
        descriptor: mcpDescriptors[0],
        rawInput: { tool_name: "delete_remote_ticket", arguments: { id: "ticket-1" }, server_id: "ops-mcp" },
        context: { preApproved: true },
      });
      expect(mcpAdmission.status).toBe("blocked");
      expect(mcpDescriptors[0].readiness_state).toBe("disabled");

      const pluginDir = path.join(context.rootDir, "plugins", "proposal-only");
      fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify(PluginManifestSchema.parse({
        name: "proposal-only",
        version: "1.0.0",
        type: "notifier",
        capabilities: ["notify"],
        description: "Should not import without descriptor-backed operator review",
        supported_events: ["goal_complete"],
        entry_point: "dist/index.js",
        permissions: { network: true, file_read: false, file_write: false, shell: false },
      })));
      fs.writeFileSync(path.join(pluginDir, "dist", "index.js"), "throw new Error('plugin implementation must not import in proposal-first mode');\n");
      const notifierRegistry = new NotifierRegistry();
      const pluginLoader = new PluginLoader(
        makeAdapterRegistry(),
        makeDataSourceRegistry(),
        notifierRegistry,
        path.join(context.rootDir, "plugins"),
        undefined,
        undefined,
        { controlBaseDir: context.controlBaseDir },
      );
      const pluginState = await pluginLoader.loadOne(pluginDir);
      expect(pluginState.status).toBe("disabled");
      expect(pluginState.error_message).toContain("proposal-first");
      expect(notifierRegistry.size).toBe(0);
      const pluginDescriptor = descriptorsFromPluginStates([pluginState])[0];
      const pluginAdmission = admitCapabilityDescriptor({
        descriptor: pluginDescriptor,
        rawInput: { plugin_name: "proposal-only", operation_input: { report_type: "goal_completion" } },
        context: { preApproved: true },
      });
      expect(pluginDescriptor.readiness_state).toBe("proposal");
      expect(pluginAdmission.status).toBe("blocked");

      const adapterExecute = vi.fn().mockResolvedValue({
        success: true,
        output: "should not execute",
        error: null,
        exit_code: 0,
        elapsed_ms: 1,
        stopped_reason: "completed",
      } satisfies AgentResult);
      const adapter = { adapterType: "direct-test", execute: adapterExecute } as unknown as IAdapter;
      const taskResult = await executeTask(
        makeTaskExecutorDeps(context.rootDir),
        makeTask(),
        adapter,
      );
      expect(taskResult.stopped_reason).toBe("policy_blocked");
      expect(adapterExecute).not.toHaveBeenCalled();

      const selfAssertedExecute = vi.fn().mockResolvedValue({
        success: true,
        output: "self asserted boundary should not execute",
        error: null,
        exit_code: 0,
        elapsed_ms: 1,
        stopped_reason: "completed",
      } satisfies AgentResult);
      const selfAssertedAdapter = {
        adapterType: "self-asserted-direct-test",
        capabilityPlaneBoundary: "run_adapter_tool",
        execute: selfAssertedExecute,
      } as unknown as IAdapter;
      const selfAssertedTaskResult = await executeTask(
        makeTaskExecutorDeps(context.rootDir),
        makeTask({ id: "task-self-asserted" }),
        selfAssertedAdapter,
      );
      expect(selfAssertedTaskResult.stopped_reason).toBe("policy_blocked");
      expect(selfAssertedExecute).not.toHaveBeenCalled();

      const channelDescriptor = descriptorFromGatewayChannelAction({
        channelType: "webhook",
        reportType: "goal_completion",
      });
      const channelAdmission = admitCapabilityDescriptor({
        descriptor: channelDescriptor,
        rawInput: { report_id: "report-1", report_type: "goal_completion", channel_type: "webhook" },
        context: {
          preApproved: true,
          authorityRefs: channelDescriptor.authority_requirements.required_refs,
        },
      });
      expect(channelAdmission.status).toBe("allowed");
      expect(channelDescriptor.provider_kind).toBe("gateway_channel_action");

      const runtimeControlDescriptor = descriptorFromRuntimeControlAction("reload_config");
      const missingAuthorityRuntimeControlAdmission = admitCapabilityDescriptor({
        descriptor: runtimeControlDescriptor,
        rawInput: { actor: "operator", target: "daemon", request: "reload_config" },
      });
      expect(missingAuthorityRuntimeControlAdmission.status).toBe("blocked");
      expect(missingAuthorityRuntimeControlAdmission.reason).toContain("missing descriptor authority refs");
      const runtimeControlAdmission = admitCapabilityDescriptor({
        descriptor: runtimeControlDescriptor,
        rawInput: { actor: "operator", target: "daemon", request: "reload_config" },
        context: {
          authorityRefs: runtimeControlDescriptor.authority_requirements.required_refs,
        },
      });
      expect(runtimeControlAdmission.status).toBe("requires_approval");
      expect(runtimeControlDescriptor.rollback_plan.operator_visible).toBe(true);
      const permissionAuditDescriptor = descriptorFromRuntimeControlAction("audit_permission_check");
      expect(permissionAuditDescriptor.operation_kind).toBe("read");
      expect(permissionAuditDescriptor.side_effect_profile).toBe("read");
      expect(permissionAuditDescriptor.authority_requirements.approval_required).toBe(false);

      const normalProjection = projectCapabilityNormalSurface(runtimeControlDescriptor);
      const normalProjectionJson = JSON.stringify(normalProjection);
      expect(normalProjection).toEqual({
        schema_version: "capability-normal-surface-projection/v1",
        capability_id: runtimeControlDescriptor.capability_id,
        readiness_state: runtimeControlDescriptor.readiness_state,
        safe_label: runtimeControlDescriptor.normal_surface_affordance.safe_label,
        action: runtimeControlDescriptor.normal_surface_affordance.action,
        visible: runtimeControlDescriptor.normal_surface_affordance.visible,
      });
      expect(normalProjectionJson).not.toContain("credential_scope");
      expect(normalProjectionJson).not.toContain("approval_fingerprint_inputs");
      expect(normalProjectionJson).not.toContain("authority_requirements");
      expect(normalProjectionJson).not.toContain("operator_diagnostics");
      expect(normalProjectionJson).not.toContain("raw_catalog");

      context.recordEvidence({
        authorityDecisions: [staleApproval, mcpAdmission, pluginAdmission, channelAdmission, missingAuthorityRuntimeControlAdmission, runtimeControlAdmission],
        normalProjection,
        operatorDebugEvidence: {
          rollback_plan: runtimeControlDescriptor.rollback_plan,
          channel_descriptor: channelDescriptor.capability_id,
          plugin_descriptor: pluginDescriptor.capability_id,
        },
      });
    });
  });
});

class RecordingTool implements ITool<Record<string, unknown>, unknown> {
  readonly inputSchema = z.object({
    target: z.string(),
    payload: z.string(),
  }).strict();
  callCount = 0;

  constructor(readonly metadata: ToolMetadata) {}

  description(): string {
    return `${this.metadata.name} test tool`;
  }

  async call(_input: Record<string, unknown>, _context: ToolCallContext): Promise<ToolResult> {
    this.callCount += 1;
    return {
      success: true,
      data: { called: true },
      summary: "called",
      durationMs: 0,
    };
  }

  async checkPermissions(): Promise<{ status: "allowed" }> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

function makeToolExecutor(tool: ITool, capabilityPlane?: CapabilityPlane): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(tool);
  return new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({}),
    concurrency: new ConcurrencyController(),
    ...(capabilityPlane ? { capabilityPlane } : {}),
  });
}

function makeToolContext(rootDir: string, overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    cwd: rootDir,
    goalId: "goal:capability-plane",
    trustBalance: -100,
    preApproved: false,
    approvalFn: async () => false,
    sessionId: "session:capability-plane",
    turnId: "turn:capability-plane",
    ...overrides,
  };
}

function makeAdapterRegistry() {
  return {
    register: vi.fn(),
    findAdapter: vi.fn(),
    listAdapters: vi.fn().mockReturnValue([]),
  } as never;
}

function makeDataSourceRegistry() {
  return {
    register: vi.fn(),
    findBySourceId: vi.fn(),
    findByDimension: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  } as never;
}

function makeTask(): Task {
  return {
    id: "task-capability-plane",
    goal_id: "goal:capability-plane",
    strategy_id: null,
    target_dimensions: ["safety"],
    primary_dimension: "safety",
    work_description: "Attempt direct adapter execution",
    rationale: "The direct adapter path must fail closed without Capability Plane admission.",
    approach: "Call executeTask with a raw adapter.",
    success_criteria: [{ description: "blocked", verification_method: "test", is_blocking: true }],
    scope_boundary: { in_scope: ["src"], out_of_scope: [], blast_radius: "low" },
    constraints: [],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
  };
}

function makeTaskExecutorDeps(rootDir: string): TaskExecutorDeps {
  const taskOutcomeLedgers = new Map<string, unknown>();
  return {
    stateManager: {
      loadGoal: vi.fn().mockResolvedValue({ constraints: [`workspace_path:${rootDir}`] }),
      saveTask: vi.fn().mockResolvedValue(undefined),
      loadTaskOutcomeLedger: vi.fn(async (goalId: string, taskId: string) =>
        taskOutcomeLedgers.get(`${goalId}:${taskId}`) ?? null
      ),
      saveTaskOutcomeLedger: vi.fn(async (record: { goal_id: string; task_id: string }) => {
        taskOutcomeLedgers.set(`${record.goal_id}:${record.task_id}`, record);
      }),
      readRaw: vi.fn().mockResolvedValue(null),
      writeRaw: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskExecutorDeps["stateManager"],
    sessionManager: {
      createSession: vi.fn().mockResolvedValue({ id: "session-capability-plane" }),
      buildTaskExecutionContext: vi.fn().mockReturnValue([]),
      endSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionManager,
    execFileSyncFn: vi.fn().mockReturnValue(""),
    fallbackCwd: rootDir,
  };
}
