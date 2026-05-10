import React from "react";
import { Box, Text } from "ink";
import { CheckerboardSpinner } from "./checkerboard-spinner.js";
import type { LoopState, DimensionProgress } from "./use-loop.js";
import { theme, statusColor, progressColor } from "./theme.js";
import type {
  BackgroundRun,
  RuntimeSession,
  RuntimeSessionRegistrySnapshot,
} from "../../runtime/session-registry/types.js";
import type { RuntimeEvidenceSummary } from "../../runtime/store/evidence-ledger.js";
import type { RuntimeHealthSnapshot } from "../../runtime/store/runtime-schemas.js";

interface DashboardProps {
  state: LoopState;
  maxIterations?: number;
  runtimeSessions?: RuntimeSessionRegistrySnapshot | null;
  runtimeHealth?: RuntimeHealthSnapshot | null;
  evidenceSummaries?: RuntimeEvidenceSummaryByRun;
}

const BAR_WIDTH = 20;
const CURRENT_STALE_MS = 60 * 60 * 1000;
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type WorkDashboardRowKind = "session" | "run";
export type WorkDashboardRowGroup = "active" | "recent";

export interface WorkDashboardRow {
  kind: WorkDashboardRowKind;
  group: WorkDashboardRowGroup;
  id: string;
  title: string;
  status: string;
  summary: string;
  updatedAt: string | null;
  workspace: string | null;
  attention: boolean;
  stale: boolean;
}

export type RuntimeEvidenceSummaryByRun = Record<string, RuntimeEvidenceSummary>;

export interface OperatorConsoleModel {
  selectedId: string;
  selectedTitle: string;
  lifecycle: string;
  liveness: string;
  usefulProgress: string;
  currentMode: string;
  latestEvents: string[];
  artifacts: string[];
  metrics: string[];
  blockers: string[];
  controls: string[];
}

function renderBar(progress: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, progress)) / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function latestSessionTime(session: RuntimeSession): string | null {
  return session.last_event_at ?? session.updated_at ?? session.created_at;
}

function latestRunTime(run: BackgroundRun): string | null {
  return run.completed_at ?? run.updated_at ?? run.started_at ?? run.created_at;
}

function isStaleCurrent(updatedAt: string | null, now: Date): boolean {
  const ms = timestampMs(updatedAt);
  if (ms === null) return true;
  return now.getTime() - ms > CURRENT_STALE_MS;
}

function isRecent(updatedAt: string | null, now: Date): boolean {
  const ms = timestampMs(updatedAt);
  if (ms === null) return false;
  return now.getTime() - ms <= RECENT_WINDOW_MS;
}

function sessionAttention(session: RuntimeSession, stale: boolean): boolean {
  return stale
    || session.status === "lost"
    || session.status === "unknown";
}

function summaryHasOpenApproval(summary: RuntimeEvidenceSummary | undefined): boolean {
  return Boolean(summary?.evaluator_summary.approval_required_actions.some((action) =>
    action.status === "approval_required" || action.status === "blocked"
  ));
}

function summaryHasStructuredBlocker(summary: RuntimeEvidenceSummary | undefined): boolean {
  if (!summary) return false;
  return Boolean(
    summary.evaluator_summary.gap && summary.evaluator_summary.gap.kind !== "none"
  )
    || summary.evaluator_summary.observations.some((observation) =>
      observation.status === "blocked" || observation.validation?.status === "blocked"
    )
    || summary.recent_failed_attempts.length > 0
    || summary.failed_lineages.length > 0;
}

function runAttention(run: BackgroundRun, summary?: RuntimeEvidenceSummary): boolean {
  return run.status === "failed"
    || run.status === "timed_out"
    || run.status === "lost"
    || run.status === "unknown"
    || summaryHasOpenApproval(summary)
    || summaryHasStructuredBlocker(summary);
}

function runLifecycle(
  run: BackgroundRun | null,
  row: WorkDashboardRow,
  summary: RuntimeEvidenceSummary | undefined
): string {
  if (row.stale) return "stale";
  if (!run) return row.status;
  if (summaryHasOpenApproval(summary)) return "approval-required";
  if (summaryHasStructuredBlocker(summary)) return "blocked";
  if (run.status === "succeeded") return "completed";
  if (run.status === "failed" || run.status === "timed_out" || run.status === "lost" || run.status === "unknown") return "failed";
  return run.status;
}

