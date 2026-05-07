import { z } from "zod";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import {
  PermissionGrantCapabilitySchema,
  PermissionGrantExcludedCapabilitySchema,
  type PermissionGrantCapability,
  type PermissionGrantExcludedCapability,
} from "../store/permission-grant-store.js";
import {
  RuntimeControlOperationKindSchema,
  type RuntimeControlOperationKind,
} from "../store/runtime-operation-schemas.js";

export interface RuntimeControlIntent {
  kind: RuntimeControlOperationKind;
  reason: string;
  target?: RuntimeControlTargetHint;
  targetSelector?: RuntimeControlTargetSelector;
  externalActions?: string[];
  irreversible?: boolean;
  permissionCapabilities?: PermissionGrantCapability[];
  permissionExcludedCapabilities?: PermissionGrantExcludedCapability[];
}

export interface RuntimeControlTargetHint {
  runId?: string;
  sessionId?: string;
  grantId?: string;
}

export interface RuntimeControlTargetSelector {
  scope: "run" | "session";
  reference: "current" | "latest" | "previous" | "mentioned" | "exact";
  sourceText: string;
}

export type RuntimeControlIntentClassification =
  | { status: "intent"; intent: RuntimeControlIntent }
  | { status: "none" }
  | { status: "unclassified" };

const RuntimeControlIntentDecisionSchema = z.object({
  intent: z.enum(["none", ...RuntimeControlOperationKindSchema.options]),
  reason: z.string().min(1).optional(),
  target: z.object({
    runId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    grantId: z.string().min(1).optional(),
  }).optional(),
  targetSelector: z.object({
    scope: z.enum(["run", "session"]),
    reference: z.enum(["current", "latest", "previous", "mentioned", "exact"]),
    sourceText: z.string().min(1),
  }).optional(),
  externalActions: z.array(z.enum([
    "submit",
    "publish",
    "secret",
    "production_mutation",
    "destructive_cleanup",
  ])).optional(),
  irreversible: z.boolean().optional(),
  permissionCapabilities: z.array(PermissionGrantCapabilitySchema).optional(),
  permissionExcludedCapabilities: z.array(PermissionGrantExcludedCapabilitySchema).optional(),
});

type RuntimeControlIntentDecision = z.infer<typeof RuntimeControlIntentDecisionSchema>;

function buildRuntimeControlIntentSystemPrompt(): string {
  return `You classify one operator chat message for PulSeed runtime control routing.

Decide whether the user's primary intent is to operate on an existing active or recent long-running runtime session, or on the PulSeed daemon/gateway itself.

Return only JSON matching:
{
  "intent": "none" | "restart_daemon" | "restart_gateway" | "reload_config" | "self_update" | "inspect_run" | "pause_run" | "resume_run" | "cancel_run" | "finalize_run" | "inspect_permission_boundary" | "revoke_permission" | "narrow_permission" | "extend_permission" | "audit_permission_check",
  "reason": "short reason using the user's words",
  "target": { "runId": "optional exact run id", "sessionId": "optional exact session id", "grantId": "optional exact permission grant id" },
  "targetSelector": { "scope": "run" | "session", "reference": "current" | "latest" | "previous" | "mentioned" | "exact", "sourceText": "quoted user reference" },
  "externalActions": ["submit" | "publish" | "secret" | "production_mutation" | "destructive_cleanup"],
  "irreversible": true | false,
  "permissionCapabilities": ["write_workspace" | "run_tests"],
  "permissionExcludedCapabilities": ["write_remote" | "network_send"]
}

Classification rules:
- Choose inspect_run, pause_run, resume_run, cancel_run, or finalize_run only when the user is asking to inspect/control/cancel/finalize an existing runtime run/session/execution.
- Choose none for ordinary project work, coding requests, implementation continuation, evidence/progress Q&A, status questions, explanations, help, or requests to create/start new work.
- Choose none for broad follow-ups like "continue", "finish the implementation", or "続けて" unless the message itself clearly refers to resuming/finalizing a runtime run/session/execution.
- Choose reload_config when the user asks to reload PulSeed runtime/gateway/daemon configuration.
- Choose self_update when the user asks PulSeed to update itself.
- Choose cancel_run when the user asks to stop or cancel an existing runtime run/session/execution.
- Choose finalize_run for closing/finalizing a run. Mark irreversible true.
- Choose inspect_permission_boundary when the user asks what PulSeed is allowed to do, what permission boundary is active, or why approval was not needed.
- Choose revoke_permission when the user asks to revoke, cancel, remove, or stop an active permission grant.
- Choose narrow_permission when the user asks to keep a permission but remove capabilities. Include the remaining allowed permissionCapabilities when clear.
- Choose extend_permission when the user asks to broaden an existing grant. Include permissionCapabilities when clear; the runtime may still require confirmation.
- Choose audit_permission_check when the user asks why a permission was reused, why PulSeed asked again, or whether a boundary was hit.
- If finalize would involve external submit/publish, secrets, production mutation, or destructive cleanup, include the matching externalActions. Do not assume these actions should execute.
- If the user names a run id, session id, or permission grant id, copy it exactly into target. Otherwise omit target.
- If the user refers to a run/session by natural language such as current, latest, previous, or mentioned/that run, include targetSelector instead of inventing an id.
- Use restart_daemon/restart_gateway only when the user is asking to restart the PulSeed daemon or gateway, not for run/session pause/resume/finalize.
- When uncertain, choose none.`;
}

