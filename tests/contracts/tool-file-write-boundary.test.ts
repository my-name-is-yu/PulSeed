import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ConcurrencyController, ToolExecutor, ToolPermissionManager, ToolRegistry } from "../../src/tools/index.js";
import { FileWriteTool, type FileWriteInput } from "../../src/tools/fs/FileWriteTool/FileWriteTool.js";
import type { ToolCallContext, ToolResult } from "../../src/tools/types.js";
import { PermissionWaitPlanStore } from "../../src/runtime/store/permission-wait-plan-store.js";

interface ContractRoot {
  root: string;
  workspace: string;
  runtime: string;
}

interface RecordedToolEvent {
  seq: number;
  stage: string;
  path?: string;
  call_id?: string;
  success?: boolean;
  artifact_count?: number;
  approval_id?: "<approval-id>";
  permission_wait_plan_id?: "<permission-wait-plan-id>";
}

class RecordingFileWriteTool extends FileWriteTool {
  constructor(
    private readonly record: (stage: string, fields?: Omit<RecordedToolEvent, "seq" | "stage">) => void,
  ) {
    super();
  }

  override async call(input: FileWriteInput, context: ToolCallContext): Promise<ToolResult> {
    this.record("tool_call_started", {
      path: input.path,
      ...(context.callId ? { call_id: context.callId } : {}),
    });
    const result = await super.call(input, context);
    this.record("tool_call_finished", {
      path: input.path,
      ...(context.callId ? { call_id: context.callId } : {}),
      success: result.success,
      artifact_count: result.artifacts?.length ?? 0,
    });
    if (result.success && (result.artifacts?.length ?? 0) > 0) {
      this.record("write_artifact_recorded", {
        path: input.path,
        ...(context.callId ? { call_id: context.callId } : {}),
        artifact_count: result.artifacts?.length ?? 0,
      });
    }
    return result;
  }
}

