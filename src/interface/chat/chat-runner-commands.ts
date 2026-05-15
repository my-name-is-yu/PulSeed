import type { Task } from "../../base/types/task.js";
import type { Goal } from "../../base/types/goal.js";
import type { ILLMClient, LLMResponse } from "../../base/llm/llm-client.js";
import type { LoadedChatSession } from "./chat-session-store.js";
import { ChatHistory, type ChatSession, type ChatUsageCounter } from "./chat-history.js";
import { ChatSessionCatalog } from "./chat-session-store.js";
import { resolveGitRoot } from "../../platform/observation/context-provider.js";
import { TendCommand, formatTendProgressActions, type TendDeps } from "./tend-command.js";
import { EventSubscriber } from "./event-subscriber.js";
import type { ChatEvent } from "./chat-events.js";
import { createRuntimeSessionRegistry } from "../../runtime/session-registry/index.js";
import {
  formatCurrentGoalChoiceList,
  formatCurrentGoalSummary,
  isCurrentGoalCandidate,
} from "../current-goal-summary.js";
import {
  activeGoals,
  buildGoalUsageSummary,
  buildScheduleUsageSummary,
  deterministicChatSummary,
  findTask,
  formatConfig,
  formatDiagnosticGoalLine,
  formatGoalLine,
  formatHistory,
  formatTask,
  formatTaskLine,
  formatUsageCounter,
  hasUsage,
  loadGoals,
  normalizeUsageCounter,
  parseTaskArgs,
  readProviderConfigSummary,
  readTasksForGoalFromState,
  resolveGoalForTasks,
  usageFromLLMResponse,
  zeroUsageCounter,
  type ProviderConfigSummary,
} from "./chat-runner-command-helpers.js";
import { formatGoalStatusDetails } from "../goal-status-display.js";
import { checkGitChanges } from "./chat-runner-support.js";
import { formatFailureRecovery } from "./failure-recovery.js";
import {
  loadProviderConfig,
  loadProviderConfigFile,
  MODEL_REGISTRY,
  saveProviderConfig,
  validateProviderConfig,
  type ProviderConfig,
} from "../../base/llm/provider-config.js";
import {
  summarizeExecutionPolicy,
  withExecutionPolicyOverrides,
  type ExecutionPolicy,
} from "../../orchestrator/execution/agent-loop/execution-policy.js";
import { parseExactSlashCommandToken } from "../../base/protocol/exact-protocol.js";
import { formatRoute, formatRuntimeSessionsList, formatRuntimeStatus } from "./chat-runner-runtime.js";
import type {
  ChatRunResult,
  ChatRunnerCommandHost,
  ResumeCommand,
} from "./chat-runner-contracts.js";
import type { DaemonClient } from "../../runtime/daemon/client.js";
import type { DaemonSnapshot } from "../../runtime/daemon/client.js";
import type { GoalNegotiator } from "../../orchestrator/goal/goal-negotiator.js";
import {
  formatGuardrailStatus,
  loadOpenOperatorHandoffsFromRuntime,
  loadRuntimeBudgetsFromRuntime,
} from "./chat-runner-guardrail-status.js";
import {
  COMMAND_HELP,
  parseCleanupArgs,
  parseDetailOnlyArgs,
  parseModelArgs,
  parsePermissionArgs,
  parseStatusArgs,
} from "./chat-command-args.js";

export { COMMAND_HELP };

export class ChatRunnerCommandHandler {
  constructor(private readonly host: ChatRunnerCommandHost) {}

  parseResumeCommand(input: string): ResumeCommand | null {
    const parsed = parseExactSlashCommandToken(input);
    if (!parsed || parsed.command !== "/resume") return null;
    const selector = parsed.rawArgs.trim();
    return selector ? { selector } : {};
  }