export async function recognizeRuntimeControlIntent(
  input: string,
  llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">
): Promise<RuntimeControlIntent | null> {
  const classification = await classifyRuntimeControlIntent(input, llmClient);
  return classification.status === "intent" ? classification.intent : null;
}

export async function classifyRuntimeControlIntent(
  input: string,
  llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">
): Promise<RuntimeControlIntentClassification> {
  const trimmed = input.trim();
  if (!trimmed || !llmClient) return { status: "none" };

  const response = await llmClient.sendMessage(
    [{ role: "user", content: trimmed }],
    {
      system: buildRuntimeControlIntentSystemPrompt(),
      max_tokens: 512,
      temperature: 0,
      model_tier: "light",
    }
  );
  try {
    const decision = llmClient.parseJSON(response.content, RuntimeControlIntentDecisionSchema);
    const intent = toRuntimeControlIntent(trimmed, decision);
    return intent ? { status: "intent", intent } : { status: "none" };
  } catch {
    return { status: "unclassified" };
  }
}

function toRuntimeControlIntent(
  input: string,
  decision: RuntimeControlIntentDecision
): RuntimeControlIntent | null {
  if (decision.intent === "none") return null;
  const target = normalizeTarget(decision.target);
  return {
    kind: decision.intent,
    reason: decision.reason?.trim() || input,
    ...(target ? { target } : {}),
    ...(decision.targetSelector ? { targetSelector: decision.targetSelector } : {}),
    ...(decision.externalActions && decision.externalActions.length > 0
      ? { externalActions: [...new Set(decision.externalActions)] }
      : {}),
    ...(decision.intent === "finalize_run" || decision.irreversible
      ? { irreversible: true }
      : {}),
    ...(decision.permissionCapabilities && decision.permissionCapabilities.length > 0
      ? { permissionCapabilities: [...new Set(decision.permissionCapabilities)] }
      : {}),
    ...(decision.permissionExcludedCapabilities && decision.permissionExcludedCapabilities.length > 0
      ? { permissionExcludedCapabilities: [...new Set(decision.permissionExcludedCapabilities)] }
      : {}),
  };
}

function normalizeTarget(target: RuntimeControlIntentDecision["target"]): RuntimeControlTargetHint | null {
  const runId = target?.runId?.trim();
  const sessionId = target?.sessionId?.trim();
  const grantId = target?.grantId?.trim();
  if (!runId && !sessionId && !grantId) return null;
  return {
    ...(runId ? { runId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(grantId ? { grantId } : {}),
  };
}
