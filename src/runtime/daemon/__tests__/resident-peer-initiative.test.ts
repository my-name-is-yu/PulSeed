import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { DaemonConfigSchema, DaemonStateSchema } from "../../types/daemon.js";
import type {
  GatewayOutboundConversationPort,
  OutboundConversationMessage,
  OutboundConversationSurface,
  OutboundConversationTarget,
} from "../../gateway/index.js";
import { upsertRelationshipProfileItem } from "../../../platform/profile/relationship-profile.js";
import { PeerInitiativeStore } from "../../peer-initiative/index.js";
import { proactiveTick } from "../runner-resident-proactive.js";

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
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
      delivered_at: "2026-05-15T00:00:01.000Z",
      transport_message_ref: "telegram:77",
    };
  }
}

describe("resident peer initiative caller path", () => {
  it("runs resident proactive tick into a Telegram outbound conversation without a direct user prompt", async () => {
    const baseDir = makeTempDir("resident-peer-initiative-");
    const gatewayPort = new FakeOutboundConversationPort();
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "peer-initiative-test-context",
      kind: "preference",
      value: "Low-pressure peer initiative messages are allowed when they reduce current load.",
      source: "setup_user",
      allowedScopes: ["resident_behavior"],
      sensitivity: "private",
      now: "2026-05-15T00:00:00.000Z",
    });
    const state = DaemonStateSchema.parse({
      pid: 123,
      started_at: "2026-05-15T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 4,
      active_goals: [],
      status: "idle",
      runtime_root: path.join(baseDir, "runtime"),
      last_resident_at: null,
      resident_activity: null,
    });
    const llmClient = {
      sendMessage: vi.fn(async () => ({
        content: JSON.stringify({
          action: "peer_initiative",
          details: {
            peer_initiative: {
              kind: "attention_preparation",
              message: "今日も頑張ってね。最低限版だけ作っておくね。",
              action_plan: {
                mode: "internal_preparation",
                preparation_kind: "minimum_viable_plan",
                prepared_artifact_ref: "peer-artifact:min-plan",
                permission_required: false,
                user_visible_trigger: "show_me",
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
              need_signals: [{
                signal_id: "need:min-plan",
                kind: "decision_load_high",
                created_at: "2026-05-15T00:00:00.000Z",
                attention_signal_refs: ["attention:external"],
                confidence: 0.85,
                summary: "Current attention suggests a smaller next shape would reduce load.",
              }],
            },
          },
        }),
      })),
      parseJSON: vi.fn((content: string) => JSON.parse(content) as unknown),
    };

    const context = {
      baseDir,
      config: DaemonConfigSchema.parse({
        proactive_mode: true,
        proactive_interval_ms: 1,
        goal_review_interval_ms: 7 * 24 * 60 * 60 * 1000,
        runtime_root: path.join(baseDir, "runtime"),
      }),
      llmClient: llmClient as never,
      state,
      logger: logger() as never,
      saveDaemonState: vi.fn(async () => {}),
      curiosityEngine: undefined,
      stateManager: {
        listGoalIds: vi.fn(async () => []),
        loadGoal: vi.fn(async () => null),
      } as never,
      goalNegotiator: undefined,
      currentGoalIds: [],
      supervisor: undefined,
      gateway: {
        getOutboundConversationPort: (surface: OutboundConversationSurface) => surface === "telegram" ? gatewayPort : undefined,
      },
      refreshOperationalState: vi.fn(),
      abortSleep: vi.fn(),
      scheduleEngine: undefined,
      knowledgeManager: undefined,
      memoryLifecycle: undefined,
      driveSystem: { writeEvent: vi.fn(async () => {}) } as never,
      attentionStateStore: {
        saveCycle: vi.fn(async () => null),
      },
      feedbackIngestionStore: {
        listEffects: vi.fn(async () => []),
      },
    };

    await proactiveTick(
      context,
      0,
      () => {},
      Date.now(),
      () => {},
    );

    expect(gatewayPort.messages).toHaveLength(1);
    expect(gatewayPort.messages[0]).toMatchObject({
      source: "peer_initiative",
      text: "今日も頑張ってね。最低限版だけ作っておくね。",
      reply_required: false,
      trigger_actions: [expect.objectContaining({ action: "show_prepared" })],
      feedback_actions: expect.arrayContaining([
        expect.objectContaining({ action: "less_like_this" }),
        expect.objectContaining({ action: "wrong_read" }),
      ]),
    });
    expect(state.resident_activity).toMatchObject({
      kind: "observation",
      peer_initiative_delivery_status: "delivered",
      peer_prepared_artifact_ref: "peer-artifact:min-plan",
    });
    const records = await new PeerInitiativeStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir })
      .listRecentCandidates();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "attention_preparation",
      selected_state: "suggested",
      delivered_at: expect.any(String),
    });

    await proactiveTick(
      context,
      0,
      () => {},
      Date.now(),
      () => {},
    );

    expect(gatewayPort.messages).toHaveLength(1);
  });
});
