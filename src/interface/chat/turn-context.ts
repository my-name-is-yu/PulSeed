import type { ExecutionPolicy } from "../../orchestrator/execution/agent-loop/execution-policy.js";
import type {
  RuntimeControlActor,
  RuntimeControlReplyTarget,
} from "../../runtime/store/runtime-operation-schemas.js";
import type { ChatEventContext } from "./chat-events.js";
import type { ChatCompactionRecord, ChatMessage, RunSpecConfirmationState } from "./chat-history.js";
import type { RuntimeControlChatContext } from "./chat-runner-contracts.js";
import type { SelectedChatRoute } from "./ingress-router.js";
import type { SetupDialoguePublicState } from "./setup-dialogue.js";
import type { SetupSecretIntakeResult } from "./setup-secret-intake.js";
import { USER_INPUT_SCHEMA_VERSION, type UserInput } from "./user-input.js";
import {
  createCompanionCharacterPolicyCognitionPolicyRef,
  CompanionCharacterPolicyProjectionSchema,
  type CompanionCharacterDialogueStrategy,
  type CompanionCharacterPolicyProjection,
  type CompanionCharacterSurfacePolicy,
} from "../../runtime/decision/companion-character-policy-projection.js";
import type { CognitionPolicyRef } from "../../runtime/decision/companion-decision-contract.js";

export const CHAT_TURN_CONTEXT_SCHEMA_VERSION = "chat-turn-context-v1";

export interface ChatTurnContext {
  schema_version: typeof CHAT_TURN_CONTEXT_SCHEMA_VERSION;
  modelVisible: ChatTurnModelVisibleContext;
  hostOnly: ChatTurnHostOnlyContext;
}

export interface ChatTurnModelVisibleContext {
  turn: {
    runId: string;
    turnId: string;
    startedAt: string;
    currentDate: string;
    timezone: string;
  };
  session: {
    sessionId: string | null;
	    cwd: string;
	    gitRoot: string;
	    nativeAgentLoopSessionId: string | null;
	    nativeAgentLoopStatePath: string | null;
    route: {
      kind: string;
      reason: string;
    } | null;
  };
  input: {
    text: string;
    userInput: PublicUserInput;
  };
  conversation: {
    compactionSummary: string | null;
    compactionRecords: PublicCompactionRecord[];
    priorTurns: Array<{ role: "user" | "assistant"; content: string }>;
  };
  prompts: {
    basePrompt: string;
    prompt: string;
  };
  instructions: {
    systemPrompt: string;
    agentLoopSystemPrompt: string;
  };
  runtime: {
    approvalMode: "interactive" | "preapproved" | "disallowed";
    runtimeControlAllowed: boolean;
    replyTarget: PublicReplyTarget | null;
    actor: PublicRuntimeActor | null;
  };
  characterPolicy: PublicCharacterPolicyContext | null;
  tools: {
    activatedTools: string[];
    selectedRoute: string | null;
  };
  outstanding: {
    setupDialogue: PublicSetupDialogueState | null;
    runSpecConfirmation: PublicRunSpecConfirmationState | null;
  };
  runtimeEvidence: {
    status: "not_requested" | "unavailable";
    refs: string[];
  };
}

export interface ChatTurnHostOnlyContext {
  execution: {
    cwd: string;
    gitRoot: string;
    executionCwd: string;
    goalId?: string;
    executionPolicy: ExecutionPolicy;
  };
  runtime: {
    runtimeControlContext: RuntimeControlChatContext | null;
    fallbackReplyTarget?: RuntimeControlReplyTarget;
    fallbackActor?: RuntimeControlActor;
  };
  setupSecretIntake: SetupSecretIntakeResult | null;
}

