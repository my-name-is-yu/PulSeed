import type { Goal } from "../base/types/goal.js";
import type { BackgroundRun, RuntimeSessionRegistrySnapshot } from "../runtime/session-registry/types.js";
import type {
  RuntimeBudgetDimensionStatus,
  RuntimeBudgetRecord,
  RuntimeBudgetStatus,
} from "../runtime/store/budget-store.js";

const UNKNOWN_BUDGET_QUANTITY = "unknown";

export interface RuntimeBudgetProjection {
  budget: RuntimeBudgetRecord;
  status: RuntimeBudgetStatus;
}

export interface RuntimeBudgetStatusProvider {
  status(budget: RuntimeBudgetRecord): RuntimeBudgetStatus;
}

export interface RuntimeBudgetSummaryOptions {
  diagnostic?: boolean;
  compact?: boolean;
}

export function createRuntimeBudgetProjections(
  store: RuntimeBudgetStatusProvider,
  budgets: RuntimeBudgetRecord[],
): RuntimeBudgetProjection[] {
  return budgets.map((budget) => ({
    budget,
    status: store.status(budget),
  }));
}

export function findLinkedRuntimeBudget(
  goal: Goal,
  budgets: RuntimeBudgetProjection[] | undefined,
  runtimeSnapshot?: RuntimeSessionRegistrySnapshot | null,
): RuntimeBudgetProjection | null {
  if (!budgets || budgets.length === 0) return null;
  const linkedRuns = findLinkedRuns(goal, runtimeSnapshot);
  const linkedRunIds = new Set(linkedRuns.map((run) => run.id));
  const activeRunIds = new Set(linkedRuns.filter((run) => run.status === "queued" || run.status === "running").map((run) => run.id));
  const scored = budgets
    .map((projection) => {
      const goalMatch = projection.budget.scope.goal_id === goal.id;
      const runId = projection.budget.scope.run_id;
      const runMatch = runId ? linkedRunIds.has(runId) : false;
      if (!goalMatch && !runMatch) return null;
      const score = (goalMatch ? 4 : 0) + (runMatch ? 2 : 0) + (runId && activeRunIds.has(runId) ? 1 : 0);
      return { projection, score };
    })
    .filter((candidate): candidate is { projection: RuntimeBudgetProjection; score: number } => candidate !== null)
    .sort((a, b) =>
      b.score - a.score
      || timestampValue(b.projection.budget.updated_at) - timestampValue(a.projection.budget.updated_at)
    );
  return scored[0]?.projection ?? null;
}

export function formatRuntimeBudgetSummary(
  projection: RuntimeBudgetProjection,
  options: RuntimeBudgetSummaryOptions = {},
): string {
  if (options.diagnostic) return formatDiagnosticRuntimeBudgetSummary(projection);
  const dimensions = projection.status.dimensions.map(formatPlainDimension);
  const shown = options.compact ? dimensions.slice(0, 2) : dimensions;
  const remainingCount = dimensions.length - shown.length;
  const dimensionSummary = shown.length > 0
    ? `${shown.join("; ")}${remainingCount > 0 ? `; ${remainingCount} more limit${remainingCount === 1 ? "" : "s"}` : ""}`
    : "no tracked limits";
  const notice = formatPlainBudgetNotice(projection.status);
  return `Budget: ${dimensionSummary}${notice ? `; ${notice}` : ""}`;
}

export function formatRuntimeBudgetDiagnosticCommand(projection: RuntimeBudgetProjection): string {
  return `pulseed runtime budget ${projection.budget.budget_id}`;
}

function formatDiagnosticRuntimeBudgetSummary(projection: RuntimeBudgetProjection): string {
  const dimensions = projection.status.dimensions
    .map((dimension) => {
      const actions = dimension.threshold_actions.length > 0
        ? ` actions=${dimension.threshold_actions.join(",")}`
        : "";
      return `${dimension.dimension}: used=${formatNumber(dimension.used)} remaining=${formatNumber(dimension.remaining)} limit=${formatNumber(dimension.limit)}${actions}`;
    })
    .join("; ");
  return `Budget: ${projection.budget.budget_id} (${projection.status.mode})${dimensions ? ` — ${dimensions}` : ""}`;
}