  async handleCommand(input: string, cwd?: string): Promise<ChatRunResult | null> {
    const parsed = parseExactSlashCommandToken(input);
    if (!parsed) return null;

    const trimmed = input.trim();
    const cmd = parsed.command;
    const args = parsed.rawArgs;
    const start = Date.now();

    if (cmd === "/help") {
      return { success: true, output: COMMAND_HELP, elapsed_ms: Date.now() - start };
    }
    if (cmd === "/clear") {
      await this.host.getHistory()?.clear();
      return { success: true, output: "Conversation history cleared.", elapsed_ms: Date.now() - start };
    }
    if (cmd === "/sessions") {
      const parsedSessions = parseDetailOnlyArgs(args.trim(), "/sessions");
      if (!parsedSessions.success) {
        return { success: false, output: parsedSessions.output, elapsed_ms: Date.now() - start };
      }
      const registry = createRuntimeSessionRegistry({ stateManager: this.host.deps.stateManager });
      const snapshot = await registry.snapshot();
      return {
        success: true,
        output: formatRuntimeSessionsList(snapshot, { diagnostic: parsedSessions.diagnostic }),
        elapsed_ms: Date.now() - start,
      };
    }
    if (cmd === "/history") {
      const catalog = new ChatSessionCatalog(this.host.deps.stateManager);
      const selector = args.trim();
      const history = this.host.getHistory();
      const session = selector
        ? await catalog.loadSessionBySelector(selector)
        : history
          ? await catalog.loadSession(history.getSessionId())
          : null;
      if (!session) {
        return { success: false, output: "No chat session history found.", elapsed_ms: Date.now() - start };
      }
      return { success: true, output: this.formatHistory(session), elapsed_ms: Date.now() - start };
    }
    if (cmd === "/title") {
      const title = args.trim();
      if (!title) {
        return { success: false, output: "Usage: /title <title>", elapsed_ms: Date.now() - start };
      }
      const history = this.host.getHistory();
      if (!history) {
        return { success: false, output: "No active chat session to rename.", elapsed_ms: Date.now() - start };
      }
      const catalog = new ChatSessionCatalog(this.host.deps.stateManager);
      history.setTitle(title);
      await history.persist();
      await catalog.renameSession(history.getSessionId(), title);
      return { success: true, output: `Renamed chat session to "${title}".`, elapsed_ms: Date.now() - start };
    }
    if (cmd === "/cleanup") {
      const catalog = new ChatSessionCatalog(this.host.deps.stateManager);
      const parsedCleanupArgs = parseCleanupArgs(args);
      if (!parsedCleanupArgs.success) {
        return { success: false, output: parsedCleanupArgs.output, elapsed_ms: Date.now() - start };
      }
      const dryRun = parsedCleanupArgs.dryRun;
      const report = await catalog.cleanupSessions({
        dryRun,
        activeSessionId: this.host.getHistory()?.getSessionId(),
      });
      const verb = dryRun ? "would remove" : "removed";
      return {
        success: true,
        output: `Chat session cleanup ${verb} ${report.removedSessionIds.length} session(s).`,
        elapsed_ms: Date.now() - start,
      };
    }
    if (cmd === "/compact") {
      return this.handleCompact(start);
    }
    if (cmd === "/status") {
      return this.handleStatus(args.trim(), start);
    }
    if (cmd === "/goals") {
      return this.handleGoals(args.trim(), start);
    }
    if (cmd === "/tasks") {
      return this.handleTasks(args.trim(), start);
    }
    if (cmd === "/task") {
      return this.handleTask(args.trim(), start);
    }
    if (cmd === "/config") {
      return this.handleConfig(start);
    }
    if (cmd === "/model") {
      return this.handleModel(args.trim(), start);
    }
    if (cmd === "/permissions") {
      return this.handlePermissions(args.trim(), start);
    }
    if (cmd === "/plugins") {
      return this.handlePlugins(start);
    }
    if (cmd === "/usage") {
      return this.handleUsage(args.trim(), start);
    }
    if (cmd === "/context" || cmd === "/working-memory") {
      return this.handleContext(start, cwd);
    }
    if (cmd === "/review") {
      return this.handleReview(start);
    }
    if (cmd === "/fork") {
      return this.handleFork(args.trim(), start);
    }
    if (cmd === "/undo") {
      return this.handleUndo(start);
    }
    if (cmd === "/retry") {
      return {
        success: false,
        output: [
          "/retry is not supported yet.",
          "",
          formatFailureRecovery({
            kind: "runtime_interruption",
            label: "Retry unavailable",
            summary: "PulSeed does not yet have a safe replay contract for the previous turn.",
            nextActions: [
              "Use /review to inspect any current diff before continuing.",
              "Continue from the latest chat if PulSeed reports resumable state.",
              "Ask for the exact next step to rerun instead of replaying the full turn.",
            ],
          }),
        ].join("\n"),
        elapsed_ms: Date.now() - start,
      };
    }
    if (cmd === "/exit") {
      return { success: true, output: "Exiting chat mode.", elapsed_ms: Date.now() - start };
    }
    if (cmd === "/track") {
      return this.handleTrack(start);
    }
    if (cmd === "/tend") {
      return this.handleTend(args.trim(), start);
    }

    if (this.host.getPendingTend() !== null) {
      return this.handleTendConfirmation(trimmed, start);
    }

    return {
      success: false,
      output: `Unknown command: ${input.trim()}. Type /help for available commands.`,
      elapsed_ms: Date.now() - start,
    };
  }

  async handleTendConfirmation(input: string, start: number): Promise<ChatRunResult> {
    const pending = this.host.getPendingTend()!;
    this.host.setPendingTend(null);

    const normalized = input.trim().toLowerCase();
    const confirmed = normalized === "" || normalized === "y" || normalized === "yes";

    if (!confirmed) {
      return {
        success: true,
        output: "Tend cancelled. Continue chatting to refine your goal, then try /tend again.",
        elapsed_ms: Date.now() - start,
      };
    }

    if (!this.host.deps.daemonClient) {
      return {
        success: false,
        output: "Daemon client not available.",
        elapsed_ms: Date.now() - start,
      };
    }

    const { goalId, maxIterations } = pending;
    let subscriber: EventSubscriber | null = null;
    if (this.host.deps.daemonBaseUrl && !this.host.getActiveSubscribers().has(goalId)) {
      subscriber = new EventSubscriber(this.host.deps.daemonBaseUrl, goalId, "normal");
      this.host.getActiveSubscribers().set(goalId, subscriber);

      subscriber.on("notification", (notification: unknown) => {
        const n = notification as { message: string };
        this.host.deps.onNotification?.(n.message);
        this.host.onNotification?.(n.message);
      });

      subscriber.on("chat_event", (event: ChatEvent) => {
        this.host.emitEvent(event);
      });

      try {
        await subscriber.subscribeReady();
      } catch (err) {
        subscriber.unsubscribe();
        this.host.getActiveSubscribers().delete(goalId);
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          output: `Daemon event stream unavailable: ${msg}. Goal was not started.`,
          elapsed_ms: Date.now() - start,
        };
      }
    }