export interface ChatTurnContextInput {
  eventContext: ChatEventContext;
  startedAt: Date;
  timezone?: string;
  sessionId: string | null;
  cwd: string;
  gitRoot: string;
	  executionCwd: string;
	  nativeAgentLoopSessionId?: string | null;
	  nativeAgentLoopStatePath: string | null;
  selectedRoute: SelectedChatRoute | null;
  input: string;
  userInput: UserInput;
  compactionSummary?: string | null;
  compactionRecords?: ChatCompactionRecord[] | null;
  priorTurns: ChatMessage[];
  basePrompt: string;
  prompt: string;
  systemPrompt: string;
  agentLoopSystemPrompt: string;
  runtimeControlContext: RuntimeControlChatContext | null;
  fallbackReplyTarget?: RuntimeControlReplyTarget;
  fallbackActor?: RuntimeControlActor;
  executionGoalId?: string;
  executionPolicy: ExecutionPolicy;
  setupDialogue: SetupDialoguePublicState | null;
  runSpecConfirmation: RunSpecConfirmationState | null;
  setupSecretIntake: SetupSecretIntakeResult | null;
  activatedTools: Set<string>;
  characterPolicy?: PublicCharacterPolicyContext | null;
}

export interface ChatTurnContextSnapshot {
  schema_version: typeof CHAT_TURN_CONTEXT_SCHEMA_VERSION;
  modelVisible: ChatTurnModelVisibleContext;
}

interface PublicReplyTarget {
  surface?: string;
  platform?: string;
  conversation_id?: string;
  identity_key?: string;
  user_id?: string;
  message_id?: string;
  deliveryMode?: string;
}

interface PublicRuntimeActor {
  surface?: string;
  platform?: string;
  conversation_id?: string;
  identity_key?: string;
  user_id?: string;
}

export interface PublicCharacterPolicyContext {
  policyRef: CognitionPolicyRef;
  dialogueStrategy: CompanionCharacterDialogueStrategy;
  surfacePolicy: CompanionCharacterSurfacePolicy;
  authority: {
    characterCanRelaxSafetyBoundary: false;
    characterCanRelaxApprovalBoundary: false;
    characterCanGrantAutonomy: false;
  };
}

interface PublicSetupDialogueState {
  id: string;
  channel: string;
  state: string;
  action?: string;
  updatedAt?: string;
}

interface PublicRunSpecConfirmationState {
  state: RunSpecConfirmationState["state"];
  specId: string;
  createdAt: string;
  updatedAt: string;
}

interface PublicCompactionRecord {
  sequence: number;
  createdAt: string;
  reason: string;
  summary: string;
  inputMessageCount: number;
  outputMessageCount: number;
  removedMessageCount: number;
  retainedMessageCount: number;
  pendingPermissions: ChatCompactionRecord["pendingPermissions"];
  activeTargets: ChatCompactionRecord["activeTargets"];
  replacementHistory: ChatCompactionRecord["replacementHistory"];
}

interface PublicUserInput {
  schema_version: typeof USER_INPUT_SCHEMA_VERSION;
  rawText?: string;
  items: PublicUserInputItem[];
}

type PublicUserInputItem =
  | { kind: "text"; text: string }
  | { kind: "image"; name?: string }
  | { kind: "local_image"; name?: string }
  | { kind: "mention"; label?: string }
  | { kind: "skill"; name: string }
  | { kind: "plugin"; name: string }
  | { kind: "tool"; name: string }
  | { kind: "attachment"; id: string; name?: string; mimeType?: string };

