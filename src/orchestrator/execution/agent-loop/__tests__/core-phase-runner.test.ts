import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentLoopModelInfo, AgentLoopModelRef } from "../agent-loop-model.js";
import type { BoundedAgentLoopRunner } from "../bounded-agent-loop-runner.js";
import { defaultAgentLoopCapabilities } from "../index.js";
import { CorePhaseRunner, type CorePhaseSpec } from "../core-phase-runner.js";

function makeModelRef(): AgentLoopModelRef {
  return { providerId: "test", modelId: "model" };
}

function makeModelInfo(): AgentLoopModelInfo {
  return {
    ref: makeModelRef(),
    displayName: "test/model",
    capabilities: { ...defaultAgentLoopCapabilities },
  };
}

describe("CorePhaseRunner", () => {
  it("uses DurableLoop naming in model-facing phase instructions", async () => {
    const run = vi.fn().mockResolvedValue({
      success: true,
      output: { ok: true },
      finalText: JSON.stringify({ ok: true }),
      stopReason: "completed",
      traceId: "trace-1",
      sessionId: "session-1",
      turnId: "turn-1",
      modelTurns: 1,
      toolCalls: 0,
      usage: undefined,
      compactions: 0,
      changedFiles: [],
      toolResults: [],
      commandResults: [],
    });
    const phaseRunner = new CorePhaseRunner({
      boundedRunner: { run } as unknown as BoundedAgentLoopRunner,
      model: makeModelRef(),
      modelInfo: makeModelInfo(),
      cwd: "/repo",
    });
    const spec: CorePhaseSpec<{ target: string }, { ok: boolean }> = {
      phase: "public_research",
      inputSchema: z.object({ target: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      requiredTools: [],
      allowedTools: [],
      failPolicy: "return_low_confidence",
    };

    await phaseRunner.run(spec, { target: "docs" }, { goalId: "goal-1" });

    const runInput = run.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemPrompt = runInput.messages.find((message) => message.role === "system")?.content ?? "";
    expect(systemPrompt).toContain("running DurableLoop phase public_research");
    expect(systemPrompt).not.toContain("CoreLoop phase");
  });
});
