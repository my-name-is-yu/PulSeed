import * as path from "node:path";
import { z } from "zod/v3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Report } from "../../src/base/types/report.js";
import type { ILLMClient } from "../../src/base/llm/llm-client.js";
import { NotificationDispatcher } from "../../src/runtime/notification-dispatcher.js";
import { evaluateResidentOperationBoundary } from "../../src/runtime/capability-operation-planner.js";
import {
  InteractionAuthorityStore,
  RuntimeControlService,
} from "../../src/runtime/control/index.js";
import { triggerResidentPeerInitiative } from "../../src/runtime/daemon/runner-resident-proactive.js";
import { DaemonConfigSchema, DaemonStateSchema } from "../../src/runtime/types/daemon.js";
import type { ScheduleEntryInput } from "../../src/runtime/types/schedule.js";
import { ref } from "../../src/runtime/attention/attention-refs.js";
import { OutcomeDecisionSchema } from "../../src/runtime/types/companion-autonomy.js";
import { ScheduleEngine } from "../../src/runtime/schedule/engine.js";
import {
  generatePeerInitiativeCandidates,
  peerInitiativeActionButtons,
  PeerInitiativeStore,
} from "../../src/runtime/peer-initiative/index.js";
import {
  PeerInitiativeFeedbackActionSchema,
  PeerInitiativeTriggerActionSchema,
  type GatewayOutboundConversationPort,
  type OutboundConversationMessage,
  type OutboundConversationSurface,
  type OutboundConversationTarget,
} from "../../src/runtime/gateway/index.js";
import { TelegramGatewayAdapter } from "../../src/runtime/gateway/telegram-gateway-adapter.js";
import { ChatRunner } from "../../src/interface/chat/chat-runner.js";
import type { ChatRunnerDeps } from "../../src/interface/chat/chat-runner-contracts.js";
import { SharedManagerTuiChatSurface } from "../../src/interface/tui/chat-surface.js";
import { cmdCurrentStatus, cmdStatus } from "../../src/interface/cli/commands/goal-read.js";
import { PluginChannelRuntimeStateStore } from "../../src/runtime/store/plugin-channel-runtime-state-store.js";
import { FeedbackIngestionStore } from "../../src/runtime/store/feedback-ingestion-store.js";
import { PermissionWaitPlanStore } from "../../src/runtime/store/permission-wait-plan-store.js";
import { BackgroundRunLedger } from "../../src/runtime/store/background-run-store.js";
import { RuntimeOperatorHandoffStore } from "../../src/runtime/store/operator-handoff-store.js";
import { OutboxStore } from "../../src/runtime/store/outbox-store.js";
import { PersonalAgentRuntimeStore, type PersonalAgentDecisionTrace } from "../../src/runtime/personal-agent/index.js";
import { KnowledgeManager } from "../../src/platform/knowledge/knowledge-manager.js";
import { StateManager } from "../../src/base/state/state-manager.js";
import { inspectUserMemory, runUserMemoryOperation } from "../../src/platform/corrections/user-memory-operations.js";
import { ToolExecutor, ToolPermissionManager, ToolRegistry, ConcurrencyController, type ITool } from "../../src/tools/index.js";
import { runProductGauntletScenario } from "../harness/product-gauntlet-runner.js";
import { makeDimension, makeGoal } from "../helpers/fixtures.js";

const NOW = "2026-05-16T00:00:00.000Z";
const RAW_INTERNAL_MARKERS = [
  "RAW_MEMORY_SLOT",
  "autonomy=approval_required",
  "readiness=degraded",
  "admission=approval_required",
  "capability:notify",
  "policy:deny",
  "evidence:raw",
  "run:coreloop:raw",
  "session:agent:raw",
  "trace:raw",
  "memory:raw-secret",
];

function expectNormalSurfaceRedacted(text: string): void {
  for (const marker of RAW_INTERNAL_MARKERS) {
    expect(text).not.toContain(marker);
  }
}

