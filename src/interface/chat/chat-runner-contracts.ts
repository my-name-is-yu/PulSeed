import type { StateManager } from "../../base/state/state-manager.js";
import type { IAdapter } from "../../orchestrator/execution/adapter-layer.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { EscalationHandler } from "./escalation.js";
import type { ApprovalLevel } from "./mutation-tool-defs.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { ToolExecutor } from "../../tools/executor.js";
import type { DaemonClient } from "../../runtime/daemon/client.js";
import type { GoalNegotiator } from "../../orchestrator/goal/goal-negotiator.js";
import type { ChatEvent, ChatEventContext, ChatEventHandler } from "./chat-events.js";
import type { ChatAgentLoopRunner } from "../../orchestrator/execution/agent-loop/chat-agent-loop-runner.js";
import type { ReviewAgentLoopRunner } from "../../orchestrator/execution/agent-loop/review-agent-loop-runner.js";
import type { RuntimeControlService } from "../../runtime/control/index.js";
import type { ApprovalBroker } from "../../runtime/approval-broker.js";
import type { ApprovalRequest, CapabilityExecutionResolver } from "../../tools/types.js";
import type { PermissionGrantStore } from "../../runtime/store/permission-grant-store.js";
import type { PermissionWaitPlanStore } from "../../runtime/store/permission-wait-plan-store.js";
import type { CapabilityVerificationStore } from "../../runtime/store/capability-verification-store.js";
import type {
  RuntimeControlActor,
  RuntimeControlReplyTarget,
} from "../../runtime/store/runtime-operation-schemas.js";
import type { SelectedChatRoute } from "./ingress-router.js";
import type { ChatRunnerEventBridge } from "./chat-runner-event-bridge.js";
import type { SetupSecretIntakeResult } from "./setup-secret-intake.js";
import type { SetupDialogueRuntimeState } from "./setup-dialogue.js";
import type { TurnLanguageHint } from "./turn-language.js";
import type { RunSpecConfirmationState } from "./chat-history.js";
import type { ExecutionPolicy } from "../../orchestrator/execution/agent-loop/execution-policy.js";
import type { ChatHistory } from "./chat-history.js";
import type { EventSubscriber } from "./event-subscriber.js";
import type { UserInput } from "./user-input.js";

export type ChatRunnerTelegramSetupState = "unconfigured" | "partially_configured" | "configured";

export interface ChatRunnerTelegramSetupStatus {
  channel: "telegram";
  state: ChatRunnerTelegramSetupState;
  configPath: string;
  daemon: {
    running: boolean;
    port: number;
  };
  gateway: {
    loadState: "unknown";
  };
  config: {
    exists: boolean;
    hasBotToken: boolean;
    hasHomeChat: boolean;
    allowAll: boolean;
    allowedUserCount: number;
    runtimeControlAllowedUserCount: number;
    identityKeyConfigured: boolean;
  };
}

export interface ChatRunnerGatewaySetupStatusProvider {
  getTelegramStatus(baseDir?: string): Promise<ChatRunnerTelegramSetupStatus>;
}

export interface ChatRunnerDeps {
  stateManager: StateManager;
  adapter: IAdapter;
  llmClient?: ILLMClient;
  runtimeEvidenceGateClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">;
  escalationHandler?: EscalationHandler;
  trustManager?: { getBalance(domain: string): Promise<{ balance: number }>; setOverride?(domain: string, balance: number, reason: string): Promise<void> };
  pluginLoader?: { loadAll(): Promise<Array<{ name: string; type?: string; enabled?: boolean }>> };
  approvalFn?: (description: string) => Promise<boolean>;
  approvalRequestFn?: (request: ApprovalRequest) => Promise<boolean>;
  goalId?: string;
  approvalConfig?: Record<string, ApprovalLevel>;
  toolExecutor?: ToolExecutor;
  registry?: ToolRegistry;
  onToolStart?: (toolName: string, args: Record<string, unknown>) => void;
  onToolEnd?: (toolName: string, result: { success: boolean; summary: string; durationMs: number }) => void;
  daemonClient?: DaemonClient;
  goalNegotiator?: GoalNegotiator;
  onNotification?: (message: string) => void;
  daemonBaseUrl?: string;
  onEvent?: ChatEventHandler;
  chatAgentLoopRunner?: ChatAgentLoopRunner;
  reviewAgentLoopRunner?: Pick<ReviewAgentLoopRunner, "execute">;
  runtimeControlService?: Pick<RuntimeControlService, "request">;
  approvalBroker?: Pick<
    ApprovalBroker,
    "requestConversationalApproval" | "resolveConversationalApproval" | "findPendingConversationalApproval" | "loadPendingApproval"
  >;
  permissionGrantStore?: Pick<PermissionGrantStore, "createActive" | "list" | "recordUse">;
  permissionWaitPlanStore?: Pick<
    PermissionWaitPlanStore,
    "createWaiting" | "markApproved" | "markDenied" | "markExpired" | "resumeApproved"
  >;
  capabilityVerificationStore?: Pick<CapabilityVerificationStore, "saveVerification" | "saveAudit">;
  capabilityExecutionResolver?: CapabilityExecutionResolver;
  permissionGrantContext?: {
    sessionId?: string;
    projectId?: string;
  };
  runtimeControlApprovalFn?: (description: string) => Promise<boolean>;
  runtimeReplyTarget?: RuntimeControlReplyTarget;
  runtimeControlActor?: RuntimeControlActor;
  gatewaySetupStatusProvider?: ChatRunnerGatewaySetupStatusProvider;
}