describe("file_write tool production boundary", () => {
  it("records approval wait-plan ordering before file mutation and blocks denied mutation", async () => {
    const root = await makeContractRoot();
    try {
      const events: RecordedToolEvent[] = [];
      const { executor, waitPlanStore } = makeFileWriteExecutor(root, events);
      const approvedPath = path.join("approved", "file.txt");
      const deniedPath = "denied.txt";
      const approvedTarget = path.join(root.workspace, approvedPath);
      const deniedTarget = path.join(root.workspace, deniedPath);

      const approved = await executor.execute(
        "file_write",
        { path: approvedPath, content: "approved\n" },
        makeContext(root, {
          callId: "tool-call-write-approved",
          approvalFn: async (request) => {
            recordToolEvent(events, "approval_callback", {
              path: pathFromApprovalRequest(request.input),
              ...(request.approvalId ? { approval_id: "<approval-id>" as const } : {}),
              ...(request.permissionWaitPlanId ? { permission_wait_plan_id: "<permission-wait-plan-id>" as const } : {}),
              ...(request.callId ? { call_id: request.callId } : {}),
            });
            return true;
          },
          onApprovalRequested: async (request) => {
            recordToolEvent(events, "approval_requested", {
              path: pathFromApprovalRequest(request.input),
              ...(request.approvalId ? { approval_id: "<approval-id>" as const } : {}),
              ...(request.permissionWaitPlanId ? { permission_wait_plan_id: "<permission-wait-plan-id>" as const } : {}),
              ...(request.callId ? { call_id: request.callId } : {}),
            });
          },
          permissionWaitPlanStore: waitPlanStore,
        }),
      );

      const denied = await executor.execute(
        "file_write",
        { path: deniedPath, content: "denied\n" },
        makeContext(root, {
          callId: "tool-call-write-denied",
          approvalFn: async (request) => {
            recordToolEvent(events, "approval_callback", {
              path: pathFromApprovalRequest(request.input),
              ...(request.approvalId ? { approval_id: "<approval-id>" as const } : {}),
              ...(request.permissionWaitPlanId ? { permission_wait_plan_id: "<permission-wait-plan-id>" as const } : {}),
              ...(request.callId ? { call_id: request.callId } : {}),
            });
            return false;
          },
          onApprovalRequested: async (request) => {
            recordToolEvent(events, "approval_requested", {
              path: pathFromApprovalRequest(request.input),
              ...(request.approvalId ? { approval_id: "<approval-id>" as const } : {}),
              ...(request.permissionWaitPlanId ? { permission_wait_plan_id: "<permission-wait-plan-id>" as const } : {}),
              ...(request.callId ? { call_id: request.callId } : {}),
            });
          },
          permissionWaitPlanStore: waitPlanStore,
        }),
      );

      expect(approved.success).toBe(true);
      await expect(fsp.readFile(approvedTarget, "utf8")).resolves.toBe("approved\n");
      expect(denied.execution).toMatchObject({ status: "not_executed", reason: "approval_denied" });
      expect(existsSync(deniedTarget)).toBe(false);
      expect(denied.artifacts ?? []).toEqual([]);

      const approvedRequested = eventIndex(events, "approval_requested", approvedPath);
      const approvedCallback = eventIndex(events, "approval_callback", approvedPath);
      const approvedToolStart = eventIndex(events, "tool_call_started", approvedPath);
      const approvedArtifact = eventIndex(events, "write_artifact_recorded", approvedPath);
      expect(approvedRequested).toBeGreaterThanOrEqual(0);
      expect(approvedCallback).toBeGreaterThan(approvedRequested);
      expect(approvedToolStart).toBeGreaterThan(approvedCallback);
      expect(approvedArtifact).toBeGreaterThan(approvedToolStart);
      expect(eventIndex(events, "tool_call_started", deniedPath)).toBe(-1);
      expect(eventIndex(events, "write_artifact_recorded", deniedPath)).toBe(-1);

      const waitPlans = await waitPlanStore.list();
      expect(waitPlans.map((plan) => plan.state).sort()).toEqual(["denied", "resumed"]);
      expect(waitPlans.map((plan) => plan.canonical_plan.tool_name).sort()).toEqual(["file_write", "file_write"]);
    } finally {
      await fsp.rm(root.root, { recursive: true, force: true });
    }
  });

  it("blocks unsafe file_write paths at the ToolExecutor/FileWriteTool boundary even when pre-approved", async () => {
    const root = await makeContractRoot();
    try {
      const events: RecordedToolEvent[] = [];
      const { executor } = makeFileWriteExecutor(root, events);
      let approvalRequestCount = 0;
      const unsafeInputs = [
        { path: "../outside.txt", target: path.resolve(root.workspace, "../outside.txt"), error: "Path traversal outside workspace root" },
        { path: ".env", target: path.join(root.workspace, ".env"), error: "Blocked: path targets protected area" },
        { path: "config/credentials.json", target: path.join(root.workspace, "config", "credentials.json"), error: "Blocked: path targets protected area" },
        { path: "node_modules/pkg/index.js", target: path.join(root.workspace, "node_modules", "pkg", "index.js"), error: "Blocked: path targets protected area" },
      ];

      for (const unsafe of unsafeInputs) {
        const result = await executor.execute(
          "file_write",
          { path: unsafe.path, content: "unsafe\n" },
          makeContext(root, {
            callId: `tool-call-write-unsafe-${unsafe.path.replace(/[^a-z0-9]+/gi, "-")}`,
            preApproved: true,
            trustBalance: 0,
            approvalFn: async () => {
              approvalRequestCount += 1;
              return true;
            },
          }),
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain(unsafe.error);
        expect(result.artifacts ?? []).toEqual([]);
        expect(existsSync(unsafe.target)).toBe(false);
      }

      expect(approvalRequestCount).toBe(0);
      expect(events.filter((event) => event.stage === "write_artifact_recorded")).toEqual([]);
    } finally {
      await fsp.rm(root.root, { recursive: true, force: true });
    }
  });
});

async function makeContractRoot(): Promise<ContractRoot> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-file-write-contract-"));
  const workspace = path.join(root, "workspace");
  const runtime = path.join(root, "runtime");
  await fsp.mkdir(workspace, { recursive: true });
  await fsp.mkdir(runtime, { recursive: true });
  return { root, workspace, runtime };
}

function makeFileWriteExecutor(root: ContractRoot, events: RecordedToolEvent[]): {
  executor: ToolExecutor;
  waitPlanStore: PermissionWaitPlanStore;
} {
  const registry = new ToolRegistry();
  registry.register(new RecordingFileWriteTool((stage, fields) => recordToolEvent(events, stage, fields)));
  const waitPlanStore = new PermissionWaitPlanStore(root.runtime, {
    createEventId: () => `file-write-contract-event-${events.length + 1}`,
  });
  return {
    executor: new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    }),
    waitPlanStore,
  };
}

function makeContext(root: ContractRoot, overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    cwd: root.workspace,
    goalId: "goal-file-write-contract",
    trustBalance: -50,
    preApproved: false,
    approvalFn: async () => false,
    sessionId: "session:file-write-contract",
    turnId: "turn:file-write-contract",
    ...overrides,
  };
}

function recordToolEvent(
  events: RecordedToolEvent[],
  stage: string,
  fields: Omit<RecordedToolEvent, "seq" | "stage"> = {},
): void {
  const normalizedFields = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Omit<RecordedToolEvent, "seq" | "stage">;
  events.push({ seq: events.length + 1, stage, ...normalizedFields });
}

function eventIndex(events: RecordedToolEvent[], stage: string, filePath: string): number {
  return events.findIndex((event) => event.stage === stage && event.path === filePath);
}

function pathFromApprovalRequest(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as { path?: unknown }).path;
  return typeof value === "string" ? value : undefined;
}
