import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { ChatRunner } from "../chat-runner.js";
import type { ChatRunnerDeps } from "../chat-runner-contracts.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { IAdapter, AgentResult } from "../../../orchestrator/execution/adapter-layer.js";
import { RuntimeControlService } from "../../../runtime/control/index.js";
import { RuntimeOperationStore } from "../../../runtime/store/runtime-operation-store.js";
import type { SelectedChatRoute } from "../ingress-router.js";
import { createMockLLMClient, createSingleMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
// Mock context-provider so tests don't walk the real filesystem
vi.mock("../../../platform/observation/context-provider.js", () => ({
  resolveGitRoot: (cwd: string) => cwd,
  buildChatContext: (_task: string, cwd: string) => Promise.resolve(`Working directory: ${cwd}`),
}));

const CANNED_RESULT: AgentResult = {
  success: true,
  output: "Task completed successfully.",
  error: null,
  exit_code: 0,
  elapsed_ms: 50,
  stopped_reason: "completed",
};

function makeMockAdapter(result: AgentResult = CANNED_RESULT): IAdapter {
  return {
    adapterType: "mock",
    execute: vi.fn().mockResolvedValue(result),
  } as unknown as IAdapter;
}

function makeMockStateManager(): StateManager {
  return {
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
  } as unknown as StateManager;
}

function runtimeControlRoute(
  intent: Extract<SelectedChatRoute, { kind: "runtime_control" }>["intent"],
): SelectedChatRoute {
  return {
    kind: "runtime_control",
    reason: "runtime_control_intent",
    intent,
    replyTargetPolicy: "turn_reply_target",
    eventProjectionPolicy: "latest_active_reply_target",
    concurrencyPolicy: "session_serial",
  };
}

function makeDeps(overrides: Partial<ChatRunnerDeps> = {}): ChatRunnerDeps {
  return {
    stateManager: makeMockStateManager(),
    adapter: makeMockAdapter(),
    ...overrides,
  };
}

describe("ChatRunner gateway runtime-control routes", () => {
  describe("natural-language runtime control", () => {
    it("handles daemon restart through durable runtime control without calling the adapter", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-control-chat-"));
      try {
        const adapter = makeMockAdapter();
        const stateManager = makeMockStateManager();
        const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
        const executor = vi.fn().mockResolvedValue({
          ok: true,
          message: "restart queued",
          state: "acknowledged",
        });
        const runtimeControlService = new RuntimeControlService({
          operationStore,
          executor,
        });
        const approvalFn = vi.fn().mockResolvedValue(true);
        const runner = new ChatRunner(makeDeps({
          adapter,
          llmClient: createSingleMockLLMClient(JSON.stringify({
            intent: "restart_daemon",
            reason: "PulSeed を再起動して",
          })),
          stateManager,
          approvalFn,
          runtimeControlService,
          runtimeReplyTarget: {
            surface: "gateway",
            platform: "telegram",
            conversation_id: "chat-123",
            identity_key: "owner",
            user_id: "user-1",
          },
        }));

        const result = await runner.execute("PulSeed を再起動して", "/repo", undefined, {
          selectedRoute: runtimeControlRoute({
            kind: "restart_daemon",
            reason: "PulSeed を再起動して",
          }),
        });

        expect(result.success).toBe(true);
        expect(result.output).toBe("restart queued");
        expect(adapter.execute).not.toHaveBeenCalled();
        expect(approvalFn).toHaveBeenCalledWith(
          expect.stringContaining("restart_daemon")
        );
        expect(executor).toHaveBeenCalledOnce();

        const pending = await operationStore.listPending();
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
          kind: "restart_daemon",
          state: "acknowledged",
          reason: "PulSeed を再起動して",
          requested_by: {
            surface: "gateway",
            platform: "telegram",
            conversation_id: "chat-123",
            identity_key: "owner",
            user_id: "user-1",
          },
          reply_target: {
            surface: "gateway",
            platform: "telegram",
            conversation_id: "chat-123",
            identity_key: "owner",
            user_id: "user-1",
          },
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("does not route natural-language runtime control through the deleted adapter fallback when no LLM is configured", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));

      const result = await runner.execute("PulSeed を再起動して", "/repo");

      expect(result.success).toBe(false);
      expect(result.output).toContain("no language model client is configured");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("does not claim restart started when no runtime control executor is configured", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-control-no-executor-"));
      try {
        const adapter = makeMockAdapter();
        const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
        const runtimeControlService = new RuntimeControlService({ operationStore });
        const runner = new ChatRunner(makeDeps({
          adapter,
          llmClient: createSingleMockLLMClient(JSON.stringify({
            intent: "restart_daemon",
            reason: "PulSeed を再起動して",
          })),
          approvalFn: vi.fn().mockResolvedValue(true),
          runtimeControlService,
          runtimeReplyTarget: { surface: "cli" },
        }));

        const result = await runner.execute("PulSeed を再起動して", "/repo", undefined, {
          selectedRoute: runtimeControlRoute({
            kind: "restart_daemon",
            reason: "PulSeed を再起動して",
          }),
        });

        expect(result.success).toBe(false);
        expect(result.output).toContain("not configured");
        expect(result.output).not.toContain("再起動を開始します");
        expect(adapter.execute).not.toHaveBeenCalled();
        expect(await operationStore.listPending()).toHaveLength(0);
        const completed = await operationStore.listCompleted();
        expect(completed).toHaveLength(1);
        expect(completed[0]).toMatchObject({
          kind: "restart_daemon",
          state: "failed",
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("marks runtime control failed when the executor throws", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-control-executor-throws-"));
      try {
        const adapter = makeMockAdapter();
        const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
        const runtimeControlService = new RuntimeControlService({
          operationStore,
          executor: vi.fn().mockRejectedValue(new Error("daemon auth failed")),
        });
        const runner = new ChatRunner(makeDeps({
          adapter,
          llmClient: createSingleMockLLMClient(JSON.stringify({
            intent: "restart_daemon",
            reason: "PulSeed を再起動して",
          })),
          approvalFn: vi.fn().mockResolvedValue(true),
          runtimeControlService,
          runtimeReplyTarget: { surface: "cli" },
        }));

        const result = await runner.execute("PulSeed を再起動して", "/repo", undefined, {
          selectedRoute: runtimeControlRoute({
            kind: "restart_daemon",
            reason: "PulSeed を再起動して",
          }),
        });

        expect(result.success).toBe(false);
        expect(result.output).toContain("daemon auth failed");
        expect(adapter.execute).not.toHaveBeenCalled();
        expect(await operationStore.listPending()).toHaveLength(0);
        const completed = await operationStore.listCompleted();
        expect(completed).toHaveLength(1);
        expect(completed[0]).toMatchObject({
          kind: "restart_daemon",
          state: "failed",
          result: {
            ok: false,
            message: "daemon auth failed",
          },
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("marks runtime control failed when approval throws", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-control-approval-throws-"));
      try {
        const adapter = makeMockAdapter();
        const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
        const executor = vi.fn().mockResolvedValue({ ok: true });
        const runtimeControlService = new RuntimeControlService({
          operationStore,
          executor,
        });
        const runner = new ChatRunner(makeDeps({
          adapter,
          llmClient: createSingleMockLLMClient(JSON.stringify({
            intent: "restart_daemon",
            reason: "PulSeed を再起動して",
          })),
          approvalFn: vi.fn().mockRejectedValue(new Error("approval store unavailable")),
          runtimeControlService,
          runtimeReplyTarget: { surface: "cli" },
        }));

        const result = await runner.execute("PulSeed を再起動して", "/repo", undefined, {
          selectedRoute: runtimeControlRoute({
            kind: "restart_daemon",
            reason: "PulSeed を再起動して",
          }),
        });

        expect(result.success).toBe(false);
        expect(result.output).toContain("approval store unavailable");
        expect(adapter.execute).not.toHaveBeenCalled();
        expect(executor).not.toHaveBeenCalled();
        expect(await operationStore.listPending()).toHaveLength(0);
        const completed = await operationStore.listCompleted();
        expect(completed).toHaveLength(1);
        expect(completed[0]).toMatchObject({
          kind: "restart_daemon",
          state: "failed",
          result: {
            ok: false,
            message: "approval store unavailable",
          },
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("uses runtime-control approval without reusing general tool approval", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-control-scoped-approval-"));
      try {
        const adapter = makeMockAdapter();
        const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
        const runtimeControlService = new RuntimeControlService({
          operationStore,
          executor: vi.fn().mockResolvedValue({
            ok: true,
            state: "restarting",
            message: "restart requested",
          }),
        });
        const approvalFn = vi.fn().mockResolvedValue(false);
        const runtimeControlApprovalFn = vi.fn().mockResolvedValue(true);
        const runner = new ChatRunner(makeDeps({
          adapter,
          llmClient: createSingleMockLLMClient(JSON.stringify({
            intent: "restart_daemon",
            reason: "PulSeed を再起動して",
          })),
          approvalFn,
          runtimeControlApprovalFn,
          runtimeControlService,
          runtimeReplyTarget: { surface: "gateway", platform: "telegram" },
        }));

        const result = await runner.execute("PulSeed を再起動して", "/repo", undefined, {
          selectedRoute: runtimeControlRoute({
            kind: "restart_daemon",
            reason: "PulSeed を再起動して",
          }),
        });

        expect(result.success).toBe(true);
        expect(result.output).toBe("restart requested");
        expect(runtimeControlApprovalFn).toHaveBeenCalledOnce();
        expect(approvalFn).not.toHaveBeenCalled();
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("routes approved reload_config and self_update through RuntimeControlService", async () => {
      for (const operation of ["reload_config", "self_update"] as const) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pulseed-runtime-control-${operation}-`));
        try {
          const adapter = makeMockAdapter();
          const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
          const executor = vi.fn().mockResolvedValue({
            ok: true,
            state: "verified",
            message: `${operation} requested`,
          });
          const runtimeControlService = new RuntimeControlService({
            operationStore,
            executor,
          });
          const runtimeControlApprovalFn = vi.fn().mockResolvedValue(true);
          const runner = new ChatRunner(makeDeps({
            adapter,
            llmClient: createSingleMockLLMClient(JSON.stringify({
              intent: operation,
              reason: `please ${operation}`,
            })),
            runtimeControlApprovalFn,
            runtimeControlService,
            runtimeReplyTarget: { surface: "gateway", platform: "telegram" },
          }));

          const result = await runner.execute(`please ${operation}`, "/repo", undefined, {
            selectedRoute: runtimeControlRoute({
              kind: operation,
              reason: `please ${operation}`,
            }),
          });

          expect(result).toMatchObject({ success: true, output: `${operation} requested` });
          expect(runtimeControlApprovalFn).toHaveBeenCalledWith(expect.stringContaining(operation));
          expect(executor).toHaveBeenCalledWith(expect.objectContaining({ kind: operation }), expect.anything());
          expect(adapter.execute).not.toHaveBeenCalled();
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    });

    it("routes natural-language run pause to typed runtime control instead of the adapter", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-control-chat-pause-"));
      try {
        const adapter = makeMockAdapter();
        const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
        const executor = vi.fn().mockResolvedValue({
          ok: true,
          state: "running",
          message: "pause sent",
        });
        const runtimeControlService = new RuntimeControlService({
          operationStore,
          executor,
          sessionRegistry: {
            snapshot: vi.fn().mockResolvedValue({
              schema_version: "runtime-session-registry-v1",
              generated_at: "2026-05-02T00:00:00.000Z",
              sessions: [],
              background_runs: [{
                schema_version: "background-run-v1",
                id: "run:coreloop:chat",
                kind: "coreloop_run",
                parent_session_id: null,
                child_session_id: "session:coreloop:worker-1",
                process_session_id: null,
                goal_id: "goal-1",
                status: "running",
                notify_policy: "done_only",
                reply_target_source: "none",
                pinned_reply_target: null,
                title: "DurableLoop goal goal-1",
                workspace: "/repo",
                created_at: "2026-05-02T00:00:00.000Z",
                started_at: "2026-05-02T00:00:00.000Z",
                updated_at: "2026-05-02T00:00:00.000Z",
                completed_at: null,
                summary: null,
                error: null,
                artifacts: [],
                source_refs: [],
              }],
              warnings: [],
            }),
          },
        });
        const runner = new ChatRunner(makeDeps({
          adapter,
          llmClient: createSingleMockLLMClient(JSON.stringify({
            intent: "pause_run",
            reason: "この実行を一時停止して",
            targetSelector: { scope: "run", reference: "current", sourceText: "この実行" },
          })),
          runtimeControlService,
          runtimeControlApprovalFn: vi.fn().mockResolvedValue(true),
        }));

        const result = await runner.execute("この実行を一時停止して", "/repo", undefined, {
          selectedRoute: runtimeControlRoute({
            kind: "pause_run",
            reason: "この実行を一時停止して",
            targetSelector: { scope: "run", reference: "current", sourceText: "この実行" },
          }),
        });

        expect(result).toMatchObject({ success: true, output: "pause sent" });
        expect(adapter.execute).not.toHaveBeenCalled();
        expect(executor).toHaveBeenCalledWith(expect.objectContaining({
          kind: "pause_run",
          target: expect.objectContaining({ run_id: "run:coreloop:chat", goal_id: "goal-1" }),
        }), expect.anything());
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("blocks current runtime control when the scoped conversation has no active run", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-control-chat-current-scope-"));
      try {
        const adapter = makeMockAdapter();
        const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
        const executor = vi.fn();
        const runtimeControlService = new RuntimeControlService({
          operationStore,
          executor,
          sessionRegistry: {
            snapshot: vi.fn().mockResolvedValue({
              schema_version: "runtime-session-registry-v1",
              generated_at: "2026-05-02T00:00:00.000Z",
              sessions: [],
              background_runs: [{
                schema_version: "background-run-v1",
                id: "run:coreloop:other-chat",
                kind: "coreloop_run",
                parent_session_id: "session:conversation:other",
                child_session_id: "session:coreloop:worker-1",
                process_session_id: null,
                goal_id: "goal-other",
                status: "running",
                notify_policy: "done_only",
                reply_target_source: "none",
                pinned_reply_target: null,
                title: "DurableLoop goal goal-other",
                workspace: "/repo",
                created_at: "2026-05-02T00:00:00.000Z",
                started_at: "2026-05-02T00:00:00.000Z",
                updated_at: "2026-05-02T00:00:00.000Z",
                completed_at: null,
                summary: null,
                error: null,
                artifacts: [],
                source_refs: [],
              }],
              warnings: [],
            }),
          },
        });
        const runner = new ChatRunner(makeDeps({
          adapter,
          llmClient: createSingleMockLLMClient(JSON.stringify({
            intent: "pause_run",
            reason: "この実行を一時停止して",
            targetSelector: { scope: "run", reference: "current", sourceText: "この実行" },
          })),
          runtimeControlService,
          runtimeControlApprovalFn: vi.fn().mockResolvedValue(true),
          runtimeReplyTarget: {
            surface: "gateway",
            platform: "telegram",
            conversation_id: "chat-1",
          },
        }));

        const result = await runner.execute("この実行を一時停止して", "/repo", undefined, {
          selectedRoute: runtimeControlRoute({
            kind: "pause_run",
            reason: "この実行を一時停止して",
            targetSelector: { scope: "run", reference: "current", sourceText: "この実行" },
          }),
        });

        expect(result).toMatchObject({
          success: false,
          output: expect.stringContaining("refusing to reuse another conversation"),
        });
        expect(executor).not.toHaveBeenCalled();
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("resolves latest and previous natural-language run references through typed target selection", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-control-target-selector-"));
      try {
        const adapter = makeMockAdapter();
        const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
        const runtimeControlService = new RuntimeControlService({
          operationStore,
          sessionRegistry: {
            snapshot: vi.fn().mockResolvedValue({
              schema_version: "runtime-session-registry-v1",
              generated_at: "2026-05-02T00:20:00.000Z",
              sessions: [],
              background_runs: [
                {
                  schema_version: "background-run-v1",
                  id: "run:older",
                  kind: "coreloop_run",
                  parent_session_id: null,
                  child_session_id: "session:coreloop:older",
                  process_session_id: null,
                  goal_id: "goal-older",
                  status: "running",
                  notify_policy: "done_only",
                  reply_target_source: "none",
                  pinned_reply_target: null,
                  title: "older",
                  workspace: "/repo",
                  created_at: "2026-05-02T00:00:00.000Z",
                  started_at: "2026-05-02T00:00:00.000Z",
                  updated_at: "2026-05-02T00:00:00.000Z",
                  completed_at: null,
                  summary: null,
                  error: null,
                  artifacts: [],
                  source_refs: [],
                },
                {
                  schema_version: "background-run-v1",
                  id: "run:newer",
                  kind: "coreloop_run",
                  parent_session_id: null,
                  child_session_id: "session:coreloop:newer",
                  process_session_id: null,
                  goal_id: "goal-newer",
                  status: "running",
                  notify_policy: "done_only",
                  reply_target_source: "none",
                  pinned_reply_target: null,
                  title: "newer",
                  workspace: "/repo",
                  created_at: "2026-05-02T00:10:00.000Z",
                  started_at: "2026-05-02T00:10:00.000Z",
                  updated_at: "2026-05-02T00:10:00.000Z",
                  completed_at: null,
                  summary: null,
                  error: null,
                  artifacts: [],
                  source_refs: [],
                },
              ],
              warnings: [],
            }),
          },
        });
        const runner = new ChatRunner(makeDeps({
          adapter,
          llmClient: createMockLLMClient([
            JSON.stringify({
              intent: "inspect_run",
              reason: "latest session",
              targetSelector: { scope: "run", reference: "latest", sourceText: "latest session" },
            }),
            JSON.stringify({
              intent: "inspect_run",
              reason: "前のバックグラウンドジョブ",
              targetSelector: { scope: "run", reference: "previous", sourceText: "前のバックグラウンドジョブ" },
            }),
          ]),
          runtimeControlService,
          runtimeControlApprovalFn: vi.fn().mockResolvedValue(true),
        }));

        const explicitRuntimeControl = { allowed: true, approvalMode: "interactive" as const, explicit: true };
        await expect(runner.execute("inspect latest session", "/repo", 30_000, {
          runtimeControlContext: explicitRuntimeControl,
        })).resolves.toMatchObject({ success: true });
        await expect(runner.execute("前のバックグラウンドジョブを確認して", "/repo", 30_000, {
          runtimeControlContext: explicitRuntimeControl,
        })).resolves.toMatchObject({ success: true });

        const completed = await operationStore.listCompleted();
        expect(completed.map((operation) => operation.target?.run_id).sort()).toEqual(["run:newer", "run:older"].sort());
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("routes natural-language run resume to typed runtime control or a blocked response", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-control-chat-resume-"));
      try {
        const adapter = makeMockAdapter();
        const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
        const runtimeControlService = new RuntimeControlService({
          operationStore,
          sessionRegistry: {
            snapshot: vi.fn().mockResolvedValue({
              schema_version: "runtime-session-registry-v1",
              generated_at: "2026-05-02T00:00:00.000Z",
              sessions: [],
              background_runs: [{
                schema_version: "background-run-v1",
                id: "run:process:abc",
                kind: "process_run",
                parent_session_id: null,
                child_session_id: null,
                process_session_id: "proc-1",
                goal_id: null,
                status: "running",
                notify_policy: "done_only",
                reply_target_source: "none",
                pinned_reply_target: null,
                title: "process",
                workspace: "/repo",
                created_at: "2026-05-02T00:00:00.000Z",
                started_at: "2026-05-02T00:00:00.000Z",
                updated_at: "2026-05-02T00:00:00.000Z",
                completed_at: null,
                summary: null,
                error: null,
                artifacts: [],
                source_refs: [],
              }],
              warnings: [],
            }),
          },
        });
        const runner = new ChatRunner(makeDeps({
          adapter,
          llmClient: createSingleMockLLMClient(JSON.stringify({
            intent: "resume_run",
            reason: "再開して",
          })),
          runtimeControlService,
          runtimeControlApprovalFn: vi.fn().mockResolvedValue(true),
        }));

        const result = await runner.execute("再開して", "/repo", 30_000, {
          runtimeControlContext: { allowed: true, approvalMode: "interactive", explicit: true },
        });

        expect(result).toMatchObject({
          success: false,
          output: expect.stringContaining("no typed goal/runtime bridge"),
        });
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("routes natural-language finalize to an approval-gated proposal without external execution", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-control-chat-finalize-"));
      try {
        const adapter = makeMockAdapter();
        const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
        const executor = vi.fn();
        const runtimeControlService = new RuntimeControlService({
          operationStore,
          executor,
          operatorHandoffStore: { create: vi.fn().mockResolvedValue({ handoff_id: "handoff-1" }) },
          sessionRegistry: {
            snapshot: vi.fn().mockResolvedValue({
              schema_version: "runtime-session-registry-v1",
              generated_at: "2026-05-02T00:00:00.000Z",
              sessions: [],
              background_runs: [{
                schema_version: "background-run-v1",
                id: "run:coreloop:chat",
                kind: "coreloop_run",
                parent_session_id: null,
                child_session_id: "session:coreloop:worker-1",
                process_session_id: null,
                goal_id: "goal-1",
                status: "running",
                notify_policy: "done_only",
                reply_target_source: "none",
                pinned_reply_target: null,
                title: "DurableLoop goal goal-1",
                workspace: "/repo",
                created_at: "2026-05-02T00:00:00.000Z",
                started_at: "2026-05-02T00:00:00.000Z",
                updated_at: "2026-05-02T00:00:00.000Z",
                completed_at: null,
                summary: null,
                error: null,
                artifacts: [],
                source_refs: [],
              }],
              warnings: [],
            }),
          },
        });
        const runtimeControlApprovalFn = vi.fn().mockResolvedValue(true);
        const runner = new ChatRunner(makeDeps({
          adapter,
          llmClient: createSingleMockLLMClient(JSON.stringify({
            intent: "finalize_run",
            reason: "finalize current run",
            irreversible: true,
            externalActions: ["submit"],
          })),
          runtimeControlService,
          runtimeControlApprovalFn,
        }));

        const result = await runner.execute("Finalize with the current best candidate, but do not submit externally.", "/repo", 30_000, {
          runtimeControlContext: { allowed: true, approvalMode: "interactive", explicit: true },
        });

        expect(result).toMatchObject({
          success: true,
          output: expect.stringContaining("No external submit/publish/secret/production/destructive action was executed"),
        });
        expect(runtimeControlApprovalFn).toHaveBeenCalledWith(expect.stringContaining("finalize_run"));
        expect(executor).not.toHaveBeenCalled();
        expect(adapter.execute).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });


});
