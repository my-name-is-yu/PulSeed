// ─── ChatRunner ───
//
// Central coordinator for 1-shot chat execution (Tier 1).
// Bypasses TaskLifecycle — calls adapter.execute() directly.

import type { StateManager } from "../../base/state/state-manager.js";
import { getPulseedDirPath } from "../../base/utils/paths.js";
import { ChatHistory, type ChatSession } from "./chat-history.js";
import {
  ChatSessionCatalog,
  ChatSessionSelectorError,
  type LoadedChatSession,
} from "./chat-session-store.js";
import {
  chooseSingleRecoveryResumeCandidate,
  classifyRecoveryResumeIntent,
  formatNoRecoveryResumeCandidates,
  formatRecoveryResumeChoices,
  toRecoveryResumeCandidates,
  type RecoveryResumeCandidate,
} from "./recovery-resume.js";
import { buildChatContext, resolveGitRoot } from "../../platform/observation/context-provider.js";
import { buildChatAgentLoopSystemPrompt, buildStaticSystemPrompt, createChatGroundingGateway } from "./grounding.js";
import type { GroundingGateway } from "../../grounding/gateway.js";
import type { ChatEventHandler } from "./chat-events.js";
import { classifyRuntimeControlIntent } from "../../runtime/control/index.js";
import { classifyConfirmationDecision } from "../../runtime/confirmation-decision.js";
import type { RuntimeControlReplyTarget } from "../../runtime/store/runtime-operation-schemas.js";
import type { RuntimeReplyTarget } from "../../runtime/session-registry/types.js";
import type { ExecutionPolicy } from "../../orchestrator/execution/agent-loop/execution-policy.js";
import {
  createIngressRouter,
  type ChatIngressMessage,
  type SelectedChatRoute,
} from "./ingress-router.js";
import { classifyInterruptRedirect, collectGitDiffArtifact, previewActivityText } from "./chat-runner-support.js";
import {
  COMMAND_HELP,
  ChatRunnerCommandHandler,
} from "./chat-runner-commands.js";
import { ChatRunnerEventBridge, type AssistantBuffer } from "./chat-runner-event-bridge.js";
import type {
  ChatRunResult,
  ChatRunnerDeps,
  ChatRunnerExecutionOptions,
  PendingTendState,
  ResumeCommand,
  RuntimeControlChatContext,
} from "./chat-runner-contracts.js";
import { intakeSetupSecrets } from "./setup-secret-intake.js";
import {
  isSetupWriteConfirmCommand,
  SETUP_WRITE_CONFIRM_COMMAND,
  type SetupDialogueRuntimeState,
} from "./setup-dialogue.js";
import {
  detectTurnLanguageHint,
  sameLanguageResponseInstruction,
  UNKNOWN_TURN_LANGUAGE_HINT,
  type TurnLanguageHint,
} from "./turn-language.js";
import { confirmTelegramGatewayConfigWrite } from "./setup-config-write.js";
import {
  buildRuntimeControlContextFromIngress,
  buildStandaloneIngressMessageFromContext,
  formatRoute,
  getRouteCapabilities,
  loadedSessionToChatSession,
  resolveChatResumeSelector,
} from "./chat-runner-runtime.js";
import {
  executeAdapterRoute,
  executeAssistRoute,
  executeClarifyRoute,
  executeConfigureRoute,
  executeRunSpecDraftRoute,
  executeAgentLoopRoute,
  formatBlockedRuntimeControlRoute,
  executeRuntimeControlRoute,
  executeToolLoopRoute,
  resolveSessionExecutionPolicy,
} from "./chat-runner-routes.js";
import { classifyFreeformRouteIntent } from "./freeform-route-classifier.js";
import { deriveRunSpecFromText } from "../../runtime/run-spec/index.js";
import { createTextUserInput, normalizeUserInput, replaceUserInputText, type UserInput } from "./user-input.js";
import { createTurnStartOperation, createTurnSteerOperation } from "./turn-protocol.js";
import {
  buildChatTurnContext,
  renderSystemPromptWithTurnContext,
  toTurnContextSnapshot,
} from "./turn-context.js";
import {
  createRunSpecStore,
  formatRunSpecSetupProposal,
  arbitrateRunSpecPendingDialogue,
  handleRunSpecConfirmationInput,
  RunSpecHandoffService,
  validateRunSpecStartSafety,
  type RunSpec,
} from "../../runtime/run-spec/index.js";

export type {
  ChatRunResult,
  ChatRunnerDeps,
  ChatRunnerExecutionOptions,
  RuntimeControlChatContext,
} from "./chat-runner-contracts.js";

const DEFAULT_TIMEOUT_MS = 120_000;

function normalizePinnedReplyTarget(replyTarget: RuntimeControlReplyTarget | null): RuntimeReplyTarget | null {
  if (!replyTarget) return null;
  const channel = replyTarget.channel ?? replyTarget.surface;
  if (!channel) return null;
  return {
    channel,
    target_id: replyTarget.conversation_id ?? replyTarget.identity_key ?? replyTarget.response_channel ?? null,
    thread_id: replyTarget.message_id ?? null,
    metadata: {
      ...replyTarget,
      ...(replyTarget.metadata ?? {}),
    },
  };
}

const standaloneIngressRouter = createIngressRouter();

function formatPendingSetupConfirmationSubject(publicState: SetupDialogueRuntimeState["publicState"]): string {
  const lines = [
    `Setup dialogue: ${publicState.selectedChannel}`,
    `State: ${publicState.state}`,
    `Action: ${publicState.action?.kind ?? "unknown"}`,
    `Command fallback: ${publicState.action?.command ?? SETUP_WRITE_CONFIRM_COMMAND}`,
    publicState.replacesExistingSecret
      ? "Confirming will replace an existing configured Telegram bot token."
      : "Confirming will write a Telegram gateway config from a redacted chat-supplied token.",
    "Approval is still required before writing config.",
  ];
  return lines.join("\n");
}

function formatSetupConfirmationCancelled(): string {
  return "Telegram setup config write was cancelled. No token was written.";
}

function formatTelegramSetupRefreshResult(
  result: { success: boolean; message: string; operationId?: string; state?: string; unavailable?: boolean }
): string {
  if (result.success) {
    const suffix = result.operationId ? ` (${result.operationId})` : "";
    return `PulSeed requested a gateway reload for the updated Telegram config${suffix}: ${result.message}`;
  }
  if (result.unavailable) {
    return `PulSeed could not request a gateway reload from this chat surface: ${result.message}`;
  }
  return `PulSeed requested a gateway reload, but it failed: ${result.message}`;
}