function summarizeLiveness(row: WorkDashboardRow, health: RuntimeHealthSnapshot | null | undefined): string {
  const longRunning = health?.long_running;
  if (!longRunning) {
    if (row.stale) return "stale catalog heartbeat";
    return row.group === "active" ? "catalog current" : "not active";
  }
  const process = longRunning.signals.process.status;
  const logFreshness = longRunning.signals.log_freshness.status;
  const selected = row.stale ? "stale catalog heartbeat" : row.group === "active" ? "catalog current" : "not active";
  return `${selected}; daemon aggregate ${process}; logs ${logFreshness}; ${longRunning.summary}`;
}

function summarizeUsefulProgress(summary: RuntimeEvidenceSummary | undefined, health: RuntimeHealthSnapshot | null | undefined): string {
  const trend = summary?.metric_trends[0];
  if (trend) {
    return `${trend.metric_key} ${trend.trend}; latest ${trend.latest_value}; best ${trend.best_value}`;
  }
  const metricProgress = health?.long_running?.signals.metric_progress;
  if (metricProgress && metricProgress.status !== "unknown") {
    const metric = metricProgress.metric_name ? `${metricProgress.metric_name} ` : "";
    const values = typeof metricProgress.current_value === "number"
      ? ` current ${metricProgress.current_value}`
      : "";
    return `no selected metric progress evidence; daemon aggregate ${metric}${metricProgress.status}${values}`.trim();
  }
  return "no selected metric progress evidence";
}

function summarizeMode(summary: RuntimeEvidenceSummary | undefined): string {
  const phase = summary?.evaluator_summary.budgets.find((budget) => budget.phase)?.phase;
  if (phase) return phase;
  const portfolio = summary?.candidate_selection_summary.final_portfolio;
  if (portfolio && (portfolio.safe || portfolio.aggressive || portfolio.diverse)) return "finalization";
  if (
    summary?.candidate_selection_summary.robust_best
    || summary?.candidate_selection_summary.raw_best
    || (summary?.recommended_candidate_portfolio.length ?? 0) > 0
  ) {
    return "consolidation";
  }
  if (
    summary?.latest_strategy
    || (summary?.dream_checkpoints.length ?? 0) > 0
    || (summary?.divergent_exploration.length ?? 0) > 0
  ) {
    return "exploration";
  }
  return "unknown";
}

function summarizeMetrics(summary: RuntimeEvidenceSummary | undefined): string[] {
  if (!summary) return ["No metric evidence yet."];
  const trends = summary.metric_trends.slice(0, 3).map((trend) =>
    `${trend.metric_key}: latest ${trend.latest_value}, best ${trend.best_value}, ${trend.trend}`
  );
  if (trends.length > 0) return trends;
  const bestMetric = summary.best_evidence?.metrics.find((metric) => typeof metric.value === "number");
  return bestMetric ? [`${bestMetric.label}: ${bestMetric.value}`] : ["No metric evidence yet."];
}

function summarizeArtifacts(run: BackgroundRun | null, summary: RuntimeEvidenceSummary | undefined): string[] {
  const artifacts = [
    ...(run?.artifacts ?? []).map((artifact) => `${artifact.label}: ${artifact.path ?? artifact.url ?? artifact.kind}`),
    ...(summary?.artifact_retention.cleanup_plan.actions ?? []).map((artifact) =>
      `${artifact.label}: ${artifact.path ?? artifact.state_relative_path ?? artifact.url ?? artifact.kind}`
    ),
    ...(summary?.recent_entries ?? []).flatMap((entry) =>
      entry.artifacts.map((artifact) => `${artifact.label}: ${artifact.path ?? artifact.state_relative_path ?? artifact.url ?? artifact.kind}`)
    ),
  ];
  return [...new Set(artifacts)].slice(0, 4);
}

function summarizeEvents(run: BackgroundRun | null, summary: RuntimeEvidenceSummary | undefined): string[] {
  const events = [
    ...(run?.summary ? [run.summary] : []),
    ...(run?.error ? [run.error] : []),
    ...(summary?.recent_entries ?? []).map((entry) => entry.summary ?? `${entry.kind} ${entry.outcome}`),
  ];
  return events.filter(Boolean).slice(0, 4);
}

function summarizeBlockers(row: WorkDashboardRow, run: BackgroundRun | null, summary: RuntimeEvidenceSummary | undefined): string[] {
  const blockers: string[] = [];
  if (row.attention) blockers.push(row.status === "stale" ? "stale catalog state" : row.summary);
  if (
    run?.error
    && (row.attention || run.status === "failed" || run.status === "timed_out" || run.status === "lost" || run.status === "unknown")
  ) {
    blockers.push(run.error);
  }
  blockers.push(...(summary?.evaluator_summary.approval_required_actions ?? []).map((action) => action.label));
  if (summary?.evaluator_summary.gap && summary.evaluator_summary.gap.kind !== "none") {
    blockers.push(summary.evaluator_summary.gap.summary);
  }
  return [...new Set(blockers.filter(Boolean))].slice(0, 4);
}