export function buildChatTurnContext(input: ChatTurnContextInput): ChatTurnContext {
  const route = input.selectedRoute
    ? { kind: input.selectedRoute.kind, reason: input.selectedRoute.reason }
    : null;
  const runtimeControlContext = input.runtimeControlContext;
  return {
    schema_version: CHAT_TURN_CONTEXT_SCHEMA_VERSION,
    modelVisible: {
      turn: {
        runId: input.eventContext.runId,
        turnId: input.eventContext.turnId,
        startedAt: input.startedAt.toISOString(),
        currentDate: input.startedAt.toISOString(),
        timezone: input.timezone ?? resolveLocalTimezone(),
      },
      session: {
        sessionId: input.sessionId,
	        cwd: input.cwd,
	        gitRoot: input.gitRoot,
	        nativeAgentLoopSessionId: input.nativeAgentLoopSessionId ?? null,
	        nativeAgentLoopStatePath: input.nativeAgentLoopStatePath,
        route,
      },
      input: {
        text: input.input,
        userInput: toPublicUserInput(input.userInput, input.input),
      },
      conversation: {
        compactionSummary: input.compactionSummary?.trim() ? input.compactionSummary : null,
        compactionRecords: toPublicCompactionRecords(input.compactionRecords),
        priorTurns: input.priorTurns.map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: message.content,
        })),
      },
      prompts: {
        basePrompt: input.basePrompt,
        prompt: input.prompt,
      },
      instructions: {
        systemPrompt: input.systemPrompt,
        agentLoopSystemPrompt: input.agentLoopSystemPrompt,
      },
      runtime: {
        approvalMode: runtimeControlContext?.approvalMode ?? "interactive",
        runtimeControlAllowed: runtimeControlContext?.allowed ?? true,
        replyTarget: toPublicReplyTarget(runtimeControlContext?.replyTarget ?? null),
        actor: toPublicActor(runtimeControlContext?.actor ?? null),
      },
      characterPolicy: input.characterPolicy ?? null,
      tools: {
        activatedTools: [...input.activatedTools].sort(),
        selectedRoute: route?.kind ?? null,
      },
      outstanding: {
        setupDialogue: toPublicSetupDialogue(input.setupDialogue),
        runSpecConfirmation: toPublicRunSpecConfirmation(input.runSpecConfirmation),
      },
      runtimeEvidence: {
        status: "not_requested",
        refs: [],
      },
    },
    hostOnly: {
      execution: {
        cwd: input.cwd,
        gitRoot: input.gitRoot,
        executionCwd: input.executionCwd,
        ...(input.executionGoalId ? { goalId: input.executionGoalId } : {}),
        executionPolicy: input.executionPolicy,
      },
      runtime: {
        runtimeControlContext,
        ...(input.fallbackReplyTarget ? { fallbackReplyTarget: input.fallbackReplyTarget } : {}),
        ...(input.fallbackActor ? { fallbackActor: input.fallbackActor } : {}),
      },
      setupSecretIntake: input.setupSecretIntake,
    },
  };
}

export function renderModelVisibleTurnContext(context: ChatTurnModelVisibleContext): string {
  const compactionRecordLines = context.conversation.compactionRecords.flatMap(renderCompactionRecord);
  const lines = [
    "## Turn Context",
    `- turn_id: ${context.turn.turnId}`,
    `- run_id: ${context.turn.runId}`,
    `- current_date: ${context.turn.currentDate}`,
    `- timezone: ${context.turn.timezone}`,
    `- cwd: ${context.session.cwd}`,
    `- git_root: ${context.session.gitRoot}`,
    `- session_id: ${context.session.sessionId ?? "none"}`,
    `- route: ${context.session.route ? `${context.session.route.kind} (${context.session.route.reason})` : "none"}`,
    `- runtime_control_allowed: ${context.runtime.runtimeControlAllowed}`,
    `- approval_mode: ${context.runtime.approvalMode}`,
    `- reply_target: ${formatReplyTarget(context.runtime.replyTarget)}`,
    ...renderCharacterPolicyContext(context.characterPolicy),
    `- activated_tools: ${context.tools.activatedTools.length > 0 ? context.tools.activatedTools.join(", ") : "none"}`,
    `- setup_dialogue: ${context.outstanding.setupDialogue ? `${context.outstanding.setupDialogue.channel}:${context.outstanding.setupDialogue.state}` : "none"}`,
    `- run_spec_confirmation: ${context.outstanding.runSpecConfirmation ? `${context.outstanding.runSpecConfirmation.state}:${context.outstanding.runSpecConfirmation.specId}` : "none"}`,
    `- compaction_records: ${context.conversation.compactionRecords.length}`,
    ...compactionRecordLines,
    `- runtime_evidence: ${context.runtimeEvidence.status}`,
    "- runtime_evidence_rule: Do not claim that current daemon, gateway, command, process, watchdog, runtime, session, or local machine status was checked unless this turn produced trusted tool/runtime evidence. If evidence is absent, say that you cannot verify it from here.",
  ];
  return lines.join("\n");
}

