import { randomUUID } from "node:crypto";
import {
  SoilCandidateSchema,
  SoilCompileMissObservationSchema,
  SoilContextRouteSchema,
  SoilMemoryLifecycleStateSchema,
  SoilRetrievalTraceSchema,
  type SoilCandidate,
  type SoilCompileMissObservation,
  type SoilContextRoute,
  type SoilContextRouteInput,
  type SoilMemoryLifecycleState,
  type SoilRecord,
  type SoilRecordStatus,
  type SoilSearchRepository,
  type SoilRetrievalDecision,
  type SoilRetrievalTrace,
} from "./contracts.js";

export interface SoilRouteTargetState {
  recordId?: string;
  soilId?: string;
  isActive: boolean;
  status?: SoilRecordStatus;
  lifecycleState?: SoilMemoryLifecycleState;
}

export interface SoilContextCompilerRepository {
  loadRecords: SoilSearchRepository["loadRecords"];
  recordUsage?: (recordIds: string[], input?: { used_at?: string }) => Promise<void>;
}

export interface SoilContextCompilerInput {
  routes?: SoilContextRouteInput[];
  targetPaths?: string[];
  goalId?: string | null;
  taskId?: string | null;
  taskCategory?: string | null;
  phase?: string | null;
  fallbackQuery?: string | null;
  fallbackCandidates?: SoilCandidate[];
  includeFallbackWhenRouteMatched?: boolean;
  minFallbackScore?: number;
  maxFallbackAdmitted?: number;
  routeTargetStates?: SoilRouteTargetState[];
  staleRouteAfterMs?: number;
  now?: () => Date;
  retrievalId?: string;
}

export interface SoilCompiledContextItem {
  soilId: string | null;
  recordId: string | null;
  routeId: string | null;
  source: "route" | "fallback";
  reason: string;
  score: number | null;
  candidate?: SoilCandidate;
}

export interface SoilCompiledContext {
  items: SoilCompiledContextItem[];
  trace: SoilRetrievalTrace;
  compileMissObservations: SoilCompileMissObservation[];
  warnings: string[];
}

const DEFAULT_MIN_FALLBACK_SCORE = 0.2;
const DEFAULT_MAX_FALLBACK_ADMITTED = 3;
const DEFAULT_STALE_ROUTE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const EXCLUDED_ROUTE_RECORD_STATUSES = new Set<SoilRecordStatus>([
  "archived",
  "deleted",
  "expired",
  "rejected",
  "superseded",
  "corrected",
  "retracted",
  "forgotten",
  "quarantined",
]);