function findRelatedRun(snapshot: RuntimeSessionRegistrySnapshot, row: WorkDashboardRow): BackgroundRun | null {
  if (row.kind === "run") return snapshot.background_runs.find((run) => run.id === row.id) ?? null;
  return snapshot.background_runs.find((run) =>
    run.child_session_id === row.id || run.parent_session_id === row.id || run.process_session_id === row.id
  ) ?? null;
}

export function buildOperatorConsoleModel(
  snapshot: RuntimeSessionRegistrySnapshot | null | undefined,
  health: RuntimeHealthSnapshot | null | undefined,
  evidenceSummaries: RuntimeEvidenceSummaryByRun = {},
  now: Date = new Date(),
): OperatorConsoleModel | null {
  const rows = buildWorkDashboardRows(snapshot, now, evidenceSummaries);
  if (!snapshot || rows.length === 0) return null;
  const selected = rows.find((row) => row.attention) ?? rows.find((row) => row.group === "active") ?? rows[0]!;
  const run = findRelatedRun(snapshot, selected);
  const summary = run ? evidenceSummaries[run.id] : undefined;
  const artifacts = summarizeArtifacts(run, summary);
  const latestEvents = summarizeEvents(run, summary);
  const blockers = summarizeBlockers(selected, run, summary);
  return {
    selectedId: selected.id,
    selectedTitle: selected.title,
    lifecycle: runLifecycle(run, selected, summary),
    liveness: summarizeLiveness(selected, health),
    usefulProgress: summarizeUsefulProgress(summary, health),
    currentMode: summarizeMode(summary),
    latestEvents: latestEvents.length > 0 ? latestEvents : ["No recent events or logs found."],
    artifacts: artifacts.length > 0 ? artifacts : ["No produced artifacts found."],
    metrics: summarizeMetrics(summary),
    blockers: blockers.length > 0 ? blockers : ["No blockers detected."],
    controls: [
      "inspect/pause/resume/finalize: available from natural-language chat when the selected run has a typed runtime bridge",
      "finalize/external actions: approval-gated; submit/publish/secret/production/destructive actions are not executed automatically",
    ],
  };
}

