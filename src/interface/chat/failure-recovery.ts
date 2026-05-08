import { z } from "zod";
import type { ILLMClient } from "../../base/llm/llm-client.js";

export type FailureRecoveryKind =
  | "permission"
  | "tool_input"
  | "verification"
  | "runtime_interruption"
  | "daemon_loop"
  | "resume"
  | "adapter"
  | "unknown";

export interface FailureRecoveryGuidance {
  kind: FailureRecoveryKind;
  label: string;
  summary: string;
  nextActions: string[];
}

export interface FailureRecoveryToolSignal {
  kind: "tool";
  toolName: string;
  status: "failed" | "cancelled" | "approval_denied";
  disposition?: "respond_to_model" | "fatal" | "approval_denied" | "cancelled";
  code?: string;
}

export interface FailureRecoveryApprovalSignal {
  kind: "approval";
  status: "requested" | "denied" | "blocked";
  toolName?: string;
  permissionLevel?: string;
  isDestructive?: boolean;
  code?: string;
}

export interface FailureRecoveryRuntimeSignal {
  kind: "runtime";
  stoppedReason?: string;
  operationState?: "daemon_loop" | "runtime_control" | "background_run" | "agent_loop";
  code?: string;
}

export interface FailureRecoveryVerificationSignal {
  kind: "verification";
  status: "failed" | "passed" | "not_run";
  code?: string;
}

export interface FailureRecoveryAdapterSignal {
  kind: "adapter";
  adapterType?: string;
  stoppedReason?: string;
  code?: string;
}

export type FailureRecoverySignal =
  | FailureRecoveryToolSignal
  | FailureRecoveryApprovalSignal
  | FailureRecoveryRuntimeSignal
  | FailureRecoveryVerificationSignal
  | FailureRecoveryAdapterSignal;

export interface FailureRecoveryEvidence {
  error?: string;
  stoppedReason?: string | null;
  agentLoopStopReason?: string | null;
  code?: string | null;
  signals?: FailureRecoverySignal[];
}

const MIN_MODEL_CONFIDENCE = 0.7;

