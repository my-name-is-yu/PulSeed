import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { ChatRunner } from "./chat-runner.js";
import { ChatSessionCatalog } from "./chat-session-store.js";
import type {
  ChatRunResult,
  ChatRunnerDeps,
  ChatRunnerRouteSelectionInput,
} from "./chat-runner-contracts.js";
import type { ChatEvent, ChatEventHandler } from "./chat-events.js";
import {
  createIngressRouter,
  type ChatIngressMessage,
  type ChatIngressReplyTarget,
  type SelectedChatRoute,
} from "./ingress-router.js";
import { classifyRuntimeControlIntent } from "../../runtime/control/index.js";
import { classifyFreeformRouteIntent } from "./freeform-route-classifier.js";
import { deriveRunSpecFromText } from "../../runtime/run-spec/index.js";
import { StateManager } from "../../base/state/state-manager.js";
import { buildAdapterRegistry, buildLLMClient } from "../../base/llm/provider-factory.js";
import { loadProviderConfig } from "../../base/llm/provider-config.js";
import { TrustManager } from "../../platform/traits/trust-manager.js";
import { ObservationEngine } from "../../platform/observation/observation-engine.js";
import { resolveGitRoot } from "../../platform/observation/context-provider.js";
import { KnowledgeManager } from "../../platform/knowledge/knowledge-manager.js";
import { GoalDependencyGraph } from "../../orchestrator/goal/goal-dependency-graph.js";
import { SessionManager } from "../../orchestrator/execution/session-manager.js";
import { ScheduleEngine } from "../../runtime/schedule/engine.js";
import { PluginLoader } from "../../runtime/plugin-loader.js";
import { NotifierRegistry } from "../../runtime/notifier-registry.js";
import { buildCliDataSourceRegistry } from "../cli/data-source-bootstrap.js";
import {
  ConcurrencyController,
  createBuiltinTools,
  ToolExecutor,
  ToolPermissionManager,
  ToolRegistry,
} from "../../tools/index.js";
import {
  createNativeChatAgentLoopRunner,
  createNativeReviewAgentLoopRunner,
  shouldUseNativeTaskAgentLoop,
} from "../../orchestrator/execution/agent-loop/index.js";
import {
  RuntimeControlService,
  createDaemonRuntimeControlExecutor,
} from "../../runtime/control/index.js";
import { createCapabilityExecutionResolver } from "../../runtime/capability-execution-resolver.js";
import { ApprovalBroker } from "../../runtime/approval-broker.js";
import {
  ApprovalStore,
  CapabilityVerificationStore,
  PermissionGrantCapabilitySchema,
  PermissionGrantExcludedCapabilitySchema,
  PermissionGrantStore,
  PermissionWaitPlanStore,
  createRuntimeStorePaths,
  type PermissionGrantCapability,
  type PermissionGrantCreateInput,
  type PermissionGrantExcludedCapability,
  type PermissionGrantOrigin,
  type PermissionGrantScope,
} from "../../runtime/store/index.js";
import { classifyConversationalApprovalDecision } from "../../runtime/conversational-approval-decision.js";
import {
  classifyConversationalPermissionGrantDecision,
  type PermissionGrantReplyDecision,
} from "../../runtime/permission-grant-decision.js";
import { registerGlobalCrossPlatformChatSessionManager } from "./cross-platform-session-global.js";
import type { ApprovalOrigin, ApprovalRecord } from "../../runtime/store/runtime-schemas.js";
import {
  createPendingPermissionTask,
  getPendingPermissionTask,
  getPendingPermissionGrantProposal,
  isPermissionApprovalStale,
  PendingPermissionGrantProposalSchema,
  type PendingPermissionGrantProposal,
} from "../../runtime/permission-dialogue.js";
import {
  buildCompanionRuntimeContract,
  evaluateCompanionOutputPolicy,
} from "../../runtime/companion-policy.js";
import type {
  CompanionRuntimeContract,
} from "../../runtime/types/companion.js";
import { EXTERNAL_SURFACE_METADATA_KEY } from "../../runtime/gateway/channel-policy.js";
import { normalizeUserInput } from "./user-input.js";
import type { ApprovalRequest } from "../../tools/types.js";
import {
  createSeedyActiveTurnStatus,
  formatSeedyActiveTurnStatus,
  type SeedyActiveTurnStatus,
} from "./seedy-turn-presence.js";
import {
  buildSessionKeyFromParts,
  buildSessionMetadata,
  cloneMetadata,
  cloneReplyTarget,
  isRecord,
  normalizeActor,
  normalizeIdentity,
  normalizePlatform,
  normalizeReplyTarget,
  resolveChannel,
  resolveRuntimeControl,
  stringField,
} from "./cross-platform-session-normalization.js";
import { CrossPlatformChatSessionInfoStore } from "./chat-session-data-store.js";
import { resolveChatStateBaseDir } from "./chat-state-base-dir.js";
import type {
  CrossPlatformChatSessionInfo,
  CrossPlatformChatSessionOptions,
  CrossPlatformIncomingChatMessage,
  CrossPlatformIngressMessage,
} from "./cross-platform-session-types.js";
export type {
  CrossPlatformChatSessionInfo,
  CrossPlatformChatSessionOptions,
  CrossPlatformIncomingChatMessage,
  CrossPlatformIngressMessage,
} from "./cross-platform-session-types.js";

const STANDING_PERMISSION_REVIEW_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const STANDING_PERMISSION_DEFAULT_EXCLUSIONS: PermissionGrantExcludedCapability[] = [
  "destructive_action",
  "delete",
  "write_remote",
  "network_send",
  "secret_change",
  "protected_path_mutation",
  "production_mutation",
  "billing_or_purchase",
  "unknown_capability",
];

interface ManagedChatSession {
  runner: ChatRunner;
  info: CrossPlatformChatSessionInfo;
  queue: Promise<void>;
  lastRoute?: SelectedChatRoute;
}

function createPermissionGrantProposalFromApprovalRequest(
  request: ApprovalRequest,
): PendingPermissionGrantProposal | undefined {
  const decision = isRecord(request.permissionGrantDecision) ? request.permissionGrantDecision : null;
  if (!decision) return undefined;

  const capabilities = parsePermissionGrantCapabilities(decision["requiredCapabilities"]);
  if (capabilities.length === 0) return undefined;
  const excludedCapabilities = parsePermissionGrantExcludedCapabilities(decision["excludedCapabilities"]);

  return PendingPermissionGrantProposalSchema.parse({
    schema_version: "permission-grant-proposal-v1",
    capabilities,
    current_request_capabilities: capabilities,
    excluded_capabilities: excludedCapabilities,
    default_scope: "run",
    allowed_scopes: ["once", "run", "goal"],
    summary: request.reason,
  });
}

function parsePermissionGrantCapabilities(value: unknown): PermissionGrantCapability[] {
  if (!Array.isArray(value)) return [];
  const capabilities: PermissionGrantCapability[] = [];
  const seen = new Set<PermissionGrantCapability>();
  for (const item of value) {
    const parsed = PermissionGrantCapabilitySchema.safeParse(item);
    if (!parsed.success || seen.has(parsed.data)) continue;
    seen.add(parsed.data);
    capabilities.push(parsed.data);
  }
  return capabilities;
}