export function renderSystemPromptWithTurnContext(systemPrompt: string | undefined, context: ChatTurnModelVisibleContext): string {
  return [
    systemPrompt?.trim() ?? "",
    renderModelVisibleTurnContext(context),
  ].filter((section) => section.length > 0).join("\n\n");
}

export function toTurnContextSnapshot(context: ChatTurnContext): ChatTurnContextSnapshot {
  return {
    schema_version: context.schema_version,
    modelVisible: context.modelVisible,
  };
}

export function toPublicCharacterPolicyContext(
  projection: CompanionCharacterPolicyProjection
): PublicCharacterPolicyContext {
  const parsed = CompanionCharacterPolicyProjectionSchema.parse(projection);
  return {
    policyRef: createCompanionCharacterPolicyCognitionPolicyRef(parsed),
    dialogueStrategy: parsed.dialogue_strategy,
    surfacePolicy: parsed.surface_policy,
    authority: {
      characterCanRelaxSafetyBoundary: parsed.decision_policy.character_can_relax_safety_boundary,
      characterCanRelaxApprovalBoundary: parsed.decision_policy.character_can_relax_approval_boundary,
      characterCanGrantAutonomy: parsed.decision_policy.character_can_grant_autonomy,
    },
  };
}

function toPublicReplyTarget(target: RuntimeControlReplyTarget | null): PublicReplyTarget | null {
  if (!target) return null;
  return {
    ...(target.surface ? { surface: target.surface } : {}),
    ...(target.platform ? { platform: target.platform } : {}),
    ...(target.conversation_id ? { conversation_id: target.conversation_id } : {}),
    ...(target.identity_key ? { identity_key: target.identity_key } : {}),
    ...(target.user_id ? { user_id: target.user_id } : {}),
    ...(target.message_id ? { message_id: target.message_id } : {}),
    ...(target.deliveryMode ? { deliveryMode: target.deliveryMode } : {}),
  };
}

function toPublicActor(actor: RuntimeControlActor | null): PublicRuntimeActor | null {
  if (!actor) return null;
  return {
    ...(actor.surface ? { surface: actor.surface } : {}),
    ...(actor.platform ? { platform: actor.platform } : {}),
    ...(actor.conversation_id ? { conversation_id: actor.conversation_id } : {}),
    ...(actor.identity_key ? { identity_key: actor.identity_key } : {}),
    ...(actor.user_id ? { user_id: actor.user_id } : {}),
  };
}

function toPublicSetupDialogue(dialogue: SetupDialoguePublicState | null): PublicSetupDialogueState | null {
  if (!dialogue) return null;
  return {
    id: dialogue.id,
    channel: dialogue.selectedChannel,
    state: dialogue.state,
    ...(dialogue.action ? { action: dialogue.action.kind } : {}),
    updatedAt: dialogue.updatedAt,
  };
}

function toPublicRunSpecConfirmation(confirmation: RunSpecConfirmationState | null): PublicRunSpecConfirmationState | null {
  if (!confirmation) return null;
  return {
    state: confirmation.state,
    specId: confirmation.spec.id,
    createdAt: confirmation.createdAt,
    updatedAt: confirmation.updatedAt,
  };
}

function toPublicCompactionRecords(records: ChatCompactionRecord[] | null | undefined): PublicCompactionRecord[] {
  return (records ?? []).slice(-5).map((record) => ({
    sequence: record.sequence,
    createdAt: record.createdAt,
    reason: record.reason,
    summary: record.modelVisibleSummary || record.summary,
    inputMessageCount: record.inputMessageCount,
    outputMessageCount: record.outputMessageCount,
    removedMessageCount: record.removedMessageCount,
    retainedMessageCount: record.retainedMessageCount,
    pendingPermissions: record.pendingPermissions,
    activeTargets: record.activeTargets,
    replacementHistory: record.replacementHistory,
  }));
}

