// ─── App ───
//
// Root Ink component that composes Dashboard + Chat and manages shared state.
// Layout: horizontal split — Dashboard sidebar (left, ~30%) + Chat (right, ~70%).
// Uses the useLoop() hook internally for loop state management.
// Routes chat input through IntentRecognizer → ActionHandler.
//
// Supports two modes:
// - Daemon mode: daemonClient is provided, coreLoop is absent. Events come via SSE.
// - Standalone mode: coreLoop is provided, runs in-process.

import React, { useState, useCallback, useEffect } from "react";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { Box, Text, useInput, useStdout } from "ink";
import { theme } from "./theme.js";
import { buildWorkDashboardRows, Dashboard, statusLabel } from "./dashboard.js";
import { Chat, type ChatMessage } from "./chat.js";
import { FullscreenChat } from "./fullscreen-chat.js";
import { HelpOverlay } from "./help-overlay.js";
import { SettingsOverlay } from "./settings-overlay.js";
import { ReportView } from "./report-view.js";
import { SEEDY_PIXEL } from "./seedy-art.js";
import { createShellApprovalTask, formatShellOutput } from "./bash-mode.js";
import {
  resolveFreeformInputRoute,
  resolveTuiInputAction,
  type FreeformInputRoute,
} from "./input-action.js";
import type { Report } from "../../base/types/report.js";
import type { Goal } from "../../base/types/goal.js";
import { useLoop } from "./use-loop.js";
import type { LoopState } from "./use-loop.js";
import {
  listRunnableStartGoals,
  selectRunnableStartGoal,
  type ActionHandler,
} from "./actions.js";
import type { IntentRecognizer } from "./intent-recognizer.js";
import type { DurableLoop } from "../../orchestrator/loop/durable-loop.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { TrustManager } from "../../platform/traits/trust-manager.js";
import type { Task } from "../../base/types/task.js";
import type { TuiChatSurface } from "./chat-surface.js";
import type { DaemonClient } from "../../runtime/daemon/client.js";
import { getPulseedVersion } from "../../base/utils/pulseed-meta.js";
import { parseExactSlashCommandToken } from "../../base/protocol/exact-protocol.js";
import { applyChatEventToMessages } from "../chat/chat-event-state.js";
import { setActiveCursorEscape } from "./cursor-tracker.js";
import { createRuntimeSessionRegistry } from "../../runtime/session-registry/index.js";
import type { RuntimeSessionRegistrySnapshot } from "../../runtime/session-registry/types.js";
import { RuntimeEvidenceLedger, type RuntimeEvidenceSummary } from "../../runtime/store/evidence-ledger.js";
import { RuntimeHealthStore } from "../../runtime/store/health-store.js";
import type { RuntimeHealthSnapshot } from "../../runtime/store/runtime-schemas.js";
import {
  formatCurrentGoalChoiceList,
  formatCurrentGoalSummary,
  isCurrentGoalCandidate,
} from "../current-goal-summary.js";
import {
  arbitrateRunSpecPendingDialogue,
  createRunSpecStore,
  handleRunSpecConfirmationInput,
  type RunSpec,
} from "../../runtime/run-spec/index.js";
import { answerRuntimeEvidenceQuestion } from "../../runtime/evidence-answer.js";
import { createTextUserInput } from "../chat/user-input.js";
import type { ToolExecutor } from "../../tools/executor.js";
import type { ApprovalRequest as ToolApprovalRequest } from "../../tools/types.js";
import { defaultExecutionPolicy, type ExecutionPolicy } from "../../orchestrator/execution/agent-loop/execution-policy.js";

const MAX_MESSAGES = 200;
const PULSEED_VERSION = getPulseedVersion(import.meta.url);
export const DASHBOARD_REFRESH_INTERVAL_MS = 5_000;
export const APP_HEADER_ROWS = SEEDY_PIXEL.split("\n").length;
const STATUS_BAR_ROWS = 4;

export interface ApprovalRequest {
  task: Task;
  resolve: (approved: boolean) => void;
}

export type DaemonConnectionState = "connected" | "connecting" | "disconnected";

export function formatDaemonConnectionState(state: DaemonConnectionState | undefined): string | undefined {
  if (!state) return undefined;
  return `  [daemon ${state}]`;
}