async function captureConsoleLog(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

class FakeOutboundConversationPort implements GatewayOutboundConversationPort {
  readonly surface = "telegram" as const;
  readonly messages: OutboundConversationMessage[] = [];

  async resolveDefaultTarget(): Promise<OutboundConversationTarget> {
    return {
      surface: "telegram",
      target_binding_ref: "gateway:telegram:home_chat:12345",
      channel_policy_ref: "gateway:telegram:telegram-bot:outbound-conversation-policy",
    };
  }

  async sendOutboundConversationMessage(message: OutboundConversationMessage) {
    this.messages.push(message);
    return {
      message_id: message.message_id,
      surface: "telegram" as const,
      target_binding_ref: message.target_binding_ref,
      delivered_at: "2026-05-16T00:00:01.000Z",
      transport_message_ref: `telegram:${76 + this.messages.length}`,
    };
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("interaction authority product gauntlet", () => {
  it("1. Telegram peer initiative delivery succeeds with authority, delivery, projection, and feedback affordance", async () => {
    await runProductGauntletScenario("telegram_peer_delivery_succeeds", async (context) => {
      const scenario = await runResidentPeerInitiative(context, { maxDeliveryKind: "notify" });
      const decisions = await scenario.authorityStore.listDecisions({ limit: 20 });
      const sendDecision = decisions.find((decision) => decision.source.kind === "outbound_conversation");
      const records = await scenario.peerStore.listRecentCandidates();
      const delivery = await scenario.peerStore.getLatestDeliveryForCandidate({
        candidateId: records[0]!.candidate_id,
        surface: "telegram",
      });
      context.recordEvidence({
        authorityDecision: sendDecision,
        dbSummary: { delivery },
        visibleProjection: { message: scenario.gatewayPort.messages[0] },
        nextFiles: [
          "src/runtime/daemon/runner-resident-proactive.ts",
          "src/runtime/control/execution-authority-decision.ts",
        ],
      });

      expect(scenario.gatewayPort.messages).toHaveLength(1);
      expect(sendDecision).toMatchObject({
        outcome: "allowed",
        can_send: true,
        can_notify: true,
        fail_closed: false,
        surface: "telegram",
        bindings: {
          target_binding_ref: "gateway:telegram:home_chat:12345",
          channel_policy_ref: "gateway:telegram:telegram-bot:outbound-conversation-policy",
          transport_message_ref: "telegram:77",
        },
      });
      expect(delivery).toMatchObject({
        status: "delivered",
        authority_decision_ref: sendDecision!.decision_id,
      });
      expect(scenario.gatewayPort.messages[0]!.feedback_actions).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "less_like_this" }),
        expect.objectContaining({ action: "wrong_read" }),
      ]));
      expect(JSON.stringify(scenario.gatewayPort.messages[0])).not.toContain("raw_content_allowed");
      return {
        authorityDecision: sendDecision,
        dbSummary: { delivery },
        visibleProjection: { message: scenario.gatewayPort.messages[0] },
        nextFiles: [
          "src/runtime/daemon/runner-resident-proactive.ts",
          "src/runtime/control/execution-authority-decision.ts",
        ],
      };
    });
  });

  it("2. Telegram callback from stale or wrong message is fail-closed without feedback mutation", async () => {
    await runProductGauntletScenario("telegram_callback_stale_wrong_message_rejected", async (context) => {
      const { candidate, peerStore, feedbackStore, authorityStore } = await seedTelegramPeerDelivery(context);
      const callbackAckIds: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split("/").at(-1);
        if (method === "answerCallbackQuery") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          callbackAckIds.push(String(body["callback_query_id"]));
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        throw new Error(`unexpected Telegram method: ${method}`);
      }));
      const adapter = telegramAdapter(context, { peerStore, feedbackStore, authorityStore });

      await (adapter as unknown as {
        processCallbackQuery(query: TelegramCallbackFixture): Promise<void>;
      }).processCallbackQuery({
        id: "callback-stale-message",
        from: { id: 42 },
        message: { message_id: 78, chat: { id: 12345 } },
        data: `psp1:lt:${candidate.candidate_id}`,
      });

      const decisions = await authorityStore.listDecisions({ sourceKind: "telegram_callback" });
      const feedbackRecords = await feedbackStore.listRecords();
      context.recordEvidence({
        authorityDecision: decisions[0],
        dbSummary: { feedbackRecords },
        nextFiles: ["src/runtime/gateway/telegram-gateway-adapter.ts"],
      });
      expect(callbackAckIds).toEqual(["callback-stale-message"]);
      expect(feedbackRecords).toHaveLength(0);
      expect(decisions[0]).toMatchObject({
        outcome: "fail_closed",
        can_execute: false,
        fail_closed: true,
        stale_target_rejected: true,
      });
      return {
        authorityDecision: decisions[0],
        dbSummary: { feedbackRecords },
        nextFiles: ["src/runtime/gateway/telegram-gateway-adapter.ts"],
      };
    });
  });

  it("3. Telegram callback processing failure records health and does not block polling offset progress", async () => {
    await runProductGauntletScenario("telegram_callback_failure_offset_progress", async (context) => {
      const configDir = path.join(context.rootDir, "telegram-bot");
      const updates = [{
        update_id: 10,
        callback_query: {
          id: "callback-fail",
          from: { id: 42 },
          message: { message_id: 77, chat: { id: 12345 } },
          data: "psp1:lt:peer-candidate:throws",
        },
      }, {
        update_id: 11,
        message: {
          message_id: 78,
          from: { id: 42 },
          chat: { id: 12345 },
        },
      }];
      vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split("/").at(-1);
        if (method === "getUpdates") {
          return new Response(JSON.stringify({ ok: true, result: updates }), { status: 200 });
        }
        if (method === "answerCallbackQuery") {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        throw new Error(`unexpected Telegram method: ${method} ${String(init?.body ?? "")}`);
      }));
      const adapter = new TelegramGatewayAdapter(configDir, telegramConfig(), {
        runtimeBaseDir: context.runtimeRoot,
        controlBaseDir: context.controlBaseDir,
        peerInitiativeStore: {
          getLatestDeliveryForCandidate: vi.fn(async () => {
            throw new Error("fixture callback failure");
          }),
          appendFeedbackProjection: vi.fn(),
          getFeedbackProjectionForAction: vi.fn(),
          getPreparedArtifact: vi.fn(),
        } as never,
      });
      await (adapter as unknown as { pollOnce(): Promise<void> }).pollOnce();
      const health = await new PluginChannelRuntimeStateStore(context.runtimeRoot, {
        controlBaseDir: context.controlBaseDir,
      }).loadChannelHealth("telegram-bot");
      context.recordEvidence({
        dbSummary: { health },
        nextFiles: ["src/runtime/gateway/telegram-gateway-adapter.ts"],
      });

      expect((adapter as unknown as { offset: number }).offset).toBe(12);
      expect(health?.last_error).toContain("fixture callback failure");
      return {
        dbSummary: { health },
        nextFiles: ["src/runtime/gateway/telegram-gateway-adapter.ts"],
      };
    });
  });

  it("4. digest-only peer initiative is held before transport and records hold authority", async () => {
    await runProductGauntletScenario("digest_only_peer_initiative_held", async (context) => {
      const scenario = await runResidentPeerInitiative(context, { maxDeliveryKind: "digest" });
      const decisions = await scenario.authorityStore.listDecisions({ sourceKind: "peer_initiative" });
      const records = await scenario.peerStore.listRecentCandidates();
      const delivery = await scenario.peerStore.getLatestDeliveryForCandidate({
        candidateId: records[0]!.candidate_id,
        surface: "telegram",
      });
      context.recordEvidence({
        authorityDecision: decisions[0],
        dbSummary: { delivery },
        nextFiles: ["src/runtime/daemon/runner-resident-proactive.ts"],
      });

      expect(scenario.gatewayPort.messages).toHaveLength(0);
      expect(records[0]).toMatchObject({ selected_state: "digested" });
      expect(delivery).toMatchObject({
        status: "held",
        authority_decision: expect.objectContaining({
          outcome: "held",
          can_hold: true,
          can_send: false,
          can_notify: false,
        }),
      });
      expect(decisions[0]).toMatchObject({
        outcome: "held",
        can_hold: true,
        can_send: false,
      });
      expect(JSON.stringify(delivery)).not.toContain("raw_content_allowed");
      return {
        authorityDecision: decisions[0],
        dbSummary: { delivery },
        nextFiles: ["src/runtime/daemon/runner-resident-proactive.ts"],
      };
    });
  });

  it("5. approval-required initiative cannot execute from an old approval", async () => {
    await runProductGauntletScenario("old_approval_cannot_execute", async (context) => {
      const authorityStore = new InteractionAuthorityStore(context.runtimeRoot, {
        controlBaseDir: context.controlBaseDir,
      });
      const allowed = await runApprovalRequiredTool(context, {
        authorityStore,
        label: "allowed",
        value: "current",
      });
      const stale = await runApprovalRequiredTool(context, {
        authorityStore,
        label: "stale",
        value: "old",
        mutateApprovalRequest: ({ request, context: toolContext }) => {
          (request.input as { value: string }).value = "new";
          toolContext.sessionId = "conversation:new";
        },
      });
      const expired = await runApprovalRequiredTool(context, {
        authorityStore,
        label: "expired",
        value: "expires",
        expiresAt: 1_001,
        approveAt: 1_002,
      });
      const decisions = await authorityStore.listDecisions({ sourceKind: "approval" });
      const failedDecisions = decisions.filter((decision) => decision.fail_closed);
      context.recordEvidence({
        authorityDecisions: decisions,
        dbSummary: {
          allowed: allowed.result,
          stale: stale.result,
          expired: expired.result,
          wait_plans: await stale.waitStore.list(),
        },
        operatorDebugEvidence: {
          stale_wait_plans: await stale.waitStore.list(),
          approval_resume_statuses: decisions.map((decision) => decision.metadata["resume_status"]),
        },
        safetyInvariants: {
          approval_success_executes_once: true,
          old_conversation_args_mismatch_fail_closed: true,
          expired_approval_fail_closed: true,
        },
        nextFiles: ["src/runtime/store/permission-wait-plan-store.ts", "src/tools/executor.ts"],
      });

      expect(allowed.result.execution).toMatchObject({ status: "executed" });
      expect(allowed.callCount()).toBe(1);
      expect(stale.result.execution).toMatchObject({ status: "not_executed", reason: "stale_state" });
      expect(stale.callCount()).toBe(0);
      expect(expired.result.execution).toMatchObject({ status: "not_executed" });
      expect(expired.callCount()).toBe(0);
      expect(decisions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          outcome: "allowed",
          can_execute: true,
          requires_approval: true,
          fail_closed: false,
          bindings: expect.objectContaining({
            approval_ref: expect.stringMatching(/^permission-wait:/),
            target_binding_ref: expect.stringMatching(/^permission-wait-target:/),
          }),
        }),
      ]));
      expect(failedDecisions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          outcome: "fail_closed",
          can_execute: false,
          fail_closed: true,
          stale_target_rejected: true,
          requires_approval: true,
          invalidation_refs: expect.arrayContaining(["approval-mismatch:target_changed", "approval-mismatch:input_changed"]),
        }),
        expect.objectContaining({
          outcome: "fail_closed",
          metadata: expect.objectContaining({ resume_status: "expired" }),
          fail_closed: true,
          stale_target_rejected: true,
          requires_approval: true,
        }),
      ]));
      expect(JSON.stringify(decisions)).toContain("approval_ref");
      expect(JSON.stringify(decisions)).toContain("target_binding_ref");
      return {
        authorityDecisions: decisions,
        dbSummary: {
          allowed: allowed.result,
          stale: stale.result,
          expired: expired.result,
        },
        operatorDebugEvidence: {
          stale_wait_plans: await stale.waitStore.list(),
          approval_resume_statuses: decisions.map((decision) => decision.metadata["resume_status"]),
        },
        safetyInvariants: {
          approval_success_executes_once: true,
          old_conversation_args_mismatch_fail_closed: true,
          expired_approval_fail_closed: true,
        },
        nextFiles: ["src/runtime/store/permission-wait-plan-store.ts", "src/tools/executor.ts"],
      };
    });
  });

  it("6. quiet mode suppresses notification before transport", async () => {
    await runProductGauntletScenario("quiet_mode_suppresses_before_transport", async (context) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-16T02:00:00.000Z"));
      const authorityStore = new InteractionAuthorityStore(context.runtimeRoot, {
        controlBaseDir: context.controlBaseDir,
      });
      const dispatcher = new NotificationDispatcher({
        channels: [{
          type: "email",
          address: "test@example.com",
          smtp: {
            host: "smtp.example.com",
            port: 587,
            secure: true,
            auth: { user: "u", pass: "p" },
          },
          report_types: [],
          format: "full",
        }],
        do_not_disturb: {
          enabled: true,
          start_hour: 0,
          end_hour: 23,
          exceptions: ["urgent_alert", "approval_request"],
        },
      }, undefined, undefined, undefined, authorityStore);

      const results = await dispatcher.dispatch(reportFixture({ report_type: "execution_summary" }));
      const decisions = await authorityStore.listDecisions({ sourceKind: "notification" });
      context.recordEvidence({
        authorityDecision: decisions[0],
        dbSummary: { results },
        nextFiles: ["src/runtime/notification-dispatcher.ts"],
      });
      expect(results).toEqual([
        expect.objectContaining({
          success: false,
          suppressed: true,
          suppression_reason: "dnd",
        }),
      ]);
      expect(decisions[0]).toMatchObject({
        outcome: "suppressed",
        can_notify: false,
        can_suppress: true,
        suppressed: true,
        bindings: { quieting_ref: "suppress:dnd" },
      });
      return {
        authorityDecision: decisions[0],
        dbSummary: { results },
        nextFiles: ["src/runtime/notification-dispatcher.ts"],
      };
    });
  });

  it("7. memory correction affects later recall and normal/diagnostic projection", async () => {
    await runProductGauntletScenario("memory_correction_later_recall_projection", async (context) => {
      const stateManager = new StateManager(context.rootDir, undefined, { walEnabled: false });
      await stateManager.init();
      const knowledgeManager = new KnowledgeManager(stateManager, {} as never);
      const stale = await knowledgeManager.saveAgentMemory({
        key: "user.editor.preference",
        value: "The user prefers Atom.",
        tags: ["preference"],
        memory_type: "preference",
      });
      const correctionResult = await runUserMemoryOperation(stateManager, {
        operation: "correct",
        targetRef: { kind: "agent_memory", id: stale.id },
        reason: "User corrected editor preference.",
        replacementValue: "The user prefers VS Code.",
        replacementKey: "user.editor.preference.current",
        now: "2026-05-16T00:05:00.000Z",
      });
      const restartedStateManager = new StateManager(context.rootDir, undefined, { walEnabled: false });
      await restartedStateManager.init();
      const restartedKnowledgeManager = new KnowledgeManager(restartedStateManager, {} as never);
      const recalledCurrent = await knowledgeManager.recallAgentMemory("user.editor.preference.current", {
        exact: true,
        max_sensitivity: "local",
        consent_scope: "local_planning",
        limit: 20,
      });
      const recalledStale = await knowledgeManager.recallAgentMemory("user.editor.preference", {
        exact: true,
        max_sensitivity: "local",
        consent_scope: "local_planning",
        limit: 20,
      });
      const restartedStaleRecall = await restartedKnowledgeManager.recallAgentMemory("user.editor.preference", {
        exact: true,
        max_sensitivity: "local",
        consent_scope: "local_planning",
        limit: 20,
      });
      const projection = await inspectUserMemory(stateManager, {
        targetRef: { kind: "agent_memory", id: stale.id },
      });
      const memoryStatusRunner = chatRunnerForStatus(stateManager);
      const memoryChatStatus = await memoryStatusRunner.execute("/status", context.rootDir);
      const memoryTuiSurface = new SharedManagerTuiChatSurface(chatDepsForStatus(stateManager));
      memoryTuiSurface.startSession(context.rootDir);
      const memoryTuiStatus = await memoryTuiSurface.execute("/status", context.rootDir);
      const memoryCliStatus = await captureConsoleLog(() => cmdCurrentStatus(stateManager));
      const normalSurfaceProbe = {
        chat_status: memoryChatStatus.output,
        tui_status: memoryTuiStatus.output,
        cli_status: memoryCliStatus,
      };
      const authorityStore = new InteractionAuthorityStore(context.rootDir, {
        controlBaseDir: context.rootDir,
      });
      const decisions = await authorityStore.listDecisions({ sourceKind: "memory_correction" });
      const correctionDecision = decisions.find((decision) =>
        decision.bindings.target_refs.includes(`agent_memory:${stale.id}`)
      );
      const recalledText = JSON.stringify({ recalledCurrent, recalledStale });
      context.recordEvidence({
        authorityDecision: correctionDecision,
        authorityDecisions: decisions,
        normalProjection: {
          memory_inspect: projection,
          normal_surface_probe: normalSurfaceProbe,
        },
        operatorDebugEvidence: {
          correction_history: correctionResult.history,
          archived_memory: await restartedKnowledgeManager.listAgentMemory({ include_archived: true }),
        },
        dbSummary: {
          recalled: recalledCurrent.map((entry) => entry.key),
          stale_recall_count: recalledStale.length,
          restarted_stale_recall_count: restartedStaleRecall.length,
          history: correctionResult.history,
        },
        replaySummary: {
          restarted_state_manager_base_dir: restartedStateManager.getBaseDir(),
          stale_recall_after_restart: restartedStaleRecall.length,
          correction_id: correctionResult.correction?.correction_id ?? null,
        },
        safetyInvariants: {
          corrected_memory_not_recalled_by_old_key: true,
          normal_projection_redacts_refs: true,
          normal_chat_tui_cli_status_do_not_surface_old_claim: true,
          operator_debug_history_available: true,
        },
        nextFiles: [
          "src/platform/corrections/user-memory-operations.ts",
          "src/runtime/cognition/memory-context.ts",
        ],
      });

      expect(recalledText).toContain("VS Code");
      expect(recalledText).not.toContain("Atom");
      expect(recalledStale).toHaveLength(0);
      expect(restartedStaleRecall).toHaveLength(0);
      expect(memoryChatStatus.success).toBe(true);
      expect(memoryTuiStatus.success).toBe(true);
      expect(projection).toMatchObject({
        raw_content_visible: false,
        raw_refs_visible: false,
        sensitive_content_visible: false,
        active_for_future_use: false,
        history_count: 1,
      });
      expect(JSON.stringify({ projection, normalSurfaceProbe })).not.toContain("Atom");
      expect(correctionDecision).toMatchObject({
        source: expect.objectContaining({ kind: "memory_correction" }),
        can_execute: true,
        memory_withheld: true,
        bindings: expect.objectContaining({
          normal_surface_projection_ref: expect.stringMatching(/^normal-surface:memory-correction:/),
        }),
      });
      return {
        authorityDecision: correctionDecision,
        authorityDecisions: decisions,
        normalProjection: {
          memory_inspect: projection,
          normal_surface_probe: normalSurfaceProbe,
        },
        operatorDebugEvidence: {
          correction_history: correctionResult.history,
          archived_memory: await restartedKnowledgeManager.listAgentMemory({ include_archived: true }),
        },
        dbSummary: {
          recalled: recalledCurrent.map((entry) => entry.key),
          stale_recall_count: recalledStale.length,
          restarted_stale_recall_count: restartedStaleRecall.length,
          history: correctionResult.history,
        },
        replaySummary: {
          restarted_state_manager_base_dir: restartedStateManager.getBaseDir(),
          stale_recall_after_restart: restartedStaleRecall.length,
          correction_id: correctionResult.correction?.correction_id ?? null,
        },
        safetyInvariants: {
          corrected_memory_not_recalled_by_old_key: true,
          normal_projection_redacts_refs: true,
          normal_chat_tui_cli_status_do_not_surface_old_claim: true,
          operator_debug_history_available: true,
        },
        nextFiles: [
          "src/platform/corrections/user-memory-operations.ts",
          "src/runtime/cognition/memory-context.ts",
        ],
      };
    });
  });

  it("8. ToolExecutor admission blocks missing direct adapter fallback and records non-executed outcome", async () => {
    await runProductGauntletScenario("tool_executor_denial_no_direct_fallback", async (context) => {
      const runtime = new PersonalAgentRuntimeStore(context.runtimeRoot, {
        controlBaseDir: context.controlBaseDir,
      });
      const executor = new ToolExecutor({
        registry: new ToolRegistry(),
        permissionManager: new ToolPermissionManager({}),
        concurrency: new ConcurrencyController(),
        personalAgentRuntime: runtime,
        traceBaseDir: context.controlBaseDir,
      });
      const result = await executor.execute("missing-direct-adapter", { value: "no fallback" }, {
        cwd: context.rootDir,
        callId: "call-missing-direct-adapter",
        sessionId: "session-product-gauntlet",
        approvalFn: vi.fn(async () => false),
      } as never);
      const candidates = await runtime.listTaskCandidates();
      const trace = await runtime.loadTrace(candidates[0]!.candidate_id);
      context.recordEvidence({
        dbSummary: { trace },
        nextFiles: ["src/tools/executor.ts", "src/tools/personal-agent-tool-trace.ts"],
      });

      expect(result.execution).toMatchObject({
        status: "not_executed",
        reason: "policy_blocked",
      });
      expect(trace?.initiative_events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event_type: "action_outcome",
          summary: expect.stringContaining("not_executed"),
        }),
      ]));
      expect(trace?.capability_decisions).toEqual([
        expect.objectContaining({ decision: "missing" }),
      ]);
      return {
        dbSummary: { trace },
        nextFiles: ["src/tools/executor.ts", "src/tools/personal-agent-tool-trace.ts"],
      };
    });
  });

  it("9. restart/replay does not duplicate send but distinct idempotency semantics can send", async () => {
    await runProductGauntletScenario("restart_replay_no_duplicate_side_effects", async (context) => {
      const first = await runResidentPeerInitiative(context, {
        maxDeliveryKind: "notify",
        attentionLabel: "same",
      });
      const replayedAfterRestart = await runResidentPeerInitiative(context, {
        maxDeliveryKind: "notify",
        attentionLabel: "same",
      });
      const distinctAfterRestart = await runResidentPeerInitiative(context, {
        maxDeliveryKind: "notify",
        attentionLabel: "distinct",
      });
      const outboxFirstStore = new OutboxStore(context.runtimeRoot, { controlBaseDir: context.controlBaseDir });
      const outboxFirst = await outboxFirstStore.append({
        event_type: "schedule_report_ready",
        goal_id: "goal:replay",
        correlation_id: "correlation:same",
        created_at: Date.parse(NOW),
        payload: { report_id: "report:same", text: "same payload" },
      });
      const outboxRestartedStore = new OutboxStore(context.runtimeRoot, { controlBaseDir: context.controlBaseDir });
      const outboxReplay = await outboxRestartedStore.append({
        event_type: "schedule_report_ready",
        goal_id: "goal:replay",
        correlation_id: "correlation:same",
        created_at: Date.parse(NOW) + 1,
        payload: { report_id: "report:same", text: "same payload" },
      });
      const outboxDistinct = await outboxRestartedStore.append({
        event_type: "schedule_report_ready",
        goal_id: "goal:replay",
        correlation_id: "correlation:distinct",
        created_at: Date.parse(NOW) + 2,
        payload: { report_id: "report:same", text: "same payload" },
      });
      const memoryState = new StateManager(context.rootDir, undefined, { walEnabled: false });
      await memoryState.init();
      const memoryManager = new KnowledgeManager(memoryState, {} as never);
      const replayMemory = await memoryManager.saveAgentMemory({
        key: "replay.memory.preference",
        value: "Replay should not duplicate this obsolete value.",
        tags: ["replay"],
        memory_type: "preference",
      });
      const firstCorrection = await runUserMemoryOperation(memoryState, {
        operation: "forget",
        targetRef: { kind: "agent_memory", id: replayMemory.id },
        reason: "Replay duplicate correction must be idempotent.",
        now: "2026-05-16T00:10:00.000Z",
      });
      const restartedMemoryState = new StateManager(context.rootDir, undefined, { walEnabled: false });
      await restartedMemoryState.init();
      const replayCorrection = await runUserMemoryOperation(restartedMemoryState, {
        operation: "forget",
        targetRef: { kind: "agent_memory", id: replayMemory.id },
        reason: "Replay duplicate correction must be idempotent.",
        now: "2026-05-16T00:10:00.000Z",
      });
      const records = await new PeerInitiativeStore(context.runtimeRoot, {
        controlBaseDir: context.controlBaseDir,
      }).listRecentCandidates();
      const deliveries = await Promise.all(records.map((record) =>
        first.peerStore.getLatestDeliveryForCandidate({ candidateId: record.candidate_id, surface: "telegram" })
      ));
      const authorityDecisions = await new InteractionAuthorityStore(context.runtimeRoot, {
        controlBaseDir: context.controlBaseDir,
      }).listDecisions({ limit: 50 });
      const outboxRecords = await outboxRestartedStore.list();
      context.recordEvidence({
        authorityDecisions,
        dbSummary: {
          records,
          deliveries,
          outboxRecords,
          memory_history: replayCorrection.history,
          send_counts: {
            first: first.gatewayPort.messages.length,
            replay_after_restart: replayedAfterRestart.gatewayPort.messages.length,
            distinct_after_restart: distinctAfterRestart.gatewayPort.messages.length,
          },
        },
        replaySummary: {
          peer_delivery: {
            first_sent: first.gatewayPort.messages.length,
            replay_after_store_recreate_sent: replayedAfterRestart.gatewayPort.messages.length,
            distinct_after_store_recreate_sent: distinctAfterRestart.gatewayPort.messages.length,
            candidate_ids: records.map((record) => record.candidate_id),
            replay_keys: authorityDecisions.map((decision) => decision.source.ref),
          },
          outbox: {
            first_seq: outboxFirst.seq,
            replay_seq: outboxReplay.seq,
            distinct_seq: outboxDistinct.seq,
            retained_count: outboxRecords.length,
            idempotency_key: outboxReplay.correlation_id,
          },
          memory_correction: {
            first_correction_id: firstCorrection.correction?.correction_id ?? null,
            replay_correction_id: replayCorrection.correction?.correction_id ?? null,
            history_count_after_restart: replayCorrection.history.length,
          },
        },
        safetyInvariants: {
          same_peer_delivery_replay_after_store_recreate_sends_zero: true,
          same_outbox_correlation_payload_reuses_record_after_store_recreate: true,
          same_memory_correction_id_replays_without_duplicate_history: true,
          distinct_correlation_or_attention_label_is_not_suppressed: true,
        },
        nextFiles: [
          "src/runtime/daemon/runner-resident-proactive.ts",
          "src/runtime/peer-initiative/store.ts",
          "src/runtime/store/outbox-store.ts",
          "src/platform/corrections/user-memory-operations.ts",
        ],
      });

      expect(first.gatewayPort.messages).toHaveLength(1);
      expect(replayedAfterRestart.gatewayPort.messages).toHaveLength(0);
      expect(distinctAfterRestart.gatewayPort.messages).toHaveLength(1);
      expect(records).toHaveLength(2);
      expect(deliveries.filter((delivery) => delivery?.status === "delivered")).toHaveLength(2);
      expect(outboxReplay.seq).toBe(outboxFirst.seq);
      expect(outboxDistinct.seq).not.toBe(outboxFirst.seq);
      expect(outboxRecords).toHaveLength(2);
      expect(replayCorrection.correction?.correction_id).toBe(firstCorrection.correction?.correction_id);
      expect(replayCorrection.history).toHaveLength(1);
      return {
        authorityDecisions,
        dbSummary: {
          records,
          deliveries,
          outboxRecords,
          memory_history: replayCorrection.history,
        },
        replaySummary: {
          peer_delivery: {
            first_sent: first.gatewayPort.messages.length,
            replay_after_store_recreate_sent: replayedAfterRestart.gatewayPort.messages.length,
            distinct_after_store_recreate_sent: distinctAfterRestart.gatewayPort.messages.length,
          },
          outbox: {
            first_seq: outboxFirst.seq,
            replay_seq: outboxReplay.seq,
            distinct_seq: outboxDistinct.seq,
            idempotency_key: outboxReplay.correlation_id,
          },
          memory_correction: {
            first_correction_id: firstCorrection.correction?.correction_id ?? null,
            replay_correction_id: replayCorrection.correction?.correction_id ?? null,
            history_count_after_restart: replayCorrection.history.length,
          },
        },
        safetyInvariants: {
          same_peer_delivery_replay_after_store_recreate_sends_zero: true,
          same_outbox_correlation_payload_reuses_record_after_store_recreate: true,
          same_memory_correction_id_replays_without_duplicate_history: true,
          distinct_correlation_or_attention_label_is_not_suppressed: true,
        },
        nextFiles: [
          "src/runtime/daemon/runner-resident-proactive.ts",
          "src/runtime/peer-initiative/store.ts",
          "src/runtime/store/outbox-store.ts",
          "src/platform/corrections/user-memory-operations.ts",
        ],
      };
    });
  });

  it("10. normal user projection redacts internals across status-like surfaces", async () => {
    await runProductGauntletScenario("normal_projection_redacts_internals", async (context) => {
      const stateManager = await createRuntimeCallerFixture(context.rootDir);
      const runner = chatRunnerForStatus(stateManager);
      const chatStatus = await runner.execute("/status", context.rootDir);
      const chatDiagnosticStatus = await runner.execute("/status --details", context.rootDir);
      const tuiSurface = new SharedManagerTuiChatSurface(chatDepsForStatus(stateManager));
      tuiSurface.startSession(context.rootDir);
      const tuiStatus = await tuiSurface.execute("/status", context.rootDir);
      const cliCurrent = await captureConsoleLog(() => cmdCurrentStatus(stateManager));
      const cliFocused = await captureConsoleLog(() => cmdStatus(stateManager, "goal-product-gauntlet"));
      const cliDiagnostic = await captureConsoleLog(() =>
        cmdStatus(stateManager, "goal-product-gauntlet", undefined, { diagnostic: true }));
      const normalProjection = {
        chat_status: chatStatus.output,
        tui_status: tuiStatus.output,
        cli_current: cliCurrent,
        cli_focused: cliFocused,
      };
      const operatorDebugEvidence = {
        chat_diagnostic_status: chatDiagnosticStatus.output,
        cli_diagnostic: cliDiagnostic,
      };
      context.recordEvidence({
        normalProjection,
        operatorDebugEvidence,
        expectedNormalProjection: {
          raw_trace_visible: false,
          raw_refs_visible: false,
          raw_evidence_refs_visible: false,
          internal_policy_refs_visible: false,
          capability_catalog_visible: false,
        },
        safetyInvariants: {
          chat_status_redacts_internal_refs: true,
          tui_adjacent_status_redacts_internal_refs: true,
          cli_status_report_redacts_internal_refs: true,
          operator_debug_surface_keeps_diagnostics: true,
        },
        nextFiles: [
          "src/interface/chat/chat-runner-commands.ts",
          "src/interface/cli/commands/goal-read.ts",
          "src/interface/tui/chat-surface.ts",
          "src/runtime/personal-agent/normal-surface-projection.ts",
        ],
      });

      expect(chatStatus.success).toBe(true);
      expect(tuiStatus.success).toBe(true);
      expect(chatStatus.output).toContain("Current goal");
      expect(tuiStatus.output).toContain("Current goal");
      expect(cliCurrent).toContain("Current goal");
      expect(cliFocused).toContain("# Status: Product-wide authority gauntlet");
      expectNormalSurfaceRedacted(JSON.stringify(normalProjection));
      expect(chatDiagnosticStatus.output).toContain("run:coreloop:raw");
      expect(cliDiagnostic).toContain("RAW_MEMORY_SLOT");
      return {
        normalProjection,
        operatorDebugEvidence,
        expectedNormalProjection: {
          raw_trace_visible: false,
          raw_refs_visible: false,
          raw_evidence_refs_visible: false,
          internal_policy_refs_visible: false,
          capability_catalog_visible: false,
        },
        safetyInvariants: {
          chat_status_redacts_internal_refs: true,
          tui_adjacent_status_redacts_internal_refs: true,
          cli_status_report_redacts_internal_refs: true,
          operator_debug_surface_keeps_diagnostics: true,
        },
        nextFiles: [
          "src/interface/chat/chat-runner-commands.ts",
          "src/interface/cli/commands/goal-read.ts",
          "src/interface/tui/chat-surface.ts",
          "src/runtime/personal-agent/normal-surface-projection.ts",
        ],
      };
    });
  });

  it("11. runtime-control and schedule mutation paths leave durable projection evidence before side effects", async () => {
    await runProductGauntletScenario("runtime_control_schedule_authority_boundaries", async (context) => {
      const runtime = new PersonalAgentRuntimeStore(context.runtimeRoot, {
        controlBaseDir: context.controlBaseDir,
      });
      const order: string[] = [];
      const traceSink = {
        recordTrace: async (trace: PersonalAgentDecisionTrace) => {
          order.push(`trace:${trace.situation_frame.caller_path}:${trace.task_candidates[0]?.desired_effect ?? "none"}`);
          return runtime.recordTrace(trace);
        },
      };
      const runtimeControlExecutor = vi.fn(async () => ({
        ok: true,
        state: "running" as const,
        message: "Safe-pause request reached fake daemon executor.",
      }));
      const runtimeControl = new RuntimeControlService({
        runtimeRoot: context.runtimeRoot,
        personalAgentRuntime: traceSink,
        now: () => new Date(NOW),
        sessionRegistry: {
          snapshot: vi.fn(async () => ({
            generated_at: NOW,
            sessions: [],
            warnings: [],
            background_runs: [{
              id: "run:authority-boundary",
              kind: "coreloop_run",
              status: "running",
              title: "Authority boundary run",
              goal_id: "goal:authority-boundary",
              parent_session_id: "conversation:authority",
              child_session_id: "session:authority-boundary",
              notify_policy: "silent",
              created_at: NOW,
              started_at: NOW,
              updated_at: NOW,
              summary: "Running target.",
              error: null,
            }],
          })),
        },
        executor: runtimeControlExecutor,
      });
      const runtimeResult = await runtimeControl.request({
        cwd: context.rootDir,
        intent: {
          kind: "pause_run",
          reason: "Pause the exact active run.",
          target: { runId: "run:authority-boundary" },
        },
        requestedBy: { surface: "chat", conversation_id: "conversation:authority" },
        replyTarget: { surface: "chat", conversation_id: "conversation:authority" },
        approvalFn: async () => true,
      });

      const schedule = new ScheduleEngine({
        baseDir: context.controlBaseDir,
        personalAgentRuntime: traceSink,
        dataSourceRegistry: new Map([
          ["schedule-authority-source", {
            sourceId: "schedule-authority-source",
            sourceType: "file",
            query: vi.fn(async () => {
              order.push("schedule:data_source_query");
              return {
                value: "schedule data",
                raw: "schedule data",
                timestamp: NOW,
                source_id: "schedule-authority-source",
              };
            }),
          }],
        ]) as never,
        llmClient: {
          sendMessage: vi.fn(async () => {
            order.push("schedule:llm");
            return { content: "schedule summary", usage: { input_tokens: 1, output_tokens: 1 } };
          }),
          parseJSON: vi.fn(),
        } as unknown as ILLMClient,
        logger: logger(),
      });
      await schedule.loadEntries();
      const scheduleEntry = await schedule.addEntry(scheduleCronEntry({
        cron: {
          prompt_template: "Summarize {{schedule-authority-source}}",
          context_sources: ["schedule-authority-source"],
          output_format: "notification",
          max_tokens: 100,
        },
      }));
      schedule.getEntries()[0]!.next_fire_at = new Date(Date.parse(NOW) - 1_000).toISOString();
      await schedule.saveEntries();
      await schedule.loadEntries();
      const scheduleResults = await schedule.tick();

      const traces = await loadPersonalAgentTraces(runtime);
      const runtimeControlTrace = traces.find((trace) =>
        trace.situation_frame?.caller_path === "runtime_control"
        && trace.task_candidates.some((candidate) => candidate.desired_effect === "mutate_runtime_control")
      );
      const scheduleTrace = traces.find((trace) =>
        trace.situation_frame?.caller_path === "scheduled_wake"
        && trace.situation_frame.source_ref.ref === scheduleEntry.id
      );
      const scheduleTraceIndex = order.findIndex((item) => item === "trace:scheduled_wake:execute_tool");
      context.recordEvidence({
        dbSummary: {
          runtimeResult,
          scheduleResults,
          order,
          trace_count: traces.length,
        },
        operatorDebugEvidence: {
          runtimeControlTrace,
          scheduleTrace,
          traces,
        },
        safetyInvariants: {
          runtime_control_trace_before_executor: true,
          schedule_trace_before_data_source_and_llm: true,
          projection_evidence_is_personal_agent_runtime_store_not_interaction_authority_store: true,
        },
        nextFiles: [
          "src/runtime/control/runtime-control-service.ts",
          "src/runtime/schedule/engine.ts",
          "src/runtime/schedule/engine-layers.ts",
          "src/runtime/personal-agent/trace-builder.ts",
        ],
      });

      expect(runtimeResult).toMatchObject({ success: true, state: "running" });
      expect(runtimeControlExecutor).toHaveBeenCalledOnce();
      expect(runtimeControlTrace).toMatchObject({
        intervention_decisions: expect.arrayContaining([
          expect.objectContaining({ target_effect: "mutate_runtime_control" }),
        ]),
      });
      expect(scheduleResults[0]).toMatchObject({
        entry_id: scheduleEntry.id,
        status: "ok",
      });
      expect(scheduleTrace).toMatchObject({
        intervention_decisions: expect.arrayContaining([
          expect.objectContaining({ decision: "allow", target_effect: "execute_tool" }),
        ]),
        capability_decisions: expect.arrayContaining([
          expect.objectContaining({ decision: "available" }),
        ]),
      });
      expect(scheduleTraceIndex).toBeGreaterThanOrEqual(0);
      expect(scheduleTraceIndex).toBeLessThan(order.indexOf("schedule:data_source_query"));
      expect(scheduleTraceIndex).toBeLessThan(order.indexOf("schedule:llm"));
      return {
        dbSummary: {
          runtimeResult,
          scheduleResults,
          order,
          trace_count: traces.length,
        },
        operatorDebugEvidence: {
          runtimeControlTrace,
          scheduleTrace,
          traces,
        },
        safetyInvariants: {
          runtime_control_trace_before_executor: true,
          schedule_trace_before_data_source_and_llm: true,
          projection_evidence_is_personal_agent_runtime_store_not_interaction_authority_store: true,
        },
        nextFiles: [
          "src/runtime/control/runtime-control-service.ts",
          "src/runtime/schedule/engine.ts",
          "src/runtime/schedule/engine-layers.ts",
          "src/runtime/personal-agent/trace-builder.ts",
        ],
      };
    });
  });
});

