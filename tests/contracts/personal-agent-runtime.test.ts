import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { StateManager } from "../../src/base/state/state-manager.js";
import type { Task } from "../../src/base/types/task.js";
import type { ILLMClient } from "../../src/base/llm/llm-client.js";
import type { IAdapter } from "../../src/orchestrator/execution/adapter-layer.js";
import type { Goal } from "../../src/base/types/goal.js";
import type { IDataSourceAdapter } from "../../src/platform/observation/data-source-adapter.js";
import { ChatRunner } from "../../src/interface/chat/chat-runner.js";
import type { ChatRunnerDeps } from "../../src/interface/chat/chat-runner-contracts.js";
import type { SelectedChatRoute } from "../../src/interface/chat/ingress-router.js";
import { TendCommand } from "../../src/interface/chat/tend-command.js";
import { EscalationHandler } from "../../src/interface/chat/escalation.js";
import { ChatHistory } from "../../src/interface/chat/chat-history.js";
import { ScheduleEngine } from "../../src/runtime/schedule/engine.js";
import type { ScheduleEntryInput } from "../../src/runtime/types/schedule.js";
import { RuntimeControlService } from "../../src/runtime/control/runtime-control-service.js";
import { NotificationDispatcher } from "../../src/runtime/notification-dispatcher.js";
import { runSupervisorMaintenanceCycleForDaemon } from "../../src/runtime/daemon/maintenance.js";
import { runDaemonGoalCycleLoop } from "../../src/runtime/daemon/runner-goal-cycle.js";
import { runResidentCuriosityCycle } from "../../src/runtime/daemon/runner-resident-curiosity.js";
import { proactiveTick } from "../../src/runtime/daemon/runner-resident-proactive.js";
import { runUserMemoryOperation } from "../../src/platform/corrections/user-memory-operations.js";
import { KnowledgeManager } from "../../src/platform/knowledge/knowledge-manager.js";
import { reconcileInterruptedExecutions } from "../../src/runtime/daemon/runner-recovery.js";
import { TaskLifecycle } from "../../src/orchestrator/execution/task/task-lifecycle.js";
import { RunSpecHandoffService, type RunSpec } from "../../src/runtime/run-spec/index.js";
import {
  createDaemonBackedDurableLoopControlToolset,
  createDurableLoopControlTools,
} from "../../src/orchestrator/execution/agent-loop/durable-loop-control-tools.js";
import { createBuiltinTools } from "../../src/tools/builtin/factory.js";
import { SetGoalTool } from "../../src/tools/mutation/SetGoalTool/SetGoalTool.js";
import { TaskCreateTool } from "../../src/tools/mutation/TaskCreateTool/TaskCreateTool.js";
import { cmdGoalAddRaw } from "../../src/interface/cli/commands/goal-raw.js";
import { cmdGoalArchive, cmdGoalReset } from "../../src/interface/cli/commands/goal.js";
import { toolGoalCreate, toolTrigger } from "../../src/interface/mcp-server/tools.js";
import { DriveSystem } from "../../src/platform/drive/drive-system.js";
import type { ToolCallContext } from "../../src/tools/types.js";
import {
  PersonalAgentRuntimeStore,
  buildPersonalAgentDecisionTrace,
  stableId,
  stableTraceId,
  type PersonalAgentDecisionTrace,
} from "../../src/runtime/personal-agent/index.js";
import { openControlDatabase } from "../../src/runtime/store/index.js";
import { makeDimension, makeGoal } from "../helpers/fixtures.js";

const NOW = "2026-05-15T00:00:00.000Z";
type ScheduleEntryCreationInput = Parameters<ScheduleEngine["addEntry"]>[0];

