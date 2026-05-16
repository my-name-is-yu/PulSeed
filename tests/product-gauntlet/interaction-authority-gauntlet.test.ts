import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Report } from "../../src/base/types/report.js";
import { NotificationDispatcher } from "../../src/runtime/notification-dispatcher.js";
import { evaluateResidentOperationBoundary } from "../../src/runtime/capability-operation-planner.js";
import {
  createExecutionAuthorityDecision,
  InteractionAuthorityStore,
  projectMemoryCorrectionAuthority,
} from "../../src/runtime/control/index.js";
import { triggerResidentPeerInitiative } from "../../src/runtime/daemon/runner-resident-proactive.js";
import { DaemonConfigSchema, DaemonStateSchema } from "../../src/runtime/types/daemon.js";
import { ref } from "../../src/runtime/attention/attention-refs.js";
import { OutcomeDecisionSchema } from "../../src/runtime/types/companion-autonomy.js";
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
import { PluginChannelRuntimeStateStore } from "../../src/runtime/store/plugin-channel-runtime-state-store.js";
import { FeedbackIngestionStore } from "../../src/runtime/store/feedback-ingestion-store.js";
import { PermissionWaitPlanStore, type PermissionWaitCanonicalPlan } from "../../src/runtime/store/permission-wait-plan-store.js";
import { PersonalAgentRuntimeStore, projectPersonalAgentNormalSurface } from "../../src/runtime/personal-agent/index.js";
import { KnowledgeManager } from "../../src/platform/knowledge/knowledge-manager.js";
import { StateManager } from "../../src/base/state/state-manager.js";
import { runUserMemoryOperation } from "../../src/platform/corrections/user-memory-operations.js";
import { projectUserFacingMemoryInspect } from "../../src/platform/corrections/memory-inspect-projection.js";
import { ToolExecutor, ToolPermissionManager, ToolRegistry, ConcurrencyController } from "../../src/tools/index.js";
import { runProductGauntletScenario } from "../harness/product-gauntlet-runner.js";