function compact(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export function buildWorkDashboardRows(
  snapshot: RuntimeSessionRegistrySnapshot | null | undefined,
  now: Date = new Date(),
  evidenceSummaries: RuntimeEvidenceSummaryByRun = {},
): WorkDashboardRow[] {
  if (!snapshot) return [];
  const rows: WorkDashboardRow[] = [];

  for (const session of snapshot.sessions) {
    const updatedAt = latestSessionTime(session);
    const stale = isStaleCurrent(updatedAt, now);
    const activeState = (session.status === "active" || session.status === "idle") && !stale;
    const recentState = !activeState && isRecent(updatedAt, now);
    if (!activeState && !recentState) continue;
    rows.push({
      kind: "session",
      group: activeState ? "active" : "recent",
      id: session.id,
      title: compact(session.title, session.id),
      status: stale ? "stale" : session.status,
      summary: session.attachable ? "attachable runtime session" : "runtime session",
      updatedAt,
      workspace: session.workspace,
      attention: sessionAttention(session, stale),
      stale,
    });
  }

  for (const run of snapshot.background_runs) {
    const updatedAt = latestRunTime(run);
    const stale = isStaleCurrent(updatedAt, now);
    const activeState = (run.status === "queued" || run.status === "running") && !stale;
    const terminalState = ["succeeded", "failed", "timed_out", "cancelled", "lost", "unknown"].includes(run.status);
    const recentState = !activeState && (terminalState || stale) && isRecent(updatedAt, now);
    if (!activeState && !recentState) continue;
    rows.push({
      kind: "run",
      group: activeState ? "active" : "recent",
      id: run.id,
      title: compact(run.title, run.id),
      status: stale ? "stale" : run.status,
      summary: compact(run.error ?? run.summary, run.kind),
      updatedAt,
      workspace: run.workspace,
      attention: runAttention(run, evidenceSummaries[run.id]) || stale,
      stale,
    });
  }

  return rows.sort((a, b) => {
    if (a.group !== b.group) return a.group === "active" ? -1 : 1;
    if (a.attention !== b.attention) return a.attention ? -1 : 1;
    return (timestampMs(b.updatedAt) ?? 0) - (timestampMs(a.updatedAt) ?? 0);
  });
}

export function statusLabel(status: string): string {
  switch (status) {
    case "idle":          return "Idle";
    case "running":       return "Running";
    case "completed":     return "Completed";
    case "stalled":       return "Stalled";
    case "max_iterations": return "Max iterations reached";
    case "error":         return "Error";
    case "stopped":       return "Stopped";
    default:              return status;
  }
}


function formatElapsed(startedAt: string): string {
  const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function DimensionRow({ dim }: { dim: DimensionProgress }) {
  const bar = renderBar(dim.progress);
  const pct = String(dim.progress).padStart(3, " ") + "%";
  // bar(20) + "  "(2) + "  "(2) + pct(4) + border/padding(4) = 32 fixed chars
  const termWidth = process.stdout.columns || 80;
  const labelWidth = Math.max(8, Math.min(32, termWidth - 32));
  const rawLabel = dim.displayName || dim.name;
  const truncated = rawLabel.length > labelWidth;
  const label = (truncated ? rawLabel.slice(0, labelWidth - 1) + "…" : rawLabel).padEnd(labelWidth, " ");
  const color = progressColor(dim.progress);
  return (
    <Box>
      <Text>{label}  </Text>
      <Text color={color}>{bar}</Text>
      <Text>  {pct}</Text>
    </Box>
  );
}

function formatUpdated(value: string | null): string {
  if (!value) return "unknown";
  return value.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function WorkRow({ row }: { row: WorkDashboardRow }) {
  const marker = row.attention ? "!" : row.group === "active" ? ">" : "-";
  const color = row.attention ? theme.warning : row.group === "active" ? theme.success : theme.text;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color}>
        {marker} {row.title} <Text dimColor>({row.kind}:{row.id})</Text>
      </Text>
      <Text>
        <Text dimColor>{"  "}{row.group} / </Text>
        <Text color={color}>{row.status}</Text>
        <Text dimColor>{" / updated "}{formatUpdated(row.updatedAt)}</Text>
      </Text>
      <Text dimColor>{"  "}{row.summary}</Text>
      {row.workspace && <Text dimColor>{"  "}{row.workspace}</Text>}
    </Box>
  );
}

function WorkDashboard({ rows }: { rows: WorkDashboardRow[] }) {
  const activeRows = rows.filter((row) => row.group === "active");
  const recentRows = rows.filter((row) => row.group === "recent").slice(0, 6);
  const attentionRows = rows.filter((row) => row.attention);
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} overflow="hidden">
      <Text bold color={theme.brand}>Work Dashboard</Text>
      <Text dimColor>
        Active {activeRows.length}  Recent {recentRows.length}  Attention {attentionRows.length}
      </Text>
      <Text> </Text>
      {attentionRows.length > 0 && (
        <>
          <Text color={theme.warning}>Attention needed</Text>
          {attentionRows.slice(0, 4).map((row) => <WorkRow key={`${row.kind}:${row.id}`} row={row} />)}
        </>
      )}
      <Text color={theme.success}>Active work</Text>
      {activeRows.length === 0 ? (
        <Text dimColor>{"  No active background work."}</Text>
      ) : (
        activeRows.slice(0, 6).map((row) => <WorkRow key={`${row.kind}:${row.id}`} row={row} />)
      )}
      <Text> </Text>
      <Text dimColor>Recent work</Text>
      {recentRows.length === 0 ? (
        <Text dimColor>{"  No recent background work."}</Text>
      ) : (
        recentRows.map((row) => <WorkRow key={`${row.kind}:${row.id}`} row={row} />)
      )}
    </Box>
  );
}