export class ChatRunner {
  private readonly groundingGateway: GroundingGateway;
  private readonly eventBridge: ChatRunnerEventBridge;
  private readonly commandHandler: ChatRunnerCommandHandler;
  private history: ChatHistory | null = null;
  private sessionCwd: string | null = null;
  private sessionActive = false;
  private activatedTools: Set<string> = new Set();
  private cachedStaticSystemPrompt: string | null = null;
  private pendingTend: PendingTendState | null = null;
  private activeSubscribers = new Map<string, { unsubscribe(): void }>();
  onNotification: ((message: string) => void) | undefined = undefined;
  onEvent: ChatEventHandler | undefined = undefined;
  private nativeAgentLoopStatePath: string | null = null;
  private nativeAgentLoopSessionId: string | null = null;
  private runtimeControlContext: RuntimeControlChatContext | null = null;
  private sessionExecutionPolicy: ExecutionPolicy | null = null;
  private lastSelectedRoute: SelectedChatRoute | null = null;
  private setupSecretIntake: ReturnType<typeof intakeSetupSecrets> | null = null;
  private turnLanguageHint: TurnLanguageHint = UNKNOWN_TURN_LANGUAGE_HINT;
  private pendingSetupDialogue: SetupDialogueRuntimeState | null = null;
  private pendingResumeChoices: RecoveryResumeCandidate[] | null = null;
  private eventJournalHistory: ChatHistory | null = null;
  private eventJournalDirty = false;

  constructor(private readonly deps: ChatRunnerDeps) {
    this.groundingGateway = createChatGroundingGateway({
      stateManager: deps.stateManager,
      pluginLoader: deps.pluginLoader,
    });
    this.eventBridge = new ChatRunnerEventBridge(() => this.onEvent ?? this.deps.onEvent);
    this.commandHandler = new ChatRunnerCommandHandler({
      deps: this.deps,
      onNotification: this.onNotification,
      getHistory: () => this.history,
      setHistory: (history) => { this.history = history; },
      getSessionCwd: () => this.sessionCwd,
      setSessionCwd: (cwd) => { this.sessionCwd = cwd; },
      setSessionActive: (active) => { this.sessionActive = active; },
      getNativeAgentLoopStatePath: () => this.nativeAgentLoopStatePath,
      setNativeAgentLoopStatePath: (path) => { this.nativeAgentLoopStatePath = path; },
      getNativeAgentLoopSessionId: () => this.nativeAgentLoopSessionId,
      setNativeAgentLoopSessionId: (sessionId) => { this.nativeAgentLoopSessionId = sessionId; },
      getRuntimeControlContext: () => this.runtimeControlContext,
      getPendingTend: () => this.pendingTend,
      setPendingTend: (value) => { this.pendingTend = value; },
      getLastSelectedRoute: () => this.lastSelectedRoute,
      getSessionExecutionPolicy: () => this.getSessionExecutionPolicy(),
      reloadProviderRuntime: () => this.reloadProviderRuntime(),
      emitEvent: (event) => this.eventBridge.emitEvent(event),
      getActiveSubscribers: () => this.activeSubscribers as Map<string, never>,
      setSessionExecutionPolicy: (policy: ExecutionPolicy) => { this.sessionExecutionPolicy = policy; },
      resetSessionExecutionPolicy: () => { this.sessionExecutionPolicy = null; },
    } as ConstructorParameters<typeof ChatRunnerCommandHandler>[0]);
  }

  startSession(cwd: string): void {
    const gitRoot = resolveGitRoot(cwd);
    const sessionId = crypto.randomUUID();
    this.history = new ChatHistory(this.deps.stateManager, sessionId, gitRoot);
    this.sessionCwd = gitRoot;
    this.sessionActive = true;
    this.nativeAgentLoopStatePath = null;
    this.nativeAgentLoopSessionId = sessionId;
    this.history.resetAgentLoopState(null);
    this.history.setAgentLoopSessionIdentity({ sessionId, traceId: null });
    this.sessionExecutionPolicy = null;
  }

  startSessionFromLoadedSession(session: LoadedChatSession): void {
    const chatSession = loadedSessionToChatSession(session);
    this.history = ChatHistory.fromSession(this.deps.stateManager, chatSession);
    this.sessionCwd = resolveGitRoot(session.cwd);
    this.sessionActive = true;
    this.nativeAgentLoopStatePath = session.agentLoopStatePath ?? null;
    this.nativeAgentLoopSessionId = session.agentLoopSessionId ?? session.id;
    this.history.setAgentLoopStatePath(this.nativeAgentLoopStatePath);
    this.history.setAgentLoopSessionIdentity({
      sessionId: this.nativeAgentLoopSessionId,
      traceId: session.agentLoopTraceId ?? null,
    });
    this.sessionExecutionPolicy = null;
  }

  getSessionId(): string | null {
    return this.history?.getSessionId() ?? null;
  }

  getCurrentSessionMessages(): ChatSession["messages"] {
    return this.history?.getMessages() ?? [];
  }

  private async resolvePendingResumeSelection(input: string): Promise<{ session?: LoadedChatSession; result?: ChatRunResult } | null> {
    const candidates = this.pendingResumeChoices;
    if (!candidates || candidates.length === 0) return null;
    const choice = parseResumeChoiceNumber(input);
    if (choice === null) {
      this.pendingResumeChoices = null;
      return null;
    }
    const candidate = candidates.find((item) => item.index === choice);
    if (!candidate) {
      return {
        result: {
          success: false,
          output: formatRecoveryResumeChoices(candidates),
          elapsed_ms: 0,
        },
      };
    }
    this.pendingResumeChoices = null;
    const catalog = new ChatSessionCatalog(this.deps.stateManager);
    const session = await catalog.loadSession(candidate.sessionId);
    if (!session) {
      return {
        result: {
          success: false,
          output: formatNoRecoveryResumeCandidates(),
          elapsed_ms: 0,
        },
      };
    }
    return { session };
  }

  private async resolveResumeSelectorChoice(selector: string): Promise<{ session?: LoadedChatSession; result?: ChatRunResult } | null> {
    const choice = parseResumeChoiceNumber(selector);
    if (choice === null) {
      this.pendingResumeChoices = null;
      return null;
    }
    if (!this.pendingResumeChoices) return null;
    return this.resolvePendingResumeSelection(String(choice));
  }

  private clearPendingResumeChoicesUnlessSelecting(input: string, resumeCommand: ResumeCommand | null): void {
    if (!this.pendingResumeChoices) return;
    const selectionInput = resumeCommand?.selector ?? input;
    if (parseResumeChoiceNumber(selectionInput) === null) {
      this.pendingResumeChoices = null;
    }
  }