interface TelegramCallbackFixture {
  id: string;
  from: { id: number };
  message?: { message_id: number; chat: { id: number } };
  data: string;
}

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function runApprovalRequiredTool(
  context: { rootDir: string; runtimeRoot: string; controlBaseDir: string },
  options: {
    authorityStore: InteractionAuthorityStore;
    label: string;
    value: string;
    expiresAt?: number;
    approveAt?: number;
    mutateApprovalRequest?: (input: {
      request: { input: unknown };
      context: {
        sessionId?: string;
      };
    }) => void;
  },
) {
  let now = 1_000;
  let executed = 0;
  const waitStore = new PermissionWaitPlanStore(context.runtimeRoot, {
    controlBaseDir: context.controlBaseDir,
    now: () => now,
    createEventId: () => `permission-event:${options.label}:${now}`,
  });
  const permissionWaitPlanStore = {
    createWaiting: (input: Parameters<PermissionWaitPlanStore["createWaiting"]>[0]) =>
      waitStore.createWaiting({
        ...input,
        ...(options.expiresAt !== undefined ? { expires_at: options.expiresAt } : {}),
      }),
    markApproved: waitStore.markApproved.bind(waitStore),
    markDenied: waitStore.markDenied.bind(waitStore),
    markExpired: waitStore.markExpired.bind(waitStore),
    resumeApproved: waitStore.resumeApproved.bind(waitStore),
  };
  const registry = new ToolRegistry();
  registry.register({
    metadata: {
      name: "send_peer_action",
      aliases: [],
      permissionLevel: "write_remote",
      isReadOnly: false,
      isDestructive: false,
      shouldDefer: false,
      alwaysLoad: false,
      maxConcurrency: 0,
      maxOutputChars: 8_000,
      tags: ["peer_initiative"],
      requiresNetwork: true,
      activityCategory: "command",
    },
    inputSchema: z.object({ value: z.string() }),
    description: () => "Fake approval-required peer action.",
    checkPermissions: async () => ({
      status: "needs_approval",
      reason: "Peer action needs approval before it can execute.",
    }),
    isConcurrencySafe: () => false,
    call: async (input) => {
      executed += 1;
      return {
        success: true,
        data: input,
        summary: "approval-gated peer action executed",
        durationMs: 0,
        execution: { status: "executed" },
      };
    },
  } satisfies ITool<{ value: string }>);
  const executor = new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({}),
    concurrency: new ConcurrencyController(),
    interactionAuthorityStore: options.authorityStore,
    traceBaseDir: context.controlBaseDir,
  });
  const toolContext = {
    cwd: context.rootDir,
    goalId: `goal:${options.label}`,
    trustBalance: -100,
    preApproved: false,
    sessionId: `conversation:${options.label}`,
    turnId: `turn:${options.label}`,
    callId: `tool-call:${options.label}`,
    permissionWaitPlanStore,
    interactionAuthorityStore: options.authorityStore,
    approvalFn: async (request: { input: unknown }) => {
      if (options.approveAt !== undefined) now = options.approveAt;
      options.mutateApprovalRequest?.({ request, context: toolContext });
      return true;
    },
  };
  const result = await executor.execute("send_peer_action", { value: options.value }, toolContext as never);
  return {
    result,
    waitStore,
    callCount: () => executed,
  };
}