function normalizeApprovalTask(data: Record<string, unknown>): Task {
  const rawTask = data.task;
  if (rawTask && typeof rawTask === "object") {
    return rawTask as Task;
  }
  const goalId = String(data.goalId ?? data.goal_id ?? "");
  const title = String(data.title ?? "Operator handoff required");
  const summary = String(data.summary ?? data.recommended_action ?? "Review this operator handoff before continuing.");
  const currentStatus = String(data.current_status ?? "");
  const triggers = Array.isArray(data.triggers) ? data.triggers.map(String).join(", ") : "operator_handoff";
  return {
    id: String(data.handoff_id ?? data.requestId ?? "operator_handoff"),
    goal_id: goalId,
    strategy_id: null,
    target_dimensions: [],
    primary_dimension: "operator_handoff",
    work_description: title,
    rationale: summary,
    approach: String(data.recommended_action ?? currentStatus ?? "Operator decision required."),
    success_criteria: [{
      description: "Operator has approved or rejected the handoff.",
      verification_method: "daemon approval response",
      is_blocking: true,
    }],
    scope_boundary: {
      in_scope: [triggers],
      out_of_scope: [],
      blast_radius: "operator handoff",
    },
    constraints: ["Requires explicit operator approval."],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "unknown",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: String(data.created_at ?? new Date().toISOString()),
  };
}

function formatApprovalNotice(task: Task): string {
  return [
    "Approval required.",
    `Work: ${task.work_description}`,
    `Rationale: ${task.rationale}`,
    `Approach: ${task.approach}`,
    "Approval decisions are handled in the originating conversation channel.",
  ].join("\n");
}

export { resolveFreeformInputRoute, type FreeformInputRoute } from "./input-action.js";

const CHAT_RUNNER_OWNED_COMMANDS = new Set([
  "/resume",
  "/sessions",
  "/history",
  "/title",
  "/cleanup",
  "/compact",
  "/context",
  "/working-memory",
  "/status",
  "/goals",
  "/tasks",
  "/task",
  "/track",
  "/tend",
  "/config",
  "/model",
  "/permissions",
  "/plugins",
  "/usage",
  "/review",
  "/fork",
  "/undo",
  "/retry",
]);

const INITIAL_CHAT_MESSAGE = [
  "Describe what you want PulSeed to help with.",
  'Examples: "organize this project and tell me what to do next" or "keep working on the README until it is ready."',
  "Type /help when you want command details.",
].join("\n");

export function isChatRunnerOwnedSlashCommand(input: string): boolean {
  const parsed = parseExactSlashCommandToken(input);
  return parsed ? CHAT_RUNNER_OWNED_COMMANDS.has(parsed.command) : false;
}

export function deriveDaemonGoalIdFromActiveGoals(
  currentGoalId: string | null,
  activeGoals: string[],
): string | null {
  if (activeGoals.length === 0) return null;
  return currentGoalId && activeGoals.includes(currentGoalId) ? currentGoalId : activeGoals[0]!;
}

function buildRunSpecIngress(input: string, spec: RunSpec, effectiveCwd: string) {
  return {
    ingress_id: randomUUID(),
    received_at: new Date().toISOString(),
    channel: "tui" as const,
    platform: "local_tui",
    text: input,
    userInput: createTextUserInput(input),
    actor: {
      surface: "tui" as const,
      platform: "local_tui",
    },
    runtimeControl: {
      allowed: true,
      approvalMode: "interactive" as const,
    },
    metadata: {
      run_spec_id: spec.id,
      run_spec_profile: spec.profile,
      run_spec_status: spec.status,
    },
    replyTarget: {
      surface: "tui" as const,
      channel: "tui" as const,
      platform: "local_tui",
      metadata: {
        run_spec_id: spec.id,
        run_spec_profile: spec.profile,
        run_spec_status: spec.status,
      },
    },
    cwd: effectiveCwd,
  };
}

function resolveRunSpecExecutionCwd(spec: RunSpec, fallbackCwd: string): string {
  return spec.workspace?.path ?? fallbackCwd;
}

interface AppProps {
  // Daemon mode (thin client — events via SSE, commands via REST)
  daemonClient?: DaemonClient;
  // Standalone mode (in-process CoreLoop)
  coreLoop?: DurableLoop;
  trustManager?: TrustManager;
  actionHandler?: ActionHandler;
  intentRecognizer?: IntentRecognizer;
  llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">;
  chatRunner?: TuiChatSurface;
  onApprovalReady?: (requestFn: (req: ApprovalRequest) => void) => void;
  shellApprovalFn?: (task: Task) => Promise<boolean>;
  toolExecutor?: Pick<ToolExecutor, "execute">;
  shellExecutionPolicy?: ExecutionPolicy;
  // Shared
  stateManager: StateManager;
  cwd?: string;
  gitBranch?: string;
  providerName?: string;
  noFlicker?: boolean;
  controlStream?: Pick<NodeJS.WriteStream, "write">;
}

