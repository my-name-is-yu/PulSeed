import type { ToolDefinition } from "../../../base/llm/llm-client.js";
import type { ToolActivityCategory } from "../../../tools/types.js";
import type { AgentLoopSandboxMode } from "./execution-policy.js";
import type { ResponseItem } from "./response-item.js";

export interface AgentLoopModelRef {
  providerId: string;
  modelId: string;
  variant?: string;
}

export interface AgentLoopModelCapabilities {
  /** Native provider function/tool calling support; prompted text protocols can still run the loop. */
  toolCalling: boolean;
  parallelToolCalls: boolean;
  streaming: boolean;
  structuredOutput: boolean;
  reasoning: boolean;
  attachments: boolean;
  interleavedThinking: boolean;
  inputModalities: Array<"text" | "image" | "audio" | "video" | "pdf">;
  outputModalities: Array<"text" | "image" | "audio" | "video" | "pdf">;
  contextLimitTokens?: number;
  outputLimitTokens?: number;
}

export interface AgentLoopModelInfo {
  ref: AgentLoopModelRef;
  displayName: string;
  capabilities: AgentLoopModelCapabilities;
  providerOptions?: Record<string, unknown>;
  modelOptions?: Record<string, unknown>;
}

export type AgentLoopMessageRole = "system" | "user" | "assistant" | "tool";
export type AgentLoopMessagePhase = "commentary" | "final_answer";
export type AgentLoopReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AgentLoopMessage {
  role: AgentLoopMessageRole;
  content: string;
  phase?: AgentLoopMessagePhase;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: AgentLoopToolCall[];
  observation?: AgentLoopToolObservation;
}

export interface AgentLoopToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type AgentLoopToolObservationState =
  | "success"
  | "failure"
  | "denied"
  | "blocked"
  | "timed_out"
  | "interrupted";

export type AgentLoopToolObservationReason =
  | "approval_denied"
  | "permission_denied"
  | "policy_blocked"
  | "dry_run"
  | "tool_error"
  | "timed_out"
  | "interrupted"
  | "sandbox_required"
  | "escalation_required"
  | "stale_state";

export interface AgentLoopToolObservationExecution {
  status: "executed" | "not_executed";
  reason?: AgentLoopToolObservationReason;
  message?: string;
}

export interface AgentLoopToolObservation {
  type: "tool_observation";
  callId: string;
  toolName: string;
  arguments: unknown;
  state: AgentLoopToolObservationState;
  success: boolean;
  execution?: AgentLoopToolObservationExecution;
  durationMs: number;
  output: {
    content: string;
    summary?: string;
    data?: unknown;
    error?: string;
  };
  command?: string;
  cwd?: string;
  artifacts?: string[];
  truncated?: {
    originalChars: number;
    overflowPath?: string;
  };
  activityCategory?: ToolActivityCategory;
}

export interface AgentLoopModelRequest {
  model: AgentLoopModelRef;
  messages: AgentLoopMessage[];
  tools: ToolDefinition[];
  system?: string;
  maxOutputTokens?: number;
  reasoningEffort?: AgentLoopReasoningEffort;
  cwd?: string;
  sandboxMode?: AgentLoopSandboxMode;
  abortSignal?: AbortSignal;
}

export interface AgentLoopAssistantOutput {
  content: string;
  phase?: AgentLoopMessagePhase;
}

export interface AgentLoopModelResponse {
  content: string;
  toolCalls: AgentLoopToolCall[];
  stopReason: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface AgentLoopModelTurnProtocol {
  assistant: AgentLoopAssistantOutput[];
  toolCalls: AgentLoopToolCall[];
  /** Canonical provider output items, preserving text/reasoning/tool-call boundaries. */
  responseItems?: ResponseItem[];
  stopReason: string;
  responseCompleted: boolean;
  providerResponseId?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface AgentLoopModelRegistry {
  list(): Promise<AgentLoopModelInfo[]>;
  get(ref: AgentLoopModelRef): Promise<AgentLoopModelInfo>;
  defaultModel(): Promise<AgentLoopModelRef>;
  smallModel?(providerId: string): Promise<AgentLoopModelRef | null>;
}

export interface AgentLoopModelClient {
  createTurn(input: AgentLoopModelRequest): Promise<AgentLoopModelResponse>;
  createTurnProtocol?(input: AgentLoopModelRequest): Promise<AgentLoopModelTurnProtocol>;
  getModelInfo(ref: AgentLoopModelRef): Promise<AgentLoopModelInfo>;
}

export const defaultAgentLoopCapabilities: AgentLoopModelCapabilities = {
  toolCalling: true,
  parallelToolCalls: false,
  streaming: false,
  structuredOutput: false,
  reasoning: false,
  attachments: false,
  interleavedThinking: false,
  inputModalities: ["text"],
  outputModalities: ["text"],
};

export function parseAgentLoopModelRef(value: string): AgentLoopModelRef {
  const [providerId, ...modelParts] = value.split("/");
  if (!providerId || modelParts.length === 0 || modelParts.join("/").trim() === "") {
    throw new Error(`Invalid model ref "${value}". Expected "provider/model".`);
  }
  return { providerId, modelId: modelParts.join("/") };
}

export function formatAgentLoopModelRef(ref: AgentLoopModelRef): string {
  return `${ref.providerId}/${ref.modelId}${ref.variant ? `#${ref.variant}` : ""}`;
}

export function formatAgentLoopToolMessageContent(message: AgentLoopMessage): string {
  if (message.role !== "tool" || !message.observation) return message.content;
  return stringifyToolObservation(message.observation);
}

function stringifyToolObservation(observation: AgentLoopToolObservation): string {
  try {
    return JSON.stringify(observation, null, 2);
  } catch {
    return JSON.stringify({
      type: "tool_observation",
      callId: observation.callId,
      toolName: observation.toolName,
      state: observation.state,
      success: observation.success,
      durationMs: observation.durationMs,
      output: observation.output.content,
    }, null, 2);
  }
}
