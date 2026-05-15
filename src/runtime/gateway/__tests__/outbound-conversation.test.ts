import { afterEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { FeedbackIngestionStore } from "../../store/feedback-ingestion-store.js";
import {
  generatePeerInitiativeCandidates,
  peerInitiativeActionButtons,
  PeerInitiativeStore,
} from "../../peer-initiative/index.js";
import {
  PeerInitiativeFeedbackActionSchema,
  PeerInitiativeTriggerActionSchema,
} from "../outbound-conversation.js";
import { TelegramGatewayAdapter } from "../telegram-gateway-adapter.js";

describe("gateway outbound conversation port", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends peer initiative messages through the live Telegram adapter capability", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (body["chat_id"] === 12345 && body["text"] === "今日も頑張ってね。") {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const configDir = makeTempDir("telegram-outbound-send-");
    const adapter = new TelegramGatewayAdapter(configDir, {
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
    });

    const target = await adapter.outboundConversation.resolveDefaultTarget();
    const receipt = await adapter.outboundConversation.sendOutboundConversationMessage({
      message_id: "peer-message:1",
      surface: "telegram",
      target_binding_ref: target!.target_binding_ref,
      channel_policy_ref: target!.channel_policy_ref,
      text: "今日も頑張ってね。",
      reply_required: false,
      source: "peer_initiative",
      candidate_id: "peer-candidate:1",
      expression_decision_ref: "expression:1",
      visibility_policy_ref: "visibility:1",
      trigger_actions: [],
      feedback_actions: [{
        action: "less_like_this",
        candidate_id: "peer-candidate:1",
        initiative_kind: "care_presence",
        feedback_target: {
          kind: "outcome_decision",
          id: "outcome:1",
          peer_candidate_id: "peer-candidate:1",
        },
        feedback_epoch: "2026-05-15T00:00:00.000Z",
      }],
    });

    expect(receipt).toMatchObject({
      message_id: "peer-message:1",
      surface: "telegram",
      target_binding_ref: target!.target_binding_ref,
      transport_message_ref: "77",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottoken/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: 12345,
          text: "今日も頑張ってね。",
          reply_markup: {
            inline_keyboard: [[{
              text: "少なめ",
              callback_data: "psp1:lt:peer-candidate:1",
            }]],
          },
        }),
      }),
    );
  });

  it("rejects stale outbound target refs before sending", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const configDir = makeTempDir("telegram-outbound-stale-");
    const adapter = new TelegramGatewayAdapter(configDir, {
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
    });

    await expect(adapter.outboundConversation.sendOutboundConversationMessage({
      message_id: "peer-message:1",
      surface: "telegram",
      target_binding_ref: "gateway:telegram:home_chat:99999",
      channel_policy_ref: "gateway:telegram:telegram-bot:outbound-conversation-policy",
      text: "今日も頑張ってね。",
      reply_required: false,
      source: "peer_initiative",
      candidate_id: "peer-candidate:1",
      expression_decision_ref: "expression:1",
      visibility_policy_ref: "visibility:1",
      trigger_actions: [],
      feedback_actions: [],
    })).rejects.toThrow("stale target");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects peer feedback actions with unsupported initiative kinds", () => {
    expect(PeerInitiativeFeedbackActionSchema.safeParse({
      action: "less_like_this",
      candidate_id: "peer-candidate:1",
      initiative_kind: "unknown_peer_kind",
      feedback_target: {
        kind: "peer_initiative_candidate",
        id: "peer-candidate:1",
      },
      feedback_epoch: "2026-05-15T00:00:00.000Z",
    }).success).toBe(false);
  });

  it("routes Telegram peer feedback callbacks through canonical feedback ingestion and peer projection", async () => {
    const tmpDir = makeTempDir("telegram-peer-feedback-");
    const runtimeRoot = path.join(tmpDir, "runtime");
    const peerStore = new PeerInitiativeStore(runtimeRoot, { controlBaseDir: tmpDir });
    const feedbackStore = new FeedbackIngestionStore(runtimeRoot, { controlBaseDir: tmpDir });
    const [candidate] = generatePeerInitiativeCandidates({
      details: {
        peer_initiative: {
          kind: "care_presence",
          message: "今日も頑張ってね。",
          action_plan: { mode: "care_only", permission_required: false },
          worthiness: {
            can_be_valuable_without_reply: true,
            user_cognitive_load: "low",
            reply_pressure: "none",
            care_value: "high",
            attention_fit: "medium",
            concrete_helpfulness: "medium",
            self_serving_risk: "none",
            tutorial_risk: "none",
          },
        },
      },
      attentionSignalRefs: ["attention:telegram:feedback"],
      policyEpoch: "policy:telegram-feedback",
      now: "2026-05-15T00:00:00.000Z",
      surfaceTarget: "telegram",
    });
    const actionButtons = peerInitiativeActionButtons({
      candidate,
      outcomeDecisionId: "outcome:telegram:peer-feedback",
      feedbackEpoch: "2026-05-15T00:00:01.000Z",
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
      delivered_at: "2026-05-15T00:00:02.000Z",
      message_id: outbound.message_id,
      transport_message_ref: "77",
      target_binding_ref: outbound.target_binding_ref,
      expression_decision_ref: outbound.expression_decision_ref,
      visibility_policy_ref: outbound.visibility_policy_ref,
      outbound_message: outbound,
    });
    const callbackAckIds: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").at(-1);
      if (method === "answerCallbackQuery") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        callbackAckIds.push(String(body["callback_query_id"]));
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      throw new Error(`unexpected Telegram method: ${method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new TelegramGatewayAdapter("/tmp/telegram-bot", {
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
    }, {
      runtimeBaseDir: tmpDir,
      controlBaseDir: tmpDir,
      peerInitiativeStore: peerStore,
      feedbackIngestionStore: feedbackStore,
    });

    await (adapter as unknown as {
      processCallbackQuery(query: {
        id: string;
        from: { id: number };
        message: { message_id: number; chat: { id: number } };
        data: string;
      }): Promise<void>;
    }).processCallbackQuery({
      id: "callback-wrong-chat",
      from: { id: 42 },
      message: { message_id: 77, chat: { id: 99999 } },
      data: `psp1:lt:${candidate.candidate_id}`,
    });
    await (adapter as unknown as {
      processCallbackQuery(query: {
        id: string;
        from: { id: number };
        message: { message_id: number; chat: { id: number } };
        data: string;
      }): Promise<void>;
    }).processCallbackQuery({
      id: "callback-wrong-message",
      from: { id: 42 },
      message: { message_id: 78, chat: { id: 12345 } },
      data: `psp1:lt:${candidate.candidate_id}`,
    });
    await (adapter as unknown as {
      processCallbackQuery(query: {
        id: string;
        from: { id: number };
        message: { message_id: number; chat: { id: number } };
        data: string;
      }): Promise<void>;
    }).processCallbackQuery({
      id: "callback-1",
      from: { id: 42 },
      message: { message_id: 77, chat: { id: 12345 } },
      data: `psp1:lt:${candidate.candidate_id}`,
    });
    await (adapter as unknown as {
      processCallbackQuery(query: {
        id: string;
        from: { id: number };
        message: { message_id: number; chat: { id: number } };
        data: string;
      }): Promise<void>;
    }).processCallbackQuery({
      id: "callback-2",
      from: { id: 42 },
      message: { message_id: 77, chat: { id: 12345 } },
      data: `psp1:lt:${candidate.candidate_id}`,
    });

    const feedbackRecords = await feedbackStore.listRecords();
    const projections = await peerStore.listFeedbackProjections({ candidateId: candidate.candidate_id });
    expect(callbackAckIds).toEqual([
      "callback-wrong-chat",
      "callback-wrong-message",
      "callback-1",
      "callback-2",
    ]);
    expect(feedbackRecords).toHaveLength(1);
    expect(projections).toHaveLength(1);
    expect(feedbackRecords).toMatchObject([{
      source: "telegram",
      feedback_kind: "proactive_feedback",
      outcome: "dismissed",
      target: {
        kind: "outcome_decision",
        id: "outcome:telegram:peer-feedback",
      },
    }]);
    expect(projections).toMatchObject([{
      candidate_id: candidate.candidate_id,
      structured_outcome: "less_like_this",
      source_surface: "telegram",
      feedback_id: feedbackRecords[0]!.feedback_id,
    }]);
  });

  it("acknowledges malformed Telegram peer callback payloads without side effects", async () => {
    const tmpDir = makeTempDir("telegram-peer-feedback-malformed-");
    const callbackAckIds: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").at(-1);
      if (method === "answerCallbackQuery") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        callbackAckIds.push(String(body["callback_query_id"]));
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      throw new Error(`unexpected Telegram method: ${method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new TelegramGatewayAdapter("/tmp/telegram-bot", {
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
    }, {
      runtimeBaseDir: tmpDir,
      controlBaseDir: tmpDir,
    });

    await (adapter as unknown as {
      processCallbackQuery(query: {
        id: string;
        from: { id: number };
        message: { message_id: number; chat: { id: number } };
        data: string;
      }): Promise<void>;
    }).processCallbackQuery({
      id: "callback-malformed",
      from: { id: 42 },
      message: { message_id: 77, chat: { id: 12345 } },
      data: "not-a-peer-callback",
    });

    expect(callbackAckIds).toEqual(["callback-malformed"]);
  });
});