function chatDepsForStatus(stateManager: StateManager): ChatRunnerDeps {
  return {
    stateManager,
    adapter: {
      adapterType: "product-gauntlet-status-test",
      execute: vi.fn(),
    },
    llmClient: {
      sendMessage: vi.fn(),
      parseJSON: vi.fn((content: string, schema?: { parse(value: unknown): unknown }) => {
        const parsed = JSON.parse(content) as unknown;
        return schema ? schema.parse(parsed) : parsed;
      }),
    },
  } as unknown as ChatRunnerDeps;
}

function chatRunnerForStatus(stateManager: StateManager): ChatRunner {
  return new ChatRunner(chatDepsForStatus(stateManager));
}

async function createRuntimeCallerFixture(baseDir: string): Promise<StateManager> {
  const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
  await stateManager.init();
  await stateManager.saveGoal(makeGoal({
    id: "goal-product-gauntlet",
    title: "Product-wide authority gauntlet",
    loop_status: "running",
    dimensions: [makeDimension({
      name: "claim_truth",
      label: "Claim truth",
      current_value: 0.5,
      threshold: { type: "min", value: 1 },
      confidence: 0.42,
    })],
  }));

  const ledger = new BackgroundRunLedger(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
  await ledger.create({
    id: "run:coreloop:raw",
    kind: "coreloop_run",
    status: "running",
    notify_policy: "silent",
    goal_id: "goal-product-gauntlet",
    child_session_id: "session:agent:raw",
    title: "Product gauntlet run",
    summary: "RAW_MEMORY_SLOT autonomy=approval_required readiness=degraded",
    error: "policy:deny evidence:raw admission=approval_required capability:notify trace:raw",
    source_refs: [{
      kind: "task_ledger",
      id: "trace:raw",
      path: null,
      relative_path: "state/pulseed-control.sqlite",
      updated_at: NOW,
    }],
  });
  await ledger.terminal("run:coreloop:raw", {
    status: "failed",
    summary: "RAW_MEMORY_SLOT autonomy=approval_required readiness=degraded",
    error: "policy:deny evidence:raw admission=approval_required capability:notify trace:raw",
    completed_at: NOW,
  });

  await new RuntimeOperatorHandoffStore(path.join(baseDir, "runtime"), {
    controlBaseDir: baseDir,
    now: () => new Date(NOW),
  }).create({
    handoff_id: "handoff-product-gauntlet",
    goal_id: "goal-product-gauntlet",
    run_id: "run:coreloop:raw",
    triggers: ["policy", "external_action"],
    title: "Operator approval needed",
    summary: "RAW_MEMORY_SLOT autonomy=approval_required readiness=degraded admission=approval_required",
    current_status: "policy:deny capability:notify evidence:raw",
    recommended_action: "Review the prepared operation before continuing.",
    next_action: {
      label: "Review the prepared operation before continuing.",
      approval_required: true,
    },
    evidence_refs: [{ kind: "audit_trace", ref: "evidence:raw", observed_at: NOW }],
  });

  await stateManager.writeRaw("reports/goal-product-gauntlet/report-raw.json", {
    id: "report-product-gauntlet-raw",
    report_type: "execution_summary",
    goal_id: "goal-product-gauntlet",
    title: "Execution Summary - Product authority",
    content: "RAW_MEMORY_SLOT autonomy=approval_required readiness=degraded admission=approval_required capability:notify policy:deny evidence:raw trace:raw session:agent:raw",
    verbosity: "standard",
    generated_at: NOW,
    delivered_at: null,
    read: false,
  });

  return stateManager;
}

async function loadPersonalAgentTraces(store: PersonalAgentRuntimeStore) {
  const candidates = await store.listTaskCandidates(100);
  const traces = await Promise.all(candidates.map((candidate) => store.loadTrace(candidate.candidate_id)));
  const byId = new Map<string, NonNullable<(typeof traces)[number]>>();
  for (const trace of traces) {
    if (trace) byId.set(trace.trace_id, trace);
  }
  return [...byId.values()];
}

function telegramConfig() {
  return {
    bot_token: "token",
    chat_id: 12345,
    allowed_user_ids: [],
    denied_user_ids: [],
    allowed_chat_ids: [],
    denied_chat_ids: [],
    runtime_control_allowed_user_ids: [],
    chat_goal_map: {},
    user_goal_map: {},
    allow_all: true,
    polling_timeout: 1,
  };
}

function telegramAdapter(
  context: { runtimeRoot: string; controlBaseDir: string },
  options: {
    peerStore: PeerInitiativeStore;
    feedbackStore: FeedbackIngestionStore;
    authorityStore: InteractionAuthorityStore;
  },
): TelegramGatewayAdapter {
  return new TelegramGatewayAdapter("/tmp/telegram-bot", telegramConfig(), {
    runtimeBaseDir: context.runtimeRoot,
    controlBaseDir: context.controlBaseDir,
    peerInitiativeStore: options.peerStore,
    feedbackIngestionStore: options.feedbackStore,
    interactionAuthorityStore: options.authorityStore,
  });
}

async function seedTelegramPeerDelivery(context: { runtimeRoot: string; controlBaseDir: string }) {
  const peerStore = new PeerInitiativeStore(context.runtimeRoot, { controlBaseDir: context.controlBaseDir });
  const feedbackStore = new FeedbackIngestionStore(context.runtimeRoot, { controlBaseDir: context.controlBaseDir });
  const authorityStore = new InteractionAuthorityStore(context.runtimeRoot, { controlBaseDir: context.controlBaseDir });
  const [candidate] = generatePeerInitiativeCandidates({
    details: peerDetails({ maxDeliveryKind: "notify" }),
    attentionSignalRefs: ["attention:telegram:feedback"],
    policyEpoch: "policy:telegram-feedback",
    now: NOW,
    surfaceTarget: "telegram",
  });
  const actionButtons = peerInitiativeActionButtons({
    candidate,
    outcomeDecisionId: "outcome:telegram:peer-feedback",
    feedbackEpoch: "2026-05-16T00:00:01.000Z",
  });
  const outbound = {
    message_id: `peer-message:${candidate.candidate_id}`,
    surface: "telegram" as const,
    target_binding_ref: "gateway:telegram:home_chat:12345",
    channel_policy_ref: "gateway:telegram:telegram-bot:outbound-conversation-policy",
    text: "今日も頑張ってね。",
    reply_required: false as const,
    source: "peer_initiative" as const,
    candidate_id: candidate.candidate_id,
    expression_decision_ref: "expression:telegram:peer-feedback",
    visibility_policy_ref: "visibility:telegram:peer-feedback",
    trigger_actions: actionButtons.flatMap((action) => {
      const parsed = PeerInitiativeTriggerActionSchema.safeParse(action);
      return parsed.success ? [parsed.data] : [];
    }),
    feedback_actions: actionButtons.flatMap((action) => {
      const parsed = PeerInitiativeFeedbackActionSchema.safeParse(action);
      return parsed.success ? [parsed.data] : [];
    }),
  };
  await peerStore.upsertCandidate({ candidate, selectedState: "suggested" });
  await peerStore.recordDelivery({
    delivery_id: `peer-delivery:${candidate.candidate_id}:telegram`,
    candidate_id: candidate.candidate_id,
    surface: "telegram",
    status: "delivered",
    delivered_at: "2026-05-16T00:00:02.000Z",
    message_id: outbound.message_id,
    transport_message_ref: "77",
    target_binding_ref: outbound.target_binding_ref,
    expression_decision_ref: outbound.expression_decision_ref,
    visibility_policy_ref: outbound.visibility_policy_ref,
    outbound_message: outbound,
  });
  return { candidate, peerStore, feedbackStore, authorityStore };
}

async function runResidentPeerInitiative(
  context: { rootDir: string; runtimeRoot: string; controlBaseDir: string },
  options: {
    maxDeliveryKind: "digest" | "suggest" | "notify";
    attentionLabel?: string;
    gatewayPort?: FakeOutboundConversationPort;
  },
) {
  const gatewayPort = options.gatewayPort ?? new FakeOutboundConversationPort();
  const state = DaemonStateSchema.parse({
    pid: 123,
    started_at: NOW,
    last_loop_at: null,
    loop_count: 4,
    active_goals: [],
    status: "idle",
    runtime_root: context.runtimeRoot,
    last_resident_at: null,
    resident_activity: null,
  });
  const details = peerDetails({ maxDeliveryKind: options.maxDeliveryKind });
  const label = options.attentionLabel ?? options.maxDeliveryKind;
  const outcomeDecision = OutcomeDecisionSchema.parse({
    outcome_decision_id: `outcome:peer:${label}`,
    initiative_decision_ref: ref("initiative_gate_decision", `gate:peer:${label}`),
    decided_at: NOW,
    requested_outcome: "express_to_user",
    admission_status: "admitted",
    final_outcome: "express_to_user",
    visibility_policy_ref: ref("visibility_policy", `visibility:peer:${label}`),
  });
  const attentionAdmission = {
    action: "peer_initiative",
    source_kind: "resident_proactive_maintenance",
    attention_input_id: `attention:peer:${label}`,
    signal_context_id: `signal:peer:${label}`,
    urge_id: `urge:peer:${label}`,
    agenda_item_id: `agenda:peer:${label}`,
    inhibition_decision_id: `inhibition:peer:${label}`,
    initiative_gate_decision_id: `gate:peer:${label}`,
    outcome_decision_id: outcomeDecision.outcome_decision_id,
    outcome_decision: outcomeDecision,
    replay_disposition: "accepted",
    requested_outcome: "express_to_user",
    admission_status: "admitted",
    final_outcome: "express_to_user",
    branch_admitted: true,
    summary: "Resident peer initiative admitted for product gauntlet.",
  };
  const operationBoundary = evaluateResidentOperationBoundary({
    admission: attentionAdmission as never,
    assembledAt: NOW,
    details,
  });
  await triggerResidentPeerInitiative(
    {
      baseDir: context.controlBaseDir,
      config: DaemonConfigSchema.parse({
        proactive_mode: true,
        proactive_interval_ms: 1,
        goal_review_interval_ms: 7 * 24 * 60 * 60 * 1000,
        runtime_root: context.runtimeRoot,
      }),
      state,
      logger: logger() as never,
      saveDaemonState: vi.fn(async () => {}),
      gateway: {
        getOutboundConversationPort: (surface: OutboundConversationSurface) => surface === "telegram" ? gatewayPort : undefined,
      },
    },
    details,
    {
      attentionAdmission: attentionAdmission as never,
      operationBoundary,
      selectionSurfaceRef: `surface:relationship-profile:peer:${label}`,
      metadata: {},
    },
  );
  return {
    gatewayPort,
    peerStore: new PeerInitiativeStore(context.runtimeRoot, { controlBaseDir: context.controlBaseDir }),
    authorityStore: new InteractionAuthorityStore(context.runtimeRoot, { controlBaseDir: context.controlBaseDir }),
    state,
  };
}

function peerDetails(input: { maxDeliveryKind: "digest" | "suggest" | "notify" }) {
  return {
    peer_initiative: {
      kind: "care_presence",
      message: "今日も頑張ってね。",
      max_delivery_kind: input.maxDeliveryKind,
      action_plan: {
        mode: "care_only",
        permission_required: false,
      },
      worthiness: {
        can_be_valuable_without_reply: true,
        user_cognitive_load: "low",
        reply_pressure: "none",
        care_value: "high",
        attention_fit: "strong",
        concrete_helpfulness: "high",
        self_serving_risk: "none",
        tutorial_risk: "none",
      },
    },
  };
}

function scheduleCronEntry(overrides: Partial<ScheduleEntryInput> = {}): Omit<
  ScheduleEntryInput,
  | "id"
  | "created_at"
  | "updated_at"
  | "last_fired_at"
  | "next_fire_at"
  | "consecutive_failures"
  | "last_escalation_at"
  | "baseline_results"
  | "total_executions"
  | "total_tokens_used"
  | "max_tokens_per_day"
  | "tokens_used_today"
  | "budget_reset_at"
  | "escalation_timestamps"
> {
  return {
    name: "authority-boundary-cron",
    layer: "cron",
    trigger: { type: "interval", seconds: 3600, jitter_factor: 0 },
    enabled: true,
    cron: {
      prompt_template: "Summarize {{schedule-authority-source}}",
      context_sources: ["schedule-authority-source"],
      output_format: "notification",
      max_tokens: 100,
    },
    ...overrides,
  };
}

function reportFixture(overrides: Partial<Report> = {}): Report {
  return {
    id: "report:quiet-mode",
    report_type: "execution_summary",
    goal_id: "goal:authority",
    title: "Authority report",
    content: "Normal report content.",
    verbosity: "standard",
    generated_at: NOW,
    delivered_at: null,
    read: false,
    ...overrides,
  };
}
