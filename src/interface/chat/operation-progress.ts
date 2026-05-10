import type { AgentTimelineActivitySummaryItem } from "../../orchestrator/execution/agent-loop/agent-timeline.js";
import { redactSetupSecretsDeep } from "./setup-secret-intake.js";
import type { GatewayPublicProgress } from "./gateway-progress.js";
import type { TurnLanguageHint } from "./turn-language.js";

export type OperationProgressKind =
  | "started"
  | "checked_status"
  | "read_config"
  | "planned_action"
  | "awaiting_approval"
  | "wrote_config"
  | "verified"
  | "completed"
  | "blocked";

export interface OperationProgressItem {
  id: string;
  kind: OperationProgressKind;
  operation: string;
  title: string;
  detail?: string;
  createdAt: string;
  languageHint?: TurnLanguageHint;
  metadata?: Record<string, unknown>;
  publicProgress?: GatewayPublicProgress;
}

export function createOperationProgressItem(input: OperationProgressItem): OperationProgressItem {
  return {
    ...input,
    title: redactSetupSecretsDeep(input.title) as string,
    ...(input.detail ? { detail: redactSetupSecretsDeep(input.detail) as string } : {}),
    ...(input.metadata ? { metadata: redactSetupSecretsDeep(input.metadata) as Record<string, unknown> } : {}),
    ...(input.publicProgress ? { publicProgress: redactSetupSecretsDeep(input.publicProgress) as GatewayPublicProgress } : {}),
  };
}

export function operationProgressFromAgentActivitySummary(
  summary: AgentTimelineActivitySummaryItem,
  languageHint?: TurnLanguageHint,
): OperationProgressItem {
  return createOperationProgressItem({
    id: `operation-progress:${summary.sourceEventId}`,
    kind: "completed",
    operation: "agent_loop",
    title: "Agent-loop activity summarized",
    detail: summary.text,
    createdAt: summary.createdAt,
    ...(languageHint ? { languageHint } : {}),
    metadata: {
      source: "agent_timeline_activity_summary",
      buckets: summary.buckets,
    },
  });
}

export function renderOperationProgress(item: OperationProgressItem): string {
  const line = `${item.title}${item.detail ? `: ${item.detail}` : ""}`;
  return redactSetupSecretsDeep(line) as string;
}