const NOW = "2026-05-16T00:00:00.000Z";

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
      const waitStore = new PermissionWaitPlanStore(context.runtimeRoot, {
        controlBaseDir: context.controlBaseDir,
        now: () => 1_000,
        createEventId: () => "permission-event",
      });
      const approvedPlan = permissionPlan({ conversationId: "conversation:old", value: "old" });
      await waitStore.createWaiting({
        wait_plan_id: "approval:old-peer-action",
        canonical_plan: approvedPlan,
        audit_refs: ["approval:old-peer-action"],
      });
      await waitStore.markApproved("approval:old-peer-action", { resolved_at: 1_001 });
      const resume = await waitStore.resumeApproved("approval:old-peer-action", {
        canonical_plan: permissionPlan({ conversationId: "conversation:new", value: "new" }),
        resumed_at: 1_002,
      });
      const authorityStore = new InteractionAuthorityStore(context.runtimeRoot, {
        controlBaseDir: context.controlBaseDir,
      });
      const authorityDecision = await authorityStore.recordDecision(createExecutionAuthorityDecision({
        schema_version: "execution-authority-decision/v1",
        decision_id: "execution-authority:approval:old-peer-action",
        decided_at: NOW,
        lifecycle: "terminal",
        outcome: "fail_closed",
        reason: "Old approval rejected because conversation and args no longer match the canonical plan.",
        requires_approval: true,
        fail_closed: true,
        stale_target_rejected: true,
        source: {
          kind: "approval",
          ref: "approval:old-peer-action",
          stage: "execute",
        },
        bindings: {
          approval_ref: "approval:old-peer-action",
          target_refs: ["conversation:old", "conversation:new"],
        },
        invalidation_refs: ["conversation:old", "args:value"],
      }));
      context.recordEvidence({
        authorityDecision,
        dbSummary: { resume },
        nextFiles: ["src/runtime/store/permission-wait-plan-store.ts", "src/tools/executor.ts"],
      });

      expect(resume.status).toBe("mismatch_rejected");
      expect(resume).toMatchObject({
        mismatch_reasons: expect.arrayContaining(["target_changed", "input_changed"]),
      });
      expect(authorityDecision).toMatchObject({
        fail_closed: true,
        stale_target_rejected: true,
        requires_approval: true,
      });
      return {
        authorityDecision,
        dbSummary: { resume },
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
      const history = correctionResult.history;
      const target = (await knowledgeManager.listAgentMemory({ include_archived: true }))
        .find((entry) => entry.id === stale.id) ?? null;
      const projection = projectUserFacingMemoryInspect({
        targetKind: "agent_memory",
        history,
        agentMemoryEntry: target,
      });
      const authorityStore = new InteractionAuthorityStore(context.runtimeRoot, {
        controlBaseDir: context.controlBaseDir,
      });
      const authorityDecision = await authorityStore.recordDecision(projectMemoryCorrectionAuthority({
        correctionId: history[0]!.correction_id,
        targetRef: stale.id,
        decidedAt: NOW,
        reason: "Corrected memory is withheld from future recall and normal projection.",
        memoryWithheld: true,
        normalSurfaceProjectionRef: "normal-surface:memory-inspect:user.editor.preference",
      }));
      const recalledText = JSON.stringify({ recalledCurrent, recalledStale });
      context.recordEvidence({
        authorityDecision,
        visibleProjection: projection,
        dbSummary: { recalled: recalledCurrent.map((entry) => entry.key), history },
        nextFiles: [
          "src/platform/corrections/user-memory-operations.ts",
          "src/runtime/cognition/memory-context.ts",
        ],
      });

      expect(recalledText).toContain("VS Code");
      expect(recalledText).not.toContain("Atom");
      expect(recalledStale).toHaveLength(0);
      expect(projection).toMatchObject({
        raw_content_visible: false,
        raw_refs_visible: false,
        sensitive_content_visible: false,
        active_for_future_use: false,
        history_count: 1,
      });
      expect(authorityDecision.memory_withheld).toBe(true);
      return {
        authorityDecision,
        visibleProjection: projection,
        dbSummary: { recalled: recalledCurrent.map((entry) => entry.key), history },
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
      await runResidentPeerInitiative(context, {
        maxDeliveryKind: "notify",
        attentionLabel: "same",
        gatewayPort: first.gatewayPort,
      });
      await runResidentPeerInitiative(context, {
        maxDeliveryKind: "notify",
        attentionLabel: "distinct",
        gatewayPort: first.gatewayPort,
      });
      const records = await first.peerStore.listRecentCandidates();
      const deliveries = await Promise.all(records.map((record) =>
        first.peerStore.getLatestDeliveryForCandidate({ candidateId: record.candidate_id, surface: "telegram" })
      ));
      context.recordEvidence({
        dbSummary: { records, deliveries, send_count: first.gatewayPort.messages.length },
        nextFiles: ["src/runtime/daemon/runner-resident-proactive.ts", "src/runtime/peer-initiative/store.ts"],
      });

      expect(first.gatewayPort.messages).toHaveLength(2);
      expect(records).toHaveLength(2);
      expect(deliveries.filter((delivery) => delivery?.status === "delivered")).toHaveLength(2);
      return {
        dbSummary: { records, deliveries, send_count: first.gatewayPort.messages.length },
        nextFiles: ["src/runtime/daemon/runner-resident-proactive.ts", "src/runtime/peer-initiative/store.ts"],
      };
    });
  });

  it("10. normal user projection redacts internals across status-like surfaces", async () => {
    await runProductGauntletScenario("normal_projection_redacts_internals", async (context) => {
      const projection = projectPersonalAgentNormalSurface({
        situation_frame: {
          caller_path: "chat_gateway_turn",
          withheld_memory_refs: [{ kind: "memory_record", ref: "memory:raw-secret" }],
          stale_refs: [{ kind: "reply_target", ref: "reply:old" }],
          uncertainty_refs: [],
          conflict_refs: [],
        },
        initiative_events: [],
        task_candidates: [{
          desired_effect: "send_notification",
          proposed_at: NOW,
        }],
        capability_decisions: [],
        intervention_decisions: [{
          decision: "suppress",
          target_effect: "send_notification",
          permission_required: false,
          decided_at: NOW,
        }],
        memory_audits: [{
          action: "withhold",
          invalidated: true,
          correction_state: "retracted",
        }],
      } as never);
      const authorityDecision = createExecutionAuthorityDecision({
        schema_version: "execution-authority-decision/v1",
        decision_id: "execution-authority:normal-surface:redaction",
        decided_at: NOW,
        lifecycle: "approved",
        outcome: "allowed",
        reason: "Normal surface projection is redacted and projection-only.",
        surface: "status",
        surface_class: "normal_user",
        source: {
          kind: "surface_projection",
          ref: "normal-surface:redaction",
          stage: "inspect",
        },
        bindings: {
          normal_surface_projection_ref: "normal-surface:redaction",
          target_refs: ["chat", "gateway", "tui-adjacent", "status", "report"],
        },
      });
      context.recordEvidence({
        authorityDecision,
        visibleProjection: projection,
        nextFiles: ["src/runtime/personal-agent/normal-surface-projection.ts"],
      });

      expect(projection).toMatchObject({
        raw_trace_visible: false,
        raw_refs_visible: false,
        raw_evidence_refs_visible: false,
        internal_policy_refs_visible: false,
        capability_catalog_visible: false,
        readonly_projection: true,
        mutation_performed: false,
      });
      expect(JSON.stringify(projection)).not.toContain("memory:raw-secret");
      expect(authorityDecision.surface_class).toBe("normal_user");
      return {
        authorityDecision,
        visibleProjection: projection,
        nextFiles: ["src/runtime/personal-agent/normal-surface-projection.ts"],
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

function permissionPlan(input: { conversationId: string; value: string }): PermissionWaitCanonicalPlan {
  return {
    schema_version: "permission-wait-canonical-plan-v1",
    tool_name: "send_peer_action",
    input: { value: input.value },
    cwd: "/workspace",
    target: {
      session_id: input.conversationId,
      tool_call_id: "tool-call:peer-action",
    },
    permission: {
      permission_level: "write_remote",
      is_destructive: false,
      reversibility: "unknown",
    },
    state_epoch: "epoch:approval-request",
    capability_facts: {
      tool_permission_level: "write_remote",
      tool_is_read_only: false,
      tool_is_destructive: false,
      tool_requires_network: true,
      tool_tags: ["peer_initiative"],
    },
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