function parsePermissionGrantExcludedCapabilities(value: unknown): PermissionGrantExcludedCapability[] {
  if (!Array.isArray(value)) return [];
  const capabilities: PermissionGrantExcludedCapability[] = [];
  const seen = new Set<PermissionGrantExcludedCapability>();
  for (const item of value) {
    const parsed = PermissionGrantExcludedCapabilitySchema.safeParse(item);
    if (!parsed.success || seen.has(parsed.data)) continue;
    seen.add(parsed.data);
    capabilities.push(parsed.data);
  }
  return capabilities;
}

type PermissionGrantScopeResolution =
  | {
      status: "ok";
      scope: PermissionGrantScope;
      duration: PermissionGrantCreateInput["duration"];
      review?: PermissionGrantCreateInput["review"];
    }
  | { status: "needs_confirmation" | "unavailable"; message: string };

function resolveGrantScopeFromReply(
  approval: ApprovalRecord,
  proposal: PendingPermissionGrantProposal,
  decision: PermissionGrantReplyDecision,
  context: { cwd?: string; projectId?: string } = {},
): PermissionGrantScopeResolution {
  const requestedScope = requestedGrantScope(proposal, decision);
  if (decision.standing_confirmation) {
    const now = Date.now();
    const review = {
      kind: "periodic" as const,
      interval_ms: STANDING_PERMISSION_REVIEW_INTERVAL_MS,
      due_at: now + STANDING_PERMISSION_REVIEW_INTERVAL_MS,
      last_reviewed_at: now,
    };
    switch (decision.standing_confirmation.scope) {
      case "workspace": {
        if (!context.cwd) {
          return { status: "unavailable", message: "Standing workspace permission requires a current workspace path. The proposal remains pending." };
        }
        return {
          status: "ok",
          scope: { kind: "workspace", workspace_root: path.resolve(context.cwd) },
          duration: { kind: "standing" },
          review,
        };
      }
      case "project": {
        if (!context.projectId) {
          return { status: "unavailable", message: "Standing project permission requires a current project id. The proposal remains pending." };
        }
        return {
          status: "ok",
          scope: { kind: "project", project_id: context.projectId },
          duration: { kind: "standing" },
          review,
        };
      }
      case "global":
        return {
          status: "ok",
          scope: { kind: "global" },
          duration: { kind: "standing" },
          review,
        };
    }
  }
  if (requestedScope === "global" || decision.requested_scope === "standing") {
    return {
      status: "needs_confirmation",
      message: [
        "Standing or global permission requires a second explicit confirmation naming the broader scope.",
        `Allowed capabilities: ${proposal.capabilities.join(", ")}.`,
        `Excluded capabilities: ${proposal.excluded_capabilities.length > 0 ? proposal.excluded_capabilities.join(", ") : "none"}.`,
        "It can be revoked later with the permission revoke control.",
        "The proposal remains pending.",
      ].join(" "),
    };
  }
  if (!proposal.allowed_scopes.includes(requestedScope)) {
    return {
      status: "needs_confirmation",
      message: `The requested ${requestedScope} permission scope is broader than this proposal. The proposal remains pending.`,
    };
  }

  const task = getPendingPermissionTask(approval);
  switch (requestedScope) {
    case "once": {
      const turnId = approval.origin?.turn_id;
      if (!turnId) {
        return { status: "unavailable", message: "Permission grant could not be scoped to the current turn. The proposal remains pending." };
      }
      return {
        status: "ok",
        scope: { kind: "turn", turn_id: turnId },
        duration: { kind: "once" },
      };
    }
    case "run": {
      const runId = task?.target.run_id ?? approval.origin?.session_id;
      if (!runId) {
        return { status: "unavailable", message: "Permission grant could not be scoped to the current run. The proposal remains pending." };
      }
      return {
        status: "ok",
        scope: { kind: "run", run_id: runId },
        duration: { kind: "until_run_done" },
      };
    }
    case "goal": {
      const goalId = approval.goal_id;
      if (!goalId) {
        return { status: "unavailable", message: "Permission grant could not be scoped to the current goal. The proposal remains pending." };
      }
      return {
        status: "ok",
        scope: { kind: "goal", goal_id: goalId },
        duration: { kind: "until_goal_done" },
      };
    }
    case "session":
    case "workspace":
    case "project":
      return {
        status: "needs_confirmation",
        message: `The requested ${requestedScope} permission scope requires a more specific proposal. The proposal remains pending.`,
      };
  }
}

function requestedGrantScope(
  proposal: PendingPermissionGrantProposal,
  decision: PermissionGrantReplyDecision,
): PendingPermissionGrantProposal["default_scope"] {
  if (decision.decision === "approve_current_run") return "run";
  if (decision.decision === "approve_current_goal") return "goal";
  if (decision.decision === "extend_scope") {
    switch (decision.requested_scope) {
      case "current_run":
        return "run";
      case "current_goal":
        return "goal";
      case "standing":
        return "global";
      case "once":
      case "session":
      case "workspace":
      case "project":
      case "global":
        return decision.requested_scope;
      default:
        return proposal.default_scope;
    }
  }
  return proposal.default_scope;
}

function resolveGrantCapabilitiesFromReply(
  proposal: PendingPermissionGrantProposal,
  decision: PermissionGrantReplyDecision,
): PermissionGrantCapability[] {
  if (decision.decision !== "narrow_scope" || !decision.capabilities) {
    return proposal.capabilities;
  }
  const allowed = new Set(proposal.capabilities);
  return decision.capabilities.filter((capability) => allowed.has(capability));
}

function resolveGrantExcludedCapabilities(
  proposal: PendingPermissionGrantProposal,
  duration: PermissionGrantCreateInput["duration"],
): PermissionGrantExcludedCapability[] {
  if (duration.kind !== "standing") {
    return proposal.excluded_capabilities;
  }
  return [...new Set([...proposal.excluded_capabilities, ...STANDING_PERMISSION_DEFAULT_EXCLUSIONS])];
}

function createPermissionGrantOrigin(origin: ApprovalOrigin): PermissionGrantOrigin {
  const replyTarget = isRecord(origin.reply_target) ? origin.reply_target : undefined;
  const platform = normalizeIdentity(stringField(replyTarget, "platform")) ?? undefined;
  const messageId = normalizeIdentity(stringField(replyTarget, "message_id")) ?? origin.turn_id;
  return {
    channel: origin.channel,
    ...(platform ? { platform } : {}),
    conversation_id: origin.conversation_id,
    ...(origin.user_id ? { user_id: origin.user_id } : {}),
    ...(origin.session_id ? { session_id: origin.session_id } : {}),
    ...(origin.turn_id ? { turn_id: origin.turn_id } : {}),
    ...(messageId ? { message_id: messageId } : {}),
    ...(replyTarget ? { reply_target: { ...replyTarget } } : {}),
  };
}