  private async resolveNaturalRecoveryResume(input: string): Promise<{ session?: LoadedChatSession; result?: ChatRunResult } | null> {
    if (!this.deps.chatAgentLoopRunner) return null;
    if (this.sessionActive) return null;
    const catalog = this.createChatSessionCatalog();
    if (!catalog) return null;
    const sessions = await catalog.listSessions();
    const candidates = toRecoveryResumeCandidates(sessions);
    const decision = await classifyRecoveryResumeIntent(input, this.deps.llmClient);
    if (!decision || decision.kind === "none") return null;
    if (candidates.length === 0) {
      this.pendingResumeChoices = null;
      return {
        result: {
          success: false,
          output: formatNoRecoveryResumeCandidates(),
          elapsed_ms: 0,
        },
      };
    }
    if (decision.kind === "show_sessions" || decision.kind === "inspect_running") {
      this.pendingResumeChoices = candidates;
      return {
        result: {
          success: true,
          output: formatRecoveryResumeChoices(candidates),
          elapsed_ms: 0,
        },
      };
    }
    if (decision.kind === "start_new") {
      this.pendingResumeChoices = null;
      return null;
    }
    const candidate = chooseSingleRecoveryResumeCandidate(candidates);
    if (!candidate) {
      this.pendingResumeChoices = candidates;
      return {
        result: {
          success: true,
          output: formatRecoveryResumeChoices(candidates),
          elapsed_ms: 0,
        },
      };
    }
    this.pendingResumeChoices = null;
    const session = await catalog.loadSession(candidate.sessionId);
    if (!session) {
      return {
        result: {
          success: false,
          output: formatNoRecoveryResumeCandidates(),
          elapsed_ms: 0,
        },
      };
    }
    return { session };
  }

  private createChatSessionCatalog(): ChatSessionCatalog | null {
    const stateManager = this.deps.stateManager as StateManager & { getBaseDir?: () => string };
    return typeof stateManager.getBaseDir === "function" ? new ChatSessionCatalog(this.deps.stateManager) : null;
  }

  hasActiveTurn(): boolean {
    return this.eventBridge.hasActiveTurn();
  }

  async interruptAndRedirect(
    input: string,
    cwd: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    options: { userInput?: UserInput } = {},
  ): Promise<ChatRunResult> {
    const steerUserInput = normalizeUserInput(options.userInput, input);
    const activeTurn = this.eventBridge.getActiveTurn();
    if (!activeTurn) {
      return this.execute(input, cwd, timeoutMs, { userInput: steerUserInput });
    }

    const start = Date.now();
    const steerOperation = createTurnSteerOperation({
      activeTurn,
      userInput: steerUserInput,
    });
    this.eventBridge.emitEvent({
      type: "turn_steer",
      input,
      userInput: steerUserInput,
      operation: steerOperation,
      ...this.eventBridge.eventBase(activeTurn.context),
    });
    const redirect = await classifyInterruptRedirect(input, {
      llmClient: this.deps.llmClient,
      cwd: activeTurn.cwd,
      activeTurnStartedAt: new Date(activeTurn.startedAt).toISOString(),
      recentEvents: activeTurn.recentEvents,
      sessionId: this.getSessionId(),
    });
    if (this.eventBridge.getActiveTurn() !== activeTurn) {
      return this.execute(input, cwd, timeoutMs, { userInput: steerUserInput });
    }
    if (redirect === "background") {
      return this.eventBridge.emitEphemeralAssistantResult(input, [
        "Continuing this same turn in the background is not available yet.",
        "",
        "The active turn is still running in the foreground.",
        "Use /tend for daemon-backed work, or send a narrower follow-up request.",
      ].join("\n"), true, start, {
        context: activeTurn.context,
        operation: steerOperation,
        userInput: steerUserInput,
      });
    }

    activeTurn.interruptRequested = true;
    if (!activeTurn.abortController.signal.aborted) {
      activeTurn.abortController.abort();
    }
    this.eventBridge.emitCheckpoint("Interrupt requested", `Redirect: ${previewActivityText(input, 120)}`, activeTurn.context, "interrupt");

    const stopped = await this.eventBridge.waitForActiveTurn(activeTurn, 2_000);
    if (!stopped) {
      return this.eventBridge.emitEphemeralAssistantResult(
        input,
        "Interrupt requested. The active turn will stop at the next safe point.",
        false,
        start,
        {
          context: activeTurn.context,
          operation: steerOperation,
          userInput: steerUserInput,
        },
      );
    }

    let output: string;
    if (redirect === "diff") {
      const diff = await collectGitDiffArtifact(activeTurn.cwd);
      if (diff) {
        const context = this.eventBridge.createEventContext();
        this.eventBridge.emitDiffArtifact(diff, context);
        output = "Interrupted the active turn. Current diff is shown above.";
      } else {
        output = "Interrupted the active turn. No working-tree changes were detected.";
      }
    } else if (redirect === "review") {
      const review = await this.commandHandler.handleCommand("/review", activeTurn.cwd);
      output = `Interrupted the active turn and switched to review-only mode.\n\n${review?.output ?? "Review unavailable."}`;
    } else {
      output = [
        "Interrupted the active turn.",
        "",
        "Activity before interruption",
        ...(activeTurn.recentEvents.length > 0
          ? activeTurn.recentEvents.slice(-6).map((event) => `- ${event}`)
          : ["- No activity was captured before the interrupt."]),
        "",
        "Next actions",
        "- Ask for the exact continuation you want.",
        "- Ask to show diff or switch to review if files may have changed.",
      ].join("\n");
    }

    return this.eventBridge.emitEphemeralAssistantResult(
      input,
      output,
      true,
      start,
      {
        context: activeTurn.context,
        operation: steerOperation,
        userInput: steerUserInput,
      },
    );
  }

  setRuntimeControlContext(context: RuntimeControlChatContext | null): void {
    this.runtimeControlContext = context;
  }

  async executeIngressMessage(
    ingress: ChatIngressMessage,
    cwd: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    selectedRoute: SelectedChatRoute
  ): Promise<ChatRunResult> {
    if (!selectedRoute) {
      throw new Error(
        "executeIngressMessage requires selectedRoute; use CrossPlatformChatSessionManager for ingress route selection."
      );
    }
    const runtimeControlContext = buildRuntimeControlContextFromIngress(ingress, this.runtimeControlContext, this.deps);
    return this.execute(ingress.text, cwd, timeoutMs, {
      selectedRoute,
      runtimeControlContext,
      goalId: ingress.goal_id,
      userInput: ingress.userInput,
    });
  }

