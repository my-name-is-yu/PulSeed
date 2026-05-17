import { describe, expect, it } from "vitest";
import { applyChatEventToMessages } from "../chat-event-state.js";
import { ChatRunnerEventBridge } from "../chat-runner-event-bridge.js";
import type { ChatEvent } from "../chat-events.js";
import { classifyFailureRecovery } from "../failure-recovery.js";
import type { AgentLoopEvent } from "../../../orchestrator/execution/agent-loop/agent-loop-events.js";
import { projectTextSurface } from "../../../runtime/surface-projection-protocol.js";

describe("applyChatEventToMessages", () => {
  it("keeps activity as one updatable row per turn", () => {
    const first = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "lifecycle",
      message: "Received. Starting work...",
      sourceId: "lifecycle:start",
      transient: true,
    }, 20);

    const second = applyChatEventToMessages(first, {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      kind: "tool",
      message: "Running tool: grep - ChatEvent",
      sourceId: "tool-1",
      transient: true,
    }, 20);

    expect(second).toHaveLength(1);
    expect(second[0]!).toMatchObject({
      id: "activity:turn-1",
      role: "pulseed",
      text: "Running tool: grep - ChatEvent",
      messageType: "info",
    });
  });

  it("renders operation progress separately from the final assistant answer", () => {
    const progress = applyChatEventToMessages([], {
      type: "operation_progress",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      item: {
        id: "telegram-configure:read-config",
        kind: "read_config",
        operation: "telegram_setup",
        title: "Read Telegram config",
        detail: "Bot token is configured, but no home chat is set.",
        createdAt: "2026-04-08T00:00:00.000Z",
      },
    }, 20);

    const final = applyChatEventToMessages(progress, {
      type: "assistant_final",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      text: "Final setup guidance.",
      persisted: true,
    }, 20);

    expect(final.map((message) => message.text)).toEqual([
      "Read Telegram config: Bot token is configured, but no home chat is set.",
      "Final setup guidance.",
    ]);
  });

  it("redacts setup secrets from rendered operation progress", () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    const messages = applyChatEventToMessages([], {
      type: "operation_progress",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      item: {
        id: "secret-progress",
        kind: "awaiting_approval",
        operation: "telegram_setup",
        title: "Prepared config write",
        detail: `Token ${token} is ready.`,
        createdAt: "2026-04-08T00:00:00.000Z",
        metadata: { token },
      },
    }, 20);

    expect(JSON.stringify(messages)).not.toContain(token);
    expect(messages[0]!.text).toContain("[REDACTED:telegram_bot_token");
  });

  it("shows raw tool events without current/recent activity headings", () => {
    const messages = applyChatEventToMessages([], {
      type: "tool_start",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      toolCallId: "tool-1",
      toolName: "shell_command",
      args: { command: "rg ChatEvent src/interface/chat", cwd: "/repo" },
      activityCategory: "search",
    }, 20);

    expect(messages).toHaveLength(1);
    expect(messages[0]!).toMatchObject({
      id: "tool-log:turn-1",
      role: "pulseed",
      messageType: "info",
    });
    expect(messages[0]!.text).not.toContain("Current activity");
    expect(messages[0]!.text).not.toContain("Recent activity");
    expect(messages[0]!.text).toContain("Reading shell_command - command=rg ChatEvent src/interface/chat");
  });

  it("renders shared agent timeline items as chronological chat messages", () => {
    const base = {
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
    };
    const timelineBase = {
      sourceEventId: "event-1",
      sessionId: "session-1",
      traceId: "trace-1",
      turnId: "agent-turn-1",
      goalId: "goal-1",
      visibility: "user" as const,
    };
    const events = [
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:commentary-1",
          sourceEventId: "commentary-1",
          sourceType: "assistant_message" as const,
          createdAt: "2026-04-08T00:00:01.000Z",
          kind: "assistant_message" as const,
          phase: "commentary" as const,
          text: "I will inspect the relevant files first.",
          toolCallCount: 1,
        },
      },
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:tool-start-1",
          sourceEventId: "tool-start-1",
          sourceType: "tool_call_started" as const,
          createdAt: "2026-04-08T00:00:02.000Z",
          kind: "tool" as const,
          status: "started" as const,
          callId: "call-1",
          toolName: "shell_command",
          inputPreview: "{\"command\":\"pwd\"}",
        },
      },
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:tool-finish-1",
          sourceEventId: "tool-finish-1",
          sourceType: "tool_call_finished" as const,
          createdAt: "2026-04-08T00:00:03.000Z",
          kind: "tool" as const,
          status: "finished" as const,
          callId: "call-1",
          toolName: "shell_command",
          success: true,
          outputPreview: "/repo",
          durationMs: 10,
        },
      },
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:final-1",
          sourceEventId: "final-1",
          sourceType: "final" as const,
          createdAt: "2026-04-08T00:00:04.000Z",
          kind: "final" as const,
          success: true,
          outputPreview: "Done",
        },
      },
    ];

    const messages = events.reduce(
      (current, event) => applyChatEventToMessages(current, event, 20),
      [] as ReturnType<typeof applyChatEventToMessages>
    );

    expect(messages.map((message) => message.id)).toEqual([
      "agent-timeline:turn-1:commentary-1",
      "agent-timeline:turn-1:tool-start-1",
      "agent-timeline:turn-1:tool-finish-1",
      "agent-timeline:turn-1:final-1",
    ]);
    expect(messages.map((message) => message.text)).toEqual([
      "I will inspect the relevant files first.",
      "Started shell_command: {\"command\":\"pwd\"}",
      "Finished shell_command: /repo",
      "Done",
    ]);

    const afterFinal = applyChatEventToMessages(messages, {
      type: "assistant_final",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:05.000Z",
      text: "Done",
      persisted: true,
    }, 20);

    expect(afterFinal.map((message) => message.id)).toEqual([
      "agent-timeline:turn-1:commentary-1",
      "agent-timeline:turn-1:tool-start-1",
      "agent-timeline:turn-1:tool-finish-1",
      "turn-1",
    ]);
    expect(afterFinal.at(-1)!.text).toBe("Done");
  });

  it("drops transient timeline overflow before evicting durable chat messages", () => {
    let messages = applyChatEventToMessages([], {
      type: "assistant_final",
      runId: "run-1",
      turnId: "older-turn",
      createdAt: "2026-04-08T00:00:00.000Z",
      text: "Earlier durable answer",
      persisted: true,
    }, 3);

    for (let index = 1; index <= 4; index += 1) {
      messages = applyChatEventToMessages(messages, {
        type: "agent_timeline",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: `2026-04-08T00:00:0${index}.000Z`,
        item: {
          id: `agent-timeline:final-${index}`,
          sourceEventId: `final-${index}`,
          sourceType: "final",
          sessionId: "session-1",
          traceId: "trace-1",
          turnId: "agent-turn-1",
          goalId: "goal-1",
          createdAt: `2026-04-08T00:00:0${index}.000Z`,
          visibility: "user",
          kind: "final",
          success: true,
          outputPreview: `Candidate final ${index}`,
        },
      }, 3);
    }

    expect(messages.some((message) => message.id === "older-turn")).toBe(true);
    expect(messages).toHaveLength(3);
    expect(messages.filter((message) => message.transient)).toHaveLength(2);
  });

  it("preserves agent commentary around tool work through the shared timeline caller path", async () => {
    const events: ChatEvent[] = [];
    const bridge = new ChatRunnerEventBridge(() => (event) => {
      events.push(event);
    });
    const context = { runId: "run-1", turnId: "turn-1" };
    const sink = bridge.createAgentLoopEventSink(context);
    const base = {
      sessionId: "session-1",
      traceId: "trace-1",
      turnId: "agent-turn-1",
      goalId: "goal-1",
      createdAt: "2026-04-08T00:00:00.000Z",
    };

    await sink.emit({
      ...base,
      type: "assistant_message",
      eventId: "commentary-1",
      phase: "commentary",
      contentPreview: "I will inspect the entrypoint first.",
      toolCallCount: 1,
    });
    await sink.emit({
      ...base,
      type: "tool_call_started",
      eventId: "tool-start-1",
      callId: "call-1",
      toolName: "shell_command",
      activityCategory: "search",
      inputPreview: "{\"command\":\"rg ChatRunner src/interface/chat\"}",
    });
    await sink.emit({
      ...base,
      type: "tool_call_finished",
      eventId: "tool-finish-1",
      callId: "call-1",
      toolName: "shell_command",
      activityCategory: "search",
      success: true,
      inputPreview: "{\"command\":\"rg ChatRunner src/interface/chat\"}",
      outputPreview: "src/interface/chat/chat-runner.ts",
      durationMs: 12,
    });
    await sink.emit({
      ...base,
      type: "assistant_message",
      eventId: "commentary-2",
      phase: "commentary",
      contentPreview: "I found the bridge path, so I will update the contract test next.",
      toolCallCount: 0,
    });
    await sink.emit({
      ...base,
      type: "final",
      eventId: "final-1",
      success: true,
      outputPreview: "Done",
    });
    await sink.emit({
      ...base,
      type: "stopped",
      eventId: "stopped-1",
      reason: "completed",
    });

    const messages = events.reduce(
      (current, event) => applyChatEventToMessages(current, event, 20),
      [] as ReturnType<typeof applyChatEventToMessages>
    );
    const timelineMessages = messages.filter((message) => message.id.startsWith("agent-timeline:turn-1:"));
    const operationProgressMessages = messages.filter((message) => message.id.startsWith("operation-progress:turn-1:"));

    expect(timelineMessages.map((message) => message.text)).toEqual([
      "I will inspect the entrypoint first.",
      "Started shell_command: {\"command\":\"rg ChatRunner src/interface/chat\"}",
      "Finished shell_command: src/interface/chat/chat-runner.ts",
      "I found the bridge path, so I will update the contract test next.",
      "searched 1 search",
      "Done",
      "Stopped: completed",
    ]);
    expect(timelineMessages.filter((message) => message.text === "searched 1 search")).toHaveLength(1);
    expect(operationProgressMessages.map((message) => message.text)).toEqual([
      "Agent-loop activity summarized: searched 1 search",
    ]);
  });

  it("streams full agent-loop final candidate content instead of truncated previews", async () => {
    const events: ChatEvent[] = [];
    const bridge = new ChatRunnerEventBridge(() => (event) => {
      events.push(event);
    });
    const assistantBuffer = { text: "" };
    const sink = bridge.createAgentLoopEventSink(
      { runId: "run-1", turnId: "turn-1" },
      assistantBuffer,
      { streamFinalCandidate: true },
    );
    const fullContent = `${"A".repeat(520)} complete.`;

    await sink.emit({
      type: "assistant_message",
      eventId: "final-candidate-1",
      sessionId: "session-1",
      traceId: "trace-1",
      turnId: "agent-turn-1",
      goalId: "goal-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      phase: "final_candidate",
      content: fullContent,
      contentPreview: `${"A".repeat(500)}...`,
      toolCallCount: 0,
    });

    const delta = events.find((event): event is Extract<ChatEvent, { type: "assistant_delta" }> =>
      event.type === "assistant_delta"
    );
    expect(delta?.text).toBe(fullContent);
    expect(delta?.text).not.toContain("...");
    expect(assistantBuffer.text).toBe(fullContent);
  });

  it("renders shared timeline tool and approval rows chronologically without a latest-five cap", () => {
    const base = {
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
    };
    const timelineBase = {
      sessionId: "session-1",
      traceId: "trace-1",
      turnId: "agent-turn-1",
      goalId: "goal-1",
      visibility: "user" as const,
    };
    const events = [
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:commentary-1",
          sourceEventId: "commentary-1",
          sourceType: "assistant_message" as const,
          createdAt: "2026-04-08T00:00:01.000Z",
          kind: "assistant_message" as const,
          phase: "commentary" as const,
          text: "I will inspect the files first.",
          toolCallCount: 6,
        },
      },
      ...Array.from({ length: 6 }, (_, offset) => {
        const index = offset + 1;
        return {
          type: "agent_timeline" as const,
          ...base,
          item: {
            ...timelineBase,
            id: `agent-timeline:tool-start-${index}`,
            sourceEventId: `tool-start-${index}`,
            sourceType: "tool_call_started" as const,
            createdAt: `2026-04-08T00:00:0${index + 1}.000Z`,
            kind: "tool" as const,
            status: "started" as const,
            callId: `call-${index}`,
            toolName: "read_file",
            inputPreview: `src/file-${index}.ts`,
          },
        };
      }),
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:approval-1",
          sourceEventId: "approval-1",
          sourceType: "approval_request" as const,
          createdAt: "2026-04-08T00:00:08.000Z",
          kind: "approval" as const,
          status: "requested" as const,
          callId: "call-approval",
          toolName: "apply_patch",
          reason: "modify src/example.ts",
          permissionLevel: "workspace-write",
          isDestructive: false,
        },
      },
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:final-1",
          sourceEventId: "final-1",
          sourceType: "final" as const,
          createdAt: "2026-04-08T00:00:09.000Z",
          kind: "final" as const,
          success: true,
          outputPreview: "Done",
        },
      },
    ];

    const messages = events.reduce(
      (current, event) => applyChatEventToMessages(current, event, 20),
      [] as ReturnType<typeof applyChatEventToMessages>
    );

    expect(messages.map((message) => message.text)).toEqual([
      "I will inspect the files first.",
      "Started read_file: src/file-1.ts",
      "Started read_file: src/file-2.ts",
      "Started read_file: src/file-3.ts",
      "Started read_file: src/file-4.ts",
      "Started read_file: src/file-5.ts",
      "Started read_file: src/file-6.ts",
      "Approval requested for apply_patch: modify src/example.ts",
      "Done",
    ]);
    expect(messages.map((message) => message.text).join("\n")).not.toContain("Current activity");
    expect(messages.map((message) => message.text).join("\n")).not.toContain("Recent activity");
  });

  it("keeps operational timeline information visible without internal presentation labels", () => {
    const base = {
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
    };
    const timelineBase = {
      sessionId: "session-1",
      traceId: "trace-1",
      turnId: "agent-turn-1",
      goalId: "goal-1",
      visibility: "user" as const,
    };
    const events = [
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:resume-1",
          sourceEventId: "resume-1",
          sourceType: "resumed" as const,
          createdAt: "2026-04-08T00:00:01.000Z",
          kind: "lifecycle" as const,
          status: "resumed" as const,
          restoredMessages: 3,
          fromUpdatedAt: "2026-04-08T00:00:00.000Z",
        },
      },
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:plan-1",
          sourceEventId: "plan-1",
          sourceType: "plan_update" as const,
          createdAt: "2026-04-08T00:00:02.000Z",
          kind: "plan" as const,
          summary: "Inspect, edit, then verify.",
        },
      },
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:approval-1",
          sourceEventId: "approval-1",
          sourceType: "approval_request" as const,
          createdAt: "2026-04-08T00:00:03.000Z",
          kind: "approval" as const,
          status: "requested" as const,
          callId: "call-approval",
          toolName: "apply_patch",
          reason: "modify src/example.ts",
          permissionLevel: "workspace-write",
          isDestructive: false,
        },
      },
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:compaction-1",
          sourceEventId: "compaction-1",
          sourceType: "context_compaction" as const,
          createdAt: "2026-04-08T00:00:04.000Z",
          kind: "compaction" as const,
          phase: "mid_turn" as const,
          reason: "context_limit" as const,
          inputMessages: 10,
          outputMessages: 4,
          summaryPreview: "Shorter context",
        },
      },
    ];

    const messages = events.reduce(
      (current, event) => applyChatEventToMessages(current, event, 20),
      [] as ReturnType<typeof applyChatEventToMessages>
    );
    const transcript = messages.map((message) => message.text).join("\n");

    expect(transcript).toContain("Resumed 3 message(s)");
    expect(transcript).toContain("Plan changed: Inspect, edit, then verify.");
    expect(transcript).toContain("Approval requested for apply_patch: modify src/example.ts");
    expect(transcript).toContain("Compacted context (mid_turn, context_limit): 10 -> 4.");
    expect(transcript).not.toContain("Checkpoint");
    expect(transcript).not.toContain("Intent");
    expect(transcript).not.toContain("Updated plan:");
    expect(transcript).not.toContain("Current activity");
    expect(transcript).not.toContain("Recent activity");
  });

  it("renders shared activity summary rows without replacing detailed timeline rows", () => {
    const base = {
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
    };
    const timelineBase = {
      sessionId: "session-1",
      traceId: "trace-1",
      turnId: "agent-turn-1",
      goalId: "goal-1",
      visibility: "user" as const,
    };
    const events = [
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:commentary-1",
          sourceEventId: "commentary-1",
          sourceType: "assistant_message" as const,
          createdAt: "2026-04-08T00:00:01.000Z",
          kind: "assistant_message" as const,
          phase: "commentary" as const,
          text: "I will inspect the files first.",
          toolCallCount: 1,
        },
      },
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:tool-finish-1",
          sourceEventId: "tool-finish-1",
          sourceType: "tool_call_finished" as const,
          createdAt: "2026-04-08T00:00:02.000Z",
          kind: "tool" as const,
          status: "finished" as const,
          callId: "call-1",
          toolName: "shell_command",
          success: true,
          inputPreview: "{\"command\":\"rg Timeline src\"}",
          outputPreview: "src/orchestrator/execution/agent-loop/agent-timeline.ts",
          durationMs: 10,
        },
      },
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:summary-1",
          sourceEventId: "summary-1",
          sourceType: "tool_call_finished" as const,
          createdAt: "2026-04-08T00:00:03.000Z",
          kind: "activity_summary" as const,
          buckets: [{ kind: "search" as const, count: 1 }],
          text: "searched 1 search",
        },
      },
    ];

    const messages = events.reduce(
      (current, event) => applyChatEventToMessages(current, event, 20),
      [] as ReturnType<typeof applyChatEventToMessages>
    );

    expect(messages.map((message) => message.text)).toEqual([
      "I will inspect the files first.",
      "Finished shell_command: src/orchestrator/execution/agent-loop/agent-timeline.ts",
      "searched 1 search",
    ]);
  });

  it("keeps shared timeline rendering compatible when no commentary is emitted", async () => {
    const events: ChatEvent[] = [];
    const bridge = new ChatRunnerEventBridge(() => (event) => {
      events.push(event);
    });
    const sink = bridge.createAgentLoopEventSink({ runId: "run-1", turnId: "turn-1" });
    const base = {
      sessionId: "session-1",
      traceId: "trace-1",
      turnId: "agent-turn-1",
      goalId: "goal-1",
      createdAt: "2026-04-08T00:00:00.000Z",
    };

    await sink.emit({
      ...base,
      type: "tool_call_started",
      eventId: "tool-start-1",
      callId: "call-1",
      toolName: "shell_command",
      inputPreview: "{\"command\":\"pwd\"}",
    });
    await sink.emit({
      ...base,
      type: "final",
      eventId: "final-1",
      success: true,
      outputPreview: "Done",
    });

    const messages = events.reduce(
      (current, event) => applyChatEventToMessages(current, event, 20),
      [] as ReturnType<typeof applyChatEventToMessages>
    );

    expect(messages.map((message) => message.text)).toContain("Started shell_command: {\"command\":\"pwd\"}");
    expect(messages.map((message) => message.text)).toContain("Done");
  });

  it("renders denied typed tool observations from the production bridge path", async () => {
    const events: ChatEvent[] = [];
    const bridge = new ChatRunnerEventBridge(() => (event) => {
      events.push(event);
    });
    const sink = bridge.createAgentLoopEventSink({ runId: "run-1", turnId: "turn-1" });
    const base = {
      sessionId: "session-1",
      traceId: "trace-1",
      turnId: "agent-turn-1",
      goalId: "goal-1",
      createdAt: "2026-04-08T00:00:00.000Z",
    };

    await sink.emit({
      ...base,
      type: "tool_observation",
      eventId: "observation-denied-1",
      observation: {
        type: "tool_observation",
        callId: "call-denied",
        toolName: "apply_patch",
        arguments: { path: "src/example.ts" },
        state: "denied",
        success: false,
        execution: {
          status: "not_executed",
          reason: "approval_denied",
          message: "Write access was denied.",
        },
        durationMs: 7,
        output: {
          content: "TOOL NOT EXECUTED (approval_denied): Write access was denied.",
        },
        activityCategory: "file_modify",
      },
    } as AgentLoopEvent);

    const messages = events.reduce(
      (current, event) => applyChatEventToMessages(current, event, 20),
      [] as ReturnType<typeof applyChatEventToMessages>
    );

    expect(messages.map((message) => message.text)).toEqual([
      "Observed apply_patch (denied): TOOL NOT EXECUTED (approval_denied): Write access was denied.",
    ]);
    expect(messages[0]!.text).not.toContain("\"observation\"");
  });

  it("carries surface projections on ephemeral assistant finals", async () => {
    const events: ChatEvent[] = [];
    const bridge = new ChatRunnerEventBridge(() => (event) => {
      events.push(event);
    });
    const context = { runId: "run-ephemeral", turnId: "turn-ephemeral" };
    const projection = projectTextSurface({
      surface: "chat",
      text: "Interrupt requested.",
      purpose: "chat/active-turn steer assistant output",
      projectedAt: "2026-05-17T00:00:00.000Z",
      replayKey: "chat-ephemeral:run-ephemeral:turn-ephemeral",
    });

    const result = bridge.emitEphemeralAssistantResult(
      "stop",
      "Interrupt requested.",
      true,
      Date.now(),
      {
        context,
        surfaceProjection: projection,
      },
    );

    expect(result.surface_projection).toBe(projection);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const finalEvent = events.find((event): event is Extract<ChatEvent, { type: "assistant_final" }> =>
      event.type === "assistant_final"
    );
    expect(finalEvent?.surface_projection).toStrictEqual(projection);
    expect(finalEvent?.surface_projection).not.toHaveProperty("operator_debug_view");
  });

  it("emits plan_update bridge events with typed planning metadata", async () => {
    const events: ChatEvent[] = [];
    const bridge = new ChatRunnerEventBridge(() => (event) => {
      events.push(event);
    });
    const sink = bridge.createAgentLoopEventSink({ runId: "run-1", turnId: "turn-1" });
    const base = {
      sessionId: "session-1",
      traceId: "trace-1",
      turnId: "agent-turn-1",
      goalId: "goal-1",
      createdAt: "2026-04-08T00:00:00.000Z",
    };

    await sink.emit({
      ...base,
      type: "plan_update",
      eventId: "plan-1",
      summary: "inspect files, then verify behavior",
    });

    const toolUpdate = events.find((event): event is Extract<ChatEvent, { type: "tool_update" }> =>
      event.type === "tool_update"
    );

    expect(toolUpdate).toMatchObject({
      type: "tool_update",
      toolName: "update_plan",
      status: "result",
      message: "inspect files, then verify behavior",
      activityCategory: "planning",
      presentation: { suppressTranscript: true },
    });
  });

  it("removes transient activity when assistant final arrives", () => {
    const withActivity = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "lifecycle",
      message: "Working...",
      transient: true,
    }, 20);

    const afterFinal = applyChatEventToMessages(withActivity, {
      type: "assistant_final",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      text: "Done",
      persisted: true,
    }, 20);

    expect(afterFinal).toHaveLength(1);
    expect(afterFinal[0]!.id).toBe("turn-1");
    expect(afterFinal[0]!.text).toBe("Done");
  });

  it("removes transient activity when lifecycle error arrives", () => {
    const withActivity = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "tool",
      message: "Running tool...",
      transient: true,
    }, 20);

    const afterError = applyChatEventToMessages(withActivity, {
      type: "lifecycle_error",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      error: "boom",
      partialText: "Partial",
      persisted: false,
      recovery: classifyFailureRecovery("boom"),
    }, 20);

    expect(afterError).toHaveLength(1);
    expect(afterError[0]!.id).toBe("turn-1");
    expect(afterError[0]!.messageType).toBe("error");
    expect(afterError[0]!.text).toContain("Recovery");
    expect(afterError[0]!.text).toContain("Next actions");
  });

  it("removes transient activity on lifecycle end", () => {
    const withActivity = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "commentary",
      message: "Still working...",
      transient: true,
    }, 20);

    const afterEnd = applyChatEventToMessages(withActivity, {
      type: "lifecycle_end",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:02.000Z",
      status: "completed",
      elapsedMs: 2000,
      persisted: true,
    }, 20);

    expect(afterEnd).toEqual([]);
  });

  it("keeps non-transient activity rows after turn-ending events", () => {
    const withPersistentActivity = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "commentary",
      message: "Pinned note",
      transient: false,
    }, 20);

    const afterEnd = applyChatEventToMessages(withPersistentActivity, {
      type: "lifecycle_end",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      status: "completed",
      elapsedMs: 1000,
      persisted: true,
    }, 20);

    expect(afterEnd).toHaveLength(1);
    expect(afterEnd[0]!.id).toBe("activity:turn-1");
    expect(afterEnd[0]!.text).toBe("Pinned note");
  });

  it("keeps non-transient sourced activity separate from transient status updates", () => {
    const withPersistentCommentary = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "commentary",
      message: "I will use the file inspection tool.",
      sourceId: "commentary:tool-plan",
      transient: false,
    }, 20);

    const withStatus = applyChatEventToMessages(withPersistentCommentary, {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      kind: "lifecycle",
      message: "Preparing context...",
      sourceId: "lifecycle:context",
      transient: true,
    }, 20);

    const afterEnd = applyChatEventToMessages(withStatus, {
      type: "lifecycle_end",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:02.000Z",
      status: "completed",
      elapsedMs: 2000,
      persisted: true,
    }, 20);

    expect(afterEnd).toHaveLength(1);
    expect(afterEnd[0]!).toMatchObject({
      id: "activity:turn-1:commentary:tool-plan",
      text: "I will use the file inspection tool.",
      transient: false,
    });
    expect(afterEnd[0]!.text).not.toContain("Intent");
  });

  it("keeps checkpoint rows visible after transient lifecycle activity ends", () => {
    const withCheckpoint = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "checkpoint",
      message: "Context gathered: Workspace grounding is ready.",
      sourceId: "checkpoint:context",
      transient: false,
    }, 20);

    const withStatus = applyChatEventToMessages(withCheckpoint, {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      kind: "lifecycle",
      message: "Calling adapter...",
      sourceId: "lifecycle:adapter",
      transient: true,
    }, 20);

    const afterEnd = applyChatEventToMessages(withStatus, {
      type: "lifecycle_end",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:02.000Z",
      status: "completed",
      elapsedMs: 2000,
      persisted: true,
    }, 20);

    expect(afterEnd).toHaveLength(1);
    expect(afterEnd[0]!).toMatchObject({
      id: "activity:turn-1:checkpoint:context",
      text: "Context gathered: Workspace grounding is ready.",
      transient: false,
    });
    expect(afterEnd[0]!.text).not.toContain("Checkpoint");
  });

  it("keeps diff artifact rows visible after transient lifecycle activity ends", () => {
    const withDiff = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "diff",
      message: "Changed files\nModified files\nM\tsrc/example.ts",
      sourceId: "diff:working-tree",
      transient: false,
    }, 20);

    const withStatus = applyChatEventToMessages(withDiff, {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      kind: "lifecycle",
      message: "Completing turn...",
      sourceId: "lifecycle:finalizing",
      transient: true,
    }, 20);

    const afterEnd = applyChatEventToMessages(withStatus, {
      type: "lifecycle_end",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:02.000Z",
      status: "completed",
      elapsedMs: 2000,
      persisted: true,
    }, 20);

    expect(afterEnd).toHaveLength(1);
    expect(afterEnd[0]!).toMatchObject({
      id: "activity:turn-1:diff:working-tree",
      text: "Changed files\nModified files\nM\tsrc/example.ts",
      transient: false,
    });
  });

  it("keeps all raw tool activities visible without current/recent headings", () => {
    let messages = [] as ReturnType<typeof applyChatEventToMessages>;
    for (let index = 1; index <= 6; index += 1) {
      messages = applyChatEventToMessages(messages, {
        type: "tool_start",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: `2026-04-08T00:00:0${index}.000Z`,
        toolCallId: `tool-${index}`,
        toolName: "read_file",
        args: { path: `src/file-${index}.ts` },
        activityCategory: "read",
      }, 20);
    }

    const toolLog = messages.find((message) => message.id === "tool-log:turn-1");
    expect(toolLog?.text).toContain("file-1.ts");
    expect(toolLog?.text).toContain("file-2.ts");
    expect(toolLog?.text).toContain("file-6.ts");
    expect(toolLog?.text).not.toContain("Current activity");
    expect(toolLog?.text).not.toContain("Recent activity");

    const afterEnd = applyChatEventToMessages(messages, {
      type: "lifecycle_end",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:10.000Z",
      status: "completed",
      elapsedMs: 10_000,
      persisted: true,
    }, 20);

    expect(afterEnd.find((message) => message.id === "tool-log:turn-1")?.text).not.toContain("Recent activity");
    expect(afterEnd.find((message) => message.id === "tool-log:turn-1")?.text).toContain("file-1.ts");
  });

  it("keeps tool intent categories across updates and distinguishes waiting for approval", () => {
    const started = applyChatEventToMessages([], {
      type: "tool_start",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      toolCallId: "tool-1",
      toolName: "shell_command",
      args: { command: "npm run test:changed -- --run" },
      activityCategory: "test",
    }, 20);

    const running = applyChatEventToMessages(started, {
      type: "tool_update",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      toolCallId: "tool-1",
      toolName: "shell_command",
      status: "running",
      message: "running",
    }, 20);

    expect(running[0]!.text).toContain("Verifying shell_command");
    expect(running[0]!.text).toContain("command=npm run test:changed -- --run");

    const waiting = applyChatEventToMessages(running, {
      type: "tool_update",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:02.000Z",
      toolCallId: "tool-2",
      toolName: "apply_patch",
      status: "awaiting_approval",
      message: "write src/example.ts",
      activityCategory: "file_modify",
    }, 20);

    expect(waiting[0]!.text).toContain("Waiting for approval apply_patch - write src/example.ts");
  });

  it("renders update_plan as planning from typed tool metadata", () => {
    const messages = applyChatEventToMessages([], {
      type: "tool_start",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      toolCallId: "tool-plan",
      toolName: "update_plan",
      args: { steps: [{ step: "inspect", status: "in_progress" }] },
      activityCategory: "planning",
    }, 20);

    expect(messages[0]!.text).toContain("Planning update_plan");
  });

  it("moves a tool out of waiting once execution resumes after approval", () => {
    const waiting = applyChatEventToMessages([], {
      type: "tool_update",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      toolCallId: "tool-1",
      toolName: "apply_patch",
      status: "awaiting_approval",
      message: "write src/example.ts",
      activityCategory: "file_modify",
    }, 20);

    const running = applyChatEventToMessages(waiting, {
      type: "tool_update",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      toolCallId: "tool-1",
      toolName: "apply_patch",
      status: "running",
      message: "running",
    }, 20);

    expect(running[0]!.text).not.toContain("Waiting for approval apply_patch");
    expect(running[0]!.text).toContain("Editing apply_patch - write src/example.ts");
  });
});