const FailureRecoveryFallbackDecisionSchema = z.object({
  kind: z.enum([
    "permission",
    "tool_input",
    "verification",
    "runtime_interruption",
    "daemon_loop",
    "resume",
    "adapter",
    "unknown",
  ]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().optional(),
});

const GUIDANCE_BY_KIND: Record<FailureRecoveryKind, FailureRecoveryGuidance> = {
  permission: {
    kind: "permission",
    label: "Permission failure",
    summary: "The turn stopped because the requested action was blocked by permissions or approval policy.",
    nextActions: [
      "Inspect the requested action before retrying.",
      "Use /permissions to review the current execution policy.",
      "Re-run with a narrower request or explicit approval if the action is expected.",
    ],
  },
  verification: {
    kind: "verification",
    label: "Verification failure",
    summary: "Changes were made, but the configured checks did not pass.",
    nextActions: [
      "Run /review to inspect the current diff and verification context.",
      "Inspect the test output shown with this failure.",
      "Ask for a focused fix for the failing check before continuing.",
    ],
  },
  resume: {
    kind: "resume",
    label: "Resume failure",
    summary: "PulSeed could not find or load the session state needed to continue this turn.",
    nextActions: [
      "Run /sessions to find the intended chat session.",
      "Run /resume <id> when the target session is available.",
      "Start a new turn with the missing context if no resumable state exists.",
    ],
  },
  daemon_loop: {
    kind: "daemon_loop",
    label: "Daemon loop failure",
    summary: "A background loop or runtime-control path stopped before completing successfully.",
    nextActions: [
      "Run /status to inspect the active goal or daemon state.",
      "Use /resume when the session has resumable state.",
      "Check the daemon logs if the failure references runtime internals.",
    ],
  },
  runtime_interruption: {
    kind: "runtime_interruption",
    label: "Runtime interruption",
    summary: "The active turn was interrupted before it could produce a complete final response.",
    nextActions: [
      "Use /resume if PulSeed reports resumable agent-loop state.",
      "Ask for a narrower continuation from the last visible step.",
      "Run /review first if files may have changed before the interruption.",
    ],
  },
  tool_input: {
    kind: "tool_input",
    label: "Tool input failure",
    summary: "A tool or command received input it could not validate.",
    nextActions: [
      "Retry with the exact file, command, or option you want PulSeed to use.",
      "Ask PulSeed to inspect the target before attempting the tool again.",
      "Use /review if the failure happened after a file change.",
    ],
  },
  adapter: {
    kind: "adapter",
    label: "Adapter failure",
    summary: "The configured model or adapter path failed before the turn completed.",
    nextActions: [
      "Retry the turn after checking provider availability.",
      "Use /model to confirm the active provider and adapter.",
      "Narrow the request if the failure happened during a long turn.",
    ],
  },
  unknown: {
    kind: "unknown",
    label: "Unclassified failure",
    summary: "PulSeed did not receive enough structured failure evidence to classify this safely.",
    nextActions: [
      "Run /review if the turn may have changed files.",
      "Retry with a narrower request that names the intended next step.",
      "Use /sessions or /status when the failure relates to session or daemon state.",
    ],
  },
};

const PERMISSION_CODES = new Set([
  "permission_denied",
  "approval_denied",
  "approval_required",
  "sandbox_denied",
  "eacces",
  "eperm",
  "unauthorized",
  "forbidden",
]);

const TOOL_INPUT_CODES = new Set([
  "invalid_tool_input",
  "schema_validation_failed",
  "tool_runtime_failure",
  "tool_fatal",
  "consecutive_tool_errors",
  "missing_required_argument",
  "invalid_argument",
  "parse_error",
]);

const VERIFICATION_CODES = new Set([
  "verification_failed",
  "checks_failed",
  "test_failed",
  "typecheck_failed",
  "lint_failed",
]);

const RESUME_CODES = new Set([
  "resume_state_missing",
  "session_state_missing",
  "agent_loop_state_missing",
]);

const ADAPTER_CODES = new Set([
  "adapter_error",
  "model_error",
  "provider_failure",
  "provider_error",
  "rate_limited",
  "llm_error",
]);

const RUNTIME_INTERRUPTION_CODES = new Set([
  "wall_clock_timeout",
  "model_request_timeout",
  "model_request_aborted",
  "tool_batch_deadline_exceeded",
  "tool_batch_timed_out",
  "tool_cancelled",
  "operator_cancelled",
]);

const RUNTIME_INTERRUPTION_REASONS = new Set([
  "timeout",
  "aborted",
  "abort",
  "cancelled",
  "canceled",
  "interrupted",
  "disconnect",
  "disconnected",
]);

const DAEMON_LOOP_REASONS = new Set([
  "daemon_loop_failed",
  "core_loop_failed",
  "runtime_control_failed",
  "background_run_failed",
  "stalled_tool_loop",
]);

const TOOL_INPUT_REASONS = new Set([
  "invalid_tool_input",
  "schema_validation_failed",
]);

const RESUME_REASONS = new Set([
  "resume_state_missing",
  "session_state_missing",
  "agent_loop_state_missing",
]);

export function classifyFailureRecovery(input: string | FailureRecoveryEvidence): FailureRecoveryGuidance {
  const evidence = normalizeFailureRecoveryEvidence(input);
  const kind = classifyFromStructuredEvidence(evidence);
  return guidanceFor(kind);
}

export async function classifyFailureRecoveryWithFallback(
  input: string | FailureRecoveryEvidence,
  llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">
): Promise<FailureRecoveryGuidance> {
  const evidence = normalizeFailureRecoveryEvidence(input);
  const structuredKind = classifyFromStructuredEvidence(evidence);
  if (structuredKind !== "unknown") return guidanceFor(structuredKind);
  const modelKind = await classifyFailureRecoveryFallback(evidence, llmClient);
  return guidanceFor(modelKind);
}

function normalizeFailureRecoveryEvidence(input: string | FailureRecoveryEvidence): FailureRecoveryEvidence {
  if (typeof input === "string") return { error: input, signals: [] };
  return { ...input, signals: input.signals ?? [] };
}

function classifyFromStructuredEvidence(evidence: FailureRecoveryEvidence): FailureRecoveryKind {
  const signals = evidence.signals ?? [];
  const codes = collectCodes(evidence, signals);
  if (signals.some((signal) => signal.kind === "approval" && (signal.status === "denied" || signal.status === "blocked"))
    || signals.some((signal) => signal.kind === "tool" && signal.status === "approval_denied")
    || signals.some((signal) => signal.kind === "tool" && signal.disposition === "approval_denied")
    || hasAny(codes, PERMISSION_CODES)) {
    return "permission";
  }
  if (signals.some((signal) => signal.kind === "verification" && signal.status === "failed")
    || hasAny(codes, VERIFICATION_CODES)) {
    return "verification";
  }
  if (hasReason(evidence, RESUME_REASONS) || hasAny(codes, RESUME_CODES)) {
    return "resume";
  }
  if (
    signals.some((signal) => signal.kind === "runtime" && signal.operationState === "daemon_loop")
    || hasReason(evidence, DAEMON_LOOP_REASONS)
  ) {
    return "daemon_loop";
  }
  if (
    signals.some((signal) => signal.kind === "tool" && signal.status === "cancelled")
    || signals.some((signal) => signal.kind === "tool" && signal.disposition === "cancelled")
    || hasReason(evidence, RUNTIME_INTERRUPTION_REASONS)
    || hasAny(codes, RUNTIME_INTERRUPTION_CODES)
  ) {
    return "runtime_interruption";
  }
  if (
    signals.some((signal) => signal.kind === "tool" && signal.disposition === "fatal")
    || hasReason(evidence, TOOL_INPUT_REASONS)
    || hasAny(codes, TOOL_INPUT_CODES)
  ) {
    return "tool_input";
  }
  if (signals.some((signal) => signal.kind === "adapter" && signal.stoppedReason && signal.stoppedReason !== "completed")
    || hasAny(codes, ADAPTER_CODES)) {
    return "adapter";
  }
  return "unknown";
}

async function classifyFailureRecoveryFallback(
  evidence: FailureRecoveryEvidence,
  llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">
): Promise<FailureRecoveryKind> {
  if (!llmClient || !evidence.error?.trim()) return "unknown";
  try {
    const response = await llmClient.sendMessage(
      [{ role: "user", content: JSON.stringify({ error: evidence.error }) }],
      {
        system: getFailureRecoveryFallbackPrompt(),
        max_tokens: 256,
        temperature: 0,
        model_tier: "light",
      }
    );
    const decision = llmClient.parseJSON(response.content, FailureRecoveryFallbackDecisionSchema);
    if (decision.confidence < MIN_MODEL_CONFIDENCE) return "unknown";
    return decision.kind;
  } catch {
    return "unknown";
  }
}

function getFailureRecoveryFallbackPrompt(): string {
  return `You classify a PulSeed chat lifecycle failure only when structured runtime evidence is unavailable.

Return JSON: { "kind": "permission" | "tool_input" | "verification" | "runtime_interruption" | "daemon_loop" | "resume" | "adapter" | "unknown", "confidence": 0.0-1.0, "rationale": "short" }.

Use unknown for ambiguous, provider-specific, localized, or low-evidence messages. Do not infer approval, verification, session, runtime, or provider state unless the failure text clearly states that category.`;
}

function collectCodes(evidence: FailureRecoveryEvidence, signals: FailureRecoverySignal[]): Set<string> {
  return new Set([
    normalizeToken(evidence.code),
    ...signals.map((signal) => normalizeToken(signal.code)),
  ].filter((token): token is string => Boolean(token)));
}

function hasAny(values: Set<string>, candidates: Set<string>): boolean {
  for (const value of values) {
    if (candidates.has(value)) return true;
  }
  return false;
}

function hasReason(evidence: FailureRecoveryEvidence, candidates: Set<string>): boolean {
  const reasons = [
    normalizeToken(evidence.stoppedReason),
    normalizeToken(evidence.agentLoopStopReason),
    ...(evidence.signals ?? [])
      .map((signal) => signal.kind === "runtime" || signal.kind === "adapter" ? normalizeToken(signal.stoppedReason) : null),
  ].filter((token): token is string => Boolean(token));
  return reasons.some((reason) => candidates.has(reason));
}

function normalizeToken(value: string | null | undefined): string | null {
  const token = value?.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  return token || null;
}

function guidanceFor(kind: FailureRecoveryKind): FailureRecoveryGuidance {
  return GUIDANCE_BY_KIND[kind];
}

export function formatFailureRecovery(guidance: FailureRecoveryGuidance): string {
  return [
    "Recovery",
    `Type: ${guidance.label}`,
    guidance.summary,
    "Next actions:",
    ...guidance.nextActions.map((action) => `- ${action}`),
  ].join("\n");
}

export function formatLifecycleFailureMessage(
  error: string,
  partialText: string,
  guidance: FailureRecoveryGuidance = classifyFailureRecovery(error)
): string {
  const normalizedPartial = partialText.trim();
  const normalizedError = error.trim();
  const base = normalizedPartial && normalizedPartial !== normalizedError
    ? `${partialText}\n\n[interrupted: ${error}]`
    : normalizedPartial || `Error: ${error}`;
  return `${base}\n\n${formatFailureRecovery(guidance)}`;
}