const StatusBar: React.FC<{
  goalCount: number;
  trustScore: number;
  status: string;
  iteration: number;
  daemonConnectionState?: DaemonConnectionState;
  currentGoalSummary?: string | null;
}> = ({ goalCount, trustScore, status, iteration, daemonConnectionState, currentGoalSummary }) => (
  <Box
    borderStyle="single"
    borderColor={theme.border}
    paddingX={1}
    justifyContent="space-between"
  >
    <Box flexDirection="column" flexGrow={1}>
      <Text dimColor>
        Active: {goalCount}  Trust: {trustScore >= 0 ? "+" : ""}
        {trustScore}  Status: {statusLabel(status)}  Iter: {iteration}
        {formatDaemonConnectionState(daemonConnectionState)}
      </Text>
      {currentGoalSummary && <Text dimColor>{currentGoalSummary}</Text>}
    </Box>
    <Text dimColor>d:dashboard  ?:help  Ctrl-C× 2:quit</Text>
  </Box>
);

// ─── Default idle loop state for daemon mode ───

const IDLE_LOOP_STATE: LoopState = {
  running: false,
  goalId: null,
  iteration: 0,
  status: "idle",
  dimensions: [],
  trustScore: 0,
  startedAt: null,
  lastResult: null,
};

export function App({
  daemonClient,
  coreLoop,
  stateManager,
  trustManager,
  actionHandler,
  intentRecognizer,
  llmClient,
  chatRunner,
  onApprovalReady,
  shellApprovalFn,
  toolExecutor,
  shellExecutionPolicy,
  cwd,
  gitBranch,
  providerName,
  noFlicker,
}: AppProps) {
  const isDaemonMode = daemonClient !== undefined && coreLoop === undefined;

  // ── Terminal dimensions ──
  const { stdout } = useStdout();
  const termCols = stdout?.columns ?? 80;
  const termRows = stdout?.rows ?? 24;
  const [showSidebar, setShowSidebar] = useState(false);
  const [runtimeSessionSnapshot, setRuntimeSessionSnapshot] = useState<RuntimeSessionRegistrySnapshot | null>(null);
  const [runtimeHealthSnapshot, setRuntimeHealthSnapshot] = useState<RuntimeHealthSnapshot | null>(null);
  const [runtimeEvidenceSummaries, setRuntimeEvidenceSummaries] = useState<Record<string, RuntimeEvidenceSummary>>({});
  const [daemonActiveGoalIds, setDaemonActiveGoalIds] = useState<string[]>([]);
  const [currentGoals, setCurrentGoals] = useState<Goal[]>([]);

  // ── Loop state ──
  // In standalone mode, useLoop() manages state via CoreLoop.
  // In daemon mode, we maintain local state updated via SSE events.
  const standaloneHook = (!isDaemonMode && coreLoop && trustManager)
    ? useLoop(coreLoop, stateManager, trustManager)
    : null;

  const [daemonLoopState, setDaemonLoopState] = useState<LoopState>(IDLE_LOOP_STATE);
  const [daemonConnectionState, setDaemonConnectionState] = useState<DaemonConnectionState | undefined>(
    isDaemonMode
      ? (daemonClient?.isConnected() ? "connected" : "connecting")
      : undefined
  );

  const loopState = isDaemonMode ? daemonLoopState : (standaloneHook?.loopState ?? IDLE_LOOP_STATE);
  const startLoop = isDaemonMode
    ? (goalId: string) => { daemonClient!.startGoal(goalId).catch(() => {}); }
    : (standaloneHook?.start ?? (() => {}));
  const stopLoop = isDaemonMode
    ? () => {
        if (daemonLoopState.goalId) {
          daemonClient!.stopGoal(daemonLoopState.goalId).catch(() => {});
        }
      }
    : (standaloneHook?.stop ?? (() => {}));

  // ── Daemon SSE event listeners ──
  useEffect(() => {
    if (!isDaemonMode || !daemonClient) return;

    const onConnected = () => setDaemonConnectionState("connected");
    const onDisconnected = () => setDaemonConnectionState("disconnected");

    const onLoopUpdate = (data: unknown) => {
      const d = data as Record<string, unknown>;
      setDaemonLoopState((prev) => ({
        ...prev,
        running: (d.running as boolean) ?? prev.running,
        goalId: Object.hasOwn(d, "goalId") ? (d.goalId as string | null) : prev.goalId,
        iteration: (d.iteration as number) ?? prev.iteration,
        status: (d.status as string) ?? prev.status,
        trustScore: (d.trustScore as number) ?? prev.trustScore,
      }));
    };

    const onDaemonStatus = (data: unknown) => {
      const d = data as Record<string, unknown>;
      const activeGoals = Array.isArray(d.activeGoals)
        ? d.activeGoals.filter((goalId): goalId is string => typeof goalId === "string" && goalId.length > 0)
        : null;
      if (activeGoals) setDaemonActiveGoalIds(activeGoals);
      setDaemonLoopState((prev) => {
        const nextGoalId = activeGoals
          ? deriveDaemonGoalIdFromActiveGoals(prev.goalId, activeGoals)
          : prev.goalId;
        return {
          ...prev,
          goalId: nextGoalId,
          running: activeGoals ? activeGoals.length > 0 : prev.running,
          status: typeof d.status === "string"
            ? d.status
            : activeGoals && activeGoals.length === 0
              ? "idle"
              : prev.status,
          iteration: typeof d.loopCount === "number" ? d.loopCount : prev.iteration,
        };
      });
    };

    const onApproval = (data: unknown) => {
      const d = data as Record<string, unknown>;
      const task = normalizeApprovalTask(d);
      const requestId = String(d.requestId ?? d.handoff_id ?? "");
      const goalId = String(d.goalId ?? d.goal_id ?? task.goal_id);
      if (!requestId || !goalId) return;

      setMessages((prev) => [...prev, {
        id: randomUUID(),
        role: "pulseed" as const,
        text: formatApprovalNotice(task),
        timestamp: new Date(),
        messageType: "warning" as const,
      }].slice(-MAX_MESSAGES));
    };

    daemonClient.on("_connected", onConnected);
    daemonClient.on("_disconnected", onDisconnected);
    daemonClient.on("loop_update", onLoopUpdate);
    daemonClient.on("daemon_status", onDaemonStatus);
    daemonClient.on("approval_required", onApproval);
    daemonClient.on("operator_handoff_required", onApproval);

    return () => {
      daemonClient.off("_connected", onConnected);
      daemonClient.off("_disconnected", onDisconnected);
      daemonClient.off("loop_update", onLoopUpdate);
      daemonClient.off("daemon_status", onDaemonStatus);
      daemonClient.off("approval_required", onApproval);
      daemonClient.off("operator_handoff_required", onApproval);
    };
  }, [isDaemonMode, daemonClient]);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: randomUUID(),
      role: "pulseed",
      text: INITIAL_CHAT_MESSAGE,
      timestamp: new Date(),
      messageType: "info",
    },
  ]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const [goalNames, setGoalNames] = useState<string[]>([]);
  const [reportToShow, setReportToShow] = useState<Report | null>(null);
  const [pendingRunSpec, setPendingRunSpec] = useState<RunSpec | null>(null);

  // Ctrl-C double-press exit state
  const [ctrlCPending, setCtrlCPending] = useState(false);

  // Expose setApprovalRequest to entry.ts via callback prop (standalone mode)
  const showApprovalRequest = useCallback((req: ApprovalRequest) => {
    setMessages((prev) => [...prev, {
      id: randomUUID(),
      role: "pulseed" as const,
      text: formatApprovalNotice(req.task),
      timestamp: new Date(),
      messageType: "warning" as const,
    }].slice(-MAX_MESSAGES));
    req.resolve(false);
  }, []);

  useEffect(() => {
    if (onApprovalReady) {
      onApprovalReady(showApprovalRequest);
    }
  }, [onApprovalReady, showApprovalRequest]);

  useEffect(() => {
    if (!showSidebar) return;
    let cancelled = false;

    const refreshRuntimeSessions = async () => {
      try {
        const registry = createRuntimeSessionRegistry({ stateManager });
        const runtimeRoot = path.join(stateManager.getBaseDir(), "runtime");
        const healthStore = new RuntimeHealthStore(runtimeRoot);
        const evidenceLedger = new RuntimeEvidenceLedger(runtimeRoot);
        const snapshot = await registry.snapshot();
        const dashboardRunIds = new Set<string>();
        const rows = buildWorkDashboardRows(snapshot);
        for (const row of rows.slice(0, 12)) {
          if (row.kind === "run") {
            dashboardRunIds.add(row.id);
            continue;
          }
          const relatedRun = snapshot.background_runs.find((run) =>
            run.child_session_id === row.id || run.parent_session_id === row.id || run.process_session_id === row.id
          );
          if (relatedRun) dashboardRunIds.add(relatedRun.id);
        }
        const [health, summaries] = await Promise.all([
          healthStore.loadSnapshot().catch(() => null),
          Promise.all([...dashboardRunIds].map(async (runId) => {
            const summary = await evidenceLedger.summarizeRun(runId).catch(() => null);
            return [runId, summary] as const;
          })),
        ]);
        if (!cancelled) {
          setRuntimeSessionSnapshot(snapshot);
          setRuntimeHealthSnapshot(health);
          setRuntimeEvidenceSummaries(Object.fromEntries(summaries.filter((entry): entry is readonly [string, RuntimeEvidenceSummary] => entry[1] !== null)));
        }
      } catch {
        if (!cancelled) {
          setRuntimeSessionSnapshot(null);
          setRuntimeHealthSnapshot(null);
          setRuntimeEvidenceSummaries({});
        }
      }
    };

    void refreshRuntimeSessions();
    const interval = setInterval(() => {
      void refreshRuntimeSessions();
    }, DASHBOARD_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [showSidebar, stateManager]);

  useEffect(() => {
    let cancelled = false;
    const goalIds = isDaemonMode && daemonActiveGoalIds.length > 0
      ? daemonActiveGoalIds
      : loopState.goalId
        ? [loopState.goalId]
        : [];
    if (goalIds.length === 0) {
      setCurrentGoals([]);
      return;
    }

    Promise.all(goalIds.map((goalId) => stateManager.loadGoal(goalId)))
      .then((goals) => {
        if (!cancelled) {
          setCurrentGoals(goals.filter((goal): goal is Goal => goal !== null && isCurrentGoalCandidate(goal)));
        }
      })
      .catch(() => {
        if (!cancelled) setCurrentGoals([]);
      });

    return () => {
      cancelled = true;
    };
  }, [stateManager, isDaemonMode, daemonActiveGoalIds, loopState.goalId, loopState.status, loopState.iteration]);

  // Start ChatRunner session on mount (standalone mode)
  useEffect(() => {
    if (chatRunner) {
      chatRunner.startSession(cwd ?? process.cwd());
      chatRunner.onEvent = async (event) => {
        setMessages((prev) => applyChatEventToMessages(prev, event, MAX_MESSAGES) as ChatMessage[]);
        if (event.type === "operation_progress") {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      };
    }
  }, [chatRunner, cwd]);

  // Pre-load active/waiting goal names for fuzzy completion in Chat
  useEffect(() => {
    (async () => {
      try {
        const ids = await stateManager.listGoalIds();
        const names: string[] = [];
        for (const id of ids) {
          const goal = await stateManager.loadGoal(id);
          if (goal && (goal.status === "active" || goal.status === "waiting")) {
            names.push(goal.title);
          }
        }
        setGoalNames(names);
      } catch {
        // Non-critical — goal completion simply won't show suggestions
      }
    })();
  }, [stateManager]);

  // Handle Ctrl-C via useInput (raw mode — SIGINT does not fire when Ink holds the terminal)
  useInput((input, key) => {
    if (input === "c" && key.ctrl) {
      if (ctrlCPending) {
        // Second Ctrl-C — disconnect and exit
        if (isDaemonMode && daemonClient) {
          daemonClient.disconnect();
        } else if (coreLoop) {
          coreLoop.stop();
        }
        process.exit(0);
      }
      setCtrlCPending(true);
      setTimeout(() => setCtrlCPending(false), 3000);
      return;
    }

    // Any other input cancels the pending Ctrl-C
    if (ctrlCPending) {
      setCtrlCPending(false);
    }

    // F1 key toggles help overlay
    if (
      input === "OP" ||
      input === "[11~" ||
      input === "[[A"
    ) {
      setShowHelp((prev) => !prev);
    }
  }, { isActive: reportToShow === null });

  const handleClear = useCallback(() => {
    setMessages([
      {
        id: randomUUID(),
        role: "pulseed" as const,
        text: "Chat cleared. Describe what you want to do next, or type /help for command details.",
        timestamp: new Date(),
        messageType: "info" as const,
      },
    ]);
  }, []);

  const handleInput = useCallback(
    async (input: string) => {
      const action = resolveTuiInputAction(input, {
        isProcessing,
        hasChatRunner: chatRunner !== undefined,
        hasPendingRunSpec: pendingRunSpec !== null,
        hasStandaloneSlashHandlers: intentRecognizer !== undefined && actionHandler !== undefined,
        isDaemonMode,
        daemonGoalId: daemonLoopState.goalId,
        isChatRunnerOwnedSlashCommand,
      });

      if (action.kind === "ignore_processing") {
        return;
      }

      if (action.kind === "interrupt_redirect") {
        if (!chatRunner) return;
        setMessages((prev) => [...prev, { id: randomUUID(), role: "user" as const, text: input, timestamp: new Date() }].slice(-MAX_MESSAGES));
        try {
          await chatRunner.interruptAndRedirect(input, cwd ?? process.cwd());
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setMessages((prev) => [...prev, {
            id: randomUUID(),
            role: "pulseed" as const,
            text: `Interrupt error: ${message}`,
            timestamp: new Date(),
            messageType: "error" as const,
          }].slice(-MAX_MESSAGES));
        }
        return;
      }
      // Add user message
      setMessages((prev) => [...prev, { id: randomUUID(), role: "user" as const, text: input, timestamp: new Date() }].slice(-MAX_MESSAGES));
      setIsProcessing(true);

      try {
        // Local-only commands — no LLM round-trip needed
        if (action.kind === "shell_missing_command") {
          setMessages((prev) => [...prev, {
            id: randomUUID(),
            role: "pulseed" as const,
            text: "Shell command required after !",
            timestamp: new Date(),
            messageType: "warning" as const,
          }].slice(-MAX_MESSAGES));
          return;
        }

        if (action.kind === "shell") {
          const effectiveCwd = cwd ?? process.cwd();
          if (!toolExecutor) {
            setMessages((prev) => [...prev, {
              id: randomUUID(),
              role: "pulseed" as const,
              text: "Shell execution unavailable: typed tool executor is not configured.",
              timestamp: new Date(),
              messageType: "error" as const,
            }].slice(-MAX_MESSAGES));
            return;
          }
          const shellInput = { command: action.command, cwd: effectiveCwd, timeoutMs: 120_000 };
          const result = await toolExecutor.execute("shell", shellInput, {
            cwd: effectiveCwd,
            goalId: "shell-mode",
            trustBalance: 0,
            preApproved: false,
            approvalFn: (request: ToolApprovalRequest) => {
              if (!shellApprovalFn) return Promise.resolve(false);
              return shellApprovalFn(createShellApprovalTask(action.command, effectiveCwd, request.reason));
            },
            executionPolicy: shellExecutionPolicy ?? defaultExecutionPolicy(effectiveCwd),
          });
          const shellOutput = result.data as { stdout?: string; stderr?: string; exitCode?: number } | null;
          const text = shellOutput
            ? formatShellOutput(action.command, {
                stdout: shellOutput.stdout ?? "",
                stderr: shellOutput.stderr ?? "",
                exitCode: shellOutput.exitCode ?? (result.success ? 0 : 1),
              })
            : (result.error ? `Error: ${result.error}` : "Shell command completed.");

          setMessages((prev) => [...prev, {
            id: randomUUID(),
            role: "pulseed" as const,
            text,
            timestamp: new Date(),
            messageType: result.success ? ("info" as const) : ("error" as const),
          }].slice(-MAX_MESSAGES));
          return;
        }

        if (action.kind === "chat_runner_slash" && chatRunner) {
          await chatRunner.execute(input, cwd ?? process.cwd());
          return;
        }

        if (action.kind === "pending_run_spec_confirmation" && pendingRunSpec && chatRunner) {
          const effectiveCwd = cwd ?? process.cwd();
          const result = await handleRunSpecConfirmationInput(pendingRunSpec, input, {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            llmClient,
          });
          if (result.kind === "unrecognized") {
            const dialogue = await arbitrateRunSpecPendingDialogue(pendingRunSpec, input, {
              llmClient,
            });
            if (dialogue.outcome === "new_intent") {
              await chatRunner.execute(input, effectiveCwd);
              return;
            }
          }
          const savedRunSpec = await createRunSpecStore(stateManager).save(result.spec);
          if (result.kind === "cancelled") {
            setPendingRunSpec(null);
          } else if (result.kind === "confirmed") {
            setPendingRunSpec(null);
          } else {
            setPendingRunSpec(savedRunSpec);
          }
          setMessages((prev) => [...prev, {
            id: randomUUID(),
            role: "pulseed" as const,
            text: result.message,
            timestamp: new Date(),
            messageType: result.kind === "blocked" || result.kind === "unrecognized" ? ("warning" as const) : ("info" as const),
          }].slice(-MAX_MESSAGES));
          if (result.kind === "confirmed") {
            const runSpecCwd = resolveRunSpecExecutionCwd(savedRunSpec, effectiveCwd);
            await chatRunner.executeIngressMessage(
              buildRunSpecIngress(savedRunSpec.source_text, savedRunSpec, runSpecCwd),
              runSpecCwd,
            );
          }
          return;
        }

        // Slash commands go through IntentRecognizer -> ActionHandler (standalone)
        // or through daemon REST API (daemon mode)
        if (action.kind === "standalone_slash" && intentRecognizer && actionHandler) {
          const intent = await intentRecognizer.recognize(input);
          const result = await actionHandler.handle(intent);

          if (result.showHelp) {
            setShowHelp(true);
            return;
          }

          if (action.trimmedInput === "/settings" || action.trimmedInput === "/config") {
            setShowSettings(true);
            return;
          }

          if (result.showReport) {
            setReportToShow(result.showReport);
            return;
          }

          setMessages((prev) => [
            ...prev,
            ...result.messages.map((text) => ({
              id: randomUUID(),
              role: "pulseed" as const,
              text,
              timestamp: new Date(),
              messageType: result.messageType ?? ("info" as const),
            })),
          ].slice(-MAX_MESSAGES));

          if (result.toggleDashboard === "toggle") {
            setShowSidebar(prev => !prev);
          }

          if (result.startLoop) {
            startLoop(result.startLoop.goalId);
          }
          if (result.stopLoop) {
            stopLoop();
          }
        } else if (action.kind === "daemon_slash") {
          // Daemon mode: handle basic slash commands locally
          const trimmed = action.trimmedInput;
          if (trimmed === "/help" || trimmed === "/?") {
            setShowHelp(true);
          } else if (trimmed === "/settings" || trimmed === "/config") {
            setShowSettings(true);
          } else if (trimmed === "/dashboard" || trimmed === "/d") {
            setShowSidebar(prev => !prev);
          } else if (trimmed.startsWith("/start ")) {
            const goalArg = action.input.trim().slice(7).trim();
            const runnableGoals = await listRunnableStartGoals(stateManager);
            const goal = goalArg ? selectRunnableStartGoal(runnableGoals, goalArg) : undefined;
            if (goal) {
              startLoop(goal.id);
              setMessages((prev) => [...prev, {
                id: randomUUID(), role: "pulseed" as const,
                text: `Starting goal: ${goal.title}`, timestamp: new Date(), messageType: "info" as const,
              }].slice(-MAX_MESSAGES));
            } else {
              setMessages((prev) => [...prev, {
                id: randomUUID(), role: "pulseed" as const,
                text: `No goal matching "${goalArg}". Choose one by number with /start <number>, or describe what you want to work on.`,
                timestamp: new Date(), messageType: "warning" as const,
              }].slice(-MAX_MESSAGES));
            }
          } else if (trimmed === "/stop") {
            stopLoop();
            setMessages((prev) => [...prev, {
              id: randomUUID(), role: "pulseed" as const,
              text: "Stop signal sent to daemon.", timestamp: new Date(), messageType: "info" as const,
            }].slice(-MAX_MESSAGES));
          } else {
            setMessages((prev) => [...prev, {
              id: randomUUID(), role: "pulseed" as const,
              text: `I could not run "${input}" as a command. Describe what you want instead, or type /help for command details.`,
              timestamp: new Date(), messageType: "warning" as const,
            }].slice(-MAX_MESSAGES));
          }
        } else {
          const evidenceAnswer = await answerRuntimeEvidenceQuestion({
            text: input,
            stateManager,
            llmClient,
          });
          if (evidenceAnswer.kind === "answered" && evidenceAnswer.message) {
            const message = evidenceAnswer.message;
            setMessages((prev) => [...prev, {
              id: randomUUID(),
              role: "pulseed" as const,
              text: message,
              timestamp: new Date(),
              messageType: evidenceAnswer.messageType ?? ("info" as const),
            }].slice(-MAX_MESSAGES));
            return;
          }

          const freeformRoute = action.kind === "freeform" ? action.route : resolveFreeformInputRoute({
            isDaemonMode,
            daemonGoalId: daemonLoopState.goalId,
            hasChatRunner: chatRunner !== undefined,
          });

          if (freeformRoute === "daemon_goal_chat" && daemonClient && daemonLoopState.goalId) {
            try {
              await daemonClient.chat(daemonLoopState.goalId, input);
              setMessages((prev) => [...prev, {
                id: randomUUID(), role: "pulseed" as const,
                text: "Message sent to daemon.", timestamp: new Date(), messageType: "info" as const,
              }].slice(-MAX_MESSAGES));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              setMessages((prev) => [...prev, {
                id: randomUUID(), role: "pulseed" as const,
                text: `Chat error: ${msg}`, timestamp: new Date(), messageType: "error" as const,
              }].slice(-MAX_MESSAGES));
            }
          } else if (freeformRoute === "chat_runner" && chatRunner) {
            const effectiveCwd = cwd ?? process.cwd();
            await chatRunner.execute(input, effectiveCwd);
          } else {
            setMessages((prev) => [...prev, {
              id: randomUUID(), role: "pulseed" as const,
              text: isDaemonMode
                ? "No active goal is running. Describe what you want to work on, or choose a listed goal by number with /start <number>."
                : "Chat is not available yet. Describe the outcome after chat setup is ready, or type /help for command details.",
              timestamp: new Date(), messageType: "info" as const,
            }].slice(-MAX_MESSAGES));
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setMessages((prev) => [
          ...prev,
          {
            id: randomUUID(),
            role: "pulseed" as const,
            text: `Error: ${message}`,
            timestamp: new Date(),
            messageType: "error" as const,
          },
        ].slice(-MAX_MESSAGES));
      } finally {
        setIsProcessing(false);
      }
    },
    [intentRecognizer, actionHandler, llmClient, chatRunner, daemonClient, isDaemonMode, daemonLoopState.goalId, startLoop, stopLoop, isProcessing, cwd, stateManager, pendingRunSpec]
  );

  const statusGoalCount = isDaemonMode && daemonActiveGoalIds.length > 0
    ? daemonActiveGoalIds.length
    : loopState.goalId !== null
      ? 1
      : 0;
  const statusBarCurrentGoal = currentGoals.length === 1
    ? formatCurrentGoalSummary(currentGoals[0]!, {
      runtimeSnapshot: runtimeSessionSnapshot,
      surface: "compact",
    })
    : currentGoals.length > 1
      ? formatCurrentGoalChoiceList(currentGoals, {
        runtimeSnapshot: runtimeSessionSnapshot,
        surface: "compact",
      })
      : null;
  const chatAvailableRows = Math.max(
    1,
    termRows - APP_HEADER_ROWS - STATUS_BAR_ROWS - (ctrlCPending ? 1 : 0),
  );
  const sidebarCols = showSidebar ? Math.floor(termCols * 0.3) : 0;
  const chatAvailableCols = Math.max(20, termCols - sidebarCols);
  const showingOverlay =
    showSettings ||
    reportToShow !== null ||
    showHelp;
  useEffect(() => {
    if (!noFlicker || !showingOverlay) return;
    setActiveCursorEscape(null);
  }, [noFlicker, showingOverlay]);

  // ─── Sidebar layout ───
  return (
    <Box flexDirection="column" height={termRows}>
      {/* App banner — Claude Code style */}
      <Box flexDirection="row" paddingY={0}>
        {/* Seedy pixel art (left) */}
        <Box marginRight={2}>
          <Text>{SEEDY_PIXEL}</Text>
        </Box>
        {/* Info text (right, vertically centered) */}
        <Box flexDirection="column" justifyContent="center">
          <Box>
            <Text bold color={theme.brand}>PulSeed</Text>
            <Text dimColor> v{PULSEED_VERSION}</Text>
          </Box>
          <Text dimColor>
            daemon: {isDaemonMode ? daemonConnectionState ?? "connecting" : "off"}{providerName ? ` · ${providerName}` : ""}
          </Text>
          {cwd && (
            <Text dimColor>{cwd}</Text>
          )}
        </Box>
      </Box>

      {/* Main content: sidebar + chat */}
      <Box flexDirection="row" flexGrow={1}>
        {/* ── Left sidebar: Dashboard ── */}
        {showSidebar && (
          <Box
            flexDirection="column"
            width="30%"
            borderStyle="single"
            borderColor={theme.border}
            paddingX={1}
            overflow="hidden"
          >
            <Dashboard
              state={loopState}
              runtimeSessions={runtimeSessionSnapshot}
              runtimeHealth={runtimeHealthSnapshot}
              evidenceSummaries={runtimeEvidenceSummaries}
            />
          </Box>
        )}

        {/* ── Right pane: Chat / overlays ── */}
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {showSettings ? (
            <SettingsOverlay onClose={() => setShowSettings(false)} />
          ) : reportToShow !== null ? (
            <ReportView report={reportToShow} onDismiss={() => setReportToShow(null)} />
          ) : showHelp ? (
            <HelpOverlay onDismiss={() => setShowHelp(false)} />
          ) : (
            noFlicker ? (
              <FullscreenChat
                messages={messages}
                onSubmit={handleInput}
                onClear={handleClear}
                isProcessing={isProcessing}
                goalNames={goalNames}
                availableRows={chatAvailableRows}
                availableCols={chatAvailableCols}
                cursorOriginX={sidebarCols}
                cursorOriginY={APP_HEADER_ROWS}
              />
            ) : (
              <Chat
                messages={messages}
                onSubmit={handleInput}
                onClear={handleClear}
                isProcessing={isProcessing}
                goalNames={goalNames}
                noFlicker={false}
                availableRows={chatAvailableRows}
                availableCols={chatAvailableCols}
              />
            )
          )}
        </Box>
      </Box>

      <StatusBar
        goalCount={statusGoalCount}
        trustScore={loopState.trustScore}
        status={loopState.status}
        iteration={loopState.iteration}
        daemonConnectionState={daemonConnectionState}
        currentGoalSummary={statusBarCurrentGoal}
      />
      {ctrlCPending && (
        <Box paddingX={1}>
          <Text color={theme.warning}>(Press Ctrl-C once more to quit)</Text>
        </Box>
      )}
    </Box>
  );
}