function nowIso(now?: () => Date): string {
  return (now?.() ?? new Date()).toISOString();
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globMatches(glob: string, value: string): boolean {
  const normalizedGlob = normalizePath(glob);
  const normalizedValue = normalizePath(value);
  const pattern = `^${normalizedGlob.split("*").map((part) => escapeRegex(part)).join(".*")}$`;
  return new RegExp(pattern).test(normalizedValue);
}

function routeMatches(route: SoilContextRoute, input: SoilContextCompilerInput): boolean {
  if (route.status !== "active") return false;
  if (route.path_globs.length > 0) {
    const paths = input.targetPaths ?? [];
    if (paths.length === 0 || !paths.some((targetPath) => route.path_globs.some((glob) => globMatches(glob, targetPath)))) {
      return false;
    }
  }
  if (route.goal_ids.length > 0 && (!input.goalId || !route.goal_ids.includes(input.goalId))) {
    return false;
  }
  if (route.task_categories.length > 0 && (!input.taskCategory || !route.task_categories.includes(input.taskCategory))) {
    return false;
  }
  if (route.phases.length > 0 && (!input.phase || !route.phases.includes(input.phase))) {
    return false;
  }
  return route.soil_ids.length > 0 || route.record_ids.length > 0;
}

function metadataString(candidate: SoilCandidate, key: string): string | null {
  const value = candidate.metadata_json[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function metadataLifecycleState(candidate: SoilCandidate): SoilMemoryLifecycleState | null {
  const value = metadataString(candidate, "lifecycle_state");
  const parsed = SoilMemoryLifecycleStateSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return null;
}

function fallbackRejectionReason(candidate: SoilCandidate, minScore: number): string | null {
  const lifecycleState = metadataLifecycleState(candidate);
  if (lifecycleState && lifecycleState !== "active") {
    return `lifecycle state ${lifecycleState} is excluded from default context`;
  }
  const recordStatus = metadataString(candidate, "status");
  if (recordStatus && [
    "archived",
    "corrected",
    "deleted",
    "expired",
    "forgotten",
    "quarantined",
    "rejected",
    "retracted",
    "superseded",
  ].includes(recordStatus)) {
    return `record status ${recordStatus} is excluded from default context`;
  }
  if (candidate.metadata_json["schema_compatible"] === false) {
    return "schema is incompatible with default context";
  }
  const exactMatch = candidate.metadata_json["exact_metadata_match"] === true || candidate.metadata_json["exact_source_match"] === true;
  if (!exactMatch && candidate.score < minScore) {
    return `score ${candidate.score} is below fallback admission threshold ${minScore}`;
  }
  return null;
}

function routeTargetStateKey(kind: "record" | "soil", id: string): string {
  return JSON.stringify([kind, id]);
}

function routeTargetStateIndex(states: SoilRouteTargetState[] = []): Map<string, SoilRouteTargetState> {
  const index = new Map<string, SoilRouteTargetState>();
  for (const state of states) {
    if (state.recordId) index.set(routeTargetStateKey("record", state.recordId), state);
    if (state.soilId) index.set(routeTargetStateKey("soil", state.soilId), state);
  }
  return index;
}

function routeIdsForStateLookup(routes: SoilContextRouteInput[] = []): {
  recordIds: string[];
  soilIds: string[];
} {
  const recordIds = new Set<string>();
  const soilIds = new Set<string>();
  for (const route of routes) {
    for (const recordId of route.record_ids ?? []) recordIds.add(recordId);
    for (const soilId of route.soil_ids ?? []) soilIds.add(soilId);
  }
  return { recordIds: [...recordIds], soilIds: [...soilIds] };
}

function routeTargetStatesForRecords(records: SoilRecord[]): SoilRouteTargetState[] {
  const states: SoilRouteTargetState[] = records.map((record) => ({
    recordId: record.record_id,
    soilId: record.soil_id,
    isActive: record.is_active,
    status: record.status,
    lifecycleState: record.is_active ? "active" : "tombstoned",
  }));
  const recordsBySoilId = new Map<string, SoilRecord[]>();
  for (const record of records) {
    const recordsForSoil = recordsBySoilId.get(record.soil_id) ?? [];
    recordsForSoil.push(record);
    recordsBySoilId.set(record.soil_id, recordsForSoil);
  }
  for (const [soilId, recordsForSoil] of recordsBySoilId) {
    const activeRecord = recordsForSoil.find((record) =>
      record.is_active && routeTargetRejectionReason({
        soilId,
        isActive: true,
        status: record.status,
        lifecycleState: "active",
      }) === null
    );
    const representative = activeRecord ?? recordsForSoil[0];
    states.push({
      recordId: representative?.record_id,
      soilId,
      isActive: Boolean(activeRecord),
      status: representative?.status,
      lifecycleState: activeRecord ? "active" : "tombstoned",
    });
  }
  return states;
}

function routeTargetRejectionReason(state: SoilRouteTargetState | undefined): string | null {
  if (!state) return "route target state is unknown and excluded from default context";
  if (!state.isActive) return "route target is inactive and excluded from default context";
  if (state.lifecycleState && state.lifecycleState !== "active") {
    return `route target lifecycle state ${state.lifecycleState} is excluded from default context`;
  }
  if (state.status && EXCLUDED_ROUTE_RECORD_STATUSES.has(state.status)) {
    return `route target record status ${state.status} is excluded from default context`;
  }
  return null;
}

function dedupeItems(items: SoilCompiledContextItem[]): SoilCompiledContextItem[] {
  const seen = new Set<string>();
  const deduped: SoilCompiledContextItem[] = [];
  for (const item of items) {
    const key = `${item.source}:${item.routeId ?? ""}:${item.soilId ?? ""}:${item.recordId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function routeStaleWarning(route: SoilContextRoute, timestamp: string, staleAfterMs: number): string | null {
  if (route.last_evaluation_result === "failed") {
    return `Route ${route.route_id} last evaluation failed; verify routed context before relying on it.`;
  }
  if (route.last_evaluated_at === null) {
    return null;
  }
  const evaluatedAt = Date.parse(route.last_evaluated_at);
  const compiledAt = Date.parse(timestamp);
  if (Number.isNaN(evaluatedAt) || Number.isNaN(compiledAt)) {
    return null;
  }
  if (compiledAt - evaluatedAt > staleAfterMs) {
    return `Route ${route.route_id} has not been evaluated since ${route.last_evaluated_at}.`;
  }
  return null;
}

interface RouteSelectionResult {
  routes: SoilContextRoute[];
  decisions: SoilRetrievalDecision[];
}

function selectMatchingRoutes(input: SoilContextCompilerInput): RouteSelectionResult {
  const decisions: SoilRetrievalDecision[] = [];
  const routes = (input.routes ?? [])
    .map((route) => SoilContextRouteSchema.parse(route))
    .filter((route) => {
      const matched = routeMatches(route, input);
      if (!matched && route.status !== "active") {
        decisions.push({
          candidate_id: `route:${route.route_id}`,
          decision: "rejected",
          reason: `route status ${route.status} is excluded from default context`,
          score: null,
          soil_id: null,
          record_id: null,
          route_id: route.route_id,
        });
      }
      return matched;
    })
    .sort((left, right) => right.priority - left.priority || left.route_id.localeCompare(right.route_id));
  return { routes, decisions };
}

function compileRouteItems(
  routes: SoilContextRoute[],
  timestamp: string,
  staleAfterMs: number,
  targetStates: Map<string, SoilRouteTargetState>
): {
  warnings: string[];
  decisions: SoilRetrievalDecision[];
  items: SoilCompiledContextItem[];
} {
  const warnings: string[] = [];
  const decisions: SoilRetrievalDecision[] = [];
  const items: SoilCompiledContextItem[] = [];

  for (const route of routes) {
    const staleWarning = routeStaleWarning(route, timestamp, staleAfterMs);
    if (staleWarning) {
      warnings.push(staleWarning);
    }
    for (const soilId of route.soil_ids) {
      const targetState = targetStates.get(routeTargetStateKey("soil", soilId));
      const rejectionReason = routeTargetRejectionReason(targetState);
      if (rejectionReason) {
        warnings.push(`Route ${route.route_id} target ${soilId} was rejected: ${rejectionReason}.`);
        decisions.push({
          candidate_id: `route:${route.route_id}:soil:${soilId}`,
          decision: "rejected",
          reason: rejectionReason,
          score: null,
          soil_id: soilId,
          record_id: null,
          route_id: route.route_id,
        });
        continue;
      }
      decisions.push({
        candidate_id: `route:${route.route_id}:soil:${soilId}`,
        decision: "routed",
        reason: route.reason,
        score: null,
        soil_id: soilId,
        record_id: targetState?.recordId ?? null,
        route_id: route.route_id,
      });
      items.push({
        soilId,
        recordId: targetState?.recordId ?? null,
        routeId: route.route_id,
        source: "route",
        reason: route.reason,
        score: null,
      });
    }
    for (const recordId of route.record_ids) {
      const rejectionReason = routeTargetRejectionReason(targetStates.get(routeTargetStateKey("record", recordId)));
      if (rejectionReason) {
        warnings.push(`Route ${route.route_id} target ${recordId} was rejected: ${rejectionReason}.`);
        decisions.push({
          candidate_id: `route:${route.route_id}:record:${recordId}`,
          decision: "rejected",
          reason: rejectionReason,
          score: null,
          soil_id: null,
          record_id: recordId,
          route_id: route.route_id,
        });
        continue;
      }
      decisions.push({
        candidate_id: `route:${route.route_id}:record:${recordId}`,
        decision: "routed",
        reason: route.reason,
        score: null,
        soil_id: null,
        record_id: recordId,
        route_id: route.route_id,
      });
      items.push({
        soilId: null,
        recordId,
        routeId: route.route_id,
        source: "route",
        reason: route.reason,
        score: null,
      });
    }
  }

  return { warnings, decisions, items };
}

function fallbackCandidatesFor(input: SoilContextCompilerInput, routes: SoilContextRoute[]): SoilCandidate[] {
  const shouldEvaluateFallback = routes.length === 0 || input.includeFallbackWhenRouteMatched === true;
  if (!shouldEvaluateFallback) {
    return [];
  }
  return (input.fallbackCandidates ?? []).map((candidate) => SoilCandidateSchema.parse(candidate));
}

function compileFallbackItems(
  fallbackCandidates: SoilCandidate[],
  minScore: number,
  maxFallbackAdmitted: number
): {
  decisions: SoilRetrievalDecision[];
  items: SoilCompiledContextItem[];
  admittedFallbackCount: number;
} {
  const decisions: SoilRetrievalDecision[] = [];
  const items: SoilCompiledContextItem[] = [];
  let admittedFallbackCount = 0;

  for (const candidate of fallbackCandidates) {
    const candidateId = `candidate:${candidate.chunk_id}`;
    const rejectionReason = fallbackRejectionReason(candidate, minScore);
    if (rejectionReason || admittedFallbackCount >= maxFallbackAdmitted) {
      decisions.push({
        candidate_id: candidateId,
        decision: "rejected",
        reason: rejectionReason ?? `fallback admission cap ${maxFallbackAdmitted} reached`,
        score: candidate.score,
        soil_id: candidate.soil_id,
        record_id: candidate.record_id,
        route_id: null,
      });
      continue;
    }

    const reason = `fallback search admitted ${candidate.lane} candidate with score ${candidate.score}`;
    decisions.push({
      candidate_id: candidateId,
      decision: "admitted",
      reason,
      score: candidate.score,
      soil_id: candidate.soil_id,
      record_id: candidate.record_id,
      route_id: null,
    });
    items.push({
      soilId: candidate.soil_id,
      recordId: candidate.record_id,
      routeId: null,
      source: "fallback",
      reason,
      score: candidate.score,
      candidate,
    });
    admittedFallbackCount += 1;
  }

  return { decisions, items, admittedFallbackCount };
}

function buildRetrievalTrace(input: {
  source: SoilContextCompilerInput;
  retrievalId: string;
  timestamp: string;
  decisions: SoilRetrievalDecision[];
  warnings: string[];
}): SoilRetrievalTrace {
  return SoilRetrievalTraceSchema.parse({
    retrieval_id: input.retrievalId,
    timestamp: input.timestamp,
    task_id: input.source.taskId ?? null,
    goal_id: input.source.goalId ?? null,
    phase: input.source.phase ?? null,
    task_category: input.source.taskCategory ?? null,
    target_paths: input.source.targetPaths ?? [],
    fallback_query: input.source.fallbackQuery ?? null,
    decisions: input.decisions,
    warnings: input.warnings,
  });
}

function compileMissObservationsFor(input: {
  source: SoilContextCompilerInput;
  routes: SoilContextRoute[];
  fallbackCandidates: SoilCandidate[];
  admittedFallbackCount: number;
  rejectedCandidateIds: string[];
  retrievalId: string;
  timestamp: string;
}): SoilCompileMissObservation[] {
  if (input.routes.length > 0) {
    return [];
  }
  return [
    SoilCompileMissObservationSchema.parse({
      observation_id: `${input.retrievalId}:compile-miss:no-route`,
      retrieval_id: input.retrievalId,
      reason: input.fallbackCandidates.length > 0 && input.admittedFallbackCount === 0 ? "low_confidence_search" : "no_route",
      target_paths: input.source.targetPaths ?? [],
      route_ids: [],
      rejected_candidate_ids: input.rejectedCandidateIds,
      created_at: input.timestamp,
      notes: input.fallbackCandidates.length > 0
        ? "No active context route matched; fallback candidates were evaluated with the admission gate."
        : "No active context route matched and no fallback candidates were available.",
    }),
  ];
}

export function compileSoilContext(input: SoilContextCompilerInput): SoilCompiledContext {
  const timestamp = nowIso(input.now);
  const retrievalId = input.retrievalId ?? `soil-retrieval:${randomUUID()}`;
  const routeSelection = selectMatchingRoutes(input);
  const routeCompilation = compileRouteItems(
    routeSelection.routes,
    timestamp,
    input.staleRouteAfterMs ?? DEFAULT_STALE_ROUTE_AFTER_MS,
    routeTargetStateIndex(input.routeTargetStates)
  );
  const fallbackCandidates = fallbackCandidatesFor(input, routeSelection.routes);

  const warnings = [...routeCompilation.warnings];
  if (routeSelection.routes.length === 0 && input.fallbackQuery) {
    warnings.push("No active context route matched; fallback search candidates were evaluated.");
  }

  const minScore = input.minFallbackScore ?? DEFAULT_MIN_FALLBACK_SCORE;
  const maxFallbackAdmitted = input.maxFallbackAdmitted ?? DEFAULT_MAX_FALLBACK_ADMITTED;
  const fallbackCompilation = compileFallbackItems(fallbackCandidates, minScore, maxFallbackAdmitted);
  const decisions = [
    ...routeSelection.decisions,
    ...routeCompilation.decisions,
    ...fallbackCompilation.decisions,
  ];
  const items = [...routeCompilation.items, ...fallbackCompilation.items];

  const trace = buildRetrievalTrace({
    source: input,
    retrievalId,
    timestamp,
    decisions,
    warnings,
  });
  const rejectedCandidateIds = decisions
    .filter((decision) => decision.decision === "rejected" && decision.candidate_id.startsWith("candidate:"))
    .map((decision) => decision.candidate_id);
  const compileMissObservations = compileMissObservationsFor({
    source: input,
    routes: routeSelection.routes,
    fallbackCandidates,
    admittedFallbackCount: fallbackCompilation.admittedFallbackCount,
    rejectedCandidateIds,
    retrievalId,
    timestamp,
  });

  return {
    items: dedupeItems(items),
    trace,
    compileMissObservations,
    warnings,
  };
}

export async function compileSoilContextFromRepository(
  input: SoilContextCompilerInput,
  repository: SoilContextCompilerRepository
): Promise<SoilCompiledContext> {
  const { recordIds, soilIds } = routeIdsForStateLookup(input.routes);
  const recordsById = recordIds.length > 0
    ? await repository.loadRecords({
        active_only: false,
        record_ids: recordIds,
      })
    : [];
  const recordsBySoilId = soilIds.length > 0
    ? await repository.loadRecords({
        active_only: false,
        soil_ids: soilIds,
      })
    : [];
  const compiled = compileSoilContext({
    ...input,
    routeTargetStates: [
      ...(input.routeTargetStates ?? []),
      ...routeTargetStatesForRecords([...recordsById, ...recordsBySoilId]),
    ],
  });
  const admittedRecordIds = [...new Set(compiled.items
    .map((item) => item.recordId)
    .filter((recordId): recordId is string => recordId !== null))];
  if (admittedRecordIds.length > 0) {
    await repository.recordUsage?.(admittedRecordIds, { used_at: compiled.trace.timestamp });
  }
  return compiled;
}