function findLinkedRuns(goal: Goal, runtimeSnapshot?: RuntimeSessionRegistrySnapshot | null): BackgroundRun[] {
  if (!runtimeSnapshot) return [];
  return runtimeSnapshot.background_runs.filter((run) => run.goal_id === goal.id);
}

function formatPlainBudgetNotice(status: RuntimeBudgetStatus): string | null {
  if (status.exhausted) return "budget spent";
  const notices: string[] = [];
  if (status.finalization_required) notices.push("finalization should start");
  if (status.handoff_required) notices.push("handoff needed");
  if (status.approval_required) notices.push("approval needed to continue");
  if (notices.length > 0) return notices.join("; ");
  if (status.mode === "finalization") return "finalization phase";
  if (status.mode === "consolidation") return "consolidation phase";
  return null;
}

function formatPlainDimension(dimension: RuntimeBudgetDimensionStatus): string {
  if (dimension.dimension === "wall_clock_ms") {
    return `${formatDuration(dimension.used)} of ${formatDuration(dimension.limit)} used (${formatDuration(dimension.remaining)} left)`;
  }
  if (dimension.dimension === "process_ms") {
    return `${formatDuration(dimension.used)} of ${formatDuration(dimension.limit)} process time used (${formatDuration(dimension.remaining)} left)`;
  }
  if (dimension.dimension === "disk_bytes") {
    return `${formatBytes(dimension.used)} of ${formatBytes(dimension.limit)} used (${formatBytes(dimension.remaining)} left)`;
  }
  const label = dimensionLabel(dimension.dimension);
  return `${formatNumber(dimension.used)} of ${formatNumber(dimension.limit)} ${label} used (${formatNumber(dimension.remaining)} left)`;
}

function dimensionLabel(dimension: RuntimeBudgetDimensionStatus["dimension"]): string {
  return {
    iterations: "iterations",
    tasks: "tasks",
    artifacts: "artifacts",
    llm_tokens: "LLM tokens",
    tool_calls: "tool calls",
    evaluator_attempts: "evaluator attempts",
    wall_clock_ms: "wall-clock time",
    process_ms: "process time",
    disk_bytes: "disk",
  }[dimension];
}

function formatDuration(ms: number): string {
  const normalizedMs = normalizeBudgetDisplayNumber(ms);
  if (normalizedMs === null) return UNKNOWN_BUDGET_QUANTITY;
  if (normalizedMs < 1_000) return `${formatNumber(normalizedMs)}ms`;
  const seconds = normalizedMs / 1_000;
  if (seconds < 60) return `${formatRounded(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${formatRounded(minutes)}m`;
  const hours = minutes / 60;
  return `${formatRounded(hours)}h`;
}

function formatBytes(bytes: number): string {
  const normalizedBytes = normalizeBudgetDisplayNumber(bytes);
  if (normalizedBytes === null) return UNKNOWN_BUDGET_QUANTITY;
  if (normalizedBytes < 1024) return `${formatNumber(normalizedBytes)}B`;
  const kib = normalizedBytes / 1024;
  if (kib < 1024) return `${formatRounded(kib)}KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${formatRounded(mib)}MiB`;
  return `${formatRounded(mib / 1024)}GiB`;
}

function formatNumber(value: number): string {
  const normalizedValue = normalizeBudgetDisplayNumber(value);
  if (normalizedValue === null) return UNKNOWN_BUDGET_QUANTITY;
  return Number.isInteger(normalizedValue) ? String(normalizedValue) : formatRounded(normalizedValue);
}

function formatRounded(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function normalizeBudgetDisplayNumber(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (value < 0) return null;
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) return null;
  return value;
}

function timestampValue(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