function renderCompactionRecord(record: PublicCompactionRecord, index: number): string[] {
  return [
    `  - compaction_record[${index}].sequence: ${record.sequence}`,
    `    reason: ${record.reason}`,
    `    summary: ${preview(record.summary, 700)}`,
    `    counts: input=${record.inputMessageCount} output=${record.outputMessageCount} removed=${record.removedMessageCount} retained=${record.retainedMessageCount}`,
    `    pending_permissions: ${previewJson(record.pendingPermissions, 1200)}`,
    `    active_targets: ${previewJson(record.activeTargets, 1200)}`,
    `    replacement_history: ${previewJson(record.replacementHistory, 800)}`,
  ];
}

function renderCharacterPolicyContext(policy: PublicCharacterPolicyContext | null): string[] {
  if (!policy) return ["- character_policy: none"];
  return [
    `- character_policy_ref: ${policy.policyRef.kind}:${policy.policyRef.ref} (${policy.policyRef.result})`,
    `- character_directness: ${policy.dialogueStrategy.directness}`,
    `- character_response_shape: ${policy.dialogueStrategy.default_response_shape}`,
    `- character_initiative_posture: ${policy.dialogueStrategy.initiative_posture}`,
    `- character_clarification_bias: ${policy.dialogueStrategy.clarification_bias}`,
    `- character_visible_reason: ${policy.surfacePolicy.normal_companion_user_visible_reason}`,
    `- character_execution_summary_verbosity: ${policy.surfacePolicy.execution_summary_verbosity}`,
    `- character_escalation_suggestion_policy: ${policy.surfacePolicy.escalation_suggestion_policy}`,
    `- character_raw_policy_state_visible: ${policy.surfacePolicy.normal_companion_raw_policy_state_visible}`,
    `- character_debug_state_visible: ${policy.surfacePolicy.normal_companion_debug_state_visible}`,
    `- character_discloses_raw_knobs: ${policy.surfacePolicy.ordinary_surface_discloses_character_knobs}`,
    `- character_can_relax_safety_boundary: ${policy.authority.characterCanRelaxSafetyBoundary}`,
    `- character_can_relax_approval_boundary: ${policy.authority.characterCanRelaxApprovalBoundary}`,
    `- character_can_grant_autonomy: ${policy.authority.characterCanGrantAutonomy}`,
  ];
}

function previewJson(value: unknown, maxChars: number): string {
  try {
    return preview(JSON.stringify(value), maxChars);
  } catch {
    return "[unserializable]";
  }
}

function preview(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}

function toPublicUserInput(input: UserInput, redactedText: string): PublicUserInput {
  return {
    schema_version: USER_INPUT_SCHEMA_VERSION,
    rawText: redactedText,
    items: input.items.map((item): PublicUserInputItem => {
      if (item.kind === "text") {
        return { kind: "text", text: redactedText };
      }
      if (item.kind === "image" || item.kind === "local_image") {
        return {
          kind: item.kind,
          ...(item.name ? { name: item.name } : {}),
        };
      }
      if (item.kind === "mention") {
        return {
          kind: "mention",
          ...(item.label ? { label: item.label } : {}),
        };
      }
      if (item.kind === "skill" || item.kind === "plugin" || item.kind === "tool") {
        return { kind: item.kind, name: item.name };
      }
      return {
        kind: "attachment",
        id: item.id,
        ...(item.name ? { name: item.name } : {}),
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      };
    }),
  };
}

function formatReplyTarget(target: PublicReplyTarget | null): string {
  if (!target) return "none";
  return [
    target.surface,
    target.platform,
    target.conversation_id,
    target.message_id,
  ].filter(Boolean).join(":") || "present";
}

function resolveLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