describe("durable personal-agent runtime production paths", () => {
  it("records SituationFrame and InitiativeEvent traces from ordinary chat/gateway and TUI turns", async () => {
    const { baseDir, cleanup } = await fixtureState();
    const gatewayTrace = vi.fn();
    const tuiTrace = vi.fn();
    const commandTrace = vi.fn();
    try {
      const gatewayRunner = new ChatRunner({
        stateManager: new StateManager(baseDir),
        adapter: mockAdapter(),
        llmClient: llm("gateway reply"),
        personalAgentRuntime: { recordTrace: gatewayTrace },
      } as unknown as ChatRunnerDeps);
      const gateway = await gatewayRunner.execute("ordinary turn", baseDir, 10_000, {
        selectedRoute: gatewayModelRoute(),
      });

      const tuiRunner = new ChatRunner({
        stateManager: new StateManager(baseDir),
        adapter: mockAdapter(),
        llmClient: llm("tui reply"),
        runtimeReplyTarget: {
          surface: "tui",
          channel: "tui",
          conversation_id: "local-tui",
          deliveryMode: "reply",
        } as ChatRunnerDeps["runtimeReplyTarget"],
        personalAgentRuntime: { recordTrace: tuiTrace },
      } as unknown as ChatRunnerDeps);
      const tui = await tuiRunner.execute("ordinary tui turn", baseDir, 10_000, {
        selectedRoute: gatewayModelRoute(),
      });
      const commandRunner = new ChatRunner({
        stateManager: new StateManager(baseDir),
        adapter: mockAdapter(),
        llmClient: llm("command reply"),
        personalAgentRuntime: { recordTrace: commandTrace },
      } as unknown as ChatRunnerDeps);
      const command = await commandRunner.execute("/help", baseDir, 10_000);

      expect(gateway.success).toBe(true);
      expect(tui.success).toBe(true);
      expect(command.success).toBe(true);
      expect(gatewayTrace).toHaveBeenCalledOnce();
      expect(tuiTrace).toHaveBeenCalledOnce();
      expect(commandTrace).toHaveBeenCalledOnce();
      expect(recordedTrace(gatewayTrace)).toMatchObject({
        situation_frame: {
          caller_path: "chat_gateway_turn",
          cognition_situation: expect.objectContaining({
            caller_path: "chat_user_turn",
            route_ref: { kind: "chat_route", ref: "gateway_model_loop" },
          }),
          normal_surface_trace_visible: false,
        },
        initiative_events: expect.arrayContaining([
          expect.objectContaining({ event_type: "user_follow_up" }),
          expect.objectContaining({ event_type: "task_candidate_proposed" }),
          expect.objectContaining({ event_type: "action_requested" }),
          expect.objectContaining({ event_type: "policy_decision_recorded" }),
        ]),
      });
      expect(recordedTrace(tuiTrace)).toMatchObject({
        situation_frame: {
          caller_path: "tui_turn",
          normal_surface_trace_visible: false,
        },
      });
      expect(recordedTrace(commandTrace)).toMatchObject({
        situation_frame: {
          caller_path: "explicit_user_command",
          source_kind: "explicit_command",
          normal_surface_trace_visible: false,
        },
        initiative_events: expect.arrayContaining([
          expect.objectContaining({ event_type: "user_follow_up" }),
          expect.objectContaining({ event_type: "task_candidate_proposed" }),
          expect.objectContaining({ event_type: "action_requested" }),
          expect.objectContaining({ event_type: "policy_decision_recorded" }),
          expect.objectContaining({ event_type: "action_outcome" }),
        ]),
      });
    } finally {
      cleanup();
    }
  });

  it("records scheduler wait-resume, resident attention, runtime-control, notification, and task execution decisions", async () => {
    const { baseDir, stateManager, cleanup } = await fixtureState();
    const recordTrace = vi.fn();
    try {
      const schedule = new ScheduleEngine({
        baseDir,
        personalAgentRuntime: { recordTrace },
      });
      await schedule.loadEntries();
      const entry = await schedule.addEntry(goalTriggerEntry({
        metadata: {
          internal: true,
          activation_kind: "wait_resume",
          goal_id: "goal-personal-agent",
          strategy_id: "strategy:wait",
          wait_strategy_id: "strategy:wait",
        },
        goal_trigger: {
          goal_id: "goal-personal-agent",
          max_iterations: 1,
          skip_if_active: false,
        },
      }));
      const waitResumeDueAt = new Date(Date.now() - 1000).toISOString();
      schedule.getEntries()[0]!.next_fire_at = waitResumeDueAt;
      await schedule.saveEntries();
      await schedule.loadEntries();
      await schedule.tick();

      const coreLoop = {
        run: vi.fn().mockResolvedValue({ finalStatus: "completed", totalIterations: 1, tokensUsed: 2 }),
      };
      const goalTriggerSchedule = new ScheduleEngine({
        baseDir,
        stateManager,
        coreLoop,
        logger: logger(),
        personalAgentRuntime: { recordTrace },
      });
      await goalTriggerSchedule.loadEntries();
      const directGoalTriggerEntry = await goalTriggerSchedule.addEntry(goalTriggerEntry({
        name: "direct-goal-trigger",
        goal_trigger: {
          goal_id: "goal-personal-agent",
          max_iterations: 1,
          skip_if_active: false,
        },
      }));
      goalTriggerSchedule.getEntries().find((candidate) => candidate.id === directGoalTriggerEntry.id)!
        .next_fire_at = new Date(Date.now() - 1000).toISOString();
      await goalTriggerSchedule.saveEntries();
      await goalTriggerSchedule.loadEntries();
      await goalTriggerSchedule.tick();
      expect(coreLoop.run).toHaveBeenCalledWith("goal-personal-agent", {
        maxIterations: 1,
        runPolicy: "bounded",
      });

      const escalationCoreLoop = {
        run: vi.fn().mockResolvedValue({ finalStatus: "completed", totalIterations: 1, tokensUsed: 3 }),
      };
      const escalationSchedule = new ScheduleEngine({
        baseDir: path.join(baseDir, "escalation-schedule"),
        coreLoop: escalationCoreLoop,
        logger: logger(),
        personalAgentRuntime: { recordTrace },
      });
      const escalatingEntry = await escalationSchedule.addEntry({
        name: "direct-goal-escalation",
        layer: "probe",
        trigger: { type: "interval", seconds: 60, jitter_factor: 0 },
        enabled: true,
        probe: {
          data_source_id: "missing-source",
          query_params: {},
          change_detector: { mode: "diff", baseline_window: 5 },
          llm_on_change: false,
        },
        escalation: {
          enabled: true,
          circuit_breaker_threshold: 100,
          cooldown_minutes: 0,
          max_per_hour: 100,
          target_layer: "goal_trigger",
          target_goal_id: "goal-escalated",
        },
      });
      escalationSchedule.getEntries()[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
      await escalationSchedule.saveEntries();
      await escalationSchedule.loadEntries();
      await escalationSchedule.tick();
      expect(escalationCoreLoop.run).toHaveBeenCalledWith("goal-escalated", {
        maxIterations: 10,
        runPolicy: "bounded",
      });

      await runResidentCuriosityCycle({
        curiosityEngine: {
          evaluateTriggers: vi.fn().mockResolvedValue([]),
        },
        stateManager,
        saveDaemonState: vi.fn().mockResolvedValue(undefined),
        state: {
          loop_count: 1,
          active_goals: [],
          status: "idle",
        },
        logger: logger(),
        baseDir,
        config: { runtime_root: path.join(baseDir, "runtime") },
        personalAgentRuntime: { recordTrace },
      } as never);

      await new RuntimeControlService({
        runtimeRoot: path.join(baseDir, "runtime"),
        stateManager,
        personalAgentRuntime: { recordTrace },
      }).request({
        intent: { kind: "restart_daemon", reason: "operator requested restart" },
        cwd: baseDir,
        requestedBy: { surface: "cli" },
      });

      await new NotificationDispatcher(
        { channels: [] },
        undefined,
        undefined,
        { recordTrace },
      ).dispatch({
        id: "report-notify-1",
        report_type: "daily_summary",
        goal_id: "goal-personal-agent",
        title: "Daily summary",
        content: "No user-facing trace ids here.",
        verbosity: "standard",
        generated_at: NOW,
        delivered_at: null,
        read: false,
      });

      const lifecycle = new TaskLifecycle({
        stateManager,
        llmClient: taskGenerationLlm(),
        sessionManager: sessionManager(),
        trustManager: { requiresApproval: vi.fn().mockResolvedValue(false) } as never,
        strategyManager: { getActiveStrategy: vi.fn().mockResolvedValue({ id: "strategy-1" }) } as never,
        stallDetector: {} as never,
        options: { personalAgentRuntime: { recordTrace } },
      });
      const task = await lifecycle.generateTask(
        "goal-personal-agent",
        "claim_truth",
        "strategy-1",
        undefined,
        "mock-adapter",
      );
      expect(task).not.toBeNull();
      await lifecycle.executeTask(task!, mockAdapter());

      const callerPaths = recordTrace.mock.calls.map((call) =>
        (call[0] as PersonalAgentDecisionTrace).situation_frame.caller_path
      );
      expect(callerPaths).toEqual(expect.arrayContaining([
        "scheduled_wake",
        "resident_proactive",
        "runtime_control",
        "notification_interruption",
        "goal_gap_task_generation",
        "task_execution",
      ]));
      const traces = recordTrace.mock.calls.map((call) => call[0] as PersonalAgentDecisionTrace);
      const waitResumeTrace = traces.find((trace) => trace.replay_key === `wait_resume:${entry.id}:${waitResumeDueAt}`);
      expect(waitResumeTrace).toMatchObject({
        situation_frame: expect.objectContaining({
          caller_path: "scheduled_wake",
          source_kind: "schedule_wake",
        }),
        task_candidates: [
          expect.objectContaining({
            target_kind: "attention_only",
            desired_effect: "hold_concern",
            task_created: false,
          }),
        ],
        intervention_decisions: [
          expect.objectContaining({
            decision: "hold",
            target_effect: "hold_concern",
          }),
        ],
      });
      const directGoalTriggerTrace = traces.find((trace) =>
        trace.situation_frame.source_ref.ref === directGoalTriggerEntry.id &&
        trace.task_candidates[0]?.target_kind === "run"
      );
      expect(directGoalTriggerTrace).toMatchObject({
        intervention_decisions: [
          expect.objectContaining({
            decision: "allow",
            target_effect: "create_run",
          }),
        ],
        task_candidates: [
          expect.objectContaining({
            desired_effect: "create_run",
            task_created: false,
          }),
        ],
      });
      const escalationGoalTrace = traces.find((trace) =>
        trace.situation_frame.source_ref.ref === escalatingEntry.id &&
        trace.task_candidates[0]?.target_ref.ref.startsWith("run:schedule:")
      );
      expect(escalationGoalTrace).toMatchObject({
        intervention_decisions: [
          expect.objectContaining({
            decision: "allow",
            target_effect: "create_run",
          }),
        ],
      });

      const runtimeDecision = recordTrace.mock.calls
        .map((call) => call[0] as PersonalAgentDecisionTrace)
        .find((trace) => trace.situation_frame.caller_path === "runtime_control")!;
      expect(runtimeDecision.intervention_decisions[0]).toMatchObject({
        decision: "confirm_required",
        permission_required: true,
        target_effect: "mutate_runtime_control",
      });

      const notificationDecision = recordTrace.mock.calls
        .map((call) => call[0] as PersonalAgentDecisionTrace)
        .find((trace) => trace.situation_frame.caller_path === "notification_interruption")!;
      expect(notificationDecision.intervention_decisions[0]).toMatchObject({
        decision: "suppress",
        target_effect: "hold_concern",
      });

      const generationDecision = recordTrace.mock.calls
        .map((call) => call[0] as PersonalAgentDecisionTrace)
        .find((trace) => trace.situation_frame.caller_path === "goal_gap_task_generation")!;
      expect(generationDecision.task_candidates[0]).toMatchObject({
        target_kind: "task",
        task_created: false,
        desired_effect: "create_task",
      });

      expect(entry.metadata?.activation_kind).toBe("wait_resume");
    } finally {
      cleanup();
    }
  });

  it("records denied permission-gated task execution as durable policy history before returning early", async () => {
    const { baseDir, stateManager, cleanup } = await fixtureState();
    const recordTrace = vi.fn();
    try {
      const adapter = mockAdapter();
      const lifecycle = new TaskLifecycle({
        stateManager,
        llmClient: externalActionTaskGenerationLlm(),
        sessionManager: sessionManager(),
        trustManager: { requiresApproval: vi.fn().mockResolvedValue(false) } as never,
        strategyManager: { getActiveStrategy: vi.fn().mockResolvedValue({ id: "strategy-1" }) } as never,
        stallDetector: {} as never,
        options: {
          approvalFn: vi.fn().mockResolvedValue(false),
          personalAgentRuntime: { recordTrace },
        },
      });

      const result = await lifecycle.runTaskCycle(
        "goal-personal-agent",
        {
          goal_id: "goal-personal-agent",
          gaps: [{
            dimension_name: "claim_truth",
            raw_gap: 1,
            normalized_gap: 1,
            normalized_weighted_gap: 1,
            confidence: 1,
            uncertainty_weight: 1,
          }],
          timestamp: NOW,
        },
        {
          time_since_last_attempt: { claim_truth: 24 },
          deadlines: { claim_truth: null },
          opportunities: {},
          pacing: {},
        },
        adapter,
      );

      expect(result.action).toBe("approval_denied");
      expect(adapter.execute).not.toHaveBeenCalled();
      const traces = recordTrace.mock.calls.map((call) => call[0] as PersonalAgentDecisionTrace);
      const preExecutionDecisions = traces.filter((trace) =>
        trace.replay_key.startsWith("task_pre_execution_policy:irreversible_approval")
      );
      expect(preExecutionDecisions.map((trace) => trace.intervention_decisions[0]?.decision))
        .toEqual(["confirm_required", "block"]);
      expect(preExecutionDecisions[0]).toMatchObject({
        situation_frame: {
          caller_path: "task_execution",
          source_kind: "task_execution",
          normal_surface_trace_visible: false,
        },
        initiative_events: expect.arrayContaining([
          expect.objectContaining({ event_type: "action_requested" }),
          expect.objectContaining({ event_type: "policy_decision_recorded" }),
        ]),
        task_candidates: [
          expect.objectContaining({
            desired_effect: "execute_tool",
            materialization_state: "held",
            task_created: false,
          }),
        ],
        intervention_decisions: [
          expect.objectContaining({
            decision: "confirm_required",
            permission_required: true,
            target_effect: "execute_tool",
          }),
        ],
      });
      expect(preExecutionDecisions[1]).toMatchObject({
        initiative_events: expect.arrayContaining([
          expect.objectContaining({ event_type: "policy_decision_recorded" }),
          expect.objectContaining({ event_type: "action_outcome" }),
        ]),
        task_candidates: [
          expect.objectContaining({
            desired_effect: "execute_tool",
            materialization_state: "blocked",
            task_created: false,
          }),
        ],
        intervention_decisions: [
          expect.objectContaining({
            decision: "block",
            permission_required: true,
            target_effect: "execute_tool",
          }),
        ],
      });
      expect(traces.some((trace) => trace.replay_key.startsWith("task_execution:adapter:"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("admits cron and probe scheduled jobs before data, model, report, baseline, and notification side effects", async () => {
    const { baseDir, cleanup } = await fixtureState();
    const order: string[] = [];
    const recordTrace = vi.fn().mockImplementation(async (trace: PersonalAgentDecisionTrace) => {
      order.push(`trace:${trace.situation_frame.caller_path}:${trace.task_candidates[0]?.target_kind}`);
      return undefined;
    });
    const cronAdapter = dataSourceAdapter("cron-source", async () => {
      order.push("cron:query");
      return { value: "cron-data", raw: "cron-data", timestamp: NOW, source_id: "cron-source" };
    });
    const probeAdapter = dataSourceAdapter("probe-source", async () => {
      order.push("probe:query");
      return { value: "probe-data", raw: "probe-data", timestamp: NOW, source_id: "probe-source" };
    });
    const llmClient = {
      sendMessage: vi.fn()
        .mockImplementationOnce(async () => {
          order.push("cron:llm");
          return { content: "cron summary", usage: { input_tokens: 1, output_tokens: 1 } };
        })
        .mockImplementationOnce(async () => {
          order.push("probe:llm");
          return { content: "probe summary", usage: { input_tokens: 1, output_tokens: 1 } };
        }),
      parseJSON: vi.fn(),
    } as unknown as ILLMClient;
    const notificationDispatcher = new NotificationDispatcher(
      { channels: [] },
      undefined,
      undefined,
      { recordTrace },
    );
    const schedule = new ScheduleEngine({
      baseDir,
      dataSourceRegistry: new Map([
        ["cron-source", cronAdapter],
        ["probe-source", probeAdapter],
      ]),
      llmClient,
      notificationDispatcher: notificationDispatcher as unknown as { dispatch(report: Record<string, unknown>): Promise<unknown> },
      reportingEngine: {
        generateNotification: vi.fn(async () => {
          order.push("cron:report");
          return undefined;
        }),
      },
      personalAgentRuntime: { recordTrace },
      logger: logger(),
    });
    try {
      await schedule.loadEntries();
      const cronEntry = await schedule.addEntry(scheduleCronEntry({
        cron: {
          prompt_template: "Summarize {{cron-source}}",
          context_sources: ["cron-source"],
          output_format: "both",
          max_tokens: 100,
        },
      }));
      const probeEntry = await schedule.addEntry(scheduleProbeEntry({
        probe: {
          data_source_id: "probe-source",
          query_params: {},
          change_detector: { mode: "diff", baseline_window: 5 },
          llm_on_change: true,
        },
      }));
      const mutableProbe = schedule.getEntries().find((entry) => entry.id === probeEntry.id)!;
      mutableProbe.baseline_results = ["previous-probe-data"];
      for (const entry of schedule.getEntries()) {
        entry.next_fire_at = new Date(Date.now() - 1000).toISOString();
      }
      await schedule.saveEntries();
      await schedule.loadEntries();

      const results = await schedule.tick();

      expect(results.map((result) => result.entry_id)).toEqual(expect.arrayContaining([cronEntry.id, probeEntry.id]));
      const traces = recordTrace.mock.calls.map((call) => call[0] as PersonalAgentDecisionTrace);
      const cronAdmission = traces.find((trace) =>
        trace.situation_frame.caller_path === "scheduled_wake" &&
        trace.situation_frame.source_ref.ref === cronEntry.id &&
        trace.task_candidates[0]?.target_kind === "tool_call"
      );
      const probeAdmission = traces.find((trace) =>
        trace.situation_frame.caller_path === "scheduled_wake" &&
        trace.situation_frame.source_ref.ref === probeEntry.id &&
        trace.task_candidates[0]?.target_kind === "tool_call"
      );
      expect(cronAdmission).toMatchObject({
        intervention_decisions: [expect.objectContaining({
          decision: "allow",
          target_effect: "execute_tool",
          policy_ref: expect.objectContaining({ kind: "response_plan" }),
        })],
        capability_decisions: [expect.objectContaining({ decision: "available" })],
        situation_frame: expect.objectContaining({
          cognition_situation: expect.objectContaining({ caller_path: "schedule_wake" }),
          current_refs: expect.arrayContaining([
            expect.objectContaining({ kind: "cognition_response_plan" }),
          ]),
        }),
      });
      expect(probeAdmission).toMatchObject({
        intervention_decisions: [expect.objectContaining({
          decision: "allow",
          target_effect: "execute_tool",
          policy_ref: expect.objectContaining({ kind: "response_plan" }),
        })],
      });
      expect(order.indexOf("trace:scheduled_wake:tool_call")).toBeLessThan(order.indexOf("cron:query"));
      expect(order.indexOf("trace:scheduled_wake:tool_call")).toBeLessThan(order.indexOf("cron:llm"));
      const secondScheduleTraceIndex = order.findIndex((item, index) =>
        item === "trace:scheduled_wake:tool_call" && index > order.indexOf("cron:report")
      );
      expect(secondScheduleTraceIndex).toBeGreaterThanOrEqual(0);
      expect(secondScheduleTraceIndex).toBeLessThan(order.indexOf("probe:query"));
      expect(secondScheduleTraceIndex).toBeLessThan(order.indexOf("probe:llm"));
      const updatedProbe = schedule.getEntries().find((entry) => entry.id === probeEntry.id)!;
      expect(updatedProbe.baseline_results).toContain("probe-data");
      expect(traces).toEqual(expect.arrayContaining([
        expect.objectContaining({
          situation_frame: expect.objectContaining({
            caller_path: "notification_interruption",
            source_kind: "notification_report",
          }),
          intervention_decisions: [expect.objectContaining({ decision: "suppress", target_effect: "hold_concern" })],
        }),
      ]));
    } finally {
      cleanup();
    }
  });

  it("materializes goal-gap generated tasks through task_create admission with deterministic replay", async () => {
    const { baseDir, stateManager, cleanup } = await fixtureState();
    const recordTrace = vi.fn().mockResolvedValue(undefined);
    try {
      const lifecycle = new TaskLifecycle({
        stateManager,
        llmClient: taskGenerationLlm(),
        sessionManager: sessionManager(),
        trustManager: { requiresApproval: vi.fn().mockResolvedValue(false) } as never,
        strategyManager: { getActiveStrategy: vi.fn().mockResolvedValue({ id: "strategy-1" }) } as never,
        stallDetector: {} as never,
        options: { personalAgentRuntime: { recordTrace } },
      });

      const first = await lifecycle.generateTask(
        "goal-personal-agent",
        "claim_truth",
        "strategy-1",
        undefined,
        "mock-adapter",
      );
      const second = await lifecycle.generateTask(
        "goal-personal-agent",
        "claim_truth",
        "strategy-1",
        undefined,
        "mock-adapter",
      );

      expect(first?.id).toMatch(/^task:tool:task_create:/);
      expect(second?.id).toBe(first?.id);
      await expect(stateManager.listTasks("goal-personal-agent"))
        .resolves.toHaveLength(1);

      const traces = recordTrace.mock.calls.map((call) => call[0] as PersonalAgentDecisionTrace);
      expect(traces).toEqual(expect.arrayContaining([
        expect.objectContaining({
          situation_frame: expect.objectContaining({
            caller_path: "goal_gap_task_generation",
            source_kind: "goal_gap",
          }),
          task_candidates: [expect.objectContaining({
            target_kind: "tool_call",
            desired_effect: "execute_tool",
          })],
          intervention_decisions: [expect.objectContaining({
            decision: "allow",
            target_effect: "execute_tool",
          })],
        }),
        expect.objectContaining({
          situation_frame: expect.objectContaining({
            caller_path: "goal_gap_task_generation",
            source_kind: "goal_gap",
          }),
          task_candidates: [expect.objectContaining({
            target_kind: "task",
            desired_effect: "create_task",
          })],
          intervention_decisions: [expect.objectContaining({
            decision: "allow",
            target_effect: "create_task",
          })],
        }),
      ]));
    } finally {
      cleanup();
    }
  });

  it("materializes knowledge-gap acquisition tasks through task_create admission with deterministic replay", async () => {
    const { stateManager, cleanup } = await fixtureState();
    const recordTrace = vi.fn().mockResolvedValue(undefined);
    try {
      const manager = new KnowledgeManager(
        stateManager,
        llm(JSON.stringify({
          knowledge_target: "How to verify durable personal-agent traces",
          knowledge_questions: [
            "Which trace proves the SituationFrame?",
            "Which decision admits task creation?",
            "Which replay key prevents duplicates?",
          ],
          in_scope: ["local runtime history", "contract evidence"],
          out_of_scope: ["production deployment"],
        })),
        undefined,
        undefined,
        undefined,
        undefined,
        { recordTrace },
      );

      const signal = {
        signal_type: "stall_information_deficit" as const,
        missing_knowledge: "Need durable trace evidence before continuing.",
        source_step: "task_generation",
        related_dimension: "claim_truth",
      };
      const first = await manager.generateAcquisitionTask(signal, "goal-personal-agent");
      const second = await manager.generateAcquisitionTask(signal, "goal-personal-agent");

      expect(first.id).toMatch(/^task:tool:task_create:/);
      expect(second.id).toBe(first.id);
      await expect(stateManager.listTasks("goal-personal-agent")).resolves.toHaveLength(1);
      const traces = recordTrace.mock.calls.map((call) => call[0] as PersonalAgentDecisionTrace);
      expect(traces).toEqual(expect.arrayContaining([
        expect.objectContaining({
          situation_frame: expect.objectContaining({
            caller_path: "goal_gap_task_generation",
            source_kind: "goal_gap",
          }),
          task_candidates: [expect.objectContaining({
            target_kind: "tool_call",
            desired_effect: "execute_tool",
            task_created: false,
          })],
          intervention_decisions: [expect.objectContaining({
            decision: "allow",
            target_effect: "execute_tool",
          })],
        }),
        expect.objectContaining({
          situation_frame: expect.objectContaining({
            caller_path: "goal_gap_task_generation",
            source_kind: "goal_gap",
          }),
          task_candidates: [expect.objectContaining({
            target_kind: "task",
            desired_effect: "create_task",
          })],
          intervention_decisions: [expect.objectContaining({
            decision: "allow",
            target_effect: "create_task",
          })],
        }),
      ]));
    } finally {
      cleanup();
    }
  });

  it("records approved runtime-control actions as separate allow and outcome decisions before execution", async () => {
    const { baseDir, stateManager, cleanup } = await fixtureState();
    const order: string[] = [];
    const recordTrace = vi.fn().mockImplementation(async (trace: PersonalAgentDecisionTrace) => {
      order.push(`trace:${trace.intervention_decisions[0]?.decision}:${trace.initiative_events.map((event) => event.event_type).join(",")}`);
    });
    const executor = vi.fn().mockImplementation(async () => {
      order.push("execute");
      return { ok: true, message: "daemon restart queued", state: "verified" as const };
    });
    try {
      const result = await new RuntimeControlService({
        runtimeRoot: path.join(baseDir, "runtime"),
        stateManager,
        executor,
        personalAgentRuntime: { recordTrace },
      }).request({
        intent: { kind: "restart_daemon", reason: "operator approved restart" },
        cwd: baseDir,
        requestedBy: { surface: "cli" },
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(result.success).toBe(true);
      expect(executor).toHaveBeenCalledOnce();
      expect(order).toEqual([
        "trace:confirm_required:signal_received,task_candidate_proposed,action_requested,policy_decision_recorded",
        "trace:allow:signal_received,task_candidate_proposed,action_requested,policy_decision_recorded",
        "execute",
        "trace:allow:signal_received,task_candidate_proposed,action_requested,policy_decision_recorded,action_outcome",
      ]);
      const traces = recordTrace.mock.calls.map((call) => call[0] as PersonalAgentDecisionTrace);
      expect(traces.map((trace) => trace.trace_id)).toHaveLength(new Set(traces.map((trace) => trace.trace_id)).size);
      expect(traces[0]?.task_candidates[0]?.materialization_state).toBe("held");
      expect(traces[1]?.task_candidates[0]?.materialization_state).toBe("materialized");
      expect(traces[1]?.intervention_decisions[0]).toMatchObject({
        decision: "allow",
        permission_required: false,
        target_effect: "mutate_runtime_control",
      });
      expect(traces[2]?.initiative_events).toEqual(expect.arrayContaining([
        expect.objectContaining({ event_type: "action_outcome" }),
      ]));
    } finally {
      cleanup();
    }
  });

  it("records daemon and supervisor goal-run admission before durable execution is materialized", async () => {
    const order: string[] = [];
    const recordTrace = vi.fn().mockImplementation(async (trace: PersonalAgentDecisionTrace) => {
      order.push(`trace:${trace.situation_frame.source_ref.kind}`);
      return {} as never;
    });
    const schedule = {
      goal_id: "goal-personal-agent",
      next_check_at: NOW,
      check_interval_hours: 1,
      last_triggered_at: null,
      consecutive_actions: 0,
      cooldown_until: null,
      current_interval_hours: 1,
    };

    const run = vi.fn().mockImplementation(async () => {
      order.push("run");
      return {
        goalId: "goal-personal-agent",
        finalStatus: "completed",
        totalIterations: 1,
        iterations: [],
        startedAt: NOW,
        completedAt: NOW,
      };
    });
    let context: Record<string, unknown>;
    context = {
      running: true,
      shuttingDown: false,
      currentGoalIds: ["goal-personal-agent"],
      config: { iterations_per_cycle: 1 },
      state: {
        loop_count: 4,
        last_loop_at: null,
        status: "running",
        active_goals: ["goal-personal-agent"],
      },
      consecutiveIdleCycles: 0,
      currentLoopIndex: 0,
      coreLoop: { run },
      eventServer: null,
      personalAgentRuntime: { recordTrace },
      stateManager: { loadGoal: vi.fn().mockResolvedValue({ status: "active" }) },
      logger: logger(),
      refreshOperationalState: vi.fn(),
      collectGoalCycleSnapshot: vi.fn().mockResolvedValue([{
        goalId: "goal-personal-agent",
        shouldActivate: true,
        schedule,
      }]),
      determineActiveGoals: vi.fn().mockResolvedValue(["goal-personal-agent"]),
      maybeRefreshProviderRuntime: vi.fn().mockResolvedValue(undefined),
      broadcastGoalUpdated: vi.fn().mockResolvedValue(undefined),
      handleLoopError: vi.fn(),
      saveDaemonState: vi.fn().mockResolvedValue(undefined),
      processScheduleEntries: vi.fn().mockResolvedValue(undefined),
      proactiveTick: vi.fn().mockResolvedValue(undefined),
      runRuntimeStoreMaintenance: vi.fn().mockResolvedValue(undefined),
      getNextInterval: vi.fn().mockReturnValue(1),
      getMaxGapScore: vi.fn().mockResolvedValue(0),
      calculateAdaptiveInterval: vi.fn().mockReturnValue(1),
      sleep: vi.fn().mockImplementation(async () => {
        context.running = false;
      }),
      handleCriticalError: vi.fn(),
      cleanup: vi.fn().mockResolvedValue(undefined),
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    try {
      await runDaemonGoalCycleLoop(context);
      await runSupervisorMaintenanceCycleForDaemon({
        currentGoalIds: ["goal-personal-agent"],
        driveSystem: {
          getGoalActivationSnapshot: vi.fn(async (goalId: string) => ({
            goalId,
            shouldActivate: true,
            schedule,
          })),
          shouldActivate: vi.fn().mockResolvedValue(true),
          getSchedule: vi.fn().mockResolvedValue(schedule),
          prioritizeGoals: vi.fn().mockImplementation((ids: string[]) => ids),
        } as never,
        supervisor: {
          activateGoal: vi.fn(() => {
            order.push("activate");
          }),
        },
        personalAgentRuntime: { recordTrace },
        processScheduleEntries: vi.fn().mockResolvedValue(undefined),
        proactiveTick: vi.fn().mockResolvedValue(undefined),
        saveDaemonState: vi.fn().mockResolvedValue(undefined),
        runPolicy: "bounded",
        maxIterations: 3,
        state: {
          loop_count: 5,
          active_goals: ["goal-personal-agent"],
          interrupted_goals: [],
          status: "running",
          last_loop_at: null,
          last_resident_at: null,
          resident_activity: null,
        } as never,
      });
    } finally {
      vi.useRealTimers();
    }

    expect(order).toEqual([
      "trace:daemon_goal_cycle",
      "run",
      "trace:supervisor_maintenance",
      "activate",
    ]);
    const traces = recordTrace.mock.calls.map((call) => call[0] as PersonalAgentDecisionTrace);
    expect(traces).toEqual(expect.arrayContaining([
      expect.objectContaining({
        situation_frame: expect.objectContaining({
          caller_path: "scheduled_wake",
          source_kind: "schedule_wake",
        }),
        task_candidates: [
          expect.objectContaining({
            target_kind: "run",
            desired_effect: "create_run",
            task_created: false,
          }),
        ],
      }),
    ]));
    expect(traces).toEqual(expect.arrayContaining([
      expect.objectContaining({
        situation_frame: expect.objectContaining({
          replay_key: expect.stringContaining(":bounded:3"),
        }),
      }),
    ]));
    expect(traces.every((trace) =>
      trace.intervention_decisions[0]?.policy_ref.ref === "policy:goal-run-admission-v1"
    )).toBe(true);
  });

  it("records RunSpec starts and resident maintenance before durable work can be materialized", async () => {
    const { baseDir, stateManager, cleanup } = await fixtureState();
    const recordTrace = vi.fn();
    const daemonStart = vi.fn().mockResolvedValue({ ok: true });
    try {
      const spec = runSpecFixture();
      const first = await new RunSpecHandoffService({
        stateManager,
        daemonClient: { startGoal: daemonStart } as never,
        personalAgentRuntime: { recordTrace },
      }).startConfirmed(spec);
      const second = await new RunSpecHandoffService({
        stateManager,
        daemonClient: { startGoal: daemonStart } as never,
        personalAgentRuntime: { recordTrace },
      }).startConfirmed(spec);

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(first.goalId).toBe(second.goalId);
      expect(first.backgroundRunId).toBe(second.backgroundRunId);
      expect(daemonStart).toHaveBeenCalledWith(first.goalId, expect.objectContaining({
        backgroundRun: expect.objectContaining({
          backgroundRunId: first.backgroundRunId,
        }),
      }));

      await proactiveTick({
        baseDir,
        config: {
          proactive_mode: true,
          proactive_interval_ms: 0,
          goal_review_interval_ms: Number.MAX_SAFE_INTEGER,
          runtime_root: path.join(baseDir, "runtime"),
          workspace_path: baseDir,
        },
        llmClient: llm(JSON.stringify({ action: "sleep" })),
        state: {
          loop_count: 1,
          active_goals: [],
          status: "idle",
        },
        logger: logger(),
        saveDaemonState: vi.fn().mockResolvedValue(undefined),
        currentGoalIds: [],
        stateManager,
        driveSystem: { writeEvent: vi.fn().mockResolvedValue(undefined) },
        refreshOperationalState: vi.fn(),
        abortSleep: vi.fn(),
        personalAgentRuntime: { recordTrace },
      } as never, 0, vi.fn(), Date.now(), vi.fn());

      const traces = recordTrace.mock.calls.map((call) => call[0] as PersonalAgentDecisionTrace);
      const runSpecTrace = traces.find((trace) =>
        trace.situation_frame.caller_path === "explicit_user_command"
        && trace.task_candidates.some((candidate) => candidate.desired_effect === "create_run")
        && trace.intervention_decisions.some((decision) => decision.decision === "allow")
      );
      expect(runSpecTrace).toMatchObject({
        situation_frame: expect.objectContaining({
          caller_path: "explicit_user_command",
          source_kind: "explicit_command",
        }),
      });
      expect(runSpecTrace?.task_candidates[0]).toMatchObject({
        target_kind: "run",
        desired_effect: "create_run",
        task_created: false,
      });
      expect(runSpecTrace?.intervention_decisions[0]).toMatchObject({
        decision: "allow",
        target_effect: "create_run",
      });
      expect(traces.some((trace) =>
        trace.initiative_events.some((event) => event.event_type === "action_outcome")
      )).toBe(true);

      const residentTrace = traces.find((trace) => trace.situation_frame.caller_path === "resident_proactive");
      expect(residentTrace).toMatchObject({
        situation_frame: expect.objectContaining({
          caller_path: "resident_proactive",
          source_kind: "resident_observation",
        }),
      });
      expect(residentTrace?.task_candidates[0]).toMatchObject({
        target_kind: "attention_only",
        materialization_state: "held",
        task_created: false,
      });
      expect(residentTrace?.intervention_decisions[0]).toMatchObject({
        decision: "hold",
      });
    } finally {
      cleanup();
    }
  });

  it("routes mutating tools and chat commands through policy traces before durable materialization", async () => {
    const { baseDir, stateManager, cleanup } = await fixtureState();
    const recordTrace = vi.fn();
    try {
      const deniedContext = toolContext(baseDir, { preApproved: false, callId: "call-denied" });
      const setGoal = new SetGoalTool(stateManager, { recordTrace });
      const deniedGoal = await setGoal.call({ description: "Create a replay-safe tool goal" }, deniedContext);
      expect(deniedGoal.success).toBe(false);
      expect(deniedGoal.execution).toMatchObject({ status: "not_executed" });
      expect(await stateManager.listGoalIds()).not.toContain("goal:tool:set_goal");

      const approvedGoalContext = toolContext(baseDir, { callId: "call-set-goal", turnId: "turn-set-goal" });
      const createdGoal = await setGoal.call({ description: "Create a replay-safe tool goal" }, approvedGoalContext);
      const replayedGoal = await setGoal.call({ description: "Create a replay-safe tool goal" }, approvedGoalContext);
      expect(createdGoal.success).toBe(true);
      expect(replayedGoal.data).toEqual(createdGoal.data);

      const createdGoalId = (createdGoal.data as { goalId: string }).goalId;
      const taskCreate = new TaskCreateTool(stateManager, { recordTrace });
      const deniedTask = await taskCreate.call(taskCreateInput(createdGoalId), deniedContext);
      expect(deniedTask.success).toBe(false);
      expect(deniedTask.execution).toMatchObject({ status: "not_executed" });
      const createdTask = await taskCreate.call(taskCreateInput(createdGoalId), toolContext(baseDir, {
        callId: "call-task-create",
        turnId: "turn-task-create",
      }));
      const replayedTask = await taskCreate.call(taskCreateInput(createdGoalId), toolContext(baseDir, {
        callId: "call-task-create",
        turnId: "turn-task-create",
      }));
      expect(createdTask.success).toBe(true);
      expect(replayedTask.data).toEqual(createdTask.data);
      const createdTaskId = (createdTask.data as { taskId: string }).taskId;

      const scheduleEngine = new ScheduleEngine({
        baseDir,
        stateManager,
        logger: logger(),
        personalAgentRuntime: { recordTrace },
      });
      const builtinTools = createBuiltinTools({
        stateManager,
        scheduleEngine,
        personalAgentRuntime: { recordTrace },
      });
      const updateGoalTool = builtinTools.find((tool) => tool.metadata.name === "update_goal")!;
      const taskUpdateTool = builtinTools.find((tool) => tool.metadata.name === "task_update")!;
      const createScheduleTool = builtinTools.find((tool) => tool.metadata.name === "create_schedule")!;
      const updateScheduleTool = builtinTools.find((tool) => tool.metadata.name === "update_schedule")!;

      const deniedGoalUpdate = await updateGoalTool.call(
        { goalId: createdGoalId, description: "Blocked goal update" },
        deniedContext,
      );
      expect(deniedGoalUpdate.success).toBe(false);
      expect(deniedGoalUpdate.execution).toMatchObject({ status: "not_executed" });
      expect((await stateManager.loadGoal(createdGoalId))?.description).toBe("Create a replay-safe tool goal");

      const allowedGoalUpdate = await updateGoalTool.call(
        { goalId: createdGoalId, description: "Allowed goal update" },
        toolContext(baseDir, { callId: "call-update-goal", turnId: "turn-update-goal" }),
      );
      expect(allowedGoalUpdate.success).toBe(true);
      expect((await stateManager.loadGoal(createdGoalId))?.description).toBe("Allowed goal update");

      const deniedTaskUpdate = await taskUpdateTool.call(
        { goalId: createdGoalId, taskId: createdTaskId, approach: "Blocked task update" },
        deniedContext,
      );
      expect(deniedTaskUpdate.success).toBe(false);
      expect(deniedTaskUpdate.execution).toMatchObject({ status: "not_executed" });
      expect((await stateManager.loadTask(createdGoalId, createdTaskId))?.approach)
        .toBe("Persist through TaskCreateTool only after InterventionPolicy allow.");

      const allowedTaskUpdate = await taskUpdateTool.call(
        { goalId: createdGoalId, taskId: createdTaskId, approach: "Allowed task update" },
        toolContext(baseDir, { callId: "call-update-task", turnId: "turn-update-task" }),
      );
      expect(allowedTaskUpdate.success).toBe(true);
      expect((await stateManager.loadTask(createdGoalId, createdTaskId))?.approach).toBe("Allowed task update");

      const scheduleInput = {
        name: "Personal-agent review cadence",
        layer: "cron" as const,
        trigger: { type: "interval" as const, seconds: 3600 },
        cron: {
          prompt_template: "Review durable runtime traces.",
          context_sources: [],
          output_format: "notification" as const,
          max_tokens: 500,
        },
      };
      const deniedScheduleCreate = await createScheduleTool.call(scheduleInput, deniedContext);
      expect(deniedScheduleCreate.success).toBe(false);
      expect(deniedScheduleCreate.execution).toMatchObject({ status: "not_executed" });
      expect(scheduleEngine.getEntries()).toHaveLength(0);

      const createdSchedule = await createScheduleTool.call(scheduleInput, toolContext(baseDir, {
        callId: "call-create-schedule",
        turnId: "turn-create-schedule",
      }));
      expect(createdSchedule.success).toBe(true);
      const scheduleId = (createdSchedule.data as { entry: { id: string } }).entry.id;
      const deniedScheduleUpdate = await updateScheduleTool.call(
        { schedule_id: scheduleId, enabled: false },
        deniedContext,
      );
      expect(deniedScheduleUpdate.success).toBe(false);
      expect(deniedScheduleUpdate.execution).toMatchObject({ status: "not_executed" });
      expect(scheduleEngine.getEntries()[0]?.enabled).toBe(true);

      const daemonStart = vi.fn().mockResolvedValue({ ok: true });
      const durableTools = createDurableLoopControlTools(
        createDaemonBackedDurableLoopControlToolset({
          stateManager,
          daemonClientFactory: async () => ({
            startGoal: daemonStart,
            stopGoal: vi.fn(),
            pauseGoal: vi.fn(),
            resumeGoal: vi.fn(),
            getSnapshot: vi.fn(),
          }),
          personalAgentRuntime: { recordTrace },
        }),
        { personalAgentRuntime: { recordTrace }, baseDir },
      );
      const tendTool = durableTools.find((tool) => tool.metadata.name === "core_tend_goal")!;
      const tendResult = await tendTool.call(
        { description: "Start a durable loop from the builtin tool", notifyPolicy: "silent" },
        toolContext(baseDir, { callId: "call-core-tend", turnId: "turn-core-tend" }),
      );
      expect(tendResult.success).toBe(true);
      expect(daemonStart).toHaveBeenCalledWith(
        expect.stringMatching(/^goal:tool:core_goal:/),
        expect.objectContaining({
          backgroundRun: expect.objectContaining({
            backgroundRunId: expect.stringMatching(/^run:coreloop:/),
          }),
        }),
      );

      const tendGoal = makeGoal({
        id: "goal-tend-chat",
        title: "Tend chat goal",
        status: "active",
      });
      await stateManager.saveGoal(tendGoal);
      const tendCommandResult = await new TendCommand().startAcceptedGoal("goal-tend-chat", undefined, {
        llmClient: llm("unused"),
        goalNegotiator: {} as never,
        daemonClient: { startGoal: vi.fn().mockResolvedValue({ ok: true }) } as never,
        stateManager,
        chatHistory: [],
        sessionId: "chat-session-tend",
        workspace: baseDir,
        personalAgentRuntime: { recordTrace },
      });
      expect(tendCommandResult.success).toBe(true);
      expect(tendCommandResult.backgroundRunId).toMatch(/^run:coreloop:/);

      const trackHistory = new ChatHistory(stateManager, "chat-session-track", baseDir);
      await trackHistory.appendUserMessage("Track this migration as a goal");
      const trackNegotiator = {
        negotiate: vi.fn(async (description: string, options?: { goalId?: string }) => ({
          goal: makeGoal({
            id: options?.goalId ?? "missing-goal-id",
            title: description,
            description,
            status: "active",
          }) as Goal,
          response: {},
          log: {},
        })),
      };
      const track = await new EscalationHandler({
        stateManager,
        llmClient: llm("Track durable runtime migration"),
        goalNegotiator: trackNegotiator as never,
        personalAgentRuntime: { recordTrace },
      }).escalateToGoal(trackHistory);
      expect(track.goalId).toMatch(/^goal:track:/);
      expect(trackNegotiator.negotiate).toHaveBeenCalledWith(
        "Track durable runtime migration",
        expect.objectContaining({ goalId: track.goalId }),
      );

      await new NotificationDispatcher(
        {
          batching: { enabled: true, window_minutes: 5, digest_format: "compact" },
          channels: [],
        },
        undefined,
        undefined,
        { recordTrace },
      ).dispatch({
        id: "report-batched-1",
        report_type: "daily_summary",
        goal_id: "goal-personal-agent",
        title: "Batched report",
        content: "Batch this report.",
        verbosity: "standard",
        generated_at: NOW,
        delivered_at: null,
        read: false,
      });

      const traces = recordTrace.mock.calls.map((call) => call[0] as PersonalAgentDecisionTrace);
      expect(traces).toEqual(expect.arrayContaining([
        expect.objectContaining({
          situation_frame: expect.objectContaining({ caller_path: "explicit_user_command" }),
          task_candidates: [expect.objectContaining({ target_kind: "goal", desired_effect: "create_goal" })],
        }),
        expect.objectContaining({
          situation_frame: expect.objectContaining({ caller_path: "explicit_user_command" }),
          task_candidates: [expect.objectContaining({ target_kind: "task", desired_effect: "create_task" })],
        }),
        expect.objectContaining({
          situation_frame: expect.objectContaining({ caller_path: "explicit_user_command" }),
          task_candidates: [expect.objectContaining({ target_kind: "run", desired_effect: "create_run" })],
        }),
        expect.objectContaining({
          situation_frame: expect.objectContaining({ caller_path: "notification_interruption" }),
          intervention_decisions: [expect.objectContaining({ decision: "hold", target_effect: "hold_concern" })],
        }),
      ]));
      for (const capabilityRef of [
        "tool:update_goal",
        "tool:task_update",
        "tool:create_schedule",
        "tool:update_schedule",
      ]) {
        expect(traces.some((trace) =>
          trace.task_candidates.some((candidate) =>
            candidate.target_kind === "tool_call" &&
            candidate.desired_effect === "execute_tool" &&
            candidate.capability_refs.some((ref) => ref.ref === capabilityRef)
          )
        )).toBe(true);
      }
      expect(traces.some((trace) =>
        trace.intervention_decisions.some((decision) => decision.decision === "confirm_required")
      )).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("records explicit CLI and MCP goal mutation paths before durable state changes", async () => {
    const { baseDir, stateManager, cleanup } = await fixtureState();
    const store = new PersonalAgentRuntimeStore(baseDir, { controlBaseDir: baseDir });
    try {
      const resetSourceGoal = await stateManager.loadGoal("goal-personal-agent");
      expect(resetSourceGoal).not.toBeNull();

      await expect(cmdGoalAddRaw(stateManager, {
        title: "CLI raw personal-agent goal",
        description: "Create through the real CLI raw goal command.",
        rawDimensions: ["done:present:true"],
      })).resolves.toBe(0);
      const rawGoal = await findGoalByTitle(stateManager, "CLI raw personal-agent goal");
      expect(rawGoal).not.toBeNull();
      const rawTrace = await store.loadTrace(stableTraceId([
        "explicit_command",
        "cli",
        "pulseed goal add --dim",
        `pulseed goal add --dim:${rawGoal!.id}`,
        rawGoal!.id,
        "goal",
        "goal",
        rawGoal!.id,
      ].join(":")));
      expect(rawTrace).toMatchObject({
        situation_frame: expect.objectContaining({ caller_path: "explicit_user_command" }),
        task_candidates: [expect.objectContaining({ target_kind: "goal", desired_effect: "create_goal" })],
        intervention_decisions: [expect.objectContaining({ decision: "allow", target_effect: "create_goal" })],
      });

      await expect(cmdGoalReset(stateManager, "goal-personal-agent")).resolves.toBe(0);
      const resetTrace = await store.loadTrace(stableTraceId([
        "explicit_command",
        "cli",
        "pulseed goal reset",
        "pulseed goal reset:goal-personal-agent",
        resetSourceGoal!.updated_at,
        "goal",
        "goal",
        "goal-personal-agent",
      ].join(":")));
      expect(resetTrace).toMatchObject({
        task_candidates: [expect.objectContaining({ desired_effect: "mutate_runtime_control" })],
        intervention_decisions: [expect.objectContaining({ decision: "allow" })],
      });

      const archiveSourceGoal = await stateManager.loadGoal("goal-personal-agent");
      expect(archiveSourceGoal).not.toBeNull();
      await expect(cmdGoalArchive(stateManager, "goal-personal-agent", { yes: true })).resolves.toBe(0);
      const archiveTrace = await store.loadTrace(stableTraceId([
        "explicit_command",
        "cli",
        "pulseed goal archive",
        "pulseed goal archive:goal-personal-agent",
        archiveSourceGoal!.updated_at,
        "goal",
        "goal",
        "goal-personal-agent",
      ].join(":")));
      expect(archiveTrace).toMatchObject({
        task_candidates: [expect.objectContaining({ desired_effect: "mutate_runtime_control" })],
        intervention_decisions: [expect.objectContaining({ decision: "allow" })],
      });

      const mcp = await toolGoalCreate({
        stateManager,
        baseDir,
      }, {
        title: "MCP personal-agent goal",
        description: "Create through the real MCP tool surface.",
      });
      const parsedMcp = JSON.parse(mcp.content[0].text) as { error: string };
      expect(parsedMcp.error).toContain("capability:mcp_server:pulseed:pulseed_goal_create requires approval before mutate");
      const mcpArgsFingerprint = stableId(stableTestJson({
        title: "MCP personal-agent goal",
        description: "Create through the real MCP tool surface.",
      }));
      const blockedMcpGoalId = `goal_${stableId(stableTestJson({
        command: "pulseed_goal_create",
        title: "MCP personal-agent goal",
        description: "Create through the real MCP tool surface.",
      })).slice(0, 16)}`;
      await expect(stateManager.loadGoal(blockedMcpGoalId)).resolves.toBeNull();
      const mcpPendingRef = `pending:${mcpArgsFingerprint}`;
      const mcpTrace = await store.loadTrace(stableTraceId([
        "explicit_command",
        "mcp",
        "pulseed_goal_create",
        `pulseed_goal_create:${mcpArgsFingerprint}`,
        mcpArgsFingerprint,
        "goal",
        "goal",
        mcpPendingRef,
      ].join(":")));
      expect(mcpTrace).toMatchObject({
        situation_frame: expect.objectContaining({ source_kind: "explicit_command" }),
        task_candidates: [expect.objectContaining({ target_kind: "goal", desired_effect: "create_goal" })],
        capability_decisions: [expect.objectContaining({ decision: "permission_required" })],
        intervention_decisions: [expect.objectContaining({ decision: "confirm_required" })],
      });

      const triggerPayload = { goal_id: "goal-personal-agent", detail: "contract signal" };
      const mcpTrigger = await toolTrigger({
        stateManager,
        baseDir,
      }, {
        source: "contract-mcp",
        event_type: "goal_signal",
        data: triggerPayload,
      });
      const parsedTrigger = JSON.parse(mcpTrigger.content[0].text) as { error: string };
      expect(parsedTrigger.error).toContain("capability:mcp_server:pulseed:pulseed_trigger requires approval before mutate");
      const triggerSeed = stableId(stableTestJson({
        source: "contract-mcp",
        event_type: "goal_signal",
        data: triggerPayload,
      }));
      const triggerEventId = `mcp_trigger_${triggerSeed}`;
      const eventsDir = path.join(baseDir, "events");
      if (existsSync(eventsDir)) {
        expect(readdirSync(eventsDir)).not.toContain(`${triggerEventId}.json`);
      }
      const triggerTrace = await store.loadTrace(stableTraceId(`mcp_trigger:${triggerSeed}`));
      expect(triggerTrace).toMatchObject({
        situation_frame: expect.objectContaining({ source_kind: "explicit_command" }),
        task_candidates: [expect.objectContaining({ target_kind: "attention_only", desired_effect: "continue_route" })],
        capability_decisions: [expect.objectContaining({ decision: "permission_required" })],
        intervention_decisions: [expect.objectContaining({ decision: "confirm_required" })],
      });

      const driveSystem = new DriveSystem(stateManager, {
        baseDir,
        personalAgentRuntime: store,
      });
      await driveSystem.writeEvent({
        type: "external",
        source: "contract-http",
        timestamp: NOW,
        data: triggerPayload,
      });
      const driveTrace = await store.loadTrace(stableTraceId([
        "drive_event_ingress",
        "external",
        "contract-http",
        NOW,
        stableId(stableTestJson(triggerPayload)),
      ].join(":")));
      expect(driveTrace).toMatchObject({
        situation_frame: expect.objectContaining({
          caller_path: "external_signal",
          source_kind: "external_signal",
        }),
        initiative_events: expect.arrayContaining([expect.objectContaining({ event_type: "signal_received" })]),
        task_candidates: expect.arrayContaining([expect.objectContaining({ target_kind: "attention_only", desired_effect: "continue_route" })]),
        capability_decisions: expect.arrayContaining([expect.objectContaining({ decision: "available" })]),
      });
    } finally {
      cleanup();
    }
  });

  it("persists replay-safe durable traces for memory correction and crash/restart recovery", async () => {
    const { baseDir, stateManager, cleanup } = await fixtureState();
    try {
      await runUserMemoryOperation(stateManager, {
        operation: "correct",
        targetRef: { kind: "runtime_evidence", id: "evidence-1" },
        reason: "This evidence was stale.",
        goalId: "goal-personal-agent",
        now: NOW,
      });

      const store = new PersonalAgentRuntimeStore(baseDir, { controlBaseDir: baseDir });
      const audits = await store.listMemoryAudits();
      expect(audits).toEqual(expect.arrayContaining([
        expect.objectContaining({
          memory_ref: { kind: "runtime_evidence", ref: "evidence-1" },
          action: "invalidate",
          correction_state: "corrected",
          invalidated: true,
        }),
      ]));

      const runningTask = taskFixture({
        id: "task-recovery-1",
        status: "running",
        started_at: "2026-05-14T23:00:00.000Z",
      });
      await stateManager.saveTask(runningTask);
      await reconcileInterruptedExecutions({
        baseDir,
        stateManager,
        logger: logger(),
      });

      const trace = await store.loadTrace(stableTraceId("restart_recovery:daemon_startup:goal-personal-agent:task-recovery-1"));
      expect(trace).toMatchObject({
        situation_frame: {
          caller_path: "crash_restart_resume",
        },
        initiative_events: expect.arrayContaining([
          expect.objectContaining({ event_type: "runtime_resumed" }),
        ]),
        intervention_decisions: [
          expect.objectContaining({
            decision: "allow",
            target_effect: "continue_route",
          }),
        ],
      });
    } finally {
      cleanup();
    }
  });

  it("records notification suppression decisions durably before dropping an interruption", async () => {
    const recordTrace = vi.fn();
    const dispatcher = new NotificationDispatcher(
      {
        channels: [{
          type: "email",
          address: "test@example.com",
          smtp: {
            host: "smtp.example.com",
            port: 587,
            secure: true,
            auth: { user: "u", pass: "p" },
          },
          report_types: ["execution_summary"],
          format: "full",
        }],
      },
      undefined,
      undefined,
      { recordTrace },
    );

    const results = await dispatcher.dispatch({
      id: "report-filtered-1",
      report_type: "urgent_alert",
      goal_id: "goal-personal-agent",
      title: "Filtered report",
      content: "This channel does not accept urgent alerts.",
      verbosity: "standard",
      generated_at: NOW,
      delivered_at: null,
      read: false,
    });

    expect(results).toEqual([
      expect.objectContaining({
        channel_type: "email",
        suppressed: true,
        suppression_reason: "filtered",
      }),
    ]);
    expect(recordTrace).toHaveBeenCalledWith(expect.objectContaining({
      replay_key: expect.stringContaining("suppress:filtered:email"),
      situation_frame: expect.objectContaining({
        caller_path: "notification_interruption",
      }),
      task_candidates: [
        expect.objectContaining({
          target_kind: "notification",
          materialization_state: "suppressed",
          desired_effect: "hold_concern",
        }),
      ],
      intervention_decisions: [
        expect.objectContaining({
          decision: "suppress",
          target_effect: "hold_concern",
        }),
      ],
    }));
  });

  it("stores durable goal and task authority as RuntimeGraph source-of-truth nodes", async () => {
    const { baseDir, stateManager, cleanup } = await fixtureState();
    try {
      const task = taskFixture({
        id: "task-runtime-graph-source",
        work_description: "Prove RuntimeGraph owns task authority.",
      });
      await stateManager.saveTask(task);
      await stateManager.saveGoal(makeGoal({
        id: "milestone-runtime-graph-source",
        parent_id: "goal-personal-agent",
        node_type: "milestone",
        title: "RuntimeGraph milestone authority",
        status: "active",
        dimensions: [makeDimension({
          name: "milestone-proof",
          label: "Milestone proof",
          current_value: 0,
          threshold: { type: "min", value: 1 },
        })],
      }));

      const store = new PersonalAgentRuntimeStore(baseDir, { controlBaseDir: baseDir });
      const goalNode = await store.loadRuntimeGraphNode("goal-personal-agent");
      const taskNode = await store.loadRuntimeGraphNode("task-runtime-graph-source");
      const milestoneNodes = await store.listRuntimeGraphSourceNodes("milestone");

      expect(goalNode).toMatchObject({
        node_kind: "goal",
        ref: { kind: "goal", ref: "goal-personal-agent" },
        payload: expect.objectContaining({
          runtime_graph_role: "source_of_truth",
          entity_kind: "goal",
          storage_projection: "goal_records",
          goal: expect.objectContaining({ id: "goal-personal-agent" }),
        }),
      });
      expect(taskNode).toMatchObject({
        node_kind: "task",
        ref: { kind: "task", ref: "task-runtime-graph-source" },
        payload: expect.objectContaining({
          runtime_graph_role: "source_of_truth",
          entity_kind: "task",
          storage_projection: "task_records",
          task: expect.objectContaining({
            id: "task-runtime-graph-source",
            goal_id: "goal-personal-agent",
          }),
        }),
      });
      expect(milestoneNodes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          node_kind: "milestone",
          ref: { kind: "milestone", ref: "milestone-runtime-graph-source" },
          payload: expect.objectContaining({
            runtime_graph_role: "source_of_truth",
            entity_kind: "milestone",
            storage_projection: "goal_records",
          }),
        }),
      ]));
      const db = await openControlDatabase({ baseDir });
      try {
        db.transaction((sqlite) => {
          sqlite.prepare("DELETE FROM goal_records WHERE goal_id = ?").run("goal-personal-agent");
          sqlite.prepare("DELETE FROM task_records WHERE goal_id = ?").run("goal-personal-agent");
        });
      } finally {
        db.close();
      }
      await expect(stateManager.loadTask("goal-personal-agent", "task-runtime-graph-source"))
        .resolves.toMatchObject({ id: "task-runtime-graph-source" });
      await expect(stateManager.listGoalIds()).resolves.toEqual(expect.arrayContaining([
        "goal-personal-agent",
        "milestone-runtime-graph-source",
      ]));
      await expect(stateManager.listTasks("goal-personal-agent"))
        .resolves.toMatchObject([{ id: "task-runtime-graph-source" }]);
    } finally {
      cleanup();
    }
  });

  it("keeps replay idempotent and preserves durable why/situation/policy answers", async () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "pulseed-personal-agent-replay-"));
    try {
      const store = new PersonalAgentRuntimeStore(baseDir, { controlBaseDir: baseDir });
      const trace = buildPersonalAgentDecisionTrace({
        callerPath: "notification_interruption",
        source: {
          sourceKind: "notification_report",
          sourceId: "report-replay",
          emittedAt: NOW,
          replayKey: "report-replay-key",
          summary: "Replayable notification signal.",
          sourceRef: { kind: "report", ref: "report-replay" },
        },
        target: {
          kind: "notification",
          ref: { kind: "report", ref: "report-replay" },
          effect: "send_notification",
          summary: "Replay report",
        },
        decision: "allow",
        decisionReason: "The report was worth acting on because it matched a durable notification policy.",
        capabilityDecision: "available",
        capabilityRefs: [{ kind: "notification_channel", ref: "webhook" }],
        policyRef: { kind: "intervention_policy", ref: "policy:notification-interruption-v1" },
      });

      await store.recordTrace(trace);
      await store.recordTrace(trace);

      const loaded = await store.loadTrace(trace.trace_id);
      const loadedByActionRef = await store.loadTrace("report-replay");
      const runtimeNode = await store.loadRuntimeGraphNode("report-replay");
      const pending = await store.listPendingConcerns(10);
      expect(loaded?.initiative_events).toHaveLength(trace.initiative_events.length);
      expect(loaded?.initiative_events.map((event) => event.event_type)).toEqual([
        "signal_received",
        "task_candidate_proposed",
        "action_requested",
        "policy_decision_recorded",
      ]);
      expect(loadedByActionRef?.trace_id).toBe(trace.trace_id);
      expect(runtimeNode?.provenance_refs).toEqual(expect.arrayContaining([
        { kind: "initiative_event", ref: trace.initiative_events[0]!.event_id },
      ]));
      expect(loaded?.task_candidates).toHaveLength(1);
      expect(loaded?.task_candidates[0]?.source_event_id).toBe(trace.initiative_events[1]!.event_id);
      expect(loaded?.task_candidates[0]?.materialization_state).toBe("materialized");
      expect(pending.task_candidates.some((candidate) => candidate.trace_id === trace.trace_id)).toBe(false);
      expect(loaded?.intervention_decisions).toHaveLength(1);
      expect(loaded?.situation_frame?.summary).toBe("Replayable notification signal.");
      expect(loaded?.intervention_decisions[0]?.reason).toContain("worth acting on");
      expect(loaded?.capability_decisions[0]?.capability_refs).toEqual([
        { kind: "notification_channel", ref: "webhook" },
      ]);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite durable decision records when the same replay key is reused", async () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "pulseed-personal-agent-immutable-"));
    try {
      const store = new PersonalAgentRuntimeStore(baseDir, { controlBaseDir: baseDir });
      const first = buildPersonalAgentDecisionTrace({
        callerPath: "notification_interruption",
        source: {
          sourceKind: "notification_report",
          sourceId: "report-immutable",
          emittedAt: NOW,
          replayKey: "report-immutable-key",
          summary: "Original replayable notification signal.",
          sourceRef: { kind: "report", ref: "report-immutable" },
        },
        target: {
          kind: "notification",
          ref: { kind: "report", ref: "report-immutable" },
          effect: "send_notification",
          summary: "Original report",
        },
        decision: "allow",
        decisionReason: "Original policy allowed this notification.",
        capabilityDecision: "available",
        capabilityRefs: [{ kind: "notification_channel", ref: "webhook" }],
        policyRef: { kind: "intervention_policy", ref: "policy:notification-interruption-v1" },
      });
      const collision = buildPersonalAgentDecisionTrace({
        callerPath: "notification_interruption",
        source: {
          sourceKind: "notification_report",
          sourceId: "report-immutable",
          emittedAt: NOW,
          replayKey: "report-immutable-key",
          summary: "Conflicting replayable notification signal.",
          sourceRef: { kind: "report", ref: "report-immutable" },
        },
        target: {
          kind: "notification",
          ref: { kind: "report", ref: "report-immutable" },
          effect: "send_notification",
          summary: "Conflicting report",
        },
        decision: "block",
        decisionReason: "Conflicting policy tried to block this notification.",
        capabilityDecision: "blocked",
        capabilityRefs: [{ kind: "notification_channel", ref: "webhook" }],
        policyRef: { kind: "intervention_policy", ref: "policy:notification-interruption-v1" },
      });

      await store.recordTrace(first);
      await store.recordTrace(collision);

      const loaded = await store.loadTrace(first.trace_id);
      expect(collision.trace_id).toBe(first.trace_id);
      expect(loaded?.situation_frame?.summary).toBe("Original replayable notification signal.");
      expect(loaded?.intervention_decisions).toEqual([
        expect.objectContaining({
          decision: "allow",
          reason: "Original policy allowed this notification.",
        }),
      ]);
      expect(loaded?.capability_decisions).toEqual([
        expect.objectContaining({ decision: "available" }),
      ]);
      expect(loaded?.task_candidates[0]?.materialization_state).toBe("materialized");
      expect(loaded?.initiative_events.map((event) => event.event_type)).toEqual([
        "signal_received",
        "task_candidate_proposed",
        "action_requested",
        "policy_decision_recorded",
      ]);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("preserves relationship memory conflicts in SituationFrame and memory audit history", async () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "pulseed-personal-agent-conflicts-"));
    const conflictRefs = [
      { kind: "memory", ref: "relationship-profile:preference" },
      { kind: "memory", ref: "relationship-profile:boundary" },
    ];
    try {
      const store = new PersonalAgentRuntimeStore(baseDir, { controlBaseDir: baseDir });
      const trace = buildPersonalAgentDecisionTrace({
        callerPath: "chat_gateway_turn",
        source: {
          sourceKind: "user_message",
          sourceId: "turn-conflict",
          emittedAt: NOW,
          replayKey: "turn-conflict-key",
          summary: "Chat turn with conflicting relationship memories.",
          sourceRef: { kind: "chat_turn", ref: "turn-conflict" },
        },
        target: {
          kind: "attention_only",
          ref: { kind: "response_plan", ref: "plan-conflict" },
          effect: "hold_concern",
          summary: "Hold until relationship conflict is handled.",
        },
        decision: "hold",
        decisionReason: "Conflicting relationship memories require a boundary-first response plan.",
        memoryRefs: conflictRefs,
        conflictRefs,
        policyRef: { kind: "intervention_policy", ref: "policy:relationship-conflict" },
      });

      await store.recordTrace(trace);
      const loaded = await store.loadTrace(trace.trace_id);

      expect(loaded?.situation_frame?.conflict_refs).toEqual(conflictRefs);
      expect(loaded?.memory_audits).toEqual(expect.arrayContaining([
        expect.objectContaining({
          memory_ref: conflictRefs[0],
          conflict_refs: conflictRefs,
          allowed_uses: ["runtime_grounding"],
        }),
        expect.objectContaining({
          memory_ref: conflictRefs[1],
          conflict_refs: conflictRefs,
          allowed_uses: ["runtime_grounding"],
        }),
      ]));
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

async function fixtureState(): Promise<{
  baseDir: string;
  stateManager: StateManager;
  cleanup: () => void;
}> {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "pulseed-personal-agent-"));
  const stateManager = new StateManager(baseDir);
  await stateManager.init();
  await stateManager.saveGoal(makeGoal({
    id: "goal-personal-agent",
    title: "Complete personal-agent runtime",
    status: "active",
    loop_status: "running",
    dimensions: [makeDimension({
      name: "claim_truth",
      label: "Claim truth",
      current_value: 0.2,
      threshold: { type: "min", value: 1 },
    })],
  }));
  return {
    baseDir,
    stateManager,
    cleanup: () => rmSync(baseDir, { recursive: true, force: true }),
  };
}

async function findGoalByTitle(stateManager: StateManager, title: string): Promise<Goal | null> {
  for (const goalId of await stateManager.listGoalIds()) {
    const goal = await stateManager.loadGoal(goalId);
    if (goal?.title === title) return goal;
  }
  return null;
}

function gatewayModelRoute(): SelectedChatRoute {
  return {
    kind: "gateway_model_loop",
    reason: "direct_model_tool_loop",
    replyTargetPolicy: "turn_reply_target",
    eventProjectionPolicy: "turn_only",
    concurrencyPolicy: "session_serial",
  };
}

function llm(content: string): ILLMClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      content,
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    }),
    parseJSON: vi.fn((raw: string, schema?: { parse(value: unknown): unknown }) => {
      const parsed = JSON.parse(raw) as unknown;
      return schema ? schema.parse(parsed) : parsed;
    }),
    supportsToolCalling: () => true,
  } as unknown as ILLMClient;
}

function taskGenerationLlm(): ILLMClient {
  const generated = {
    work_description: "Record a durable runtime migration proof.",
    rationale: "The runtime needs caller-path coverage.",
    approach: "Add a focused production-path verification.",
    success_criteria: [{
      description: "Trace is recorded",
      verification_method: "contract test",
      is_blocking: true,
    }],
    scope_boundary: {
      in_scope: ["runtime trace"],
      out_of_scope: ["external deployment"],
      blast_radius: "local runtime state only",
    },
    constraints: ["No external side effects"],
    reversibility: "reversible",
    intended_direction: "increase",
    estimated_duration: { value: 1, unit: "minutes" },
  };
  return llm(JSON.stringify(generated));
}

function externalActionTaskGenerationLlm(): ILLMClient {
  const generated = {
    work_description: "Submit the runtime migration report to an external tracker.",
    rationale: "External submission must be permission gated.",
    approach: "Use the typed risk profile to require approval before submission.",
    success_criteria: [{
      description: "Submission is approved",
      verification_method: "operator approval",
      is_blocking: true,
    }],
    scope_boundary: {
      in_scope: ["external tracker submission"],
      out_of_scope: ["local-only edits"],
      blast_radius: "external system mutation",
    },
    constraints: ["Do not submit without approval"],
    risk_profile: {
      external_action: {
        required: true,
        approval_required: true,
        action_kind: "submission",
        rationale: "The task submits information outside the local runtime.",
      },
    },
    artifact_contract: {},
    reversibility: "irreversible",
    intended_direction: "increase",
    estimated_duration: { value: 1, unit: "minutes" },
  };
  return llm(JSON.stringify(generated));
}

function toolContext(
  baseDir: string,
  overrides: Partial<ToolCallContext> = {},
): ToolCallContext {
  return {
    cwd: baseDir,
    goalId: overrides.goalId ?? "goal-personal-agent",
    trustBalance: 1,
    preApproved: overrides.preApproved ?? true,
    approvalFn: vi.fn().mockResolvedValue(true),
    callId: "call-personal-agent",
    sessionId: "session-personal-agent",
    ...overrides,
  };
}

function taskCreateInput(goalId: string) {
  return {
    goalId,
    targetDimensions: ["claim_truth"],
    primaryDimension: "claim_truth",
    work_description: "Create a durable task through the policy path.",
    rationale: "Contract coverage for personal-agent runtime tool materialization.",
    approach: "Persist through TaskCreateTool only after InterventionPolicy allow.",
    success_criteria: [{
      description: "The task is traceable",
      verification_method: "contract test",
      is_blocking: true,
    }],
  };
}

function runSpecFixture(): RunSpec {
  return {
    schema_version: "run-spec-v1",
    id: "runspec-00000000-0000-4000-8000-000000000001",
    status: "confirmed",
    profile: "generic",
    source_text: "Keep working on the durable runtime migration until it is complete.",
    objective: "Complete the durable personal-agent runtime migration.",
    workspace: {
      path: "/repo",
      source: "user",
      confidence: "high",
    },
    execution_target: {
      kind: "daemon",
      remote_host: null,
      confidence: "high",
    },
    metric: null,
    progress_contract: {
      kind: "deadline_only",
      dimension: null,
      threshold: null,
      semantics: "Finish the requested runtime migration.",
      confidence: "high",
    },
    deadline: null,
    budget: {
      max_trials: null,
      max_wall_clock_minutes: null,
      resident_policy: "best_effort",
    },
    approval_policy: {
      submit: "approval_required",
      publish: "approval_required",
      secret: "unspecified",
      external_action: "approval_required",
      irreversible_action: "approval_required",
    },
    artifact_contract: {
      expected_artifacts: [],
      discovery_globs: [],
      primary_outputs: [],
    },
    risk_flags: [],
    missing_fields: [],
    confidence: "high",
    links: {
      goal_id: null,
      runtime_session_id: null,
      conversation_id: "conversation-personal-agent",
    },
    origin: {
      channel: "chat",
      session_id: "conversation-personal-agent",
      reply_target: null,
      metadata: {},
    },
    created_at: NOW,
    updated_at: NOW,
  };
}

function mockAdapter(): IAdapter {
  return {
    adapterType: "mock-adapter",
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: "done",
      error: null,
      exit_code: 0,
      elapsed_ms: 1,
      stopped_reason: "completed",
    }),
  } as unknown as IAdapter;
}

function sessionManager() {
  return {
    createSession: vi.fn().mockResolvedValue({ id: "session-task-1" }),
    buildTaskExecutionContext: vi.fn().mockReturnValue([]),
    endSession: vi.fn().mockResolvedValue(undefined),
  } as never;
}

function goalTriggerEntry(overrides: Partial<ScheduleEntryInput> = {}): Omit<
  ScheduleEntryInput,
  "id" | "created_at" | "updated_at" | "last_fired_at" | "next_fire_at" |
  "consecutive_failures" | "last_escalation_at" | "baseline_results" |
  "total_executions" | "total_tokens_used" | "max_tokens_per_day" | "tokens_used_today" | "budget_reset_at"
> {
  return {
    name: "wait-resume-test",
    layer: "goal_trigger",
    trigger: { type: "interval", seconds: 3600, jitter_factor: 0 },
    enabled: true,
    goal_trigger: {
      goal_id: "goal-personal-agent",
      max_iterations: 1,
      skip_if_active: false,
    },
    ...overrides,
  };
}

function scheduleCronEntry(overrides: Partial<ScheduleEntryCreationInput> = {}): ScheduleEntryCreationInput {
  return {
    name: "personal-agent-cron",
    layer: "cron",
    trigger: { type: "interval", seconds: 3600, jitter_factor: 0 },
    enabled: true,
    cron: {
      prompt_template: "Summarize {{cron-source}}",
      context_sources: ["cron-source"],
      output_format: "notification",
      max_tokens: 100,
    },
    ...overrides,
  };
}

function scheduleProbeEntry(overrides: Partial<ScheduleEntryCreationInput> = {}): ScheduleEntryCreationInput {
  return {
    name: "personal-agent-probe",
    layer: "probe",
    trigger: { type: "interval", seconds: 3600, jitter_factor: 0 },
    enabled: true,
    probe: {
      data_source_id: "probe-source",
      query_params: {},
      change_detector: { mode: "presence", baseline_window: 5 },
      llm_on_change: true,
    },
    ...overrides,
  };
}

function dataSourceAdapter(
  sourceId: string,
  query: (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
): IDataSourceAdapter {
  return {
    sourceId,
    sourceType: "file",
    config: {
      id: sourceId,
      name: sourceId,
      type: "file",
      connection: {},
      polling: { interval_ms: 60_000 },
      enabled: true,
      created_at: NOW,
    },
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
    query: vi.fn(query),
  } as unknown as IDataSourceAdapter;
}

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-personal-agent",
    goal_id: "goal-personal-agent",
    strategy_id: "strategy-1",
    target_dimensions: ["claim_truth"],
    primary_dimension: "claim_truth",
    work_description: "Recover interrupted task",
    rationale: "Prove restart recovery is durable.",
    approach: "Mark stale running task terminal.",
    success_criteria: [{
      description: "Recovered",
      verification_method: "state",
      is_blocking: true,
    }],
    scope_boundary: {
      in_scope: ["runtime state"],
      out_of_scope: ["external systems"],
      blast_radius: "local",
    },
    constraints: [],
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    consecutive_failure_count: 0,
    created_at: NOW,
    ...overrides,
  };
}

function logger() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function recordedTrace(spy: ReturnType<typeof vi.fn>): PersonalAgentDecisionTrace {
  return spy.mock.calls[0]![0] as PersonalAgentDecisionTrace;
}

function stableTestJson(value: unknown): string {
  return JSON.stringify(normalizeForStableTestJson(value));
}

function normalizeForStableTestJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeForStableTestJson(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalizeForStableTestJson(record[key])]),
    );
  }
  return value;
}
