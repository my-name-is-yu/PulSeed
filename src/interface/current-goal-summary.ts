import type { Goal } from "../base/types/goal.js";
import type { BackgroundRun, RuntimeSessionRegistrySnapshot } from "../runtime/session-registry/types.js";
import type { RuntimeOperatorHandoffRecord } from "../runtime/store/operator-handoff-store.js";

type GoalSummarySurface = "full" | "compact";

export interface CurrentGoalSummaryOptions {
  runtimeSnapshot?: RuntimeSessionRegistrySnapshot | null;
  handoffs?: RuntimeOperatorHandoffRecord[];
  surface?: GoalSummarySurface;
}

const ACTIVE_RUN_STATUSES = new Set<BackgroundRun["status"]>(["queued", "running"]);
const ATTENTION_RUN_STATUSES = new Set<BackgroundRun["status"]>(["failed", "timed_out", "lost", "unknown"]);

export function isCurrentGoalCandidate(goal: Goal): boolean {
  return goal.status !== "archived" && goal.status !== "cancelled" && goal.status !== "abandoned";
}

export function formatCurrentGoalSummary(goal: Goal, options: CurrentGoalSummaryOptions = {}): string {
  const projection = buildCurrentGoalProjection(goal, options);
  return options.surface === "compact"
    ? formatCompactCurrentGoalProjection(projection)
    : formatFullCurrentGoalProjection(projection);
}

export function formatCurrentGoalChoiceList(goals: Goal[], options: CurrentGoalSummaryOptions = {}): string {
  if (goals.length === 0) return "No active goals found.";
  if (options.surface === "compact") {
    return [
      "Current goals:",
      goals.map((goal, index) => {
        const projection = buildCurrentGoalProjection(goal, options);
        const attention = projection.blocker ? "; attention needed" : "";
        return `${index + 1}. ${projection.title} (${projection.state}${attention})`;
      }).join(" · "),
    ].join(" ");
  }
  return [
    "Current goals:",
    ...goals.map((goal, index) => {
      const projection = buildCurrentGoalProjection(goal, options);
      const parts = [
        `${index + 1}. ${projection.title}`,
        `State: ${projection.state}`,
        projection.background ? `Background: ${projection.background}` : null,
        projection.blocker ? `Needs attention: ${projection.blocker}` : null,
        `Next: ${projection.nextAction}`,
      ].filter((part): part is string => Boolean(part));
      return parts.join("\n   ");
    }),
  ].join("\n");
}

interface CurrentGoalProjection {
  title: string;
  state: string;
  updated: string;
  children: number;
  background: string | null;
  blocker: string | null;
  nextAction: string;
}

function buildCurrentGoalProjection(goal: Goal, options: CurrentGoalSummaryOptions): CurrentGoalProjection {
  const linkedRuns = findLinkedRuns(goal, options.runtimeSnapshot);
  const primaryRun = linkedRuns[0] ?? null;
  const handoff = findLinkedHandoff(goal, primaryRun, options.handoffs ?? []);
  const background = primaryRun ? formatBackgroundRun(primaryRun) : null;
  const blocker = handoff
    ? `${handoff.title}: ${handoff.recommended_action}`
    : primaryRun && ATTENTION_RUN_STATUSES.has(primaryRun.status)
      ? primaryRun.error ?? `Background work needs attention (${primaryRun.status})`
      : null;

  return {
    title: goal.title,
    state: formatGoalState(goal),
    updated: goal.updated_at || "unknown",
    children: goal.children_ids.length,
    background,
    blocker,
    nextAction: chooseNextAction(goal, primaryRun, handoff),
  };
}

function formatFullCurrentGoalProjection(projection: CurrentGoalProjection): string {
  const lines = [
    "Current goal",
    `- Goal: ${projection.title}`,
    `- State: ${projection.state}`,
    `- Last update: ${projection.updated}`,
    `- Children: ${projection.children}`,
  ];
  if (projection.background) lines.push(`- Background work: ${projection.background}`);
  if (projection.blocker) lines.push(`- Needs attention: ${projection.blocker}`);
  lines.push(`- Next safe action: ${projection.nextAction}`);
  return lines.join("\n");
}

function formatCompactCurrentGoalProjection(projection: CurrentGoalProjection): string {
  const parts = [`Current: ${projection.title}`, projection.state];
  if (projection.background) parts.push(projection.background);
  if (projection.blocker) parts.push(`attention: ${projection.blocker}`);
  return parts.join(" · ");
}

function formatGoalState(goal: Goal): string {
  const loop = goal.loop_status && goal.loop_status !== "idle" ? `; loop ${goal.loop_status}` : "";
  return `${goal.status}${loop}`;
}

function findLinkedRuns(goal: Goal, snapshot?: RuntimeSessionRegistrySnapshot | null): BackgroundRun[] {
  if (!snapshot) return [];
  return snapshot.background_runs
    .filter((run) => run.goal_id === goal.id)
    .filter((run) => ACTIVE_RUN_STATUSES.has(run.status) || ATTENTION_RUN_STATUSES.has(run.status))
    .sort(compareRunsByRelevance);
}

function compareRunsByRelevance(a: BackgroundRun, b: BackgroundRun): number {
  const aActive = ACTIVE_RUN_STATUSES.has(a.status);
  const bActive = ACTIVE_RUN_STATUSES.has(b.status);
  if (aActive !== bActive) return aActive ? -1 : 1;
  return timestampValue(b.updated_at ?? b.started_at ?? b.created_at) - timestampValue(a.updated_at ?? a.started_at ?? a.created_at);
}

function findLinkedHandoff(
  goal: Goal,
  run: BackgroundRun | null,
  handoffs: RuntimeOperatorHandoffRecord[]
): RuntimeOperatorHandoffRecord | null {
  return handoffs.find((handoff) =>
    handoff.status === "open"
    && (handoff.goal_id === goal.id || (run && handoff.run_id === run.id))
  ) ?? null;
}

function formatBackgroundRun(run: BackgroundRun): string {
  const updated = run.updated_at ?? run.started_at ?? run.created_at ?? "unknown";
  const title = run.title ? ` ${run.title}` : "";
  return `${run.id}${title} is ${run.status}; updated ${updated}`;
}

function chooseNextAction(
  goal: Goal,
  run: BackgroundRun | null,
  handoff: RuntimeOperatorHandoffRecord | null
): string {
  if (handoff) return handoff.next_action.label;
  if (run && ACTIVE_RUN_STATUSES.has(run.status)) {
    return "Ask for progress here, or wait for the background work to update.";
  }
  if (run && ATTENTION_RUN_STATUSES.has(run.status)) {
    return "Inspect the background work before retrying.";
  }
  if (goal.status === "completed") return "Review the result or start a new goal.";
  if (goal.status === "archived" || goal.status === "cancelled" || goal.status === "abandoned") {
    return "Restore or create a new goal before continuing.";
  }
  return "Describe the next outcome you want for this goal.";
}

function timestampValue(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