  async execute(
    input: string,
    cwd: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    options: ChatRunnerExecutionOptions = {}
  ): Promise<ChatRunResult> {
    const eventContext = this.eventBridge.createEventContext();
    const resolvedCwd = resolveGitRoot(cwd);
    const activeTurn = this.eventBridge.beginActiveTurn(eventContext, resolvedCwd);
    this.eventBridge.setEventRecorder(null);
    this.eventJournalHistory = null;
    this.eventJournalDirty = false;
    const resumeCommand = this.commandHandler.parseResumeCommand(input);
    let resumeOnly = resumeCommand !== null;
    const setupSecretIntake = intakeSetupSecrets(input);
    this.setupSecretIntake = setupSecretIntake;
    const safeInput = setupSecretIntake.redactedText;
    const safeUserInput = options.userInput
      ? replaceUserInputText(options.userInput, safeInput)
      : createTextUserInput(safeInput);
    this.turnLanguageHint = detectTurnLanguageHint(safeInput);
    eventContext.languageHint = this.turnLanguageHint;
    const persistedSecretIntake = setupSecretIntake.suppliedSecrets.map(({ value: _value, ...metadata }) => metadata);
    const runtimeControlContext = options.runtimeControlContext ?? this.runtimeControlContext;
    const executionGoalId = options.goalId ?? this.deps.goalId;

    this.clearPendingResumeChoicesUnlessSelecting(safeInput, resumeCommand);

    const pendingTelegramSetupResult = await this.handlePendingSetupConfirmation(safeInput, runtimeControlContext);
    if (pendingTelegramSetupResult !== null) {
      return this.finalizeNonPersistentResult(pendingTelegramSetupResult, eventContext);
    }

    const pendingRunSpecConfirmationResult = await this.handlePendingRunSpecConfirmation(safeInput);
    if (pendingRunSpecConfirmationResult !== null) {
      return this.finalizeNonPersistentResult(pendingRunSpecConfirmationResult, eventContext);
    }

    const commandResult = resumeOnly ? null : await this.commandHandler.handleCommand(safeInput, resolvedCwd);
    if (commandResult !== null) {
      return this.finalizeNonPersistentResult(commandResult, eventContext);
    }

    if (this.pendingTend !== null && !resumeOnly) {
      const confirmationResult = await this.commandHandler.handleTendConfirmation(safeInput.trim(), Date.now());
      return this.finalizeNonPersistentResult(confirmationResult, eventContext);
    }

    const pendingResumeSelection = !resumeOnly
      ? await this.resolvePendingResumeSelection(safeInput)
      : null;
    if (pendingResumeSelection?.result) {
      return this.finalizeNonPersistentResult(pendingResumeSelection.result, eventContext);
    }
    if (pendingResumeSelection?.session) {
      this.startSessionFromLoadedSession(pendingResumeSelection.session);
      resumeOnly = true;
    }

    if (resumeCommand?.selector) {
      try {
        const selectedChoice = await this.resolveResumeSelectorChoice(resumeCommand.selector);
        if (selectedChoice?.result) {
          return this.finalizeNonPersistentResult(selectedChoice.result, eventContext);
        }
        if (selectedChoice?.session) {
          this.startSessionFromLoadedSession(selectedChoice.session);
        } else {
          const selectorResolution = await resolveChatResumeSelector(resumeCommand.selector, this.deps);
          if (selectorResolution.nonResumableMessage) {
            return this.finalizeNonPersistentResult({
              success: false,
              output: selectorResolution.nonResumableMessage,
              elapsed_ms: 0,
            }, eventContext);
          }
          const catalog = new ChatSessionCatalog(this.deps.stateManager);
          const session = await catalog.loadSessionBySelector(selectorResolution.chatSelector);
          if (!session) {
            return this.finalizeNonPersistentResult({
              success: false,
              output: `No chat session matched selector "${selectorResolution.chatSelector}".`,
              elapsed_ms: 0,
            }, eventContext);
          }
          this.startSessionFromLoadedSession(session);
        }
      } catch (err) {
        const output = err instanceof ChatSessionSelectorError ? err.message : `Failed to load chat session: ${err instanceof Error ? err.message : String(err)}`;
        return this.finalizeNonPersistentResult({ success: false, output, elapsed_ms: 0 }, eventContext);
      }
    }

    const shouldResolveNaturalRecovery = !options.selectedRoute || options.selectedRoute.kind === "agent_loop";
    if (!resumeOnly && pendingResumeSelection === null && shouldResolveNaturalRecovery) {
      const naturalRecovery = await this.resolveNaturalRecoveryResume(safeInput);
      if (naturalRecovery?.result) {
        return this.finalizeNonPersistentResult(naturalRecovery.result, eventContext);
      }
      if (naturalRecovery?.session) {
        this.startSessionFromLoadedSession(naturalRecovery.session);
        resumeOnly = true;
      }
    }

    if (!this.sessionActive) {
      const sessionId = crypto.randomUUID();
      this.history = new ChatHistory(this.deps.stateManager, sessionId, resolvedCwd);
      this.nativeAgentLoopStatePath = null;
      this.nativeAgentLoopSessionId = sessionId;
      this.history.resetAgentLoopState(null);
      this.history.setAgentLoopSessionIdentity({ sessionId, traceId: null });
    }
    const executionCwd = this.sessionCwd ?? resolvedCwd;
    const gitRoot = this.sessionCwd ?? resolvedCwd;
    activeTurn.cwd = gitRoot;
    const history = this.history!;
    this.eventJournalHistory = history;
    this.eventBridge.setEventRecorder((event) => {
      this.eventJournalDirty = true;
      return history.recordChatEvent(event, { persist: false });
    });
    const pinnedReplyTarget = normalizePinnedReplyTarget(
      runtimeControlContext?.replyTarget ?? this.deps.runtimeReplyTarget ?? null,
    );
    if (pinnedReplyTarget) {
      history.setNotificationReplyTarget(pinnedReplyTarget);
    }

    this.eventBridge.emitEvent({
      type: "lifecycle_start",
      input: safeInput,
      userInput: safeUserInput,
      operation: createTurnStartOperation({
        context: eventContext,
        cwd: gitRoot,
        userInput: safeUserInput,
      }),
      ...this.eventBridge.eventBase(eventContext),
    });

    if (!resumeOnly) {
      await history.appendUserMessage(safeInput, {
        setupSecretIntake: persistedSecretIntake,
        eventContext,
        userInput: safeUserInput,
      });
    }

    if (this.cachedStaticSystemPrompt === null) {
      try {
        this.cachedStaticSystemPrompt = buildStaticSystemPrompt(this.providerConfigBaseDir());
      } catch {
        this.cachedStaticSystemPrompt = "";
      }
    }

    const messages = history.getModelVisibleMessages();
    const sessionData = history.getSessionData();
    const compactionSummary = sessionData.compactionSummary;
    const compactionRecords = sessionData.compactionRecords ?? [];
    const priorTurns = resumeOnly ? messages.slice(-10) : messages.slice(0, -1).slice(-10);
    const historySections: string[] = [];
    if (compactionSummary) {
      historySections.push(`Compacted previous conversation summary:\n${compactionSummary}`);
    }
    if (priorTurns.length > 0) {
      const lines = priorTurns.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n");
      historySections.push(`Previous conversation:\n${lines}`);
    }
    const historyBlock = historySections.length > 0 ? `${historySections.join("\n\n")}\n\nCurrent message:\n` : "";

    const start = Date.now();
    const assistantBuffer: AssistantBuffer = { text: "" };

    const selectedRoute = resumeOnly
      ? null
      : (options.selectedRoute ?? await this.resolveRouteFromInput(safeInput, runtimeControlContext, resolvedCwd));
    this.lastSelectedRoute = selectedRoute;
    if (selectedRoute?.kind !== "configure") {
      this.eventBridge.emitIntent(safeInput, selectedRoute, eventContext);
    }

    if (selectedRoute?.kind === "runtime_control") {
      this.eventBridge.emitCheckpoint("Runtime control selected", `${selectedRoute.intent.kind} request recognized.`, eventContext, "route");
      const runtimeControlResult = await executeRuntimeControlRoute(this.routeHost(), selectedRoute, runtimeControlContext, executionCwd, start);
      if (runtimeControlResult.success) {
        await history.appendAssistantMessage(runtimeControlResult.output, { eventContext });
        this.eventBridge.emitCheckpoint("Runtime control completed", "The runtime-control operation produced a result.", eventContext, "complete");
        this.eventBridge.emitActivity("lifecycle", "Finalizing response...", eventContext, "lifecycle:finalizing");
        this.eventBridge.emitEvent({
          type: "assistant_final",
          text: runtimeControlResult.output,
          persisted: true,
          ...this.eventBridge.eventBase(eventContext),
        });
        this.eventBridge.emitLifecycleEndEvent("completed", runtimeControlResult.elapsed_ms, eventContext, true);
      } else {
        runtimeControlResult.output = await this.eventBridge.emitLifecycleErrorEventWithFallback(
          runtimeControlResult.output,
          assistantBuffer.text,
          eventContext,
          {
            signals: [{
              kind: "runtime",
              operationState: "runtime_control",
              stoppedReason: "runtime_control_failed",
            }],
          },
          this.deps.llmClient
        );
        this.eventBridge.emitLifecycleEndEvent("error", runtimeControlResult.elapsed_ms, eventContext, false);
      }
      return this.flushAndReturn(runtimeControlResult);
    }

    if (selectedRoute?.kind === "runtime_control_blocked") {
      const output = formatBlockedRuntimeControlRoute(selectedRoute);
      this.eventBridge.pushAssistantDelta(output, assistantBuffer, eventContext);
      await history.appendAssistantMessage(output, { eventContext });
      this.eventBridge.emitEvent({
        type: "assistant_final",
        text: output,
        persisted: true,
        ...this.eventBridge.eventBase(eventContext),
      });
      const elapsed_ms = Date.now() - start;
      this.eventBridge.emitLifecycleEndEvent("error", elapsed_ms, eventContext, true);
      return this.flushAndReturn({
        success: false,
        output,
        elapsed_ms,
      });
    }

    if (selectedRoute?.kind === "run_spec_draft") {
      const result = await executeRunSpecDraftRoute(this.routeHost(), selectedRoute, eventContext, assistantBuffer, history, start);
      return this.flushAndReturn(result);
    }

    if (selectedRoute?.kind === "configure") {
      const result = await executeConfigureRoute(this.routeHost(), selectedRoute, eventContext, assistantBuffer, history, start);
      return this.flushAndReturn(result);
    }

    if (selectedRoute?.kind === "clarify") {
      const result = await executeClarifyRoute(this.routeHost(), selectedRoute, eventContext, assistantBuffer, history, start);
      return this.flushAndReturn(result);
    }

    const usesNativeAgentLoop = resumeOnly || selectedRoute?.kind === "agent_loop";
    const executionPolicy = await this.getSessionExecutionPolicy();
    const groundingWorkspaceContext = !resumeOnly && usesNativeAgentLoop
      ? await buildChatContext(safeInput, executionCwd)
      : undefined;

    let systemPrompt = this.cachedStaticSystemPrompt ?? "";
    if (!resumeOnly) {
      try {
        this.eventBridge.emitActivity("lifecycle", "Preparing context...", eventContext, "lifecycle:context");
        if (usesNativeAgentLoop) {
          systemPrompt = await buildChatAgentLoopSystemPrompt({
            stateManager: this.deps.stateManager,
            pluginLoader: this.deps.pluginLoader,
            workspaceRoot: executionCwd,
            goalId: executionGoalId,
            userMessage: safeInput,
            trustProjectInstructions: executionPolicy.trustProjectInstructions,
            workspaceContext: groundingWorkspaceContext,
          });
        } else {
          const groundingBundle = await this.groundingGateway.build({
            surface: "chat",
            purpose: "general_turn",
            workspaceRoot: executionCwd,
            goalId: executionGoalId,
            userMessage: safeInput,
            query: safeInput,
            trustProjectInstructions: executionPolicy.trustProjectInstructions,
          });
          systemPrompt = String(groundingBundle.render("prompt"));
        }
      } catch {
        systemPrompt = this.cachedStaticSystemPrompt ?? "";
      }
      this.eventBridge.emitCheckpoint("Context gathered", usesNativeAgentLoop
        ? "Workspace and tool context are ready."
        : "Workspace grounding is ready.", eventContext, "context");
    }
    const agentLoopSystemPrompt = [
      systemPrompt,
      sameLanguageResponseInstruction(this.turnLanguageHint),
      compactionSummary ? `## Compacted Chat Summary\n${compactionSummary}` : "",
    ]
      .filter((section) => section && section.trim().length > 0)
      .join("\n\n")
      .trim();

    const context = resumeOnly || usesNativeAgentLoop ? "" : await buildChatContext(safeInput, gitRoot);
    const basePrompt = resumeOnly ? "" : (context ? `${context}\n\n${safeInput}` : safeInput);
    const prompt = historyBlock ? `${historyBlock}${basePrompt}` : basePrompt;
    const turnContext = buildChatTurnContext({
      eventContext,
      startedAt: new Date(start),
      sessionId: history.getSessionId(),
      cwd,
      gitRoot,
      executionCwd,
      nativeAgentLoopStatePath: this.nativeAgentLoopStatePath,
      nativeAgentLoopSessionId: this.nativeAgentLoopSessionId,
      selectedRoute,
      input: safeInput,
      userInput: safeUserInput,
      compactionSummary,
      compactionRecords,
      priorTurns,
      basePrompt,
      prompt,
      systemPrompt,
      agentLoopSystemPrompt,
      runtimeControlContext,
      ...(this.deps.runtimeReplyTarget ? { fallbackReplyTarget: this.deps.runtimeReplyTarget } : {}),
      ...(this.deps.runtimeControlActor ? { fallbackActor: this.deps.runtimeControlActor } : {}),
      ...(executionGoalId ? { executionGoalId } : {}),
      executionPolicy,
      setupDialogue: history.getSetupDialogue(),
      runSpecConfirmation: history.getRunSpecConfirmation(),
      setupSecretIntake,
      activatedTools: this.activatedTools,
    });
    await history.recordTurnContext(toTurnContextSnapshot(turnContext));

    if (resumeOnly && !this.deps.chatAgentLoopRunner) {
      const elapsed_ms = Date.now() - start;
      const output = await this.eventBridge.emitLifecycleErrorEventWithFallback(
        "Continuing a saved chat is not available in this mode.",
        assistantBuffer.text,
        eventContext,
        {
          code: "resume_state_missing",
          stoppedReason: "resume_state_missing",
        },
        this.deps.llmClient
      );
      this.eventBridge.emitLifecycleEndEvent("error", elapsed_ms, eventContext, false);
      return this.flushAndReturn({ success: false, output, elapsed_ms });
    }

    if (selectedRoute?.kind === "assist") {
      const result = await executeAssistRoute(this.routeHost(), {
        turnContext,
        eventContext,
        assistantBuffer,
        history,
        start,
      });
      return this.flushAndReturn(result);
    }

    if (resumeOnly || selectedRoute?.kind === "agent_loop") {
      return this.flushAndReturn(executeAgentLoopRoute(this.routeHost(), {
        turnContext,
        resumeOnly,
        assistantBuffer,
        eventContext,
        history,
        gitRoot,
        activeAbortSignal: activeTurn.abortController.signal,
        start,
      }));
    }

    if (selectedRoute?.kind === "tool_loop") {
      return this.flushAndReturn(executeToolLoopRoute(this.routeHost(), {
        turnContext,
        eventContext,
        assistantBuffer,
        systemPrompt: systemPrompt || undefined,
        executionGoalId,
        history,
        gitRoot,
        runtimeControlContext,
        start,
      }));
    }

    if (!resumeOnly && selectedRoute && selectedRoute.kind !== "adapter") {
      const elapsed_ms = Date.now() - start;
      const output = await this.eventBridge.emitLifecycleErrorEventWithFallback(
        `Unsupported chat route: ${selectedRoute.kind}`,
        assistantBuffer.text,
        eventContext,
        {},
        this.deps.llmClient
      );
      this.eventBridge.emitLifecycleEndEvent("error", elapsed_ms, eventContext, false);
      return this.flushAndReturn({ success: false, output, elapsed_ms });
    }

    return this.flushAndReturn(executeAdapterRoute(this.routeHost(), {
      turnContext,
      timeoutMs,
      systemPrompt: renderSystemPromptWithTurnContext(systemPrompt || undefined, turnContext.modelVisible),
      eventContext,
      assistantBuffer,
      gitRoot,
      start,
      history,
    }));
  }

