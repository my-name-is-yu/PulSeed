import { vi } from "vitest";
import type {
  AgentLoopModelClient,
  AgentLoopModelInfo,
  AgentLoopModelRef,
  AgentLoopModelRegistry,
} from "../../src/orchestrator/execution/agent-loop/agent-loop-model.js";
import { defaultAgentLoopCapabilities } from "../../src/orchestrator/execution/agent-loop/agent-loop-model.js";
import type { BoundedAgentLoopRunner } from "../../src/orchestrator/execution/agent-loop/bounded-agent-loop-runner.js";

export function makeAgentLoopModelRef(overrides: Partial<AgentLoopModelRef> = {}): AgentLoopModelRef {
  return {
    providerId: "test",
    modelId: "model",
    ...overrides,
  };
}

export function makeAgentLoopModelInfo(overrides: Partial<AgentLoopModelInfo> = {}): AgentLoopModelInfo {
  const ref = overrides.ref ?? makeAgentLoopModelRef();
  return {
    ref,
    displayName: `${ref.providerId}/${ref.modelId}`,
    capabilities: { ...defaultAgentLoopCapabilities, ...overrides.capabilities },
    ...overrides,
  };
}

export function makeAgentLoopModelClient(modelInfo = makeAgentLoopModelInfo()): AgentLoopModelClient {
  return {
    createTurn: vi.fn(),
    getModelInfo: vi.fn().mockResolvedValue(modelInfo),
  } as unknown as AgentLoopModelClient;
}

export function makeAgentLoopModelRegistry(modelInfo = makeAgentLoopModelInfo()): AgentLoopModelRegistry {
  return {
    list: vi.fn().mockResolvedValue([modelInfo]),
    get: vi.fn().mockResolvedValue(modelInfo),
    defaultModel: vi.fn().mockResolvedValue(modelInfo.ref),
  };
}

export function makeBoundedAgentLoopRunner(output: Partial<Awaited<ReturnType<BoundedAgentLoopRunner["run"]>>> = {}): BoundedAgentLoopRunner {
  return {
    run: vi.fn().mockResolvedValue({
      success: true,
      output: {
        status: "done",
        finalAnswer: "finished",
        summary: "summary",
        filesChanged: [],
        testsRun: [],
        completionEvidence: ["bounded runner reached"],
        verificationHints: [],
        blockers: [],
      },
      finalText: "finished",
      stopReason: "completed",
      elapsedMs: 1,
      modelTurns: 1,
      toolCalls: 0,
      compactions: 0,
      changedFiles: [],
      commandResults: [],
      traceId: "trace-1",
      sessionId: "session-1",
      turnId: "turn-1",
      ...output,
    }),
  } as unknown as BoundedAgentLoopRunner;
}