function OperatorConsole({ model }: { model: OperatorConsoleModel }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={theme.brand}>Operator Console</Text>
      <Text>
        <Text color={theme.success}>{model.selectedTitle}</Text>
        <Text dimColor>{"  "}{model.selectedId}</Text>
      </Text>
      <Text>
        <Text dimColor>Lifecycle </Text>
        <Text color={model.lifecycle === "failed" || model.lifecycle === "blocked" || model.lifecycle === "approval-required" ? theme.warning : theme.text}>
          {model.lifecycle}
        </Text>
      </Text>
      <Text>
        <Text dimColor>Liveness </Text>
        <Text>{model.liveness}</Text>
      </Text>
      <Text>
        <Text dimColor>Useful progress </Text>
        <Text>{model.usefulProgress}</Text>
      </Text>
      <Text>
        <Text dimColor>Mode </Text>
        <Text>{model.currentMode}</Text>
      </Text>
      <Text color={theme.warning}>Blockers</Text>
      {model.blockers.slice(0, 3).map((line, index) => <Text key={`blocker-${index}`} dimColor>{"  "}{line}</Text>)}
      <Text dimColor>Metrics</Text>
      {model.metrics.slice(0, 3).map((line, index) => <Text key={`metric-${index}`} dimColor>{"  "}{line}</Text>)}
      <Text dimColor>Recent events</Text>
      {model.latestEvents.slice(0, 3).map((line, index) => <Text key={`event-${index}`} dimColor>{"  "}{line}</Text>)}
      <Text dimColor>Artifacts</Text>
      {model.artifacts.slice(0, 3).map((line, index) => <Text key={`artifact-${index}`} dimColor>{"  "}{line}</Text>)}
      <Text dimColor>Controls</Text>
      {model.controls.map((line, index) => <Text key={`control-${index}`} dimColor>{"  "}{line}</Text>)}
    </Box>
  );
}

export function Dashboard({ state, runtimeSessions, runtimeHealth, evidenceSummaries }: DashboardProps) {
  const workRows = buildWorkDashboardRows(runtimeSessions, new Date(), evidenceSummaries);
  const operatorConsole = buildOperatorConsoleModel(runtimeSessions, runtimeHealth, evidenceSummaries);
  if (workRows.length > 0) {
    return (
      <Box flexDirection="column" overflow="hidden">
        <WorkDashboard rows={workRows} />
        {operatorConsole && <OperatorConsole model={operatorConsole} />}
      </Box>
    );
  }

  if (state.status === "idle") {
    return (
      <Box
        flexDirection="column"
        paddingX={1}
        paddingY={1}
        overflow="hidden"
      >
        <Text bold color={theme.brand}>
          🎯 PULSEED
        </Text>
        <Text> </Text>
        <Text color={theme.warning}>No active goal is running.</Text>
        <Text> </Text>
        <Text dimColor>Describe the outcome you want:</Text>
        <Text>
          {"  "}
          <Text color={theme.userPrefix}>"improve test coverage to 90%"</Text>
        </Text>
        <Text>
          {"  "}
          <Text color={theme.userPrefix}>"organize this project and tell me what to do next"</Text>
        </Text>
        <Text> </Text>
        <Text dimColor>
          {"Slash commands are optional. Type "}
          <Text color={theme.text}>/help</Text>
          {" for command details."}
        </Text>
      </Box>
    );
  }

  const goalLabel = state.goalId ?? "(unknown)";

  return (
    <Box flexDirection="column" paddingX={1} overflow="hidden">
      {/* Header */}
      <Box>
        <Text bold color={theme.brand}>
          PULSEED
        </Text>
        <Text>{"  goal: "}</Text>
        <Text bold>{goalLabel}</Text>
        <Text>{"  "}</Text>
        {state.status === "running" ? (
          <Text color={theme.success}>
            <CheckerboardSpinner />
            {" " + statusLabel("running")}
          </Text>
        ) : (
          <Text color={statusColor(state.status)}>{statusLabel(state.status)}</Text>
        )}
      </Box>

      {/* Separator */}
      <Box borderStyle="single" borderColor={theme.border} borderTop={false} borderLeft={false} borderRight={false} />

      {/* Stats row: iter, elapsed, last result */}
      {(state.running || state.iteration > 0) && (
        <Box flexDirection="column">
          <Text dimColor>
            Diagnostics: status {statusLabel(state.status)} | trust {state.trustScore >= 0 ? "+" : ""}
            {state.trustScore} | iter {state.iteration}
          </Text>
          <Box>
            <Text dimColor>{"Iter: "}</Text>
            <Text>{state.iteration}</Text>
            {state.startedAt && (
              <>
                <Text dimColor>{" │ Elapsed: "}</Text>
                <Text>{formatElapsed(state.startedAt)}</Text>
              </>
            )}
            {state.lastResult && (
              <>
                <Text dimColor>{" │ Last: "}</Text>
                <Text>{statusLabel(state.lastResult.finalStatus)}</Text>
              </>
            )}
          </Box>
        </Box>
      )}

      {/* Dimension progress bars */}
      {state.dimensions.length === 0 ? (
        <Text color={theme.border}>Loading dimensions...</Text>
      ) : (
        state.dimensions.map((dim) => (
          <DimensionRow key={dim.name} dim={dim} />
        ))
      )}

      {/* Error message */}
      {state.status === "error" && state.lastError && (
        <Text color={theme.error}>Error: {state.lastError}</Text>
      )}
    </Box>
  );
}