  getSessionCwd(): string | null {
    return this.sessionCwd;
  }

  getNativeAgentLoopStatePath(): string | null {
    return this.nativeAgentLoopStatePath;
  }

  getNativeAgentLoopSessionId(): string | null {
    return this.nativeAgentLoopSessionId;
  }

  setSessionExecutionPolicy(policy: ExecutionPolicy): void {
    this.sessionExecutionPolicy = policy;
  }

  async getSessionExecutionPolicy(): Promise<ExecutionPolicy> {
    const policy = await resolveSessionExecutionPolicy(this.sessionExecutionPolicy, this.sessionCwd);
    this.sessionExecutionPolicy = policy;
    return policy;
  }

  private async resolveRouteFromIngress(ingress: ChatIngressMessage): Promise<SelectedChatRoute> {
    const capabilities = getRouteCapabilities(this.deps);
    const hasSetupSecret = (this.setupSecretIntake?.suppliedSecrets.length ?? 0) > 0;
    const surfaceRuntimePolicy = ingress.externalSurface?.runtime_control_policy;
    const runtimeControlApproved =
      surfaceRuntimePolicy
        ? surfaceRuntimePolicy.allowed === true && surfaceRuntimePolicy.approval_mode === "preapproved"
        : ingress.metadata["runtime_control_approved"] === true;
    const runtimeControlDenied =
      surfaceRuntimePolicy
        ? surfaceRuntimePolicy.approval_mode === "disallowed"
        : ingress.metadata["runtime_control_denied"] === true;
    const runtimeControlPolicyPresent =
      runtimeControlApproved || runtimeControlDenied || ingress.metadata["runtime_control_explicit"] === true;
    const shouldPreferFreeformBeforeDeniedRuntimeControl =
      !hasSetupSecret
      && !capabilities.hasAgentLoop
      && runtimeControlDenied
      && !runtimeControlApproved
      && ingress.metadata["runtime_control_explicit"] !== true;
    const shouldClassifyRuntimeControlForSafety =
      !hasSetupSecret
      && capabilities.hasAgentLoop
      && runtimeControlPolicyPresent;
    const shouldClassifyRuntimeControl =
      shouldClassifyRuntimeControlForSafety
      || (!hasSetupSecret && !capabilities.hasAgentLoop && (
        (capabilities.hasRuntimeControlService && ingress.runtimeControl.approvalMode !== "disallowed")
        || runtimeControlApproved
        || runtimeControlDenied
        || ingress.metadata["runtime_control_explicit"] === true
      ));
    let freeformRouteIntent = shouldPreferFreeformBeforeDeniedRuntimeControl
      ? await classifyFreeformRouteIntent(ingress.text, this.deps.llmClient)
      : null;
    const runtimeControlClassification = freeformRouteIntent == null && shouldClassifyRuntimeControl
      ? await classifyRuntimeControlIntent(ingress.text, this.deps.llmClient)
      : null;
    const runtimeControlIntent = runtimeControlClassification?.status === "intent"
      ? runtimeControlClassification.intent
      : null;
    if (!hasSetupSecret && !capabilities.hasAgentLoop && freeformRouteIntent == null && runtimeControlIntent === null) {
      freeformRouteIntent = await classifyFreeformRouteIntent(ingress.text, this.deps.llmClient);
    }
    const shouldDeriveRunSpecDraft =
      !capabilities.hasAgentLoop
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
      ? await deriveRunSpecFromText(ingress.text, {
        cwd: ingress.cwd ?? this.sessionCwd ?? undefined,
        conversationId: ingress.conversation_id ?? null,
        channel: ingress.channel,
        sessionId: this.history?.getSessionId() ?? ingress.conversation_id ?? null,
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
    return standaloneIngressRouter.selectRoute(ingress, {
      ...capabilities,
      runtimeControlIntent,
      runtimeControlUnclassified: shouldClassifyRuntimeControlForSafety
        && runtimeControlClassification?.status === "unclassified"
        && ingress.metadata["runtime_control_explicit"] === true,
      freeformRouteIntent,
      setupSecretIntake: this.setupSecretIntake,
      runSpecDraft,
    });
  }

  private async resolveRouteFromInput(
    input: string,
    runtimeControlContext: RuntimeControlChatContext | null,
    cwd?: string
  ): Promise<SelectedChatRoute> {
    const ingress = buildStandaloneIngressMessageFromContext(input, runtimeControlContext, this.deps);
    return this.resolveRouteFromIngress(cwd ? { ...ingress, cwd } : ingress);
  }

  private loadedSessionToChatSession(session: LoadedChatSession): ChatSession {
    return loadedSessionToChatSession(session);
  }

  private routeHost() {
    return {
      deps: this.deps,
      eventBridge: this.eventBridge,
      activatedTools: this.activatedTools,
      getConversationSessionId: () => this.history?.getSessionId() ?? null,
      getSessionCwd: () => this.sessionCwd,
      getNativeAgentLoopStatePath: () => this.nativeAgentLoopStatePath,
      getNativeAgentLoopSessionId: () => this.nativeAgentLoopSessionId,
      getProviderConfigBaseDir: () => this.providerConfigBaseDir(),
      getSetupSecretIntake: () => this.setupSecretIntake,
      getTurnLanguageHint: () => this.turnLanguageHint,
      setPendingSetupDialogue: async (dialogue: SetupDialogueRuntimeState | null) => {
        this.pendingSetupDialogue = dialogue;
        this.history?.setSetupDialogue(dialogue?.publicState ?? null);
        await this.history?.persist();
      },
      getPendingSetupDialogue: () => this.pendingSetupDialogue,
      setPendingRunSpecConfirmation: async (confirmation: ReturnType<ChatHistory["getRunSpecConfirmation"]>) => {
        this.history?.setRunSpecConfirmation(confirmation);
        await this.history?.persist();
      },
      getPendingRunSpecConfirmation: () => this.history?.getRunSpecConfirmation() ?? null,
      getSessionExecutionPolicy: () => this.getSessionExecutionPolicy(),
      setSessionExecutionPolicy: (policy: ExecutionPolicy) => { this.sessionExecutionPolicy = policy; },
    };
  }

  private providerConfigBaseDir(): string {
    const stateManager = this.deps.stateManager as StateManager & { getBaseDir?: () => string };
    return typeof stateManager.getBaseDir === "function" ? stateManager.getBaseDir() : getPulseedDirPath();
  }

  private async reloadProviderRuntime(): Promise<void> {
    const [
      { buildAdapterRegistry, buildLLMClient },
      { loadProviderConfig },
      {
        createNativeChatAgentLoopRunner,
        createNativeReviewAgentLoopRunner,
        shouldUseNativeTaskAgentLoop,
      },
    ] = await Promise.all([
      import("../../base/llm/provider-factory.js"),
      import("../../base/llm/provider-config.js"),
      import("../../orchestrator/execution/agent-loop/index.js"),
    ]);
    const providerConfig = await loadProviderConfig({
      baseDir: this.providerConfigBaseDir(),
      saveMigration: false,
    });
    const llmClient = await buildLLMClient(providerConfig);
    const adapterRegistry = await buildAdapterRegistry(llmClient, providerConfig);
    this.deps.llmClient = llmClient;
    this.deps.adapter = adapterRegistry.getAdapter(providerConfig.adapter);
    this.deps.chatAgentLoopRunner = this.deps.registry && this.deps.toolExecutor && shouldUseNativeTaskAgentLoop(providerConfig, llmClient)
      ? createNativeChatAgentLoopRunner({
          llmClient,
          providerConfig,
          toolRegistry: this.deps.registry,
          toolExecutor: this.deps.toolExecutor,
          cwd: this.sessionCwd ?? process.cwd(),
          traceBaseDir: this.providerConfigBaseDir(),
        })
      : undefined;
    this.deps.reviewAgentLoopRunner = this.deps.registry && this.deps.toolExecutor && shouldUseNativeTaskAgentLoop(providerConfig, llmClient)
      ? createNativeReviewAgentLoopRunner({
          llmClient,
          providerConfig,
          toolRegistry: this.deps.registry,
          toolExecutor: this.deps.toolExecutor,
          cwd: this.sessionCwd ?? process.cwd(),
          traceBaseDir: this.providerConfigBaseDir(),
        })
      : undefined;
    this.cachedStaticSystemPrompt = null;
  }

  private async handlePendingRunSpecConfirmation(input: string): Promise<ChatRunResult | null> {
    const pending = this.history?.getRunSpecConfirmation() ?? null;
    if (!pending || pending.state !== "pending") return null;
    const start = Date.now();
    const result = await handleRunSpecConfirmationInput(pending.spec, input, {
      llmClient: this.deps.llmClient,
    });
    const store = createRunSpecStore(this.deps.stateManager);
    await store.save(result.spec);

    if (result.kind === "confirmed") {
      const safetyBlock = validateRunSpecStartSafety(result.spec);
      if (safetyBlock) {
        const pendingSpec: RunSpec = {
          ...result.spec,
          status: "draft",
        };
        await store.save(pendingSpec);
        this.history?.setRunSpecConfirmation({
          ...pending,
          state: "pending",
          spec: pendingSpec,
          updatedAt: pendingSpec.updated_at,
        });
        await this.history?.persist();
        return {
          success: false,
          output: safetyBlock,
          elapsed_ms: Date.now() - start,
        };
      }
      const started = await this.startConfirmedRunSpec(result.spec);
      this.history?.setRunSpecConfirmation({
        ...pending,
        state: "confirmed",
        spec: result.spec,
        updatedAt: result.spec.updated_at,
      });
      await this.history?.persist();
      return { ...started, elapsed_ms: Date.now() - start };
    }

    if (result.kind === "cancelled") {
      this.history?.setRunSpecConfirmation(null);
      await this.history?.persist();
      return {
        success: false,
        output: `${result.message}\nNo background work was started.`,
        elapsed_ms: Date.now() - start,
      };
    }

    if (result.kind === "revised") {
      const proposal = formatRunSpecSetupProposal(result.spec);
      this.history?.setRunSpecConfirmation({
        ...pending,
        spec: result.spec,
        prompt: proposal,
        updatedAt: result.spec.updated_at,
      });
      await this.history?.persist();
      return {
        success: true,
        output: [
          proposal,
          "",
          "Long-running work updated. Reply with approval to confirm, cancel to discard it, or provide another update.",
        ].join("\n"),
        elapsed_ms: Date.now() - start,
      };
    }

    if (result.kind === "blocked") {
      this.history?.setRunSpecConfirmation({
        ...pending,
        spec: result.spec,
        updatedAt: result.spec.updated_at,
      });
      await this.history?.persist();
      return {
        success: false,
        output: result.message,
        elapsed_ms: Date.now() - start,
      };
    }

    const dialogue = await arbitrateRunSpecPendingDialogue(pending.spec, input, {
      llmClient: this.deps.llmClient,
    });
    if (dialogue.outcome === "new_intent") {
      return null;
    }
    return {
      success: false,
      output: result.message,
      elapsed_ms: Date.now() - start,
    };
  }

  private async startConfirmedRunSpec(spec: RunSpec): Promise<ChatRunResult> {
    const start = Date.now();
    const result = await new RunSpecHandoffService({
      stateManager: this.deps.stateManager,
      llmClient: this.deps.llmClient,
      daemonClient: this.deps.daemonClient,
      conversationSessionId: this.history?.getSessionId() ?? spec.origin.session_id,
      sessionCwd: this.sessionCwd,
      replyTarget: (this.runtimeControlContext?.replyTarget
        ?? this.deps.runtimeReplyTarget
        ?? spec.origin.reply_target
        ?? null) as Record<string, unknown> | null,
    }).startConfirmed(spec);
    return {
      success: result.success,
      output: result.message,
      elapsed_ms: Date.now() - start,
    };
  }

  private async handlePendingSetupConfirmation(
    input: string,
    runtimeControlContext: RuntimeControlChatContext | null
  ): Promise<ChatRunResult | null> {
    const commandConfirmed = isSetupWriteConfirmCommand(input);
    const pendingAtInput = this.pendingSetupDialogue;
    if (!commandConfirmed) {
      if (!pendingAtInput || pendingAtInput.publicState.state !== "confirm_write") return null;
      const decision = await classifyConfirmationDecision(input, {
        llmClient: this.deps.llmClient,
        kind: "approval",
        subject: formatPendingSetupConfirmationSubject(pendingAtInput.publicState),
        allowedDecisions: ["approve", "cancel", "unknown"],
      });
      if (decision.decision === "cancel") {
        this.pendingSetupDialogue = null;
        this.history?.setSetupDialogue(null);
        await this.history?.persist();
        return {
          success: false,
          output: formatSetupConfirmationCancelled(),
          elapsed_ms: 0,
        };
      }
      if (decision.decision !== "approve") return null;
    }
    const pending = this.pendingSetupDialogue;
    if (!pending) {
      return {
        success: false,
        output: "No pending setup write is available. Paste the secret again to start a protected setup turn.",
        elapsed_ms: 0,
      };
    }
    if (pending.publicState.selectedChannel !== "telegram" || pending.publicState.action?.kind !== "write_gateway_config") {
      return {
        success: false,
        output: `The pending setup dialogue is for ${pending.publicState.selectedChannel}, so it cannot be confirmed as a Telegram config write. Start a new Telegram setup turn with a Telegram bot token.`,
        elapsed_ms: 0,
      };
    }
    if (!pending.secretValue) {
      return {
        success: false,
        output: "The pending setup dialogue no longer has a transient secret value. Paste the token again so PulSeed can keep it protected through a fresh confirmation.",
        elapsed_ms: 0,
      };
    }
    const approvalFn = runtimeControlContext
      ? runtimeControlContext.approvalFn
      : this.deps.runtimeControlApprovalFn ?? this.deps.approvalFn;
    if (!approvalFn) {
      return {
        success: false,
        output: "Telegram setup requires an approval-capable chat surface before writing config. Use `pulseed telegram setup` instead.",
        elapsed_ms: 0,
      };
    }
    const writeResult = await confirmTelegramGatewayConfigWrite({
      pending,
      baseDir: this.providerConfigBaseDir(),
      approvalFn,
      runtimeControlService: this.deps.runtimeControlService,
      actor: runtimeControlContext?.actor,
      replyTarget: runtimeControlContext?.replyTarget,
    });
    if (!writeResult.success) {
      this.pendingSetupDialogue = null;
      this.history?.setSetupDialogue(null);
      await this.history?.persist();
      return {
        success: false,
        output: writeResult.message,
        elapsed_ms: 0,
      };
    }
    this.pendingSetupDialogue = {
      publicState: {
        ...pending.publicState,
        state: writeResult.refresh.success ? "verify" : "restart_offer",
        updatedAt: new Date().toISOString(),
        action: pending.publicState.action
          ? { ...pending.publicState.action, status: "completed" }
          : pending.publicState.action,
      },
    };
    this.history?.setSetupDialogue(this.pendingSetupDialogue.publicState);
    await this.history?.persist();
    return {
      success: true,
      output: [
        "Telegram gateway config was written from the redacted chat-supplied token.",
        "",
        formatTelegramSetupRefreshResult(writeResult.refresh),
        "",
        "Next steps:",
        ...(writeResult.accessClosedByDefault
          ? ["- Access remains closed until you configure allowed Telegram user IDs or intentionally enable `allow_all` with `pulseed telegram setup`."]
          : []),
        "- Send `/sethome` from Telegram if no home chat is configured yet.",
        writeResult.refresh.success
          ? "- Send a message to the Telegram bot to verify delivery."
          : "- Automatic gateway reload was not applied. Retry from a chat surface that can request gateway lifecycle actions.",
      ].join("\n"),
      elapsed_ms: 0,
    };
  }

  private async flushAndReturn(result: ChatRunResult | Promise<ChatRunResult>): Promise<ChatRunResult> {
    const resolved = await result;
    await this.eventBridge.flushEventRecorder();
    if (this.eventJournalDirty && this.eventJournalHistory) {
      this.eventJournalDirty = false;
      await this.eventJournalHistory.persist();
    }
    return resolved;
  }

  private async finalizeNonPersistentResult(result: ChatRunResult, eventContext: Parameters<ChatRunnerEventBridge["eventBase"]>[0]): Promise<ChatRunResult> {
    if (result.output) {
      this.eventBridge.emitEvent({
        type: "assistant_final",
        text: result.output,
        persisted: false,
        ...this.eventBridge.eventBase(eventContext),
      });
    }
    this.eventBridge.emitLifecycleEndEvent(result.success ? "completed" : "error", result.elapsed_ms, eventContext, false);
    await this.eventBridge.flushEventRecorder();
    return result;
  }
}

void COMMAND_HELP;
void formatRoute;

function parseResumeChoiceNumber(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1) return null;
  return String(value) === trimmed ? value : null;
}
