import {
  projectSurfaceDelivery,
  renderSurfaceDeliveryProjection,
} from "../attention/index.js";
import type { ActivityEvent } from "../../interface/chat/chat-events.js";
import type { OperationProgressItem } from "../../interface/chat/operation-progress.js";
import type { AgentTimelineItem } from "../../orchestrator/execution/agent-loop/agent-timeline.js";
import {
  publicProgressFromActivityEvent,
  publicProgressFromAgentTimelineItem,
  publicProgressFromOperationProgress,
  publicProgressFromToolEvent,
  renderGatewayPublicProgress,
} from "./gateway-progress-narration.js";
import type {
  ExpressionDecision,
  ExpressionSurfaceClass,
  OutcomeDecision,
  VisibilityPolicy,
} from "../types/companion-autonomy.js";

interface FailureRecoveryGuidanceLike {
  label: string;
  summary: string;
  nextActions: string[];
}

export function renderGatewayOperationProgress(item: OperationProgressItem): string | null {
  const narrated = renderGatewayPublicProgress(publicProgressFromOperationProgress(item));
  if (item.publicProgress) return narrated ? redactSetupSecrets(narrated) : null;
  return redactSetupSecrets(narrated ?? `${item.title}${item.detail ? `: ${item.detail}` : ""}`);
}

export function renderGatewayActivityEvent(item: ActivityEvent): string | null {
  if (item.sourceId?.startsWith("lifecycle:")) return null;
  const narrated = renderGatewayPublicProgress(publicProgressFromActivityEvent(item));
  if (narrated) return redactSetupSecrets(narrated);
  switch (item.kind) {
    case "lifecycle":
      return null;
    case "commentary":
      return item.presentation?.gatewayProgress === "user"
        ? redactSetupSecrets(item.message)
        : null;
    case "checkpoint":
      return item.presentation?.gatewayProgress === "user"
        ? redactSetupSecrets(item.message)
        : null;
    case "tool":
    case "plugin":
    case "skill":
    case "diff":
      return item.presentation?.gatewayProgress === "user"
        ? redactSetupSecrets(item.message)
        : null;
  }
}

export function renderGatewayToolProgressEvent(item: Parameters<typeof publicProgressFromToolEvent>[0]): string | null {
  const narrated = renderGatewayPublicProgress(publicProgressFromToolEvent(item));
  return narrated ? redactSetupSecrets(narrated) : null;
}

export function renderGatewayExpressionDecision(input: {
  renderId: string;
  renderedAt: string;
  surfaceClass?: Extract<ExpressionSurfaceClass, "gateway" | "notification">;
  outcomeDecision: OutcomeDecision;
  expressionDecision?: ExpressionDecision | null;
  visibilityPolicy: VisibilityPolicy;
}): string | null {
  const delivery = projectSurfaceDelivery({
    renderId: input.renderId,
    renderedAt: input.renderedAt,
    surfaceClass: input.surfaceClass ?? "gateway",
    outcomeDecision: input.outcomeDecision,
    expressionDecision: input.expressionDecision,
    visibilityPolicy: input.visibilityPolicy,
  });
  const rendered = renderSurfaceDeliveryProjection(delivery);
  return rendered ? redactSetupSecrets(rendered) : null;
}

export function renderGatewayAgentTimelineItem(item: AgentTimelineItem): string | null {
  const narrated = renderGatewayPublicProgress(publicProgressFromAgentTimelineItem(item));
  return narrated ? redactSetupSecrets(narrated) : null;
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

export function redactSetupSecrets(value: string): string {
  return value
    .replace(/bot_token=([^\s&]+)/gi, "bot_token=[REDACTED:token]")
    .replace(/([?&]token=)([^&\s]+)/gi, "$1[REDACTED:token]")
    .replace(/(xox[baprs]-)[A-Za-z0-9-]+/g, "$1[REDACTED:token]");
}
