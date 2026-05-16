import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StateManager } from "../../../base/state/state-manager.js";
import {
  buildRuntimeControlContextFromIngress,
  buildStandaloneIngressMessageFromContext,
  loadedSessionToChatSession,
  resolveChatResumeSelector,
} from "../chat-runner-runtime.js";
import { buildStandaloneIngressMessage } from "../ingress-router.js";
import { importLegacyChatAgentLoopSessionState } from "../chat-agentloop-state-migration.js";
import {
  makeChatRunnerRuntimeDeps,
  makeRuntimeControlActor,
  makeRuntimeControlChatContext,
  makeRuntimeReplyTarget,
} from "../../../../tests/helpers/runtime-control-fixtures.js";

async function writeJsonFixture(baseDir: string, relativePath: string, value: unknown): Promise<void> {
  const filePath = path.join(baseDir, relativePath);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(value), "utf8");
}

const tempDirs: string[] = [];

function trackedTempDir(): string {
  const dir = path.join(os.tmpdir(), `pulseed-chat-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    await fsp.rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("chat-runner runtime helpers", () => {
  it("preserves turn context snapshots when converting loaded sessions for resume", () => {
    const session = loadedSessionToChatSession({
      id: "session-with-context",
      cwd: "/repo",
      createdAt: "2026-05-06T07:00:00.000Z",
      updatedAt: "2026-05-06T07:01:00.000Z",
      title: null,
      messages: [],
      agentLoopStatePath: null,
      agentLoopStatus: "missing",
      agentLoopResumable: false,
      turnContexts: [{
        schema_version: "chat-turn-context-v1",
        modelVisible: { turn: { turnId: "turn-current" } },
      }],
    });

    expect(session.turnContexts).toEqual([expect.objectContaining({
      schema_version: "chat-turn-context-v1",
    })]);
  });

  it("buildStandaloneIngressMessageFromContext prefers the current runtime reply target over stale fallback deps", () => {
    const message = buildStandaloneIngressMessageFromContext(
      "restart now",
      makeRuntimeControlChatContext({
        actor: makeRuntimeControlActor({ conversation_id: "telegram-thread" }),
        replyTarget: makeRuntimeReplyTarget({
          conversation_id: "telegram-thread",
          message_id: "msg-new",
          metadata: { source: "current-turn" },
        }),
        approvalFn: async () => true,
      }),
      makeChatRunnerRuntimeDeps({
        runtimeReplyTarget: makeRuntimeReplyTarget({
          platform: "slack",
          conversation_id: "slack-thread",
          message_id: "msg-stale",
        }),
      })
    );

    expect(message.channel).toBe("plugin_gateway");
    expect(message.platform).toBe("telegram");
    expect(message.conversation_id).toBe("telegram-thread");
    expect(message.replyTarget).toMatchObject({
      platform: "telegram",
      conversation_id: "telegram-thread",
      identity_key: "owner",
      user_id: "user-1",
      message_id: "msg-new",
      deliveryMode: "thread_reply",
      metadata: { source: "current-turn" },
    });
    expect(message.replyTarget.conversation_id).not.toBe("slack-thread");
    expect(message.replyTarget.message_id).not.toBe("msg-stale");
  });

  it("buildRuntimeControlContextFromIngress auto-approves preapproved ingress without calling stale interactive approval handlers", async () => {
    const staleApproval = vi.fn().mockResolvedValue(false);
    const depsApproval = vi.fn().mockResolvedValue(false);
    const ingress = buildStandaloneIngressMessage({
      text: "restart",
      channel: "plugin_gateway",
      platform: "slack",
      conversation_id: "C123",
      user_id: "U123",
      runtimeControl: {
        allowed: true,
        approvalMode: "preapproved",
      },
    });

    const context = buildRuntimeControlContextFromIngress(
      ingress,
      {
        ...makeRuntimeControlChatContext(),
        actor: ingress.actor,
        replyTarget: ingress.replyTarget,
        approvalFn: staleApproval,
      },
      makeChatRunnerRuntimeDeps({ approvalFn: depsApproval })
    );

    expect(context?.actor).toEqual(ingress.actor);
    expect(context?.replyTarget).toEqual(ingress.replyTarget);
    await expect(context?.approvalFn?.("approve?")).resolves.toBe(true);
    expect(staleApproval).not.toHaveBeenCalled();
    expect(depsApproval).not.toHaveBeenCalled();
  });

  it("buildRuntimeControlContextFromIngress keeps disallowed ingress from reusing a previous turn approval function", () => {
    const staleApproval = vi.fn().mockResolvedValue(true);
    const ingress = buildStandaloneIngressMessage({
      text: "restart",
      channel: "plugin_gateway",
      platform: "discord",
      conversation_id: "thread-1",
      user_id: "user-1",
      runtimeControl: {
        allowed: false,
        approvalMode: "disallowed",
      },
    });

    const context = buildRuntimeControlContextFromIngress(
      ingress,
      {
        ...makeRuntimeControlChatContext(),
        actor: ingress.actor,
        replyTarget: ingress.replyTarget,
        approvalFn: staleApproval,
      },
      makeChatRunnerRuntimeDeps()
    );

    expect(context?.approvalFn).toBeUndefined();
  });

  it("resolveChatResumeSelector resumes a real agent runtime session only when its owning conversation is still chat-resumable", async () => {
    const baseDir = trackedTempDir();
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    await stateManager.init();

    await writeJsonFixture(baseDir, "chat/sessions/chat-active.json", {
      id: "chat-active",
      cwd: "/repo",
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:10:00.000Z",
      title: "Active session",
      messages: [],
      agentLoopStatePath: "chat/agentloop/active.state.json",
      agentLoopStatus: "running",
      agentLoopResumable: true,
      agentLoopUpdatedAt: "2026-04-25T00:11:00.000Z",
    });
    await writeJsonFixture(baseDir, "chat/agentloop/active.state.json", {
      sessionId: "agent-active",
      traceId: "trace-active",
      turnId: "turn-active",
      goalId: "goal-active",
      cwd: "/repo",
      modelRef: "native:test",
      messages: [],
      modelTurns: 1,
      toolCalls: 0,
      compactions: 0,
      completionValidationAttempts: 0,
      calledTools: [],
      lastToolLoopSignature: null,
      repeatedToolLoopCount: 0,
      finalText: "",
      status: "running",
      updatedAt: "2026-04-25T00:12:00.000Z",
    });

    await writeJsonFixture(baseDir, "chat/sessions/chat-stale.json", {
      id: "chat-stale",
      cwd: "/repo",
      createdAt: "2026-04-25T00:20:00.000Z",
      updatedAt: "2026-04-25T00:30:00.000Z",
      title: "Stale session",
      messages: [],
      agentLoopStatePath: "chat/agentloop/stale.state.json",
      agentLoopStatus: "completed",
      agentLoopResumable: false,
      agentLoopUpdatedAt: "2026-04-25T00:31:00.000Z",
    });
    await writeJsonFixture(baseDir, "chat/agentloop/stale.state.json", {
      sessionId: "agent-stale",
      traceId: "trace-stale",
      turnId: "turn-stale",
      goalId: "goal-stale",
      cwd: "/repo",
      modelRef: "native:test",
      messages: [],
      modelTurns: 1,
      toolCalls: 0,
      compactions: 0,
      completionValidationAttempts: 0,
      calledTools: [],
      lastToolLoopSignature: null,
      repeatedToolLoopCount: 0,
      finalText: "",
      status: "completed",
      updatedAt: "2026-04-25T00:31:00.000Z",
    });
    await importLegacyChatAgentLoopSessionState(baseDir);

    const active = await resolveChatResumeSelector("session:agent:agent-active", { stateManager });
    const stale = await resolveChatResumeSelector("session:agent:agent-stale", { stateManager });

    expect(active).toEqual({ chatSelector: "chat-active" });
    expect(stale.chatSelector).toBe("session:agent:agent-stale");
    expect(stale.nonResumableMessage).toContain("is not chat-resumable");
  });
});