async function safeInvoke(handler: ChatEventHandler | undefined, event: ChatEvent): Promise<void> {
  if (!handler) return;
  try {
    await handler(event);
  } catch (err) {
    // Event streaming should not break chat delivery.
    console.warn("[chat] event delivery failed", {
      eventType: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

class ChatEventDeliveryQueue {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly handler: ChatEventHandler | undefined,
    private readonly upstream: ChatEventHandler | undefined
  ) {}

  dispatch = (event: ChatEvent): Promise<void> => {
    this.queue = this.queue.then(async () => {
      await safeInvoke(this.handler, event);
      if (this.upstream && this.upstream !== this.handler) {
        await safeInvoke(this.upstream, event);
      }
    });
    return this.queue;
  };

  async drain(): Promise<void> {
    await this.queue;
  }
}

export class CrossPlatformChatSessionManager {
  private readonly sessions = new Map<string, ManagedChatSession>();
  private readonly sessionInitializers = new Map<string, Promise<ManagedChatSession>>();
  private readonly activeApprovalEventHandlers = new Map<string, ChatEventHandler>();
  private readonly approvalSideTurnIngressIds = new Set<string>();
  private readonly ingressRouter = createIngressRouter();

  constructor(private readonly deps: ChatRunnerDeps) {}

  /**
   * Execute a chat turn through a session keyed by identity_key.
   * If identity_key is absent, the manager falls back to a deterministic platform-scoped key when possible,
   * otherwise it creates an isolated one-shot session.
   */
  async execute(input: string, options: CrossPlatformChatSessionOptions = {}): Promise<ChatRunResult> {
    const ingress = this.createIngressMessage({
      text: input,
      identity_key: options.identity_key,
      platform: options.platform,
      conversation_id: options.conversation_id,
      conversation_name: options.conversation_name,
      user_id: options.user_id,
      user_name: options.user_name,
      message_id: options.message_id,
      goal_id: options.goal_id,
      channel: options.channel ?? (options.platform ? "plugin_gateway" : "cli"),
      actor: options.actor,
      replyTarget: options.replyTarget,
      runtimeControl: options.runtimeControl,
      externalSurface: options.externalSurface,
      companion: options.companion,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      metadata: {
        ...(options.metadata ?? {}),
        ...(options.runtimeControl && (options.channel ?? (options.platform ? "plugin_gateway" : "cli")) === "plugin_gateway"
          ? { runtime_control_explicit: true }
          : {}),
      },
      onEvent: options.onEvent,
      userInput: options.userInput,
    });
    const approvalReply = await this.tryResolveConversationalApprovalReply(ingress);
    if (approvalReply) {
      return {
        success: true,
        output: approvalReply,
        elapsed_ms: 0,
      };
    }
    const session = await this.getOrCreateSession(ingress, options.cwd);
    if (ingress.ingress_id && this.approvalSideTurnIngressIds.delete(ingress.ingress_id)) {
      return this.executeInSession(session, ingress, options);
    }
    if (session.runner.hasActiveTurn()) {
      return this.steerActiveSession(session, ingress, options);
    }
    const queueEntry = session.queue.then(() => this.executeInSession(session, ingress, options));
    session.queue = queueEntry.then(() => undefined, () => undefined);
    return queueEntry;
  }

  async processIncomingMessage(input: CrossPlatformIncomingChatMessage): Promise<string> {
    const ingress = this.createIngressMessage(input);
    if (input.approvalResponse) {
      return this.resolveConversationalApprovalIngress(ingress, input.approvalResponse);
    }
    const approvalReply = await this.tryResolveConversationalApprovalReply(ingress);
    if (approvalReply) {
      return approvalReply;
    }
    const result = await this.executeIngress(ingress, input);
    return result.output;
  }

  async interruptAndRedirect(input: CrossPlatformIncomingChatMessage): Promise<ChatRunResult> {
    const ingress = this.ensureCompanionContract(this.createIngressMessage(input));
    const approvalReply = await this.tryResolveConversationalApprovalReply(ingress);
    if (approvalReply) {
      return {
        success: true,
        output: approvalReply,
        elapsed_ms: 0,
      };
    }
    const session = await this.getOrCreateSession(ingress, input.cwd);
    const decision = evaluateCompanionOutputPolicy(ingress.companion.turn_policy);
    if (!decision.delivered) {
      return {
        success: true,
        output: formatCompanionPolicyDecision(decision),
        elapsed_ms: 0,
      };
    }
    return this.steerActiveSession(session, ingress, input);
  }

  async executeIngress(
    ingress: CrossPlatformIngressMessage,
    options: Pick<CrossPlatformIncomingChatMessage, "cwd" | "timeoutMs" | "onEvent" | "conversation_name" | "user_name"> = {}
  ): Promise<ChatRunResult> {
    const normalizedIngress = this.ensureCompanionContract(ingress);
    const decision = evaluateCompanionOutputPolicy(normalizedIngress.companion.turn_policy);
    if (!decision.delivered) {
      return {
        success: true,
        output: formatCompanionPolicyDecision(decision),
        elapsed_ms: 0,
      };
    }
    const session = await this.getOrCreateSession(normalizedIngress, options.cwd);
    if (normalizedIngress.ingress_id && this.approvalSideTurnIngressIds.delete(normalizedIngress.ingress_id)) {
      return this.executeInSession(session, normalizedIngress, options);
    }
    if (session.runner.hasActiveTurn()) {
      return this.steerActiveSession(session, normalizedIngress, options);
    }
    const queueEntry = session.queue.then(() => this.executeInSession(session, normalizedIngress, options));
    session.queue = queueEntry.then(() => undefined, () => undefined);
    return queueEntry;
  }

  private async resolveConversationalApprovalIngress(
    ingress: CrossPlatformIngressMessage,
    response: { approval_id: string; approved: boolean }
  ): Promise<string> {
    const broker = this.deps.approvalBroker;
    if (!broker) {
      return "Approval response could not be recorded because approval handling is unavailable.";
    }
    const origin = createApprovalOriginFromIngress(ingress);
    if (!origin) {
      return "Approval response could not be recorded because the conversation origin is incomplete.";
    }
    const pendingApproval = await broker.loadPendingApproval(response.approval_id);
    if (pendingApproval) {
      const staleReply = await this.rejectStalePermissionApprovalIfNeeded(pendingApproval, ingress, origin);
      if (staleReply) {
        return staleReply;
      }
    }
    const resolved = await broker.resolveConversationalApproval(
      response.approval_id,
      response.approved,
      origin
    );
    return resolved
      ? "Approval response recorded."
      : "Approval response did not match an active approval for this conversation.";
  }

  private async tryResolveConversationalApprovalReply(
    ingress: CrossPlatformIngressMessage
  ): Promise<string | null> {
    const broker = this.deps.approvalBroker;
    if (!broker) {
      return null;
    }
    const origin = createApprovalOriginFromIngress(ingress);
    if (!origin) {
      return null;
    }
    const lookup = await broker.findPendingConversationalApproval(origin);
    if (lookup.status === "none") {
      return null;
    }
    if (lookup.status === "ambiguous") {
      return "Multiple active approvals match this conversation. Please use the specific approval response.";
    }
    const approval = lookup.approval;
    const staleReply = await this.rejectStalePermissionApprovalIfNeeded(approval, ingress, origin);
    if (staleReply) {
      return staleReply;
    }

    const grantProposal = getPendingPermissionGrantProposal(approval);
    if (grantProposal) {
      const grantDecision = await classifyConversationalPermissionGrantDecision(ingress.text, {
        approval,
        proposal: grantProposal,
        replyOrigin: origin,
        llmClient: this.deps.llmClient,
        priorTurnState: this.describeLastRouteForApproval(ingress),
      });
      const grantReply = await this.resolveConversationalPermissionGrantReply(
        ingress,
        approval,
        origin,
        grantProposal,
        grantDecision,
      );
      if (grantReply !== null) {
        return grantReply;
      }
    }

    const decision = await classifyConversationalApprovalDecision(ingress.text, {
      approval,
      replyOrigin: origin,
      llmClient: this.deps.llmClient,
      priorTurnState: this.describeLastRouteForApproval(ingress),
    });
    if (decision.decision === "approve" || decision.decision === "reject") {
      const resolved = await broker.resolveConversationalApproval(
        approval.approval_id,
        decision.decision === "approve",
        approval.origin ?? origin
      );
      return resolved
        ? "Approval response recorded."
        : "Approval response did not match an active approval for this conversation.";
    }
    if (decision.decision === "clarify") {
      return decision.clarification ?? "Approval is still pending. Please clarify what you need before approving or rejecting.";
    }
    if (decision.decision === "side_question" || decision.decision === "new_intent") {
      if (ingress.ingress_id) {
        this.approvalSideTurnIngressIds.add(ingress.ingress_id);
      }
      return null;
    }
    return decision.clarification ?? "Approval reply was ambiguous. The approval remains pending.";
  }

  private async resolveConversationalPermissionGrantReply(
    ingress: CrossPlatformIngressMessage,
    approval: ApprovalRecord,
    origin: ApprovalOrigin,
    proposal: PendingPermissionGrantProposal,
    decision: PermissionGrantReplyDecision,
  ): Promise<string | null> {
    const broker = this.deps.approvalBroker;
    if (!broker) {
      return "Approval response could not be recorded because approval handling is unavailable.";
    }

    switch (decision.decision) {
      case "side_question":
      case "new_intent":
        if (ingress.ingress_id) {
          this.approvalSideTurnIngressIds.add(ingress.ingress_id);
        }
        return null;
      case "clarify":
        return decision.clarification ?? "Permission proposal is still pending. Please clarify before approving or rejecting.";
      case "unknown":
        return decision.clarification ?? "Permission reply was ambiguous. The permission proposal remains pending.";
      case "reject":
      case "revoke": {
        const resolved = await broker.resolveConversationalApproval(approval.approval_id, false, approval.origin ?? origin);
        return resolved
          ? "Approval response recorded."
          : "Approval response did not match an active approval for this conversation.";
      }
      case "approve_once": {
        const resolved = await broker.resolveConversationalApproval(approval.approval_id, true, approval.origin ?? origin);
        return resolved
          ? "Approval response recorded."
          : "Approval response did not match an active approval for this conversation.";
      }
      case "approve_current_run":
      case "approve_current_goal":
      case "narrow_scope":
      case "extend_scope":
        return this.createPermissionGrantFromReply({
          ingress,
          approval,
          origin,
          proposal,
          decision,
        });
    }
  }

  private async createPermissionGrantFromReply(input: {
    ingress: CrossPlatformIngressMessage;
    approval: ApprovalRecord;
    origin: ApprovalOrigin;
    proposal: PendingPermissionGrantProposal;
    decision: PermissionGrantReplyDecision;
  }): Promise<string> {
    const store = this.deps.permissionGrantStore;
    if (!store) {
      return "Permission grant could not be recorded because the grant store is unavailable. The approval remains pending.";
    }
    const scope = resolveGrantScopeFromReply(input.approval, input.proposal, input.decision, {
      cwd: input.ingress.cwd,
      ...(this.deps.permissionGrantContext?.projectId ? { projectId: this.deps.permissionGrantContext.projectId } : {}),
    });
    if (scope.status !== "ok") {
      return scope.message;
    }

    const capabilities = resolveGrantCapabilitiesFromReply(input.proposal, input.decision);
    if (capabilities.length === 0) {
      return "Permission proposal is still pending. Please name at least one capability to allow.";
    }

    const createInput: PermissionGrantCreateInput = {
      grant_id: `permission-grant:${input.approval.approval_id}:${randomUUID()}`,
      subject: {
        kind: "operator",
        id: input.origin.user_id ?? input.origin.session_id ?? input.origin.conversation_id,
      },
      origin: createPermissionGrantOrigin(input.origin),
      source: {
        kind: "redacted_text",
        redacted_text: "User replied to a conversational PermissionGrant proposal.",
        redaction_reason: "chat_permission_reply",
      },
      scope: scope.scope,
      duration: scope.duration,
      ...(scope.review ? { review: scope.review } : {}),
      capabilities,
      excluded_capabilities: resolveGrantExcludedCapabilities(input.proposal, scope.duration),
      audit_refs: [`approval:${input.approval.approval_id}`],
    };

    await store.createActive(createInput);
    const currentRequestCapabilities = input.proposal.current_request_capabilities ?? input.proposal.capabilities;
    const currentRequestCovered = input.proposal.excluded_capabilities.length === 0
      && currentRequestCapabilities.every((capability) => capabilities.includes(capability));
    const resolved = await this.deps.approvalBroker?.resolveConversationalApproval(
      input.approval.approval_id,
      currentRequestCovered,
      input.approval.origin ?? input.origin,
    );
    if (!resolved) {
      return "Permission grant was recorded, but the approval response did not match an active approval for this conversation.";
    }
    if (!currentRequestCovered) {
      return "Permission grant recorded with a narrower boundary; the current approval was not executed.";
    }
    return createInput.duration.kind === "standing"
      ? "Standing permission grant recorded. Approval response recorded. You can revoke it later with the permission revoke control."
      : "Permission grant recorded. Approval response recorded.";
  }

  private async rejectStalePermissionApprovalIfNeeded(
    approval: ApprovalRecord,
    ingress: CrossPlatformIngressMessage,
    origin: ApprovalOrigin,
  ): Promise<string | null> {
    if (!isPermissionApprovalStale(approval, await this.currentApprovalStateEpoch(ingress))) {
      return null;
    }
    const broker = this.deps.approvalBroker;
    const resolved = await broker?.resolveConversationalApproval(
      approval.approval_id,
      false,
      approval.origin ?? origin,
    );
    return resolved
      ? "The approval target changed after the prompt, so PulSeed did not execute it. Please ask again if you still want that action."
      : "The approval target changed after the prompt, and the stale approval could not be resolved.";
  }

  private async currentApprovalStateEpoch(ingress: CrossPlatformIngressMessage): Promise<string | null> {
    const sessionKey = buildSessionKeyFromParts(ingress);
    const session = this.sessions.get(sessionKey);
    if (session) return session.info.last_message_id ?? null;
    const persisted = await this.loadPersistedSessionInfo(sessionKey);
    return persisted?.last_message_id ?? null;
  }

  private describeLastRouteForApproval(ingress: CrossPlatformIngressMessage): string {
    const session = this.sessions.get(buildSessionKeyFromParts(ingress));
    const route = session?.lastRoute;
    return route ? JSON.stringify(route) : "none";
  }

  handleIncomingMessage(input: CrossPlatformIncomingChatMessage): Promise<string> {
    return this.processIncomingMessage(input);
  }

  continueConversation(input: CrossPlatformIncomingChatMessage): Promise<string> {
    return this.processIncomingMessage(input);
  }

  processMessage(input: CrossPlatformIncomingChatMessage): Promise<string> {
    return this.processIncomingMessage(input);
  }

  private createIngressMessage(
    input: CrossPlatformIncomingChatMessage | (CrossPlatformChatSessionOptions & { text: string })
  ): CrossPlatformIngressMessage {
    const channel = resolveChannel(input);
    const metadataGoalId = typeof input.metadata?.["goal_id"] === "string"
      ? input.metadata["goal_id"].trim()
      : typeof input.metadata?.["routed_goal_id"] === "string"
        ? input.metadata["routed_goal_id"].trim()
        : "";
    const goalId = normalizeIdentity(input.goal_id ?? metadataGoalId) ?? undefined;
    const externalSurface = input.externalSurface;
    const metadata: Record<string, unknown> = {
      ...(input.metadata ?? {}),
      ...(externalSurface ? { [EXTERNAL_SURFACE_METADATA_KEY]: externalSurface } : {}),
      ...(goalId ? { goal_id: goalId } : {}),
      ...("sender_id" in input && input.sender_id ? { sender_id: input.sender_id } : {}),
      ...(input.message_id ? { message_id: input.message_id } : {}),
      ...(input.runtimeControl && channel === "plugin_gateway" ? { runtime_control_explicit: true } : {}),
    };
    if (!externalSurface) {
      delete metadata[EXTERNAL_SURFACE_METADATA_KEY];
    }
    const userId = normalizeIdentity(input.user_id ?? ("sender_id" in input ? input.sender_id : undefined)) ?? undefined;
    const platform = normalizePlatform(input.platform) ?? undefined;
    const identityKey = normalizeIdentity(input.identity_key) ?? undefined;
    const conversationId = normalizeIdentity(input.conversation_id) ?? undefined;
    const messageId = normalizeIdentity(input.message_id) ?? undefined;
    const companion = this.buildCompanionContractForIngress({
      identity_key: identityKey,
      platform,
      conversation_id: conversationId,
      user_id: userId,
      message_id: messageId,
      goal_id: goalId,
      replyTarget: input.replyTarget,
      companion: input.companion,
    });

    return {
      ingress_id: randomUUID(),
      received_at: new Date().toISOString(),
      channel,
      ...(platform ? { platform } : {}),
      ...(identityKey ? { identity_key: identityKey } : {}),
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(messageId ? { message_id: messageId } : {}),
      ...(goalId ? { goal_id: goalId } : {}),
      ...(userId ? { user_id: userId } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      text: input.text,
      userInput: normalizeUserInput(input.userInput, input.text),
      actor: normalizeActor(channel, {
        platform,
        conversation_id: conversationId,
        identity_key: identityKey,
        user_id: userId,
        actor: input.actor,
      }),
      runtimeControl: resolveRuntimeControl(channel, input.runtimeControl, metadata, externalSurface),
      companion,
      ...(externalSurface ? { externalSurface } : {}),
      metadata,
      replyTarget: normalizeReplyTarget(channel, {
        platform,
        conversation_id: conversationId,
        identity_key: identityKey,
        user_id: userId,
        message_id: messageId,
        replyTarget: input.replyTarget,
        metadata,
        externalSurface,
      }),
    };
  }

  private ensureCompanionContract(ingress: CrossPlatformIngressMessage): CrossPlatformIngressMessage & { companion: CompanionRuntimeContract } {
    if (ingress.companion) {
      return ingress as CrossPlatformIngressMessage & { companion: CompanionRuntimeContract };
    }
    return {
      ...ingress,
      companion: this.buildCompanionContractForIngress({
        identity_key: ingress.identity_key,
        platform: ingress.platform,
        conversation_id: ingress.conversation_id,
        user_id: ingress.user_id,
        message_id: ingress.message_id,
        goal_id: ingress.goal_id,
        replyTarget: ingress.replyTarget,
      }),
    };
  }

  private buildCompanionContractForIngress(input: {
    identity_key?: string;
    platform?: string;
    conversation_id?: string;
    user_id?: string;
    message_id?: string;
    goal_id?: string;
    replyTarget?: Partial<ChatIngressReplyTarget>;
    companion?: CrossPlatformIncomingChatMessage["companion"];
  }): CompanionRuntimeContract {
    const sessionKey = buildSessionKeyFromParts({
      identity_key: input.identity_key,
      platform: input.platform,
      conversation_id: input.conversation_id,
      user_id: input.user_id,
    });
    const replyTargetId = normalizeIdentity(input.replyTarget?.conversation_id ?? input.conversation_id ?? input.replyTarget?.identity_key ?? input.identity_key) ?? undefined;
    return buildCompanionRuntimeContract({
      sessionKey,
      conversationId: input.conversation_id,
      messageId: input.message_id,
      goalId: input.goal_id,
      replyTargetId,
      presence: input.companion?.presence,
      turnPolicy: input.companion?.turnPolicy,
      inputModality: input.companion?.inputModality ?? "text",
      outputMode: input.companion?.outputMode,
    });
  }

  /**
   * Returns the active session info if a matching session is already loaded.
   */
  getSessionInfo(options: CrossPlatformChatSessionOptions): CrossPlatformChatSessionInfo | null {
    const sessionKey = buildSessionKeyFromParts(options);
    const session = this.sessions.get(sessionKey);
    return session
      ? {
          ...session.info,
          metadata: cloneMetadata(session.info.metadata),
          active_reply_target: session.info.active_reply_target
            ? {
                ...session.info.active_reply_target,
                metadata: cloneMetadata(session.info.active_reply_target.metadata),
              }
            : undefined,
        }
      : null;
  }

  getActiveSeedyTurnStatus(
    options: CrossPlatformChatSessionOptions,
    statusOptions: { readonly now?: Date | string | number } = {},
  ): SeedyActiveTurnStatus {
    const session = this.sessions.get(buildSessionKeyFromParts(options));
    return session
      ? session.runner.getActiveSeedyTurnStatus(statusOptions)
      : createSeedyActiveTurnStatus(null, statusOptions);
  }

  formatActiveSeedyTurnStatus(
    options: CrossPlatformChatSessionOptions,
    statusOptions: { readonly now?: Date | string | number } = {},
  ): string {
    return formatSeedyActiveTurnStatus(this.getActiveSeedyTurnStatus(options, statusOptions));
  }

  private async loadPersistedSessionInfo(sessionKey: string): Promise<CrossPlatformChatSessionInfo | null> {
    return new CrossPlatformChatSessionInfoStore(resolveChatStateBaseDir(this.deps.stateManager)).load(sessionKey);
  }

  private async persistSessionInfo(info: CrossPlatformChatSessionInfo): Promise<void> {
    await new CrossPlatformChatSessionInfoStore(resolveChatStateBaseDir(this.deps.stateManager)).save({
      ...info,
      metadata: cloneMetadata(info.metadata),
      active_reply_target: info.active_reply_target ? cloneReplyTarget(info.active_reply_target) : undefined,
    });
  }

  private async getOrCreateSession(
    ingress: Pick<ChatIngressMessage, "identity_key" | "platform" | "conversation_id" | "user_id">,
    cwdOverride?: string
  ): Promise<ManagedChatSession> {
    const sessionKey = buildSessionKeyFromParts(ingress);
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      return existing;
    }
    const pending = this.sessionInitializers.get(sessionKey);
    if (pending) {
      return pending;
    }

    const initializer = this.createManagedSession(sessionKey, ingress, cwdOverride)
      .finally(() => {
        this.sessionInitializers.delete(sessionKey);
      });
    this.sessionInitializers.set(sessionKey, initializer);
    return initializer;
  }

  private async createManagedSession(
    sessionKey: string,
    ingress: Pick<ChatIngressMessage, "identity_key" | "platform" | "conversation_id" | "user_id">,
    cwdOverride?: string,
  ): Promise<ManagedChatSession> {
    const cwd = resolveGitRoot(cwdOverride?.trim() || process.cwd());
    const now = new Date().toISOString();
    const persisted = await this.loadPersistedSessionInfo(sessionKey);
    const info: CrossPlatformChatSessionInfo = persisted ?? {
      session_key: sessionKey,
      identity_key: normalizeIdentity(ingress.identity_key) ?? undefined,
      platform: normalizePlatform(ingress.platform) ?? undefined,
      conversation_id: normalizeIdentity(ingress.conversation_id) ?? undefined,
      user_id: normalizeIdentity(ingress.user_id) ?? undefined,
      cwd,
      created_at: now,
      last_used_at: now,
      metadata: {},
    };
    const approvalFn = this.createApprovalFn(info);
    const approvalRequestFn = this.createApprovalRequestFn(info);
    const runner = new ChatRunner({
      ...this.deps,
      approvalFn: approvalFn ?? this.deps.approvalFn,
      approvalRequestFn: approvalRequestFn ?? this.deps.approvalRequestFn,
      runtimeControlApprovalFn: approvalFn ?? this.deps.runtimeControlApprovalFn,
      permissionGrantContext: {
        ...this.deps.permissionGrantContext,
        sessionId: info.session_key,
      },
    });
    if (info.chat_session_id) {
      const loaded = await new ChatSessionCatalog(this.deps.stateManager).loadSession(info.chat_session_id);
      if (loaded) {
        runner.startSessionFromLoadedSession(loaded);
      } else {
        runner.startSession(info.cwd);
      }
    } else {
      runner.startSession(info.cwd);
    }
    info.chat_session_id = runner.getSessionId() ?? info.chat_session_id;

    const created: ManagedChatSession = {
      runner,
      info,
      queue: Promise.resolve(),
      lastRoute: undefined,
    };
    this.sessions.set(sessionKey, created);
    await this.persistSessionInfo(info);
    return created;
  }

  private createApprovalFn(info: CrossPlatformChatSessionInfo): ((description: string) => Promise<boolean>) | null {
    const broker = this.deps.approvalBroker;
    if (!broker) {
      return null;
    }
    return async (description: string) => {
      const origin = createApprovalOriginFromSessionInfo(info);
      if (!origin) {
        return false;
      }
      const goalId = typeof info.metadata.goal_id === "string" && info.metadata.goal_id.trim()
        ? info.metadata.goal_id.trim()
        : "chat";
      const stateEpoch = currentStateEpochFromSessionInfo(info);
      return broker.requestConversationalApproval(goalId, createPendingPermissionTask({
        id: info.last_message_id ?? info.session_key,
        description,
        action: "chat_approval",
        target: { session_id: info.session_key },
        stateEpoch,
        stateVersion: info.last_used_at,
      }), {
        origin,
        deliverConversationalApproval: async ({ prompt }) => {
          const handler = this.activeApprovalEventHandlers.get(info.session_key);
          if (!handler) {
            return {
              delivered: false,
              reason: "originating_conversation_unreachable",
            };
          }
          try {
            await handler({
              type: "activity",
              kind: "checkpoint",
              message: prompt,
              sourceId: `approval:${info.last_message_id ?? info.session_key}`,
              presentation: { gatewayProgress: "user" },
              runId: info.session_key,
              turnId: info.last_message_id ?? info.session_key,
              createdAt: new Date().toISOString(),
            });
            return { delivered: true };
          } catch (err) {
            return {
              delivered: false,
              reason: err instanceof Error ? err.message : "originating_conversation_unreachable",
            };
          }
        },
      });
    };
  }

  private createApprovalRequestFn(info: CrossPlatformChatSessionInfo): ((request: ApprovalRequest) => Promise<boolean>) | null {
    const broker = this.deps.approvalBroker;
    if (!broker) {
      return null;
    }
    return async (request: ApprovalRequest) => {
      const origin = createApprovalOriginFromSessionInfo(info);
      if (!origin) {
        return false;
      }
      const goalId = typeof info.metadata.goal_id === "string" && info.metadata.goal_id.trim()
        ? info.metadata.goal_id.trim()
        : "chat";
      const stateEpoch = currentStateEpochFromSessionInfo(info);
      const grantProposal = createPermissionGrantProposalFromApprovalRequest(request);
      return broker.requestConversationalApproval(goalId, createPendingPermissionTask({
        id: request.callId ?? info.last_message_id ?? info.session_key,
        description: request.reason,
        action: request.toolName,
        target: {
          session_id: info.session_key,
          ...(request.runId ? { run_id: request.runId } : {}),
          tool_id: request.toolName,
          ...(request.callId ? { tool_call_id: request.callId } : {}),
        },
        stateEpoch,
        waitPlanId: request.permissionWaitPlanId,
        stateVersion: info.last_used_at,
        permissionLevel: request.permissionLevel,
        isDestructive: request.isDestructive,
        reversibility: request.reversibility,
        ...(grantProposal ? { grantProposal } : {}),
      }), {
        origin,
        ...(request.approvalId ? { approvalId: request.approvalId } : {}),
        deliverConversationalApproval: async ({ prompt }) => {
          const handler = this.activeApprovalEventHandlers.get(info.session_key);
          if (!handler) {
            return {
              delivered: false,
              reason: "originating_conversation_unreachable",
            };
          }
          try {
            await handler({
              type: "activity",
              kind: "checkpoint",
              message: prompt,
              sourceId: `approval:${request.callId ?? info.last_message_id ?? info.session_key}`,
              presentation: { gatewayProgress: "user" },
              runId: info.session_key,
              turnId: info.last_message_id ?? info.session_key,
              createdAt: new Date().toISOString(),
            });
            return { delivered: true };
          } catch (err) {
            return {
              delivered: false,
              reason: err instanceof Error ? err.message : "originating_conversation_unreachable",
            };
          }
        },
      });
    };
  }

  private async executeInSession(
    session: ManagedChatSession,
    ingress: CrossPlatformIngressMessage,
    options: Pick<CrossPlatformIncomingChatMessage, "timeoutMs" | "onEvent" | "conversation_name" | "user_name"> = {}
  ): Promise<ChatRunResult> {
    this.updateSessionInfoForIngress(session, ingress, options);
    await this.persistSessionInfo(session.info);

    const previousOnEvent = session.runner.onEvent;
    let deliveryQueue: ChatEventDeliveryQueue | null = null;
    if (options.onEvent) {
      deliveryQueue = new ChatEventDeliveryQueue(options.onEvent, this.deps.onEvent);
      this.activeApprovalEventHandlers.set(session.info.session_key, options.onEvent);
      session.runner.onEvent = deliveryQueue.dispatch;
    } else {
      this.activeApprovalEventHandlers.delete(session.info.session_key);
      session.runner.onEvent = undefined;
    }

    try {
      return await session.runner.executeIngressMessage(
        ingress,
        session.info.cwd,
        options.timeoutMs,
        undefined,
        {
          routeSelector: async (selectionInput) => {
            const selectedRoute = await this.selectRouteForSession(session, ingress, selectionInput);
            session.lastRoute = selectedRoute;
            return selectedRoute;
          },
        }
      );
    } finally {
      await deliveryQueue?.drain();
      this.activeApprovalEventHandlers.delete(session.info.session_key);
      session.runner.onEvent = previousOnEvent;
    }
  }

  private async selectRouteForSession(
    session: ManagedChatSession,
    ingress: CrossPlatformIngressMessage,
    input: ChatRunnerRouteSelectionInput,
  ): Promise<SelectedChatRoute> {
    const capabilities = {
      hasAgentLoop: this.deps.chatAgentLoopRunner !== undefined,
      hasToolLoop: this.deps.llmClient !== undefined,
      hasRuntimeControlService: this.deps.runtimeControlService !== undefined,
    };
    const setupSecretIntake = input.setupSecretIntake;
    const safeIngressText = input.safeInput;
    const hasSetupSecret = setupSecretIntake.suppliedSecrets.length > 0;
    const surfaceRuntimePolicy = ingress.externalSurface?.runtime_control_policy;
    const runtimeControlApproved =
      surfaceRuntimePolicy
        ? surfaceRuntimePolicy.allowed === true && surfaceRuntimePolicy.approval_mode === "preapproved"
        : ingress.metadata["runtime_control_approved"] === true;
    const runtimeControlDenied =
      surfaceRuntimePolicy
        ? surfaceRuntimePolicy.approval_mode === "disallowed"
        : ingress.metadata["runtime_control_denied"] === true;
    const metadataRuntimeControlExplicit = ingress.metadata["runtime_control_explicit"] === true;
    const canUseDefaultGatewayModelLoop = capabilities.hasToolLoop
      && (ingress.channel === "plugin_gateway" || ingress.replyTarget.surface === "gateway");
    const shouldPreferFreeformBeforeDeniedRuntimeControl =
      !hasSetupSecret
      && !canUseDefaultGatewayModelLoop
      && !capabilities.hasAgentLoop
      && runtimeControlDenied
      && !runtimeControlApproved
      && ingress.metadata["runtime_control_explicit"] !== true;
    const shouldClassifyRuntimeControl =
      !hasSetupSecret
      && (
        metadataRuntimeControlExplicit
        || (!canUseDefaultGatewayModelLoop && !capabilities.hasAgentLoop && (
          (capabilities.hasRuntimeControlService && ingress.runtimeControl.approvalMode !== "disallowed")
          || runtimeControlApproved
          || runtimeControlDenied
        ))
      );
    let freeformRouteIntent = shouldPreferFreeformBeforeDeniedRuntimeControl
      ? await classifyFreeformRouteIntent(safeIngressText, this.deps.llmClient)
      : null;
    const runtimeControlClassification = freeformRouteIntent == null && shouldClassifyRuntimeControl
      ? await classifyRuntimeControlIntent(safeIngressText, this.deps.llmClient)
      : null;
    const runtimeControlIntent = runtimeControlClassification?.status === "intent"
      ? runtimeControlClassification.intent
      : null;
    if (!hasSetupSecret && !capabilities.hasAgentLoop && !canUseDefaultGatewayModelLoop && freeformRouteIntent == null && runtimeControlIntent === null) {
      freeformRouteIntent = await classifyFreeformRouteIntent(safeIngressText, this.deps.llmClient);
    }
    const shouldDeriveRunSpecDraft =
      !capabilities.hasAgentLoop
      && !canUseDefaultGatewayModelLoop
      && !hasSetupSecret
      && runtimeControlIntent === null
      && freeformRouteIntent != null
      && (
        freeformRouteIntent.kind === "run_spec"
        || freeformRouteIntent.kind === "configure"
        || freeformRouteIntent.kind === "clarify"
      )
      && freeformRouteIntent.confidence >= 0.7;
    const runSpecDraft = shouldDeriveRunSpecDraft
      ? await deriveRunSpecFromText(safeIngressText, {
        cwd: ingress.cwd ?? session.info.cwd,
        conversationId: ingress.conversation_id ?? null,
        channel: ingress.channel,
        sessionId: input.sessionId ?? session.runner.getSessionId() ?? ingress.conversation_id ?? null,
        replyTarget: ingress.replyTarget as unknown as Record<string, unknown>,
        originMetadata: {
          ingress_id: ingress.ingress_id ?? null,
          platform: ingress.platform ?? null,
          message_id: ingress.message_id ?? null,
          deliveryMode: ingress.deliveryMode ?? null,
          metadata: ingress.metadata,
        },
        llmClient: this.deps.llmClient,
      })
      : null;
    return this.ingressRouter.selectRoute(ingress, {
      ...capabilities,
      runtimeControlIntent,
      runtimeControlUnclassified: metadataRuntimeControlExplicit
        && runtimeControlClassification?.status === "unclassified"
        && !hasSetupSecret,
      freeformRouteIntent,
      setupSecretIntake,
      runSpecDraft,
    });
  }

  private updateSessionInfoForIngress(
    session: ManagedChatSession,
    ingress: CrossPlatformIngressMessage,
    options: Pick<CrossPlatformIncomingChatMessage, "conversation_name" | "user_name"> = {},
  ): void {
    session.info.last_used_at = new Date().toISOString();
    session.info.chat_session_id = session.runner.getSessionId() ?? session.info.chat_session_id;
    session.info.conversation_name = options.conversation_name?.trim() || session.info.conversation_name;
    session.info.user_id = session.info.user_id ?? (normalizeIdentity(ingress.user_id) ?? undefined);
    session.info.user_name = options.user_name?.trim() || session.info.user_name;
    session.info.last_message_id = normalizeIdentity(ingress.message_id) ?? session.info.last_message_id;
    session.info.active_reply_target = {
      ...ingress.replyTarget,
      metadata: cloneMetadata(ingress.replyTarget.metadata),
    };
    if (ingress.companion) {
      session.info.active_companion_contract = ingress.companion;
    }
    session.info.metadata = cloneMetadata(buildSessionMetadata({
      metadata: ingress.metadata,
      channel: ingress.channel,
      platform: ingress.platform,
      conversation_id: ingress.conversation_id,
      conversation_name: options.conversation_name,
      user_id: ingress.user_id,
      user_name: options.user_name,
    }));
  }

  private async steerActiveSession(
    session: ManagedChatSession,
    ingress: CrossPlatformIngressMessage,
    options: Pick<CrossPlatformIncomingChatMessage, "timeoutMs" | "onEvent" | "conversation_name" | "user_name"> = {},
  ): Promise<ChatRunResult> {
    this.updateSessionInfoForIngress(session, ingress, options);
    await this.persistSessionInfo(session.info);

    const previousOnEvent = session.runner.onEvent;
    const approvalHandlerKey = session.info.session_key;
    const hadPreviousApprovalHandler = this.activeApprovalEventHandlers.has(approvalHandlerKey);
    const previousApprovalHandler = this.activeApprovalEventHandlers.get(approvalHandlerKey);
    let deliveryQueue: ChatEventDeliveryQueue | null = null;
    if (options.onEvent) {
      deliveryQueue = new ChatEventDeliveryQueue(options.onEvent, this.deps.onEvent);
      session.runner.onEvent = deliveryQueue.dispatch;
      this.activeApprovalEventHandlers.set(approvalHandlerKey, options.onEvent);
    }
    try {
      return await session.runner.interruptAndRedirect(
        ingress.text,
        session.info.cwd,
        options.timeoutMs,
        { userInput: ingress.userInput },
      );
    } finally {
      await deliveryQueue?.drain();
      const activeStillRunning = session.runner.hasActiveTurn();
      if (activeStillRunning && deliveryQueue && options.onEvent) {
        session.runner.onEvent = deliveryQueue.dispatch;
        this.activeApprovalEventHandlers.set(approvalHandlerKey, options.onEvent);
      } else if (activeStillRunning) {
        session.runner.onEvent = previousOnEvent;
        if (hadPreviousApprovalHandler && previousApprovalHandler) {
          this.activeApprovalEventHandlers.set(approvalHandlerKey, previousApprovalHandler);
        } else {
          this.activeApprovalEventHandlers.delete(approvalHandlerKey);
        }
      } else {
        session.runner.onEvent = undefined;
        this.activeApprovalEventHandlers.delete(approvalHandlerKey);
      }
    }
  }
}

function formatCompanionPolicyDecision(decision: ReturnType<typeof evaluateCompanionOutputPolicy>): string {
  if (decision.reason === "interruption_requires_explicit_request") {
    return "The current companion turn is non-interruptible. Send an explicit interruption request before redirecting it.";
  }
  if (decision.reason === "suppressed_by_quieting") {
    return "Companion output was suppressed by the current quieting policy.";
  }
  if (decision.reason === "deferred_by_quieting") {
    return "Companion output was deferred by the current quieting policy.";
  }
  return "Companion output is allowed.";
}

function currentStateEpochFromSessionInfo(info: CrossPlatformChatSessionInfo): string {
  return info.last_message_id ?? info.session_key;
}

export function createApprovalOriginFromSessionInfo(
  info: CrossPlatformChatSessionInfo
): ApprovalOrigin | null {
  const replyTarget = info.active_reply_target;
  const channel = normalizeIdentity(
    replyTarget?.platform
    ?? replyTarget?.channel
    ?? replyTarget?.surface
    ?? info.platform
  );
  const conversationId = normalizeIdentity(
    replyTarget?.conversation_id
    ?? info.conversation_id
    ?? info.identity_key
    ?? info.session_key
  );
  if (!channel || !conversationId) {
    return null;
  }
  const userId = normalizeIdentity(replyTarget?.user_id ?? info.user_id) ?? undefined;
  const turnId = normalizeIdentity(replyTarget?.message_id ?? info.last_message_id) ?? undefined;
  return {
    channel,
    conversation_id: conversationId,
    ...(userId ? { user_id: userId } : {}),
    session_id: info.session_key,
    ...(turnId ? { turn_id: turnId } : {}),
    reply_target: {
      ...replyTarget,
      metadata: replyTarget?.metadata ? { ...replyTarget.metadata } : undefined,
    },
  };
}

function createApprovalOriginFromIngress(
  ingress: CrossPlatformIngressMessage
): ApprovalOrigin | null {
  const channel = normalizeIdentity(
    ingress.replyTarget.platform
    ?? ingress.replyTarget.channel
    ?? ingress.replyTarget.surface
    ?? ingress.platform
  );
  const conversationId = normalizeIdentity(
    ingress.replyTarget.conversation_id
    ?? ingress.conversation_id
    ?? ingress.identity_key
  );
  const userId = normalizeIdentity(ingress.replyTarget.user_id ?? ingress.user_id) ?? undefined;
  const turnId = normalizeIdentity(ingress.replyTarget.message_id ?? ingress.message_id) ?? undefined;
  if (!channel || !conversationId || !userId || !turnId) {
    return null;
  }
  return {
    channel,
    conversation_id: conversationId,
    user_id: userId,
    session_id: buildSessionKeyFromParts(ingress),
    turn_id: turnId,
    reply_target: {
      ...ingress.replyTarget,
      metadata: cloneMetadata(ingress.replyTarget.metadata),
    },
  };
}

let globalManagerPromise: Promise<CrossPlatformChatSessionManager> | null = null;

export function getGlobalCrossPlatformChatSessionManager(): Promise<CrossPlatformChatSessionManager> {
  if (globalManagerPromise === null) {
    globalManagerPromise = createGlobalCrossPlatformChatSessionManager().catch((err) => {
      globalManagerPromise = null;
      throw err;
    });
  }
  return globalManagerPromise;
}

async function createGlobalCrossPlatformChatSessionManager(): Promise<CrossPlatformChatSessionManager> {
  const providerConfig = await loadProviderConfig();
  const stateManager = new StateManager();
  await stateManager.init();

  const llmClient = await buildLLMClient();
  const adapterRegistry = await buildAdapterRegistry(llmClient, providerConfig);
  const adapter = adapterRegistry.getAdapter(providerConfig.adapter);
  const toolRegistry = new ToolRegistry();
  const trustManager = new TrustManager(stateManager);
  const dataSourceRegistry = await buildCliDataSourceRegistry();
  const observationEngine = new ObservationEngine(
    stateManager,
    dataSourceRegistry.getAllSources(),
    llmClient,
  );
  const knowledgeManager = new KnowledgeManager(stateManager, llmClient);
  const goalDependencyGraph = new GoalDependencyGraph(stateManager, llmClient);
  await goalDependencyGraph.init();
  const sessionManager = new SessionManager(stateManager, goalDependencyGraph);
  const scheduleEngine = new ScheduleEngine({
    baseDir: stateManager.getBaseDir(),
    dataSourceRegistry,
    llmClient,
    stateManager,
    knowledgeManager,
  });
  await scheduleEngine.loadEntries();
  const pluginLoader = new PluginLoader(
    adapterRegistry,
    dataSourceRegistry,
    new NotifierRegistry(),
    undefined,
    undefined,
    (dataSource) => {
      if (!observationEngine.getDataSources().some((source) => source.sourceId === dataSource.sourceId)) {
        observationEngine.addDataSource(dataSource);
      }
    }
  );
  await pluginLoader.loadAll().catch(() => []);
  await scheduleEngine.syncExternalSources(pluginLoader.getScheduleSources()).catch(() => undefined);
  const runtimeRoot = path.join(stateManager.getBaseDir(), "runtime");
  const runtimeStorePaths = createRuntimeStorePaths(runtimeRoot);
  const controlDbOptions = { controlBaseDir: stateManager.getBaseDir() };
  const permissionGrantStore = new PermissionGrantStore(runtimeStorePaths, controlDbOptions);
  const permissionWaitPlanStore = new PermissionWaitPlanStore(runtimeStorePaths, controlDbOptions);
  const capabilityVerificationStore = new CapabilityVerificationStore(runtimeStorePaths, controlDbOptions);
  const capabilityExecutionResolver = createCapabilityExecutionResolver({ stateManager });
  const runtimeControlService = new RuntimeControlService({
    runtimeRoot,
    stateManager,
    permissionGrantStore,
    executor: createDaemonRuntimeControlExecutor({
      baseDir: stateManager.getBaseDir(),
    }),
  });

  for (const tool of createBuiltinTools({
    stateManager,
    trustManager,
    registry: toolRegistry,
    llmClient,
    runtimeControlService,
    adapterRegistry,
    knowledgeManager,
    observationEngine,
    sessionManager,
    scheduleEngine,
    pluginLoader,
  })) {
    toolRegistry.register(tool);
  }

  const toolExecutor = new ToolExecutor({
    registry: toolRegistry,
    permissionManager: new ToolPermissionManager({ trustManager }),
    concurrency: new ConcurrencyController(),
  });

  const chatAgentLoopRunner = shouldUseNativeTaskAgentLoop(providerConfig, llmClient)
    ? createNativeChatAgentLoopRunner({
        llmClient,
        providerConfig,
        toolRegistry,
        toolExecutor,
        traceBaseDir: stateManager.getBaseDir(),
      })
    : undefined;
  const reviewAgentLoopRunner = shouldUseNativeTaskAgentLoop(providerConfig, llmClient)
    ? createNativeReviewAgentLoopRunner({
        llmClient,
        providerConfig,
        toolRegistry,
        toolExecutor,
        traceBaseDir: stateManager.getBaseDir(),
      })
    : undefined;

  const approvalBroker = new ApprovalBroker({
    store: new ApprovalStore(runtimeStorePaths, controlDbOptions),
    permissionWaitPlanStore,
  });

  return new CrossPlatformChatSessionManager({
    stateManager,
    adapter,
    llmClient,
    registry: toolRegistry,
    toolExecutor,
    chatAgentLoopRunner,
    reviewAgentLoopRunner,
    approvalBroker,
    permissionGrantStore,
    permissionWaitPlanStore,
    capabilityVerificationStore,
    capabilityExecutionResolver,
    runtimeControlService,
  });
}

registerGlobalCrossPlatformChatSessionManager(getGlobalCrossPlatformChatSessionManager);