export interface ChatRunResult {
  success: boolean;
  output: string;
  elapsed_ms: number;
}

export interface RuntimeControlChatContext {
  replyTarget?: RuntimeControlReplyTarget;
  actor?: RuntimeControlActor;
  approvalFn?: (description: string) => Promise<boolean>;
  allowed?: boolean;
  approvalMode?: "interactive" | "preapproved" | "disallowed";
}

export interface ChatRunnerRouteSelectionInput {
  safeInput: string;
  setupSecretIntake: SetupSecretIntakeResult;
  runtimeControlContext: RuntimeControlChatContext | null;
  eventContext: ChatEventContext;
  cwd: string;
  sessionId: string | null;
}

export interface ChatRunnerExecutionOptions {
  selectedRoute?: SelectedChatRoute;
  routeSelector?: (input: ChatRunnerRouteSelectionInput) => Promise<SelectedChatRoute>;
  presenceIngressId?: string;
  runtimeControlContext?: RuntimeControlChatContext | null;
  goalId?: string;
  userInput?: UserInput;
}

export interface PendingTendState {
  goalId: string;
  maxIterations?: number;
}

export interface ResumeCommand {
  selector?: string;
}

export interface ChatRunnerCommandHost {
  deps: ChatRunnerDeps;
  onNotification?: (message: string) => void;
  getHistory(): ChatHistory | null;
  setHistory(history: ChatHistory | null): void;
  getSessionCwd(): string | null;
  setSessionCwd(cwd: string | null): void;
	  setSessionActive(active: boolean): void;
	  getNativeAgentLoopStatePath(): string | null;
	  setNativeAgentLoopStatePath(path: string | null): void;
	  getNativeAgentLoopSessionId?(): string | null;
	  setNativeAgentLoopSessionId?(sessionId: string | null): void;
  getRuntimeControlContext(): RuntimeControlChatContext | null;
  getPendingTend(): PendingTendState | null;
  setPendingTend(value: PendingTendState | null): void;
  getLastSelectedRoute(): SelectedChatRoute | null;
  getSessionExecutionPolicy(): Promise<ExecutionPolicy>;
  reloadProviderRuntime?(): Promise<void>;
  emitEvent(event: ChatEvent): void;
  getActiveSubscribers(): Map<string, EventSubscriber>;
}

export interface ChatRunnerRouteHost {
  deps: ChatRunnerDeps;
  eventBridge: ChatRunnerEventBridge;
  activatedTools: Set<string>;
  getRuntimeEvidenceGateClient(): Pick<ILLMClient, "sendMessage" | "parseJSON"> | undefined;
	  getConversationSessionId(): string | null;
	  getSessionCwd(): string | null;
	  getNativeAgentLoopStatePath(): string | null;
	  getNativeAgentLoopSessionId(): string | null;
  getProviderConfigBaseDir(): string;
  getSetupSecretIntake(): SetupSecretIntakeResult | null;
  getTurnLanguageHint(): TurnLanguageHint;
  setPendingSetupDialogue(dialogue: SetupDialogueRuntimeState | null): Promise<void>;
  getPendingSetupDialogue(): SetupDialogueRuntimeState | null;
  setPendingRunSpecConfirmation(confirmation: RunSpecConfirmationState | null): Promise<void>;
  getPendingRunSpecConfirmation(): RunSpecConfirmationState | null;
  getSessionExecutionPolicy(): Promise<ExecutionPolicy>;
  setSessionExecutionPolicy(policy: ExecutionPolicy): void;
}
