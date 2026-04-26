import { describe, expect, it } from "vitest";
import { IngressRouter, buildStandaloneIngressMessage } from "../ingress-router.js";

describe("IngressRouter", () => {
  const router = new IngressRouter();

  it("routes ordinary natural-language input to agent_loop when available", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "What route should answer this?",
        channel: "plugin_gateway",
        platform: "discord",
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
        },
      }),
      {
        hasAgentLoop: true,
        hasToolLoop: true,
      }
    );

    expect(route.kind).toBe("agent_loop");
    expect(route.replyTargetPolicy).toBe("turn_reply_target");
  });

  it("falls back to tool_loop when the native agent loop is unavailable", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "What files changed?",
      }),
      {
        hasAgentLoop: false,
        hasToolLoop: true,
      }
    );

    expect(route.kind).toBe("tool_loop");
  });

  it("routes explicit runtime-control requests when allowed", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "PulSeed を再起動して",
        channel: "plugin_gateway",
        platform: "telegram",
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
        },
      }),
      {
        hasAgentLoop: true,
        hasToolLoop: true,
      }
    );

    expect(route.kind).toBe("runtime_control");
    expect(route.eventProjectionPolicy).toBe("latest_active_reply_target");
  });

  it("does not route runtime-control text to runtime_control when ingress policy disallows it", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "PulSeed を再起動して",
        channel: "plugin_gateway",
        platform: "telegram",
        runtimeControl: {
          allowed: false,
          approvalMode: "disallowed",
        },
      }),
      {
        hasAgentLoop: true,
        hasToolLoop: true,
      }
    );

    expect(route.kind).toBe("agent_loop");
  });

  it("keeps long-running natural-language work on agent_loop so tools can decide handoff", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "coreloopの方でscore0.98行くまで取り組んで",
        channel: "tui",
        platform: "local_tui",
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
        },
      }),
      {
        hasAgentLoop: true,
        hasToolLoop: true,
      }
    );

    expect(route.kind).toBe("agent_loop");
    expect(route.eventProjectionPolicy).toBe("turn_only");
  });

  it("does not classify Japanese threshold phrasing with regex-based daemon routing", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "coreloopの方でscore0.98超えるまで色々やってほしい",
        channel: "tui",
        platform: "local_tui",
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
        },
      }),
      {
        hasAgentLoop: true,
        hasToolLoop: true,
      }
    );

    expect(route.kind).toBe("agent_loop");
  });

  it("keeps long-running work on agent_loop when runtime control is disallowed", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "coreloopの方でscore0.98行くまで取り組んで",
        channel: "plugin_gateway",
        platform: "slack",
        runtimeControl: {
          allowed: false,
          approvalMode: "disallowed",
        },
      }),
      {
        hasAgentLoop: true,
        hasToolLoop: true,
      }
    );

    expect(route.kind).toBe("agent_loop");
  });

  it("keeps explanatory long-running-task questions on agent_loop", () => {
    const route = router.selectRoute(
      buildStandaloneIngressMessage({
        text: "長期タスクだとどうしてエラーになるの？",
      }),
      {
        hasAgentLoop: true,
        hasToolLoop: true,
      }
    );

    expect(route.kind).toBe("agent_loop");
  });
});
