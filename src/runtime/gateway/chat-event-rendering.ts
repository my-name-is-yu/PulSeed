import { renderExpressionDecisionForSurface } from "../attention/index.js";
import type {
  ExpressionDecision,
  ExpressionSurfaceClass,
  OutcomeDecision,
  VisibilityPolicy,
} from "../types/companion-autonomy.js";

interface OperationProgressItemLike {
  title: string;
  detail?: string;
}

interface FailureRecoveryGuidanceLike {
  label: string;
  summary: string;
  nextActions: string[];
}

interface ActivityEventLike {
  kind: "lifecycle" | "commentary" | "checkpoint" | "diff" | "tool" | "plugin" | "skill";
  message: string;
  presentation?: {
    gatewayProgress?: "user" | "internal";
  };
}

interface AgentTimelineItemLike {
  kind: "lifecycle" | "turn_context" | "model_request" | "assistant_message" | "tool" | "tool_observation" | "plan" | "approval" | "compaction" | "activity_summary" | "final" | "stopped";
  status?: string;
  restoredMessages?: number;
  fromUpdatedAt?: string;
  model?: string;
  visibleTools?: unknown[];
  toolCount?: number;
  text?: string;
  inputPreview?: string;
  outputPreview?: string;
  success?: boolean;
  toolName?: string;
  state?: string;
  summary?: string;
  reason?: string;
  phase?: string;
  inputMessages?: number;
  outputMessages?: number;
  reasonDetail?: string;
}

export function renderGatewayOperationProgress(item: OperationProgressItemLike): string {
  return redactSetupSecrets(`${item.title}${item.detail ? `: ${item.detail}` : ""}`);
}

export function renderGatewayActivityEvent(item: ActivityEventLike): string | null {
  switch (item.kind) {
    case "lifecycle":
    case "commentary":
      return null;
    case "checkpoint":
      return item.presentation?.gatewayProgress === "user"
        ? redactSetupSecrets(item.message)
        : null;
    case "diff":
    case "tool":
    case "plugin":
    case "skill":
      return redactSetupSecrets(item.message);
  }
}

export function renderGatewayExpressionDecision(input: {
  renderId: string;
  renderedAt: string;
  surfaceClass?: Extract<ExpressionSurfaceClass, "gateway" | "notification">;
  outcomeDecision: OutcomeDecision;
  expressionDecision?: ExpressionDecision | null;
  visibilityPolicy: VisibilityPolicy;
}): string | null {
  const rendered = renderExpressionDecisionForSurface({
    render_id: input.renderId,
    rendered_at: input.renderedAt,
    surface_class: input.surfaceClass ?? "gateway",
    outcome_decision: input.outcomeDecision,
    expression_decision: input.expressionDecision,
    visibility_policy: input.visibilityPolicy,
  });
  return rendered ? redactSetupSecrets(rendered.user_facing_rationale) : null;
}

export function renderGatewayAgentTimelineItem(item: AgentTimelineItemLike): string | null {
  switch (item.kind) {
    case "lifecycle":
    case "turn_context":
    case "model_request":
    case "compaction":
      return null;
    case "assistant_message":
      if (item.phase === "commentary") return null;
      return redactSetupSecrets(item.text ?? "");
    case "tool": {
      const detail = item.status === "started" ? item.inputPreview : item.outputPreview;
      const label = item.status === "started" ? "Started" : item.success ? "Finished" : "Failed";
      return detail ? `${label} ${item.toolName ?? "tool"}: ${redactSetupSecrets(detail)}` : `${label} ${item.toolName ?? "tool"}.`;
    }
    case "tool_observation":
      return `Observed ${item.toolName ?? "tool"} (${item.state ?? "unknown"}): ${redactSetupSecrets(item.outputPreview ?? "")}`;
    case "plan":
      return `Plan changed: ${redactSetupSecrets(item.summary ?? "")}`;
    case "approval":
      return item.status === "requested"
        ? `Approval requested for ${item.toolName ?? "tool"}: ${redactSetupSecrets(item.reason ?? "")}`
        : `Approval denied for ${item.toolName ?? "tool"}: ${redactSetupSecrets(item.reason ?? "")}`;
    case "activity_summary":
      return redactSetupSecrets(item.text ?? "");
    case "final":
      return redactSetupSecrets(item.outputPreview ?? "");
    case "stopped":
      if (item.reason === "completed") return null;
      return item.reasonDetail ? `Stopped: ${item.reason ?? "unknown"} (${redactSetupSecrets(item.reasonDetail)})` : `Stopped: ${item.reason ?? "unknown"}`;
  }
}

export function formatGatewayLifecycleFailureMessage(
  error: string,
  partialText: string,
  guidance: FailureRecoveryGuidanceLike,
): string {
  const normalizedPartial = partialText.trim();
  const normalizedError = error.trim();
  const base = normalizedPartial && normalizedPartial !== normalizedError
    ? `${partialText}\n\n[interrupted: ${error}]`
    : normalizedPartial || `Error: ${error}`;
  return `${base}\n\n${formatFailureRecovery(guidance)}`;
}

function formatFailureRecovery(guidance: FailureRecoveryGuidanceLike): string {
  return [
    "Recovery",
    `Type: ${guidance.label}`,
    guidance.summary,
    "Next actions:",
    ...guidance.nextActions.map((action) => `- ${action}`),
  ].join("\n");
}

function redactSetupSecrets(value: string): string {
  return value
    .replace(/bot_token=([^\s&]+)/gi, "bot_token=[REDACTED:token]")
    .replace(/([?&]token=)([^&\s]+)/gi, "$1[REDACTED:token]")
    .replace(/(xox[baprs]-)[A-Za-z0-9-]+/g, "$1[REDACTED:token]");
}