    try {
      const tendDeps = this.buildTendDeps(
        this.host.deps.llmClient as ILLMClient,
        this.host.deps.goalNegotiator as GoalNegotiator,
        this.host.deps.daemonClient,
      );
      const result = await new TendCommand().startAcceptedGoal(goalId, maxIterations, tendDeps);
      if (!result.success) {
        if (subscriber) {
          subscriber.unsubscribe();
          this.host.getActiveSubscribers().delete(goalId);
        }
        return {
          success: false,
          output: result.message,
          elapsed_ms: Date.now() - start,
        };
      }
      const goalLabel = result.goalTitle ? `"${result.goalTitle}"` : "your goal";
      const iterNote = maxIterations !== undefined ? ` (max ${maxIterations} iterations)` : "";
      const diagnosticLines = [
        "Diagnostic details:",
        `- Goal: ${goalId}`,
      ];
      if (result.backgroundRunId) {
        diagnosticLines.push(`- Background run: ${result.backgroundRunId}`);
      }
      return {
        success: true,
        output: [
          formatTendProgressActions(goalId, result.backgroundRunId),
          "",
          `Started tending ${goalLabel} in the background${iterNote}.`,
          ...diagnosticLines,
        ].join("\n"),
        elapsed_ms: Date.now() - start,
      };
    } catch (err) {
      if (subscriber) {
        subscriber.unsubscribe();
        this.host.getActiveSubscribers().delete(goalId);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Daemon unavailable: ${msg}. Start the daemon with 'pulseed daemon start' first.`,
        elapsed_ms: Date.now() - start,
      };
    }
  }

  private formatHistory(session: LoadedChatSession): string {
    return formatHistory(session);
  }

  private async loadGoals(): Promise<Goal[]> {
    return loadGoals(this.host.deps.stateManager);
  }

  private activeGoals(goals: Goal[]): Goal[] {
    return activeGoals(goals);
  }

  private formatGoalLine(goal: Goal, diagnostic = false): string {
    return diagnostic ? formatDiagnosticGoalLine(goal) : formatGoalLine(goal);
  }

  private async handleStatus(args: string, start: number): Promise<ChatRunResult> {
    const parsedArgs = parseStatusArgs(args);
    if (!parsedArgs.success) {
      return { success: false, output: parsedArgs.output, elapsed_ms: Date.now() - start };
    }
    const diagnostic = parsedArgs.diagnostic;
    if (parsedArgs.goalId) {
      const goal = await this.host.deps.stateManager.loadGoal(parsedArgs.goalId);
      if (!goal) {
        return { success: false, output: `Goal not found: ${parsedArgs.goalId}`, elapsed_ms: Date.now() - start };
      }
      const registry = createRuntimeSessionRegistry({ stateManager: this.host.deps.stateManager });
      const [runtimeSnapshot, handoffs, runtimeBudgets] = await Promise.all([
        registry.snapshot(),
        loadOpenOperatorHandoffsFromRuntime(this.host.deps.stateManager),
        loadRuntimeBudgetsFromRuntime(this.host.deps.stateManager),
      ]);
      const summaryLines = isCurrentGoalCandidate(goal)
        ? [formatCurrentGoalSummary(goal, {
          runtimeSnapshot,
          handoffs,
          runtimeBudgets,
          detail: diagnostic ? "diagnostic" : "default",
        }), ""]
        : [];
      const lines = [
        ...summaryLines,
        formatGoalStatusDetails(goal, { diagnostic }),
      ];
      return { success: true, output: lines.join("\n"), elapsed_ms: Date.now() - start };
    }

    const registry = createRuntimeSessionRegistry({ stateManager: this.host.deps.stateManager });
    const [goals, runtimeSnapshot, runtimeBudgets] = await Promise.all([
      this.loadGoals(),
      registry.snapshot(),
      loadRuntimeBudgetsFromRuntime(this.host.deps.stateManager),
    ]);
    const handoffs = await loadOpenOperatorHandoffsFromRuntime(this.host.deps.stateManager);
    const active = this.activeGoals(goals);
    const daemonSnapshot = await this.loadDaemonSnapshot();
    const guardrailStatus = await formatGuardrailStatus({
      stateManager: this.host.deps.stateManager,
      snapshot: daemonSnapshot,
      diagnostic,
    });
    const statusSuffix = guardrailStatus ? `\n\n${guardrailStatus}` : "";
    if (active.length === 0) {
      return {
        success: true,
        output: `No active goals found.\n\n${formatRuntimeStatus(runtimeSnapshot, { diagnostic })}${statusSuffix}`,
        elapsed_ms: Date.now() - start,
      };
    }
    const currentGoalSummary = active.length === 1
      ? formatCurrentGoalSummary(active[0]!, {
        runtimeSnapshot,
        handoffs,
        runtimeBudgets,
        detail: diagnostic ? "diagnostic" : "default",
      })
      : formatCurrentGoalChoiceList(active, {
        runtimeSnapshot,
        handoffs,
        runtimeBudgets,
        detail: diagnostic ? "diagnostic" : "default",
      });
    return {
      success: true,
      output: `${currentGoalSummary}\n\nActive goals:\n${active.map((goal) => this.formatGoalLine(goal, diagnostic)).join("\n")}\n\n${formatRuntimeStatus(runtimeSnapshot, { diagnostic })}${statusSuffix}`,
      elapsed_ms: Date.now() - start,
    };
  }

  private async loadDaemonSnapshot(): Promise<DaemonSnapshot | null> {
    if (!this.host.deps.daemonClient) return null;
    try {
      return await this.host.deps.daemonClient.getSnapshot();
    } catch {
      return null;
    }
  }

  private async handleGoals(args: string, start: number): Promise<ChatRunResult> {
    const parsed = parseDetailOnlyArgs(args, "/goals");
    if (!parsed.success) {
      return { success: false, output: parsed.output, elapsed_ms: Date.now() - start };
    }
    const goals = await this.loadGoals();
    if (goals.length === 0) {
      return { success: true, output: "No goals found.", elapsed_ms: Date.now() - start };
    }
    return {
      success: true,
      output: `Goals:\n${goals.map((goal) => this.formatGoalLine(goal, parsed.diagnostic)).join("\n")}`,
      elapsed_ms: Date.now() - start,
    };
  }

  private async readTasksForGoal(goalId: string): Promise<Task[]> {
    return readTasksForGoalFromState(this.host.deps.stateManager, goalId);
  }

  private async resolveGoalForTasks(selector: string): Promise<{ goalId?: string; error?: string }> {
    return resolveGoalForTasks(this.host.deps.stateManager, selector);
  }

  private formatTaskLine(task: Task): string {
    return formatTaskLine(task);
  }

  private async handleTasks(args: string, start: number): Promise<ChatRunResult> {
    const resolved = await this.resolveGoalForTasks(args);
    if (resolved.error || !resolved.goalId) {
      return { success: false, output: resolved.error ?? "Usage: /tasks <goal-id>", elapsed_ms: Date.now() - start };
    }
    const tasks = await this.readTasksForGoal(resolved.goalId);
    if (tasks.length === 0) {
      return { success: true, output: `No tasks found for goal "${resolved.goalId}".`, elapsed_ms: Date.now() - start };
    }
    return {
      success: true,
      output: `Tasks for goal ${resolved.goalId}:\n${tasks.map((task) => this.formatTaskLine(task)).join("\n")}`,
      elapsed_ms: Date.now() - start,
    };
  }

  private parseTaskArgs(args: string): { taskId?: string; goalId?: string } {
    return parseTaskArgs(args);
  }

  private async findTask(taskId: string, goalId?: string): Promise<{ task?: Task; matches: Array<{ goalId: string; task: Task }> }> {
    return findTask(this.host.deps.stateManager, taskId, goalId);
  }

  private formatTask(task: Task): string {
    return formatTask(task);
  }

  private async handleTask(args: string, start: number): Promise<ChatRunResult> {
    const { taskId, goalId } = this.parseTaskArgs(args);
    if (!taskId) {
      return { success: false, output: "Usage: /task <task-id> [goal-id]", elapsed_ms: Date.now() - start };
    }
    const found = await this.findTask(taskId, goalId);
    if (found.matches.length > 1) {
      return {
        success: false,
        output: `Task selector "${taskId}" matched multiple goals. Use /task ${taskId} <goal-id>.\n${found.matches.map((match) => `- ${match.goalId}`).join("\n")}`,
        elapsed_ms: Date.now() - start,
      };
    }
    if (!found.task) {
      const suffix = goalId ? ` for goal "${goalId}"` : "";
      return { success: false, output: `Task not found: ${taskId}${suffix}`, elapsed_ms: Date.now() - start };
    }
    return { success: true, output: this.formatTask(found.task), elapsed_ms: Date.now() - start };
  }

  private async readProviderConfigSummary(): Promise<ProviderConfigSummary> {
    return readProviderConfigSummary(this.host.deps.stateManager);
  }

  private formatConfig(config: ProviderConfigSummary): string {
    return formatConfig(config);
  }

  private async handleConfig(start: number): Promise<ChatRunResult> {
    const config = await this.readProviderConfigSummary();
    return { success: true, output: `Provider configuration:\n${this.formatConfig(config)}`, elapsed_ms: Date.now() - start };
  }

  private formatModelSummary(config: ProviderConfigSummary): string {
    return [
      `Model: ${config.model}`,
      `Provider: ${config.provider}`,
      `Adapter: ${config.adapter}`,
      `Reasoning: ${config.reasoning_effort ?? "default"}`,
    ].join("\n");
  }

  private async handleModel(args: string, start: number): Promise<ChatRunResult> {
    if (!args) {
      const config = await this.readProviderConfigSummary();
      return {
        success: true,
        output: [
          "Select Model and Effort",
          this.formatModelSummary(config),
          "",
          "Usage:",
          "  /model <model>",
          "  /model <model> <none|minimal|low|medium|high|xhigh>",
          "  /model <none|minimal|low|medium|high|xhigh>",
          "",
          `Available OpenAI models: ${Object.keys(MODEL_REGISTRY).filter((model) => MODEL_REGISTRY[model]?.provider === "openai").join(", ")}`,
        ].join("\n"),
        elapsed_ms: Date.now() - start,
      };
    }

    const parsed = parseModelArgs(args);
    if (parsed.error) {
      return { success: false, output: parsed.error, elapsed_ms: Date.now() - start };
    }

    const baseDir = this.host.deps.stateManager.getBaseDir();
    const [current, fileConfig] = await Promise.all([
      loadProviderConfig({ baseDir, saveMigration: false }),
      loadProviderConfigFile({ baseDir }),
    ]);
    if (current.provider !== "openai") {
      return {
        success: false,
        output: `/model switching is currently available for provider "openai". Current provider: ${current.provider}`,
        elapsed_ms: Date.now() - start,
      };
    }
    const fileProvider = fileConfig.provider ?? "openai";
    const fileAdapter = fileConfig.adapter ?? "openai_codex_cli";
    const fileTargetModel = parsed.model ?? fileConfig.model ?? current.model;
    const fileRegistryEntry = MODEL_REGISTRY[fileTargetModel];
    const fileAdapterSupportsModel = !fileRegistryEntry
      || (fileRegistryEntry.provider === fileProvider && fileRegistryEntry.adapters.includes(fileAdapter));
    if (fileProvider !== "openai" || !fileAdapterSupportsModel) {
      return {
        success: false,
        output: [
          "/model can only update a file-owned OpenAI provider configuration.",
          `Current runtime provider is openai, but provider.json resolves as provider "${fileProvider}" with adapter "${fileAdapter}".`,
          "Update provider.json to OpenAI first, then run /model again.",
        ].join("\n"),
        elapsed_ms: Date.now() - start,
      };
    }

    const nextResolved: ProviderConfig = {
      ...current,
      ...(parsed.model ? { model: parsed.model } : {}),
    };
    const nextFile: Partial<ProviderConfig> = {
      provider: fileProvider,
      adapter: fileAdapter,
    };
    if (parsed.model ?? fileConfig.model) {
      nextFile.model = parsed.model ?? fileConfig.model;
    }
    if (parsed.reasoning !== undefined) {
      nextResolved.reasoning_effort = parsed.reasoning;
    }
    if (parsed.reasoning !== undefined && parsed.reasoning !== null) {
      nextFile.reasoning_effort = parsed.reasoning;
    } else if (fileConfig.reasoning_effort !== undefined) {
      nextFile.reasoning_effort = fileConfig.reasoning_effort;
    }
    if (fileConfig.api_key !== undefined) nextFile.api_key = fileConfig.api_key;
    if (fileConfig.base_url !== undefined) nextFile.base_url = fileConfig.base_url;
    if (fileConfig.light_model !== undefined) nextFile.light_model = fileConfig.light_model;
    if (fileConfig.codex_cli_path !== undefined) nextFile.codex_cli_path = fileConfig.codex_cli_path;
    if (fileConfig.codex_timeout_ms !== undefined) nextFile.codex_timeout_ms = fileConfig.codex_timeout_ms;
    if (fileConfig.codex_idle_timeout_ms !== undefined) nextFile.codex_idle_timeout_ms = fileConfig.codex_idle_timeout_ms;
    if (fileConfig.codex_retry_attempts !== undefined) nextFile.codex_retry_attempts = fileConfig.codex_retry_attempts;
    if (fileConfig.terminal_backend !== undefined) nextFile.terminal_backend = fileConfig.terminal_backend;
    if (fileConfig.a2a !== undefined) nextFile.a2a = fileConfig.a2a;
    if (fileConfig.openclaw !== undefined) nextFile.openclaw = fileConfig.openclaw;
    if (fileConfig.agent_loop !== undefined) {
      nextFile.agent_loop = fileConfig.agent_loop;
    }

    const registryEntry = parsed.model ? MODEL_REGISTRY[parsed.model] : undefined;
    if (registryEntry && registryEntry.provider !== nextResolved.provider) {
      return {
        success: false,
        output: `Model "${parsed.model}" requires provider "${registryEntry.provider}" but current provider is "${nextResolved.provider}".`,
        elapsed_ms: Date.now() - start,
      };
    }

    const validation = validateProviderConfig(nextResolved);
    if (!validation.valid) {
      return {
        success: false,
        output: `Model configuration was not saved:\n${validation.errors.map((error) => `- ${error}`).join("\n")}`,
        elapsed_ms: Date.now() - start,
      };
    }

    await saveProviderConfig(nextFile, { baseDir });
    await this.host.reloadProviderRuntime?.();
    const effective = await this.readProviderConfigSummary();
    const saved = this.formatModelSummary({
      ...effective,
      model: nextFile.model ?? "(unchanged)",
      reasoning_effort: nextFile.reasoning_effort,
    });
    const effectiveSummary = this.formatModelSummary(effective);
    const envOverrideNote = saved === effectiveSummary
      ? ""
      : `\n\nEffective config still differs, likely due to environment overrides:\n${effectiveSummary}`;
    return {
      success: true,
      output: `Updated model configuration:\n${saved}${envOverrideNote}`,
      elapsed_ms: Date.now() - start,
    };
  }

  private async handlePlugins(start: number): Promise<ChatRunResult> {
    if (!this.host.deps.pluginLoader) {
      return { success: true, output: "Plugin information is not available in this chat session.", elapsed_ms: Date.now() - start };
    }
    try {
      const plugins = await this.host.deps.pluginLoader.loadAll();
      if (plugins.length === 0) {
        return { success: true, output: "No plugins found.", elapsed_ms: Date.now() - start };
      }
      return {
        success: true,
        output: `Plugins:\n${plugins.map((plugin) => `${plugin.name} - ${plugin.type ?? "unknown"} - ${plugin.enabled === false ? "disabled" : "enabled"}`).join("\n")}`,
        elapsed_ms: Date.now() - start,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: true, output: `Plugin information is unavailable: ${message}`, elapsed_ms: Date.now() - start };
    }
  }

  private zeroUsageCounter(): ChatUsageCounter {
    return zeroUsageCounter();
  }

  private normalizeUsageCounter(usage: ChatUsageCounter): ChatUsageCounter {
    return normalizeUsageCounter(usage);
  }

  private usageFromLLMResponse(response: LLMResponse): ChatUsageCounter {
    return usageFromLLMResponse(response);
  }

  private hasUsage(usage: ChatUsageCounter): boolean {
    return hasUsage(usage);
  }

  private formatUsageCounter(prefix: string, usage: ChatUsageCounter): string[] {
    return formatUsageCounter(prefix, usage);
  }

  private async handleUsage(args: string, start: number): Promise<ChatRunResult> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const scope = tokens[0]?.toLowerCase();

    if (!scope || scope === "session") {
      const history = this.host.getHistory();
      if (!history) {
        return { success: false, output: "No active chat session. Start a session and run work before /usage.", elapsed_ms: Date.now() - start };
      }
      const session = history.getSessionData();
      const totals = this.normalizeUsageCounter(session.usage?.totals ?? this.zeroUsageCounter());
      const lines = [
        `Usage summary (session ${session.id})`,
        ...this.formatUsageCounter("Session", totals),
      ];
      const phaseEntries = Object.entries(session.usage?.byPhase ?? {})
        .map(([phase, usage]) => ({ phase, usage: this.normalizeUsageCounter(usage as ChatUsageCounter) }))
        .filter((entry) => this.hasUsage(entry.usage))
        .sort((left, right) => right.usage.totalTokens - left.usage.totalTokens);
      if (phaseEntries.length > 0) {
        lines.push("");
        lines.push("By phase:");
        for (const entry of phaseEntries) {
          lines.push(`- ${entry.phase}: ${entry.usage.totalTokens} (in=${entry.usage.inputTokens}, out=${entry.usage.outputTokens})`);
        }
      }
      return { success: true, output: lines.join("\n"), elapsed_ms: Date.now() - start };
    }

    if (scope === "goal" || scope === "daemon") {
      const goalId = tokens[1] ?? this.host.deps.goalId;
      if (!goalId) {
        return { success: false, output: "Usage: /usage goal <goal-id>", elapsed_ms: Date.now() - start };
      }
      const lines = await buildGoalUsageSummary(this.host.deps.stateManager, goalId);
      return { success: true, output: lines.join("\n"), elapsed_ms: Date.now() - start };
    }

    if (scope === "schedule") {
      const period = tokens[1] ?? "7d";
      try {
        const lines = await buildScheduleUsageSummary(this.host.deps.stateManager, period);
        return { success: true, output: lines.join("\n"), elapsed_ms: Date.now() - start };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: `Usage: /usage schedule [24h|7d|2w]\nError: ${message}`, elapsed_ms: Date.now() - start };
      }
    }

    return {
      success: false,
      output: "Usage: /usage [session|goal <goal-id>|daemon <goal-id>|schedule [24h|7d|2w]]",
      elapsed_ms: Date.now() - start,
    };
  }

  private deterministicChatSummary(messages: ChatSession["messages"]): string {
    return deterministicChatSummary(messages);
  }

  private async summarizeChatForCompaction(messages: ChatSession["messages"], existingSummary?: string): Promise<{ summary: string; usedLlm: boolean }> {
    const content = [
      existingSummary ? `Previous summary:\n${existingSummary}` : "",
      `Messages to summarize:\n${messages.map((message) => `${message.role}: ${message.content}`).join("\n")}`,
    ].filter(Boolean).join("\n\n");

    if (this.host.deps.llmClient) {
      try {
        const response = await this.host.deps.llmClient.sendMessage([
          { role: "user", content: `Summarize this chat history for later continuation. Preserve decisions, open tasks, constraints, and user preferences. Keep it concise.\n\n${content}` },
        ], { max_tokens: 700, model_tier: "light" });
        if (response.content.trim()) return { summary: response.content.trim(), usedLlm: true };
      } catch {
        // Fall back to deterministic summary below.
      }
    }

    const fallback = [
      existingSummary ? `Previous summary:\n${existingSummary}` : "",
      "Extractive summary:",
      this.deterministicChatSummary(messages),
    ].filter(Boolean).join("\n\n");
    return { summary: fallback, usedLlm: false };
  }

  private async handleCompact(start: number): Promise<ChatRunResult> {
    const history = this.host.getHistory();
    if (!history) {
      return { success: false, output: "No active chat session to compact.", elapsed_ms: Date.now() - start };
    }
    const session = history.getSessionData();
    if (session.messages.length <= 4) {
      return { success: true, output: "Chat history is already compact. No messages were removed.", elapsed_ms: Date.now() - start };
    }
    const olderMessages = session.messages.slice(0, -4);
    const { summary, usedLlm } = await this.summarizeChatForCompaction(olderMessages, session.compactionSummary);
    const { before, after } = await history.compact(summary, 4);
    const method = usedLlm ? "LLM summary" : "deterministic summary";
    return {
      success: true,
      output: `Compacted chat history with ${method}. Persisted ${before} message(s) down to ${after}; the latest user/assistant turns were kept.`,
      elapsed_ms: Date.now() - start,
    };
  }

  private async handleContext(start: number, cwdOverride?: string): Promise<ChatRunResult> {
    const cwd = this.host.getSessionCwd() ?? (cwdOverride ? resolveGitRoot(cwdOverride) : process.cwd());
    const session = this.host.getHistory()?.getSessionData() ?? null;
    const messages = session?.messages ?? [];
    const policy = await this.host.getSessionExecutionPolicy();
    const recentMessages = messages.slice(-6);
    const userTurns = messages.filter((message) => message.role === "user").length;
    const assistantTurns = messages.filter((message) => message.role === "assistant").length;
    const compactionSummary = session?.compactionSummary?.trim() ?? "";
    const compactionRecords = session?.compactionRecords ?? [];
    const agentLoopPath = this.host.getNativeAgentLoopSessionId?.()
      ?? this.host.getNativeAgentLoopStatePath()
      ?? session?.agentLoopSessionId
      ?? session?.agentLoopStatePath
      ?? null;
    const replyTarget = this.host.getRuntimeControlContext()?.replyTarget ?? this.host.deps.runtimeReplyTarget ?? null;
    const routeCapabilities = {
      hasAgentLoop: this.host.deps.chatAgentLoopRunner !== undefined,
      hasToolLoop: this.host.deps.llmClient !== undefined,
      hasRuntimeControlService: this.host.deps.runtimeControlService !== undefined,
    };
    const replyTargetParts = replyTarget
      ? [replyTarget.surface, replyTarget.platform, replyTarget.conversation_id].filter(Boolean)
      : [];
    const contextLines = [
      "Working context",
      "",
      "Session",
      `- session_id: ${this.host.getHistory()?.getSessionId() ?? "none"}`,
      `- cwd: ${cwd}`,
      `- messages: ${messages.length} (${userTurns} user, ${assistantTurns} assistant)`,
      `- recent_turns_retained: ${recentMessages.length}`,
      `- compaction_summary: ${compactionSummary ? "present" : "none"}`,
      `- compaction_records: ${compactionRecords.length}`,
      `- agentloop_state_path: ${agentLoopPath ?? "none"}`,
      "",
      "Turn context",
      `- last_selected_route: ${formatRoute(this.host.getLastSelectedRoute())}`,
      `- reply_target: ${replyTargetParts.length > 0 ? replyTargetParts.join(":") : "none"}`,
      `- route_capabilities: agent_loop=${routeCapabilities.hasAgentLoop}, tool_loop=${routeCapabilities.hasToolLoop}, runtime_control=${routeCapabilities.hasRuntimeControlService}`,
      "",
      "Working assumptions",
      "- this view exposes operational context, not hidden reasoning",
      "- last_selected_route describes the most recent non-command turn in this ChatRunner",
      "- future turns may select a different route based on the next input",
      "",
      "Active constraints",
      ...summarizeExecutionPolicy(policy).split("\n").map((line) => `- ${line}`),
      "",
      "Included context",
      "- current session cwd and execution policy because they constrain tool and route behavior",
      `- ${recentMessages.length} latest persisted message(s)`,
      `- ${compactionSummary ? "compacted older chat summary because older turns were summarized" : "no compacted older chat summary because none is stored"}`,
      `- ${compactionRecords.length > 0 ? "structured compaction records because compacted chat state was retained for replay" : "no structured compaction records because no compaction has run"}`,
      `- ${agentLoopPath ? "saved chat continuation path because this session can safely resume" : "no saved chat continuation path because none is active"}`,
      "",
      "Not included",
      "- hidden reasoning or private model chain-of-thought",
      "- raw state files unless a command explicitly reads them",
      "- older chat turns beyond the retained window unless compacted into the session summary",
    ];
    return {
      success: true,
      output: contextLines.join("\n"),
      elapsed_ms: Date.now() - start,
    };
  }

  private async handleTrack(start: number): Promise<ChatRunResult> {
    if (!this.host.deps.escalationHandler) {
      return {
        success: false,
        output: "Escalation not available — missing LLM configuration",
        elapsed_ms: Date.now() - start,
      };
    }
    if (!this.host.getHistory() || this.host.getHistory()!.getMessages().length === 0) {
      return {
        success: false,
        output: "No conversation to escalate. Chat first, then /track.",
        elapsed_ms: Date.now() - start,
      };
    }
    try {
      const result = await this.host.deps.escalationHandler.escalateToGoal(this.host.getHistory()!);
      return {
        success: true,
        output: `Goal created: ${result.title} (ID: ${result.goalId})\nRun: pulseed run --goal ${result.goalId} --yes`,
        elapsed_ms: Date.now() - start,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Escalation failed: ${message}`,
        elapsed_ms: Date.now() - start,
      };
    }
  }

  private async handlePermissions(args: string, start: number): Promise<ChatRunResult> {
    const policy = await this.host.getSessionExecutionPolicy();
    if (!args) {
      return {
        success: true,
        output: summarizeExecutionPolicy(policy),
        elapsed_ms: Date.now() - start,
      };
    }

    const parsed = parsePermissionArgs(policy, args);
    if (!parsed.success) {
      return {
        success: false,
        output: parsed.output,
        elapsed_ms: Date.now() - start,
      };
    }
    const nextPolicy = parsed.policy;

    const runner = this.host as unknown as { setSessionExecutionPolicy?: (policy: ExecutionPolicy) => void; sessionExecutionPolicy?: ExecutionPolicy | null };
    if (typeof runner.setSessionExecutionPolicy === "function") {
      runner.setSessionExecutionPolicy(nextPolicy);
    } else {
      runner.sessionExecutionPolicy = nextPolicy;
    }
    return {
      success: true,
      output: summarizeExecutionPolicy(nextPolicy),
      elapsed_ms: Date.now() - start,
    };
  }

  private async handleReview(start: number): Promise<ChatRunResult> {
    const cwd = this.host.getSessionCwd() ?? process.cwd();
    const diffStat = await checkGitChanges(cwd);
    const reviewPolicy = withExecutionPolicyOverrides(await this.host.getSessionExecutionPolicy(), {
      sandboxMode: "read_only",
      approvalPolicy: "never",
    });
    if (this.host.deps.reviewAgentLoopRunner) {
      const review = await this.host.deps.reviewAgentLoopRunner.execute({
        cwd,
        diffStat,
        executionPolicy: reviewPolicy,
      });
      return { success: review.success, output: review.output, elapsed_ms: Date.now() - start };
    }
    const output = [
      "Review summary",
      diffStat ? diffStat : "No uncommitted changes detected.",
      "",
      "Execution policy",
      summarizeExecutionPolicy(reviewPolicy),
    ].join("\n");
    return { success: true, output, elapsed_ms: Date.now() - start };
  }

  private async handleFork(title: string, start: number): Promise<ChatRunResult> {
    const cwd = this.host.getSessionCwd() ?? process.cwd();
    const sessionId = crypto.randomUUID();
    const baseSession = this.host.getHistory()?.getSessionData() ?? {
      id: sessionId,
      cwd,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };
    const now = new Date().toISOString();
    const forkedSession: ChatSession = {
      ...baseSession,
      id: sessionId,
      createdAt: now,
      updatedAt: now,
      title: title || (baseSession.title ? `${baseSession.title} (fork)` : "Forked session"),
    };
    this.host.setHistory(ChatHistory.fromSession(this.host.deps.stateManager, forkedSession));
    this.host.setSessionCwd(resolveGitRoot(cwd));
    this.host.setSessionActive(true);
    this.host.setNativeAgentLoopStatePath(null);
    this.host.setNativeAgentLoopSessionId?.(sessionId);
    this.host.getHistory()!.resetAgentLoopState(null);
    this.host.getHistory()!.setAgentLoopSessionIdentity({ sessionId, traceId: null });
    await this.host.getHistory()!.persist();
    const runner = this.host as unknown as { resetSessionExecutionPolicy?: () => void };
    runner.resetSessionExecutionPolicy?.();
    return {
      success: true,
      output: `Forked chat session as ${sessionId}.`,
      elapsed_ms: Date.now() - start,
    };
  }

  private async handleUndo(start: number): Promise<ChatRunResult> {
    const history = this.host.getHistory();
    if (!history) {
      return { success: false, output: "No active chat session to undo.", elapsed_ms: Date.now() - start };
    }
    const removed = await history.removeLastTurn();
    if (removed === 0) {
      return { success: false, output: "No chat turn to undo.", elapsed_ms: Date.now() - start };
    }
    return {
      success: true,
      output: `Removed ${removed} message(s) from chat history. File changes were not reverted.`,
      elapsed_ms: Date.now() - start,
    };
  }

  private async handleTend(args: string, start: number): Promise<ChatRunResult> {
    if (!this.host.deps.llmClient) {
      return {
        success: false,
        output: "Tend not available — missing LLM configuration",
        elapsed_ms: Date.now() - start,
      };
    }
    if (!this.host.deps.goalNegotiator) {
      return {
        success: false,
        output: "Tend not available — missing goal negotiator",
        elapsed_ms: Date.now() - start,
      };
    }
    if (!this.host.deps.daemonClient) {
      return {
        success: false,
        output: "Tend not available — daemon client not configured. Start the daemon with 'pulseed daemon start' first.",
        elapsed_ms: Date.now() - start,
      };
    }

    const tendCommand = new TendCommand();
    const result = await tendCommand.execute(args, this.buildTendDeps(
      this.host.deps.llmClient,
      this.host.deps.goalNegotiator,
      this.host.deps.daemonClient,
    ));

    if (result.needsConfirmation && result.goalId) {
      this.host.setPendingTend({ goalId: result.goalId, maxIterations: result.maxIterations });
      return {
        success: true,
        output: result.confirmation ?? result.message,
        elapsed_ms: Date.now() - start,
      };
    }

    return {
      success: result.success,
      output: result.message,
      elapsed_ms: Date.now() - start,
    };
  }

  private buildTendDeps(
    llmClient: ILLMClient,
    goalNegotiator: GoalNegotiator,
    daemonClient: DaemonClient,
  ): TendDeps {
    return {
      llmClient,
      goalNegotiator,
      daemonClient,
      stateManager: this.host.deps.stateManager,
      chatHistory: this.host.getHistory()?.getMessages() ?? [],
      sessionId: this.host.getHistory()?.getSessionId() ?? null,
      workspace: this.host.getSessionCwd() ?? process.cwd(),
      replyTarget: this.host.getRuntimeControlContext()?.replyTarget ?? this.host.deps.runtimeReplyTarget ?? null,
      personalAgentRuntime: this.host.getPersonalAgentRuntime(),
    };
  }
}
