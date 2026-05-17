import { createHash } from "node:crypto";
import {
  createRuntimeControlDatabaseOwner,
  type ControlDatabase,
  type ControlDatabaseHandleOwner,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import {
  RuntimeEventEnvelopeSchema,
  appendRuntimeEventEnvelopeInTransaction,
  runtimeEventFromExperienceLearningPayload,
  type RuntimeEventAppendResult,
} from "./runtime-event-log.js";
import {
  CandidateTransitionSchema,
  ExperienceFrameSchema,
  ExperimentRecordSchema,
  ExperimentValueOutcomeSchema,
  ExperienceLearningProjectionProposalSchema,
  GeneralizationCandidateSchema,
  LearningArtifactSchema,
  LearningExperimentPlanSchema,
  LearningHypothesisSchema,
  LearningPriorConsumptionRecordSchema,
  LearningPriorSnapshotSchema,
  LearningConsumerPhaseSchema,
  EXPERIENCE_LEARNING_BASELINE_RUN_KINDS,
  EXPERIENCE_LEARNING_BASELINE_SCENARIO_CLASSES,
  EXPERIENCE_LEARNING_METRIC_DEFINITIONS,
  ExperienceLearningMetricBaselineObservationSchema,
  ExperienceLearningMetricsSnapshotSchema,
  LearningPriorPhaseProjectionSchema,
  LearningPriorResolver,
  LearningScopeSchema,
  MicroProbePlanSchema,
  MicroProbeRecordSchema,
  TrialReuseBudgetConsumptionRecordSchema,
  TrialReuseReadinessGateSchema,
  ExperienceLearningRuntimeEventPayloadSchema,
  type CandidateTransition,
  type ExperienceFrame,
  type ExperimentRecord,
  type ExperimentValueOutcome,
  type ExperienceLearningProjectionProposal,
  type GeneralizationCandidate,
  type LearningArtifact,
  type LearningExperimentPlan,
  type LearningHypothesis,
  type LearningPriorConsumptionRecord,
  type LearningPriorConsumptionReasonCode,
  type LearningPriorPhaseProjection,
  type LearningPriorSnapshot,
  type LearningConsumerPhase,
  type ExperienceLearningMetricBaselineObservation,
  type ExperienceLearningMetricName,
  type ExperienceLearningMetricScenarioClass,
  type ExperienceLearningMetricValidity,
  type ExperienceLearningMetricsSnapshot,
  type LearningScope,
  type MicroProbePlan,
  type MicroProbeRecord,
  type TrialReuseBudgetConsumptionRecord,
  type TrialReuseReadinessGate,
  type ExperienceLearningRuntimeEventPayload,
} from "../learning/index.js";

export const CONTROL_DB_EXPERIENCE_LEARNING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS experience_learning_frames (
  frame_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  run_id TEXT,
  loop_index INTEGER,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  frame_json TEXT NOT NULL CHECK (json_valid(frame_json))
);

CREATE INDEX IF NOT EXISTS experience_learning_frames_goal_idx
  ON experience_learning_frames(goal_id, run_id, loop_index, created_at, frame_id);

CREATE TABLE IF NOT EXISTS experience_learning_hypotheses (
  hypothesis_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  run_id TEXT,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  hypothesis_json TEXT NOT NULL CHECK (json_valid(hypothesis_json))
);

CREATE INDEX IF NOT EXISTS experience_learning_hypotheses_goal_idx
  ON experience_learning_hypotheses(goal_id, run_id, status, updated_at, hypothesis_id);

CREATE TABLE IF NOT EXISTS experience_learning_hypothesis_events (
  event_id TEXT PRIMARY KEY,
  hypothesis_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK (json_valid(event_json))
);

CREATE INDEX IF NOT EXISTS experience_learning_hypothesis_events_hypothesis_idx
  ON experience_learning_hypothesis_events(hypothesis_id, occurred_at, event_id);

CREATE TABLE IF NOT EXISTS experience_learning_generalization_candidates (
  candidate_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  run_id TEXT,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  candidate_json TEXT NOT NULL CHECK (json_valid(candidate_json))
);

CREATE INDEX IF NOT EXISTS experience_learning_generalization_candidates_goal_idx
  ON experience_learning_generalization_candidates(goal_id, run_id, status, updated_at, candidate_id);

CREATE TABLE IF NOT EXISTS experience_learning_generalization_events (
  event_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK (json_valid(event_json))
);

CREATE INDEX IF NOT EXISTS experience_learning_generalization_events_candidate_idx
  ON experience_learning_generalization_events(candidate_id, occurred_at, event_id);

CREATE TABLE IF NOT EXISTS experience_learning_trial_reuse_readiness_gates (
  gate_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  eligible_from_iteration INTEGER NOT NULL,
  remaining_trial_uses INTEGER NOT NULL,
  gate_json TEXT NOT NULL CHECK (json_valid(gate_json))
);

CREATE INDEX IF NOT EXISTS experience_learning_trial_reuse_readiness_gates_candidate_idx
  ON experience_learning_trial_reuse_readiness_gates(candidate_id, decision, eligible_from_iteration, gate_id);

CREATE TABLE IF NOT EXISTS experience_learning_trial_reuse_budget_consumptions (
  consumption_id TEXT PRIMARY KEY,
  gate_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  consumer_attempt_id TEXT NOT NULL,
  loop_index INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  decision TEXT NOT NULL,
  consumption_json TEXT NOT NULL CHECK (json_valid(consumption_json)),
  UNIQUE (gate_id, candidate_id, consumer_attempt_id, loop_index)
);

CREATE TABLE IF NOT EXISTS experience_learning_micro_probe_plans (
  plan_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  run_id TEXT,
  loop_index INTEGER NOT NULL,
  frame_id TEXT NOT NULL,
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json))
);

CREATE INDEX IF NOT EXISTS experience_learning_micro_probe_plans_frame_idx
  ON experience_learning_micro_probe_plans(frame_id, loop_index, plan_id);

CREATE TABLE IF NOT EXISTS experience_learning_micro_probe_records (
  record_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  ran_at TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS experience_learning_micro_probe_records_plan_idx
  ON experience_learning_micro_probe_records(plan_id, ran_at, record_id);

CREATE TABLE IF NOT EXISTS experience_learning_candidate_transitions (
  transition_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  run_id TEXT,
  loop_index INTEGER NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  transition_json TEXT NOT NULL CHECK (json_valid(transition_json))
);

CREATE INDEX IF NOT EXISTS experience_learning_candidate_transitions_target_idx
  ON experience_learning_candidate_transitions(target_kind, target_id, loop_index, transition_id);

CREATE TABLE IF NOT EXISTS experience_learning_experiment_plans (
  plan_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  run_id TEXT,
  loop_index INTEGER,
  plan_kind TEXT NOT NULL,
  planned_task_id TEXT,
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json))
);

CREATE INDEX IF NOT EXISTS experience_learning_experiment_plans_goal_idx
  ON experience_learning_experiment_plans(goal_id, run_id, loop_index, plan_id);

CREATE TABLE IF NOT EXISTS experience_learning_experiment_records (
  record_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  run_id TEXT,
  loop_index INTEGER,
  task_id TEXT,
  outcome TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS experience_learning_experiment_records_plan_idx
  ON experience_learning_experiment_records(plan_id, outcome, record_id);

CREATE TABLE IF NOT EXISTS experience_learning_experiment_value_outcomes (
  outcome_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  outcome_json TEXT NOT NULL CHECK (json_valid(outcome_json))
);

CREATE TABLE IF NOT EXISTS experience_learning_experiment_events (
  event_id TEXT PRIMARY KEY,
  plan_id TEXT,
  record_id TEXT,
  occurred_at TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK (json_valid(event_json))
);

CREATE INDEX IF NOT EXISTS experience_learning_experiment_events_plan_idx
  ON experience_learning_experiment_events(plan_id, record_id, occurred_at, event_id);

CREATE TABLE IF NOT EXISTS experience_learning_artifacts (
  artifact_id TEXT PRIMARY KEY,
  source_goal_id TEXT NOT NULL,
  source_run_id TEXT,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json))
);

CREATE INDEX IF NOT EXISTS experience_learning_artifacts_goal_idx
  ON experience_learning_artifacts(source_goal_id, source_run_id, status, updated_at, artifact_id);

CREATE TABLE IF NOT EXISTS experience_learning_artifact_events (
  event_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK (json_valid(event_json))
);

CREATE INDEX IF NOT EXISTS experience_learning_artifact_events_artifact_idx
  ON experience_learning_artifact_events(artifact_id, occurred_at, event_id);

CREATE TABLE IF NOT EXISTS experience_learning_prior_snapshots (
  prior_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  run_id TEXT,
  source_loop_index INTEGER NOT NULL,
  eligible_from_iteration INTEGER NOT NULL,
  filter_decision TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  prior_json TEXT NOT NULL CHECK (json_valid(prior_json))
);

CREATE INDEX IF NOT EXISTS experience_learning_prior_snapshots_goal_idx
  ON experience_learning_prior_snapshots(goal_id, run_id, eligible_from_iteration, generated_at, prior_id);

CREATE TABLE IF NOT EXISTS experience_learning_prior_events (
  event_id TEXT PRIMARY KEY,
  prior_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK (json_valid(event_json))
);

CREATE INDEX IF NOT EXISTS experience_learning_prior_events_prior_idx
  ON experience_learning_prior_events(prior_id, occurred_at, event_id);

CREATE TABLE IF NOT EXISTS experience_learning_prior_consumption_events (
  consumption_id TEXT PRIMARY KEY,
  prior_id TEXT NOT NULL,
  suggestion_id TEXT NOT NULL,
  consumer_phase TEXT NOT NULL,
  loop_index INTEGER NOT NULL,
  consumer_decision_ref TEXT NOT NULL,
  stage TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  consumption_json TEXT NOT NULL CHECK (json_valid(consumption_json)),
  UNIQUE (prior_id, suggestion_id, consumer_phase, loop_index, consumer_decision_ref)
);

CREATE INDEX IF NOT EXISTS experience_learning_prior_consumption_events_prior_idx
  ON experience_learning_prior_consumption_events(prior_id, consumer_phase, loop_index, consumption_id);

CREATE TABLE IF NOT EXISTS experience_learning_projection_proposals (
  proposal_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  owner_review_queue_ref TEXT NOT NULL,
  source_artifact_ids_json TEXT NOT NULL CHECK (json_valid(source_artifact_ids_json)),
  correction_lineage_refs_json TEXT NOT NULL CHECK (json_valid(correction_lineage_refs_json)),
  invalidation_refs_json TEXT NOT NULL CHECK (json_valid(invalidation_refs_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json))
);

CREATE INDEX IF NOT EXISTS experience_learning_projection_proposals_status_idx
  ON experience_learning_projection_proposals(status, updated_at, proposal_id);
`.trim();

export interface ExperienceLearningStateStoreOptions extends RuntimeControlDbStoreOptions {}

export interface ExperienceLearningAppendResult {
  runtimeEvent: RuntimeEventAppendResult;
  appliedProjection: boolean;
}

export interface ExperienceLearningPriorResolutionInput {
  goalId: string;
  runId?: string;
  consumerPhase: LearningConsumerPhase;
  consumerScope: LearningScope;
  loopIndex: number;
  consumerAttemptId: string;
  consumerDecisionRef: string;
  now?: string;
}

export interface ExperienceLearningPriorResolutionResult {
  prior: LearningPriorSnapshot;
  record: LearningPriorConsumptionRecord;
  projection: LearningPriorPhaseProjection | null;
  runtimeEventId: string | null;
}

export class ExperienceLearningStateStore {
  private readonly paths: RuntimeStorePaths;
  private readonly dbOwner: ControlDatabaseHandleOwner;

  constructor(
    runtimeRootOrPaths?: string | RuntimeStorePaths,
    options: ExperienceLearningStateStoreOptions = {},
  ) {
    this.paths = typeof runtimeRootOrPaths === "string"
      ? createRuntimeStorePaths(runtimeRootOrPaths)
      : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.dbOwner = createRuntimeControlDatabaseOwner(this.paths, options);
  }

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async close(): Promise<void> {
    await this.dbOwner.close();
  }

  async appendLifecycleEvent(payloadInput: ExperienceLearningRuntimeEventPayload): Promise<ExperienceLearningAppendResult> {
    const payload = ExperienceLearningRuntimeEventPayloadSchema.parse(payloadInput);
    const db = await this.database();
    return db.transaction((sqlite) => {
      const runtimeEvent = appendRuntimeEventEnvelopeInTransaction(
        sqlite,
        runtimeEventFromExperienceLearningPayload(payload),
      );
      const appliedProjection = runtimeEvent.disposition === "inserted";
      if (appliedProjection) {
        applyExperienceLearningPayloadProjection(sqlite, payload, runtimeEvent.event.event_id, runtimeEvent.event.occurred_at);
      }
      return { runtimeEvent, appliedProjection };
    });
  }

  async rebuildFromRuntimeEventLog(): Promise<ExperienceLearningRebuildSummary> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      clearExperienceLearningProjection(sqlite);
      const rows = sqlite.prepare(`
        SELECT event_id, occurred_at, event_json
        FROM runtime_events
        WHERE event_type LIKE 'experience_learning.%'
        ORDER BY occurred_at ASC, event_sequence ASC
      `).all() as Array<{ event_id: string; occurred_at: string; event_json: string }>;
      const summary = emptyExperienceLearningRebuildSummary();
      for (const row of rows) {
        const parsed = RuntimeEventEnvelopeSchema.safeParse(JSON.parse(row.event_json) as unknown);
        if (!parsed.success) continue;
        if (parsed.data.payload.schema_version !== "runtime-event-payload/experience-learning/v1") continue;
        applyExperienceLearningPayloadProjection(sqlite, parsed.data.payload, row.event_id, row.occurred_at);
        incrementRebuildSummary(summary, parsed.data.payload.event_kind);
      }
      return summary;
    });
  }

  async listFrames(goalId: string): Promise<ExperienceFrame[]> {
    return this.listJsonRows("experience_learning_frames", "frame_json", ExperienceFrameSchema, "goal_id = ?", [goalId]);
  }

  async listHypotheses(goalId: string): Promise<LearningHypothesis[]> {
    return this.listJsonRows("experience_learning_hypotheses", "hypothesis_json", LearningHypothesisSchema, "goal_id = ?", [goalId]);
  }

  async listGeneralizationCandidates(goalId: string): Promise<GeneralizationCandidate[]> {
    return this.listJsonRows("experience_learning_generalization_candidates", "candidate_json", GeneralizationCandidateSchema, "goal_id = ?", [goalId]);
  }

  async listMicroProbeRecords(goalId: string): Promise<MicroProbeRecord[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT r.record_json AS payload_json
        FROM experience_learning_micro_probe_records r
        JOIN experience_learning_micro_probe_plans p ON p.plan_id = r.plan_id
        WHERE p.goal_id = ?
        ORDER BY r.rowid ASC
      `).all(goalId) as Array<{ payload_json: string }>;
      return rows.map((row) => MicroProbeRecordSchema.parse(JSON.parse(row.payload_json) as unknown));
    });
  }

  async listPriorSnapshots(goalId: string): Promise<LearningPriorSnapshot[]> {
    return this.listJsonRows("experience_learning_prior_snapshots", "prior_json", LearningPriorSnapshotSchema, "goal_id = ?", [goalId]);
  }

  async listExperimentPlans(goalId: string): Promise<LearningExperimentPlan[]> {
    return this.listJsonRows("experience_learning_experiment_plans", "plan_json", LearningExperimentPlanSchema, "goal_id = ?", [goalId]);
  }

  async listExperimentRecords(goalId: string): Promise<ExperimentRecord[]> {
    return this.listJsonRows("experience_learning_experiment_records", "record_json", ExperimentRecordSchema, "goal_id = ?", [goalId]);
  }

  async listArtifacts(goalId: string): Promise<LearningArtifact[]> {
    return this.listJsonRows("experience_learning_artifacts", "artifact_json", LearningArtifactSchema, "source_goal_id = ?", [goalId]);
  }

  async listPriorConsumptionRecords(priorId: string): Promise<LearningPriorConsumptionRecord[]> {
    return this.listJsonRows("experience_learning_prior_consumption_events", "consumption_json", LearningPriorConsumptionRecordSchema, "prior_id = ?", [priorId]);
  }

  async listTrialReuseBudgetConsumptions(candidateId: string): Promise<TrialReuseBudgetConsumptionRecord[]> {
    return this.listJsonRows(
      "experience_learning_trial_reuse_budget_consumptions",
      "consumption_json",
      TrialReuseBudgetConsumptionRecordSchema,
      "candidate_id = ?",
      [candidateId],
    );
  }

  async listProjectionProposals(sourceArtifactId?: string): Promise<ExperienceLearningProjectionProposal[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT proposal_json
        FROM experience_learning_projection_proposals
        ORDER BY created_at ASC, proposal_id ASC
      `).all() as Array<{ proposal_json: string }>;
      const proposals = rows.map((row) => ExperienceLearningProjectionProposalSchema.parse(JSON.parse(row.proposal_json) as unknown));
      return sourceArtifactId
        ? proposals.filter((proposal) => proposal.sourceArtifactIds.includes(sourceArtifactId))
        : proposals;
    });
  }

  async recordMetricBaselineObservation(input: ExperienceLearningMetricBaselineObservation): Promise<ExperienceLearningMetricBaselineObservation> {
    const observation = ExperienceLearningMetricBaselineObservationSchema.parse(input);
    const db = await this.database();
    return db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO experience_learning_metric_baseline_observations (
          observation_id, baseline_id, goal_id, scenario_class, run_kind, run_ref,
          observed_at, metric_names_json, observation_json
        ) VALUES (
          @observation_id, @baseline_id, @goal_id, @scenario_class, @run_kind, @run_ref,
          @observed_at, @metric_names_json, @observation_json
        )
        ON CONFLICT(baseline_id, scenario_class, run_kind, run_ref) DO UPDATE SET
          observation_id = excluded.observation_id,
          goal_id = excluded.goal_id,
          observed_at = excluded.observed_at,
          metric_names_json = excluded.metric_names_json,
          observation_json = excluded.observation_json
      `).run({
        observation_id: observation.id,
        baseline_id: observation.baselineId,
        goal_id: observation.goalId ?? null,
        scenario_class: observation.scenarioClass,
        run_kind: observation.runKind,
        run_ref: observation.runRef,
        observed_at: observation.observedAt,
        metric_names_json: JSON.stringify(observation.metricNames),
        observation_json: JSON.stringify(observation),
      });
      return observation;
    });
  }

  async getMetricsSnapshot(goalId?: string): Promise<ExperienceLearningMetricsSnapshot> {
    const db = await this.database();
    return db.read((sqlite) => {
      const counts = experienceLearningMetricCounts(sqlite, goalId);
      const baselineObservations = listMetricBaselineObservations(sqlite, goalId);
      return ExperienceLearningMetricsSnapshotSchema.parse({
        schema_version: "experience-learning-metrics/v1",
        generated_at: new Date().toISOString(),
        ...(goalId ? { goal_id: goalId } : {}),
        definitions: EXPERIENCE_LEARNING_METRIC_DEFINITIONS,
        values: EXPERIENCE_LEARNING_METRIC_DEFINITIONS.map((definition) => {
          const numerator = counts[definition.name] ?? 0;
          const denominator = denominatorForMetric(definition.name, counts);
          return {
            name: definition.name,
            numerator_value: numerator,
            denominator_value: denominator,
            value: denominator > 0 ? numerator / denominator : 0,
            validity: metricValidityForBaseline(definition.name, baselineObservations),
          };
        }),
      });
    });
  }

  async resolvePriorForPhase(input: ExperienceLearningPriorResolutionInput): Promise<ExperienceLearningPriorResolutionResult | null> {
    const parsedInput = {
      ...input,
      consumerPhase: LearningConsumerPhaseSchema.parse(input.consumerPhase),
      consumerScope: LearningScopeSchema.parse(input.consumerScope),
      now: input.now ?? new Date().toISOString(),
    };
    const db = await this.database();
    return db.transaction((sqlite) => {
      let suppressedResult: ExperienceLearningPriorResolutionResult | null = null;
      const rows = sqlite.prepare(`
        SELECT prior_json
        FROM experience_learning_prior_snapshots
        WHERE goal_id = ?
          AND filter_decision = 'activated'
          AND eligible_from_iteration <= ?
        ORDER BY generated_at DESC, prior_id DESC
      `).all(parsedInput.goalId, parsedInput.loopIndex) as Array<{ prior_json: string }>;
      const resolver = new LearningPriorResolver();
      for (const row of rows) {
        const prior = LearningPriorSnapshotSchema.parse(JSON.parse(row.prior_json) as unknown);
        if (prior.runId && parsedInput.runId !== prior.runId) continue;
        const suggestion = prior.suggestions.find((item) => item.consumerPhase === parsedInput.consumerPhase) ?? null;
        if (!suggestion) continue;
        const resolved = resolver.resolveForPhase({
          prior,
          consumerPhase: parsedInput.consumerPhase,
          consumerScope: parsedInput.consumerScope,
          loopIndex: parsedInput.loopIndex,
          consumerAttemptId: parsedInput.consumerAttemptId,
          consumerDecisionRef: parsedInput.consumerDecisionRef,
          now: parsedInput.now,
        });
        const existing = findPriorConsumptionByIdempotency(sqlite, resolved.record.idempotencyKey);
        if (existing) {
          const projection = existing.stage === "suppressed" || !resolved.projection
            ? null
            : LearningPriorPhaseProjectionSchema.parse(projectionForExistingReservation(resolved.projection, existing));
          if (existing.stage === "suppressed") {
            suppressedResult ??= {
              prior,
              record: existing,
              projection: null,
              runtimeEventId: null,
            };
            continue;
          }
          return {
            prior,
            record: existing,
            projection,
            runtimeEventId: null,
          };
        }

        let record = resolved.record;
        let projection = resolved.projection;
        const maxUsesBefore = remainingSuggestionUses(sqlite, prior.id, suggestion.id, suggestion.maxUses);
        if (record.stage === "reserved" && maxUsesBefore < 1) {
          record = LearningPriorConsumptionRecordSchema.parse({
            ...record,
            stage: "suppressed",
            reasonCodes: ["max_uses_exhausted"],
          });
          projection = null;
        }

        const payload = record.stage === "reserved"
          ? priorReservedPayload({
              prior,
              record,
              maxUsesBefore,
              maxUsesAfterReservation: Math.max(0, maxUsesBefore - 1),
            })
          : priorSuppressedPayload({ prior, record });
        const runtimeEvent = appendRuntimeEventEnvelopeInTransaction(
          sqlite,
          runtimeEventFromExperienceLearningPayload(payload),
        );
        if (runtimeEvent.disposition === "inserted") {
          applyExperienceLearningPayloadProjection(sqlite, payload, runtimeEvent.event.event_id, runtimeEvent.event.occurred_at);
        }
        if (record.stage === "suppressed") {
          suppressedResult ??= {
            prior,
            record,
            projection: null,
            runtimeEventId: runtimeEvent.event.event_id,
          };
          continue;
        }
        return {
          prior,
          record,
          projection,
          runtimeEventId: runtimeEvent.event.event_id,
        };
      }
      return suppressedResult;
    });
  }

  async markPriorConsumptionApplied(input: {
    consumptionId: string;
    generatedDecisionRefs: readonly string[];
    completedAt?: string;
  }): Promise<ExperienceLearningAppendResult | null> {
    if (input.generatedDecisionRefs.length === 0) {
      throw new Error("prior application requires at least one generated decision ref");
    }
    const db = await this.database();
    return db.transaction((sqlite) => {
      const row = sqlite.prepare(`
        SELECT c.consumption_json, p.prior_json
        FROM experience_learning_prior_consumption_events c
        JOIN experience_learning_prior_snapshots p ON p.prior_id = c.prior_id
        WHERE c.consumption_id = ?
      `).get(input.consumptionId) as { consumption_json: string; prior_json: string } | undefined;
      if (!row) return null;
      const prior = LearningPriorSnapshotSchema.parse(JSON.parse(row.prior_json) as unknown);
      const current = LearningPriorConsumptionRecordSchema.parse(JSON.parse(row.consumption_json) as unknown);
      if (current.stage === "suppressed" || current.stage === "applied") return null;
      const consumption = LearningPriorConsumptionRecordSchema.parse({
        ...current,
        stage: "applied",
        completedAt: input.completedAt ?? new Date().toISOString(),
        generatedDecisionRefs: [...input.generatedDecisionRefs],
      });
      const payload = priorAppliedPayload({ prior, consumption });
      const runtimeEvent = appendRuntimeEventEnvelopeInTransaction(
        sqlite,
        runtimeEventFromExperienceLearningPayload(payload),
      );
      const appliedProjection = runtimeEvent.disposition === "inserted";
      if (appliedProjection) {
        applyExperienceLearningPayloadProjection(sqlite, payload, runtimeEvent.event.event_id, runtimeEvent.event.occurred_at);
      }
      return { runtimeEvent, appliedProjection };
    });
  }

  async markPriorConsumptionSuppressed(input: {
    consumptionId: string;
    reasonCodes: readonly LearningPriorConsumptionReasonCode[];
    completedAt?: string;
  }): Promise<ExperienceLearningAppendResult | null> {
    if (input.reasonCodes.length === 0) {
      throw new Error("prior suppression requires at least one reason code");
    }
    const db = await this.database();
    return db.transaction((sqlite) => {
      const row = sqlite.prepare(`
        SELECT c.consumption_json, p.prior_json
        FROM experience_learning_prior_consumption_events c
        JOIN experience_learning_prior_snapshots p ON p.prior_id = c.prior_id
        WHERE c.consumption_id = ?
      `).get(input.consumptionId) as { consumption_json: string; prior_json: string } | undefined;
      if (!row) return null;
      const prior = LearningPriorSnapshotSchema.parse(JSON.parse(row.prior_json) as unknown);
      const current = LearningPriorConsumptionRecordSchema.parse(JSON.parse(row.consumption_json) as unknown);
      if (current.stage === "suppressed" || current.stage === "applied") return null;
      const consumption = LearningPriorConsumptionRecordSchema.parse({
        ...current,
        stage: "suppressed",
        completedAt: input.completedAt ?? new Date().toISOString(),
        reasonCodes: [...input.reasonCodes],
        generatedDecisionRefs: [],
      });
      const payload = priorSuppressedPayload({ prior, record: consumption });
      const runtimeEvent = appendRuntimeEventEnvelopeInTransaction(
        sqlite,
        runtimeEventFromExperienceLearningPayload(payload),
      );
      const appliedProjection = runtimeEvent.disposition === "inserted";
      if (appliedProjection) {
        applyExperienceLearningPayloadProjection(sqlite, payload, runtimeEvent.event.event_id, runtimeEvent.event.occurred_at);
      }
      return { runtimeEvent, appliedProjection };
    });
  }

  private async listJsonRows<T>(
    table: string,
    column: string,
    schema: { parse(value: unknown): T },
    where: string,
    params: unknown[],
  ): Promise<T[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT ${column} AS payload_json
        FROM ${table}
        WHERE ${where}
        ORDER BY rowid ASC
      `).all(...params) as Array<{ payload_json: string }>;
      return rows.map((row) => schema.parse(JSON.parse(row.payload_json) as unknown));
    });
  }

  private async database(): Promise<ControlDatabase> {
    return this.dbOwner.database();
  }
}

export interface ExperienceLearningRebuildSummary {
  frames: number;
  hypotheses: number;
  generalizations: number;
  microProbes: number;
  experiments: number;
  artifacts: number;
  priors: number;
  priorConsumptions: number;
  projections: number;
}

export function emptyExperienceLearningRebuildSummary(): ExperienceLearningRebuildSummary {
  return {
    frames: 0,
    hypotheses: 0,
    generalizations: 0,
    microProbes: 0,
    experiments: 0,
    artifacts: 0,
    priors: 0,
    priorConsumptions: 0,
    projections: 0,
  };
}

export function applyExperienceLearningPayloadProjection(
  sqlite: SqliteDatabase,
  payloadInput: ExperienceLearningRuntimeEventPayload,
  runtimeEventId: string,
  occurredAt: string,
): void {
  const payload = ExperienceLearningRuntimeEventPayloadSchema.parse(payloadInput);
  switch (payload.event_kind) {
    case "frame_activated":
      if (payload.frame) upsertFrame(sqlite, payload.frame);
      return;
    case "hypothesis_transitioned":
      if (payload.hypothesis) upsertHypothesis(sqlite, payload.hypothesis);
      insertJsonEvent(sqlite, "experience_learning_hypothesis_events", ["event_id", "hypothesis_id", "occurred_at", "event_json"], [
        runtimeEventId,
        payload.hypothesis_id,
        occurredAt,
        payload,
      ]);
      return;
    case "generalization_transitioned":
      if (payload.generalization) upsertGeneralization(sqlite, payload.generalization);
      insertJsonEvent(sqlite, "experience_learning_generalization_events", ["event_id", "candidate_id", "occurred_at", "event_json"], [
        runtimeEventId,
        payload.generalization_id,
        occurredAt,
        payload,
      ]);
      return;
    case "micro_probe_recorded":
      if (payload.plan) upsertMicroProbePlan(sqlite, payload.plan);
      if (payload.record) upsertMicroProbeRecord(sqlite, payload.record);
      return;
    case "candidate_transition_recorded":
      if (payload.transition) upsertCandidateTransition(sqlite, payload.transition);
      if (payload.readiness_gate && payload.trial_reuse_budget_consumption) {
        upsertTrialReuseBudgetReservation(sqlite, payload.readiness_gate, payload.trial_reuse_budget_consumption);
      } else {
        if (payload.readiness_gate) upsertTrialReuseReadinessGate(sqlite, payload.readiness_gate);
        if (payload.trial_reuse_budget_consumption) upsertTrialReuseBudgetConsumptionAgainstStoredGate(sqlite, payload.trial_reuse_budget_consumption);
      }
      return;
    case "experiment_plan_registered":
      if (payload.plan) upsertExperimentPlan(sqlite, payload.plan);
      insertJsonEvent(sqlite, "experience_learning_experiment_events", ["event_id", "plan_id", "record_id", "occurred_at", "event_json"], [
        runtimeEventId,
        payload.plan_id,
        null,
        occurredAt,
        payload,
      ]);
      return;
    case "experiment_record_closed":
      if (payload.record) upsertExperimentRecord(sqlite, payload.record);
      if (payload.value_outcome) upsertExperimentValueOutcome(sqlite, payload.value_outcome);
      insertJsonEvent(sqlite, "experience_learning_experiment_events", ["event_id", "plan_id", "record_id", "occurred_at", "event_json"], [
        runtimeEventId,
        payload.plan_id,
        payload.record_id,
        occurredAt,
        payload,
      ]);
      return;
    case "artifact_transitioned":
      if (payload.artifact) upsertArtifact(sqlite, payload.artifact);
      insertJsonEvent(sqlite, "experience_learning_artifact_events", ["event_id", "artifact_id", "occurred_at", "event_json"], [
        runtimeEventId,
        payload.artifact_id,
        occurredAt,
        payload,
      ]);
      return;
    case "prior_generated":
      if (payload.prior) upsertPriorSnapshot(sqlite, payload.prior);
      insertJsonEvent(sqlite, "experience_learning_prior_events", ["event_id", "prior_id", "event_kind", "occurred_at", "event_json"], [
        runtimeEventId,
        payload.prior_id,
        payload.event_kind,
        occurredAt,
        payload,
      ]);
      return;
    case "prior_reserved":
    case "prior_applied":
    case "prior_suppressed":
      if (payload.consumption) upsertPriorConsumption(sqlite, payload.consumption);
      return;
    case "prior_invalidated":
      suppressPriorSnapshotForInvalidation(sqlite, payload, occurredAt);
      insertJsonEvent(sqlite, "experience_learning_prior_events", ["event_id", "prior_id", "event_kind", "occurred_at", "event_json"], [
        runtimeEventId,
        payload.prior_id,
        payload.event_kind,
        occurredAt,
        payload,
      ]);
      return;
    case "projection_enqueued":
      upsertProjectionProposal(sqlite, {
        id: payload.projection_proposal_id,
        sourceArtifactIds: payload.artifact_ids,
        ownerReviewQueueRef: payload.owner_review_queue_ref,
        status: "queued",
        correctionLineageRefs: payload.correction_lineage_refs,
        invalidationRefs: [],
        createdAt: occurredAt,
        updatedAt: occurredAt,
      });
      return;
  }
}

function upsertFrame(sqlite: SqliteDatabase, frameInput: ExperienceFrame): void {
  const frame = ExperienceFrameSchema.parse(frameInput);
  const updatedAt = frame.updatedAt ?? frame.createdAt;
  sqlite.prepare(`
    INSERT INTO experience_learning_frames (
      frame_id, goal_id, run_id, loop_index, trigger, status, created_at, updated_at, frame_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(frame_id) DO UPDATE SET
      status = excluded.status,
      updated_at = excluded.updated_at,
      frame_json = excluded.frame_json
  `).run(frame.id, frame.goalId, frame.runId ?? null, frame.loopIndex ?? null, frame.trigger, frame.status, frame.createdAt, updatedAt, JSON.stringify(frame));
}

function upsertHypothesis(sqlite: SqliteDatabase, hypothesisInput: LearningHypothesis): void {
  const hypothesis = LearningHypothesisSchema.parse(hypothesisInput);
  sqlite.prepare(`
    INSERT INTO experience_learning_hypotheses (
      hypothesis_id, goal_id, run_id, status, updated_at, hypothesis_json
    ) VALUES (?, ?, ?, ?, ?, json(?))
    ON CONFLICT(hypothesis_id) DO UPDATE SET
      status = excluded.status,
      updated_at = excluded.updated_at,
      hypothesis_json = excluded.hypothesis_json
  `).run(hypothesis.id, hypothesis.goalId, hypothesis.runId ?? null, hypothesis.status, hypothesis.updatedAt, JSON.stringify(hypothesis));
}

function upsertGeneralization(sqlite: SqliteDatabase, candidateInput: GeneralizationCandidate): void {
  const candidate = GeneralizationCandidateSchema.parse(candidateInput);
  sqlite.prepare(`
    INSERT INTO experience_learning_generalization_candidates (
      candidate_id, goal_id, run_id, status, updated_at, candidate_json
    ) VALUES (?, ?, ?, ?, ?, json(?))
    ON CONFLICT(candidate_id) DO UPDATE SET
      status = excluded.status,
      updated_at = excluded.updated_at,
      candidate_json = excluded.candidate_json
  `).run(candidate.id, candidate.goalId, candidate.runId ?? null, candidate.status, candidate.updatedAt, JSON.stringify(candidate));
}

function upsertMicroProbePlan(sqlite: SqliteDatabase, planInput: MicroProbePlan): void {
  const plan = MicroProbePlanSchema.parse(planInput);
  sqlite.prepare(`
    INSERT INTO experience_learning_micro_probe_plans (
      plan_id, goal_id, run_id, loop_index, frame_id, plan_json
    ) VALUES (?, ?, ?, ?, ?, json(?))
    ON CONFLICT(plan_id) DO UPDATE SET plan_json = excluded.plan_json
  `).run(plan.id, plan.goalId, plan.runId ?? null, plan.loopIndex, plan.frameId, JSON.stringify(plan));
}

function upsertMicroProbeRecord(sqlite: SqliteDatabase, recordInput: MicroProbeRecord): void {
  const record = MicroProbeRecordSchema.parse(recordInput);
  sqlite.prepare(`
    INSERT INTO experience_learning_micro_probe_records (
      record_id, plan_id, outcome, ran_at, record_json
    ) VALUES (?, ?, ?, ?, json(?))
    ON CONFLICT(record_id) DO UPDATE SET
      outcome = excluded.outcome,
      record_json = excluded.record_json
  `).run(record.id, record.planId, record.outcome, record.ranAt, JSON.stringify(record));
}

function upsertCandidateTransition(sqlite: SqliteDatabase, transitionInput: CandidateTransition): void {
  const transition = CandidateTransitionSchema.parse(transitionInput);
  sqlite.prepare(`
    INSERT INTO experience_learning_candidate_transitions (
      transition_id, goal_id, run_id, loop_index, target_kind, target_id, reason_code, transition_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(transition_id) DO UPDATE SET transition_json = excluded.transition_json
  `).run(transition.id, transition.goalId, transition.runId ?? null, transition.loopIndex, transition.targetKind, transition.targetId, transition.reasonCode, JSON.stringify(transition));
}

function upsertTrialReuseBudgetReservation(
  sqlite: SqliteDatabase,
  gateInput: TrialReuseReadinessGate,
  consumptionInput: TrialReuseBudgetConsumptionRecord,
): void {
  const gate = TrialReuseReadinessGateSchema.parse(gateInput);
  const consumption = TrialReuseBudgetConsumptionRecordSchema.parse(consumptionInput);
  if (consumption.gateId !== gate.id || consumption.candidateId !== gate.candidateId) {
    throw new Error("trial reuse budget consumption must reference the readiness gate being projected");
  }
  const existing = findTrialReuseBudgetConsumptionByIdempotency(sqlite, consumption.idempotencyKey);
  if (existing) {
    upsertTrialReuseReadinessGate(sqlite, gate);
    upsertTrialReuseBudgetConsumption(sqlite, existing);
    return;
  }
  if (consumption.decision !== "rejected") {
    const reservedCount = countTrialReuseBudgetReservations(sqlite, gate.id, gate.candidateId);
    if (reservedCount >= gate.remainingTrialUses) {
      throw new Error(`trial reuse budget exhausted for readiness gate ${gate.id}`);
    }
  }
  upsertTrialReuseReadinessGate(sqlite, gate);
  upsertTrialReuseBudgetConsumption(sqlite, consumption);
}

function upsertTrialReuseBudgetConsumptionAgainstStoredGate(
  sqlite: SqliteDatabase,
  consumptionInput: TrialReuseBudgetConsumptionRecord,
): void {
  const consumption = TrialReuseBudgetConsumptionRecordSchema.parse(consumptionInput);
  const gateRow = sqlite.prepare(`
    SELECT gate_json
    FROM experience_learning_trial_reuse_readiness_gates
    WHERE gate_id = ?
  `).get(consumption.gateId) as { gate_json: string } | undefined;
  if (!gateRow) {
    throw new Error(`trial reuse budget readiness gate ${consumption.gateId} is missing`);
  }
  const gate = TrialReuseReadinessGateSchema.parse(JSON.parse(gateRow.gate_json) as unknown);
  upsertTrialReuseBudgetReservation(sqlite, gate, consumption);
}

function upsertTrialReuseReadinessGate(sqlite: SqliteDatabase, gateInput: TrialReuseReadinessGate): void {
  const gate = TrialReuseReadinessGateSchema.parse(gateInput);
  sqlite.prepare(`
    INSERT INTO experience_learning_trial_reuse_readiness_gates (
      gate_id, candidate_id, decision, eligible_from_iteration, remaining_trial_uses, gate_json
    ) VALUES (?, ?, ?, ?, ?, json(?))
    ON CONFLICT(gate_id) DO UPDATE SET
      decision = excluded.decision,
      remaining_trial_uses = excluded.remaining_trial_uses,
      gate_json = excluded.gate_json
  `).run(gate.id, gate.candidateId, gate.decision, gate.eligibleFromIteration, gate.remainingTrialUses, JSON.stringify(gate));
}

function upsertTrialReuseBudgetConsumption(sqlite: SqliteDatabase, consumptionInput: TrialReuseBudgetConsumptionRecord): void {
  const consumption = TrialReuseBudgetConsumptionRecordSchema.parse(consumptionInput);
  sqlite.prepare(`
    INSERT INTO experience_learning_trial_reuse_budget_consumptions (
      consumption_id, gate_id, candidate_id, consumer_attempt_id, loop_index,
      idempotency_key, decision, consumption_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(consumption_id) DO UPDATE SET
      decision = excluded.decision,
      consumption_json = excluded.consumption_json
  `).run(
    consumption.id,
    consumption.gateId,
    consumption.candidateId,
    consumption.consumerAttemptId,
    consumption.loopIndex,
    consumption.idempotencyKey,
    consumption.decision,
    JSON.stringify(consumption),
  );
}

function findTrialReuseBudgetConsumptionByIdempotency(
  sqlite: SqliteDatabase,
  idempotencyKey: string,
): TrialReuseBudgetConsumptionRecord | null {
  const row = sqlite.prepare(`
    SELECT consumption_json
    FROM experience_learning_trial_reuse_budget_consumptions
    WHERE idempotency_key = ?
  `).get(idempotencyKey) as { consumption_json: string } | undefined;
  return row
    ? TrialReuseBudgetConsumptionRecordSchema.parse(JSON.parse(row.consumption_json) as unknown)
    : null;
}

function countTrialReuseBudgetReservations(
  sqlite: SqliteDatabase,
  gateId: string,
  candidateId: string,
): number {
  const row = sqlite.prepare(`
    SELECT COUNT(*) AS reserved_count
    FROM experience_learning_trial_reuse_budget_consumptions
    WHERE gate_id = ?
      AND candidate_id = ?
      AND decision IN ('reserved', 'applied')
  `).get(gateId, candidateId) as { reserved_count: number } | undefined;
  return row?.reserved_count ?? 0;
}

function upsertExperimentPlan(sqlite: SqliteDatabase, planInput: LearningExperimentPlan): void {
  const plan = LearningExperimentPlanSchema.parse(planInput);
  sqlite.prepare(`
    INSERT INTO experience_learning_experiment_plans (
      plan_id, goal_id, run_id, loop_index, plan_kind, planned_task_id, plan_json
    ) VALUES (?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(plan_id) DO UPDATE SET
      planned_task_id = excluded.planned_task_id,
      plan_json = excluded.plan_json
  `).run(plan.id, plan.goalId, plan.runId ?? null, plan.loopIndex ?? null, plan.planKind, plan.plannedTaskId ?? null, JSON.stringify(plan));
}

function upsertExperimentRecord(sqlite: SqliteDatabase, recordInput: ExperimentRecord): void {
  const record = ExperimentRecordSchema.parse(recordInput);
  sqlite.prepare(`
    INSERT INTO experience_learning_experiment_records (
      record_id, plan_id, goal_id, run_id, loop_index, task_id, outcome, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(record_id) DO UPDATE SET outcome = excluded.outcome, record_json = excluded.record_json
  `).run(record.id, record.planId, record.goalId, record.runId ?? null, record.loopIndex ?? null, record.taskId ?? null, record.outcome, JSON.stringify(record));
}

function upsertExperimentValueOutcome(sqlite: SqliteDatabase, outcomeInput: ExperimentValueOutcome): void {
  const outcome = ExperimentValueOutcomeSchema.parse(outcomeInput);
  sqlite.prepare(`
    INSERT INTO experience_learning_experiment_value_outcomes (
      outcome_id, plan_id, record_id, outcome_json
    ) VALUES (?, ?, ?, json(?))
    ON CONFLICT(outcome_id) DO UPDATE SET outcome_json = excluded.outcome_json
  `).run(outcome.id, outcome.planId, outcome.recordId, JSON.stringify(outcome));
}

function upsertArtifact(sqlite: SqliteDatabase, artifactInput: LearningArtifact): void {
  const artifact = LearningArtifactSchema.parse(artifactInput);
  sqlite.prepare(`
    INSERT INTO experience_learning_artifacts (
      artifact_id, source_goal_id, source_run_id, status, updated_at, artifact_json
    ) VALUES (?, ?, ?, ?, ?, json(?))
    ON CONFLICT(artifact_id) DO UPDATE SET
      status = excluded.status,
      updated_at = excluded.updated_at,
      artifact_json = excluded.artifact_json
  `).run(artifact.id, artifact.sourceGoalId, artifact.sourceRunId ?? null, artifact.status, artifact.updatedAt, JSON.stringify(artifact));
}

function upsertPriorSnapshot(sqlite: SqliteDatabase, priorInput: LearningPriorSnapshot): void {
  const prior = LearningPriorSnapshotSchema.parse(priorInput);
  sqlite.prepare(`
    INSERT INTO experience_learning_prior_snapshots (
      prior_id, goal_id, run_id, source_loop_index, eligible_from_iteration, filter_decision, generated_at, prior_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(prior_id) DO UPDATE SET
      filter_decision = excluded.filter_decision,
      prior_json = excluded.prior_json
  `).run(prior.id, prior.goalId, prior.runId ?? null, prior.sourceLoopIndex, prior.eligibleFromIteration, prior.filterDecision.decision, prior.generatedAt, JSON.stringify(prior));
}

function suppressPriorSnapshotForInvalidation(
  sqlite: SqliteDatabase,
  payload: Extract<ExperienceLearningRuntimeEventPayload, { event_kind: "prior_invalidated" }>,
  occurredAt: string,
): void {
  const row = sqlite.prepare(`
    SELECT prior_json
    FROM experience_learning_prior_snapshots
    WHERE prior_id = ?
  `).get(payload.prior_id) as { prior_json: string } | undefined;
  if (!row) return;
  const prior = LearningPriorSnapshotSchema.parse(JSON.parse(row.prior_json) as unknown);
  upsertPriorSnapshot(sqlite, {
    ...prior,
    filterDecision: {
      decision: "suppressed",
      reasonCodes: ["invalidated"],
      evaluatedAt: occurredAt,
    },
  });
}

function upsertPriorConsumption(sqlite: SqliteDatabase, consumptionInput: LearningPriorConsumptionRecord): void {
  const consumption = LearningPriorConsumptionRecordSchema.parse(consumptionInput);
  sqlite.prepare(`
    INSERT INTO experience_learning_prior_consumption_events (
      consumption_id, prior_id, suggestion_id, consumer_phase, loop_index, consumer_decision_ref,
      stage, idempotency_key, consumption_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(consumption_id) DO UPDATE SET
      stage = excluded.stage,
      consumption_json = excluded.consumption_json
  `).run(
    consumption.id,
    consumption.priorId,
    consumption.suggestionId,
    consumption.consumerPhase,
    consumption.loopIndex,
    consumption.consumerDecisionRef,
    consumption.stage,
    consumption.idempotencyKey,
    JSON.stringify(consumption),
  );
}

function upsertProjectionProposal(sqlite: SqliteDatabase, proposalInput: ExperienceLearningProjectionProposal): void {
  const proposal = ExperienceLearningProjectionProposalSchema.parse(proposalInput);
  sqlite.prepare(`
    INSERT INTO experience_learning_projection_proposals (
      proposal_id, status, owner_review_queue_ref, source_artifact_ids_json,
      correction_lineage_refs_json, invalidation_refs_json, created_at, updated_at, proposal_json
    ) VALUES (?, ?, ?, json(?), json(?), json(?), ?, ?, json(?))
    ON CONFLICT(proposal_id) DO UPDATE SET
      status = excluded.status,
      correction_lineage_refs_json = excluded.correction_lineage_refs_json,
      invalidation_refs_json = excluded.invalidation_refs_json,
      updated_at = excluded.updated_at,
      proposal_json = excluded.proposal_json
  `).run(
    proposal.id,
    proposal.status,
    proposal.ownerReviewQueueRef,
    JSON.stringify(proposal.sourceArtifactIds),
    JSON.stringify(proposal.correctionLineageRefs),
    JSON.stringify(proposal.invalidationRefs),
    proposal.createdAt,
    proposal.updatedAt,
    JSON.stringify(proposal),
  );
}

function insertJsonEvent(
  sqlite: SqliteDatabase,
  table: string,
  columns: readonly string[],
  values: readonly unknown[],
): void {
  const placeholders = columns.map((column) => column === "event_json" ? "json(?)" : "?").join(", ");
  sqlite.prepare(`
    INSERT OR IGNORE INTO ${table} (${columns.join(", ")})
    VALUES (${placeholders})
  `).run(...values.map((value, index) =>
    columns[index] === "event_json" ? JSON.stringify(value) : value
  ));
}

function clearExperienceLearningProjection(sqlite: SqliteDatabase): void {
  const tables = [
    "experience_learning_projection_proposals",
    "experience_learning_prior_consumption_events",
    "experience_learning_prior_events",
    "experience_learning_prior_snapshots",
    "experience_learning_artifact_events",
    "experience_learning_artifacts",
    "experience_learning_experiment_events",
    "experience_learning_experiment_value_outcomes",
    "experience_learning_experiment_records",
    "experience_learning_experiment_plans",
    "experience_learning_candidate_transitions",
    "experience_learning_micro_probe_records",
    "experience_learning_micro_probe_plans",
    "experience_learning_trial_reuse_budget_consumptions",
    "experience_learning_trial_reuse_readiness_gates",
    "experience_learning_generalization_events",
    "experience_learning_generalization_candidates",
    "experience_learning_hypothesis_events",
    "experience_learning_hypotheses",
    "experience_learning_frames",
  ];
  for (const table of tables) {
    sqlite.prepare(`DELETE FROM ${table}`).run();
  }
}

function incrementRebuildSummary(summary: ExperienceLearningRebuildSummary, eventKind: ExperienceLearningRuntimeEventPayload["event_kind"]): void {
  switch (eventKind) {
    case "frame_activated":
      summary.frames++;
      break;
    case "hypothesis_transitioned":
      summary.hypotheses++;
      break;
    case "generalization_transitioned":
      summary.generalizations++;
      break;
    case "micro_probe_recorded":
      summary.microProbes++;
      break;
    case "experiment_plan_registered":
    case "experiment_record_closed":
      summary.experiments++;
      break;
    case "artifact_transitioned":
      summary.artifacts++;
      break;
    case "prior_generated":
    case "prior_invalidated":
      summary.priors++;
      break;
    case "prior_reserved":
    case "prior_applied":
    case "prior_suppressed":
      summary.priorConsumptions++;
      break;
    case "projection_enqueued":
      summary.projections++;
      break;
    case "candidate_transition_recorded":
      break;
  }
}

function findPriorConsumptionByIdempotency(sqlite: SqliteDatabase, idempotencyKey: string): LearningPriorConsumptionRecord | null {
  const row = sqlite.prepare(`
    SELECT consumption_json
    FROM experience_learning_prior_consumption_events
    WHERE idempotency_key = ?
  `).get(idempotencyKey) as { consumption_json: string } | undefined;
  return row
    ? LearningPriorConsumptionRecordSchema.parse(JSON.parse(row.consumption_json) as unknown)
    : null;
}

function remainingSuggestionUses(
  sqlite: SqliteDatabase,
  priorId: string,
  suggestionId: string,
  maxUses: number,
): number {
  const row = sqlite.prepare(`
    SELECT COUNT(*) AS used_count
    FROM experience_learning_prior_consumption_events
    WHERE prior_id = ?
      AND suggestion_id = ?
      AND stage IN ('reserved', 'applied')
  `).get(priorId, suggestionId) as { used_count: number } | undefined;
  return Math.max(0, maxUses - (row?.used_count ?? 0));
}

function projectionForExistingReservation(
  projection: LearningPriorPhaseProjection,
  record: LearningPriorConsumptionRecord,
): LearningPriorPhaseProjection {
  return LearningPriorPhaseProjectionSchema.parse({
    ...projection,
    consumptionRecordId: record.id,
  });
}

function priorReservedPayload(input: {
  prior: LearningPriorSnapshot;
  record: LearningPriorConsumptionRecord;
  maxUsesBefore: number;
  maxUsesAfterReservation: number;
}): ExperienceLearningRuntimeEventPayload {
  const suggestion = input.prior.suggestions.find((item) => item.id === input.record.suggestionId);
  return {
    ...priorPayloadBase(input.prior, {
      eventKind: "prior_reserved",
      idempotencyKey: `experience-learning:prior-reserved:${input.record.id}`,
      loopIndex: input.record.loopIndex,
      evidenceRefs: suggestion?.evidenceRefs ?? [],
      graphNodeRefs: [
        { kind: "learning_prior", ref: input.prior.id },
        { kind: "learning_prior_consumption", ref: input.record.id },
      ],
    }),
    event_kind: "prior_reserved",
    consumption_id: input.record.id,
    prior_id: input.prior.id,
    suggestion_id: input.record.suggestionId,
    consumer_attempt_id: input.record.consumerAttemptId,
    consumer_decision_ref: input.record.consumerDecisionRef,
    read_set: input.record.readSet,
    max_uses_before: input.maxUsesBefore,
    max_uses_after_reservation: input.maxUsesAfterReservation,
    consumption: input.record,
  };
}

function priorSuppressedPayload(input: {
  prior: LearningPriorSnapshot;
  record: LearningPriorConsumptionRecord;
}): ExperienceLearningRuntimeEventPayload {
  const suggestion = input.prior.suggestions.find((item) => item.id === input.record.suggestionId);
  return {
    ...priorPayloadBase(input.prior, {
      eventKind: "prior_suppressed",
      idempotencyKey: `experience-learning:prior-suppressed:${input.record.id}`,
      loopIndex: input.record.loopIndex,
      evidenceRefs: suggestion?.evidenceRefs ?? [],
      graphNodeRefs: [
        { kind: "learning_prior", ref: input.prior.id },
        { kind: "learning_prior_consumption", ref: input.record.id },
      ],
    }),
    event_kind: "prior_suppressed",
    consumption_id: input.record.id,
    suppression_reason_codes: input.record.reasonCodes,
    consumer_attempt_id: input.record.consumerAttemptId,
    consumption: input.record,
  };
}

function priorAppliedPayload(input: {
  prior: LearningPriorSnapshot;
  consumption: LearningPriorConsumptionRecord;
}): ExperienceLearningRuntimeEventPayload {
  const suggestion = input.prior.suggestions.find((item) => item.id === input.consumption.suggestionId);
  return {
    ...priorPayloadBase(input.prior, {
      eventKind: "prior_applied",
      idempotencyKey: `experience-learning:prior-applied:${input.consumption.id}:${stableHash(input.consumption.generatedDecisionRefs)}`,
      loopIndex: input.consumption.loopIndex,
      evidenceRefs: suggestion?.evidenceRefs ?? [],
      graphNodeRefs: [
        { kind: "learning_prior", ref: input.prior.id },
        { kind: "learning_prior_consumption", ref: input.consumption.id },
      ],
    }),
    event_kind: "prior_applied",
    consumption_id: input.consumption.id,
    generated_decision_refs: input.consumption.generatedDecisionRefs,
    consumer_decision_ref: input.consumption.consumerDecisionRef,
    consumption: input.consumption,
  };
}

function priorPayloadBase(
  prior: LearningPriorSnapshot,
  input: {
    eventKind: ExperienceLearningRuntimeEventPayload["event_kind"];
    idempotencyKey: string;
    loopIndex: number;
    evidenceRefs: readonly string[];
    graphNodeRefs: Array<{ kind: string; ref: string }>;
  },
): Extract<ExperienceLearningRuntimeEventPayload, { event_kind: "prior_reserved" }> extends infer _Never
  ? Omit<ExperienceLearningRuntimeEventPayload, "event_kind">
  : never {
  return {
    schema_version: "runtime-event-payload/experience-learning/v1",
    idempotency_key: input.idempotencyKey,
    goal_id: prior.goalId,
    ...(prior.runId ? { run_id: prior.runId } : {}),
    loop_index: input.loopIndex,
    source_refs: {
      evidence_refs: [...input.evidenceRefs],
      event_refs: [prior.generationEventRef],
      runtime_graph_refs: [],
    },
    trust: prior.trust,
    correction_state: prior.trust.correctionState,
    redaction_class: "refs_only",
    graph: {
      node_refs: input.graphNodeRefs,
      edge_refs: [],
    },
  } as Omit<ExperienceLearningRuntimeEventPayload, "event_kind">;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function listMetricBaselineObservations(
  sqlite: SqliteDatabase,
  goalId?: string,
): ExperienceLearningMetricBaselineObservation[] {
  const rows = goalId
    ? sqlite.prepare(`
        SELECT observation_json
        FROM experience_learning_metric_baseline_observations
        WHERE goal_id = ?
        ORDER BY observed_at ASC, observation_id ASC
      `).all(goalId) as Array<{ observation_json: string }>
    : sqlite.prepare(`
        SELECT observation_json
        FROM experience_learning_metric_baseline_observations
        ORDER BY observed_at ASC, observation_id ASC
      `).all() as Array<{ observation_json: string }>;
  return rows.map((row) => ExperienceLearningMetricBaselineObservationSchema.parse(JSON.parse(row.observation_json) as unknown));
}

function metricValidityForBaseline(
  name: ExperienceLearningMetricName,
  observations: ExperienceLearningMetricBaselineObservation[],
): ExperienceLearningMetricValidity {
  const relevant = observations.filter((observation) => observation.metricNames.includes(name));
  if (!EXPERIENCE_LEARNING_METRIC_DEFINITIONS.find((definition) => definition.name === name)?.baseline_requirement.required) {
    return {
      decision: "valid",
      baseline_ids: [],
      baseline_observation_ids: [],
    };
  }

  const baselineIds = uniqueStrings(relevant.map((observation) => observation.baselineId));
  for (const baselineId of baselineIds) {
    const baselineRows = relevant.filter((observation) => observation.baselineId === baselineId);
    const missingScenarioClasses = missingBaselineScenarioClasses(baselineRows);
    if (missingScenarioClasses.length === 0) {
      return {
        decision: "valid",
        baseline_ids: [baselineId],
        baseline_observation_ids: baselineRows.map((observation) => observation.id),
      };
    }
  }

  const missingScenarioClasses = missingBaselineScenarioClasses(relevant);
  return {
    decision: "invalid",
    reason_codes: uniqueStrings([
      "paired_baseline_required",
      ...missingScenarioClasses.map((scenarioClass) => missingPairReasonCode(scenarioClass)),
    ]),
    missing_scenario_classes: missingScenarioClasses,
    baseline_ids: baselineIds,
    baseline_observation_ids: relevant.map((observation) => observation.id),
  };
}

function missingBaselineScenarioClasses(
  observations: ExperienceLearningMetricBaselineObservation[],
): ExperienceLearningMetricScenarioClass[] {
  return EXPERIENCE_LEARNING_BASELINE_SCENARIO_CLASSES.filter((scenarioClass) =>
    !EXPERIENCE_LEARNING_BASELINE_RUN_KINDS.every((runKind) =>
      observations.some((observation) => observation.scenarioClass === scenarioClass && observation.runKind === runKind)
    )
  );
}

function missingPairReasonCode(
  scenarioClass: ExperienceLearningMetricScenarioClass,
): "missing_task_work_pair" | "missing_stall_recovery_pair" | "missing_companion_interaction_pair" {
  switch (scenarioClass) {
    case "task_work":
      return "missing_task_work_pair";
    case "stall_recovery":
      return "missing_stall_recovery_pair";
    case "companion_interaction":
      return "missing_companion_interaction_pair";
  }
}

function uniqueStrings<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}

function experienceLearningMetricCounts(
  sqlite: SqliteDatabase,
  goalId?: string,
): Partial<Record<ExperienceLearningMetricName, number>> {
  const goalClause = goalId ? " WHERE goal_id = ?" : "";
  const run = (sql: string, params: unknown[] = []): number => {
    const row = sqlite.prepare(sql).get(...params) as { count_value: number } | undefined;
    return row?.count_value ?? 0;
  };
  const goalParams = goalId ? [goalId] : [];
  const frames = run(`SELECT COUNT(*) AS count_value FROM experience_learning_frames${goalClause}`, goalParams);
  const probes = run(`
    SELECT COUNT(*) AS count_value
    FROM experience_learning_micro_probe_records r
    JOIN experience_learning_micro_probe_plans p ON p.plan_id = r.plan_id
    ${goalId ? "WHERE p.goal_id = ?" : ""}
  `, goalParams);
  const candidates = run(`SELECT COUNT(*) AS count_value FROM experience_learning_generalization_candidates${goalClause}`, goalParams);
  const trialReady = run(`SELECT COUNT(*) AS count_value FROM experience_learning_generalization_candidates${goalClause}${goalId ? " AND" : " WHERE"} status = 'trial_reuse_ready'`, goalParams);
  const promotedCandidates = run(`SELECT COUNT(*) AS count_value FROM experience_learning_generalization_candidates${goalClause}${goalId ? " AND" : " WHERE"} status = 'promoted'`, goalParams);
  const artifacts = run(`SELECT COUNT(*) AS count_value FROM experience_learning_artifacts${goalId ? " WHERE source_goal_id = ?" : ""}`, goalParams);
  const promotedArtifacts = run(`SELECT COUNT(*) AS count_value FROM experience_learning_artifacts${goalId ? " WHERE source_goal_id = ? AND" : " WHERE"} status = 'promoted'`, goalParams);
  const priorsApplied = run(`
    SELECT COUNT(*) AS count_value
    FROM experience_learning_prior_consumption_events c
    JOIN experience_learning_prior_snapshots p ON p.prior_id = c.prior_id
    WHERE c.stage = 'applied'${goalId ? " AND p.goal_id = ?" : ""}
  `, goalParams);
  const priorsSuppressed = run(`
    SELECT COUNT(*) AS count_value
    FROM experience_learning_prior_consumption_events c
    JOIN experience_learning_prior_snapshots p ON p.prior_id = c.prior_id
    WHERE c.stage = 'suppressed'${goalId ? " AND p.goal_id = ?" : ""}
  `, goalParams);
  const experimentPlans = run(`SELECT COUNT(*) AS count_value FROM experience_learning_experiment_plans${goalClause}`, goalParams);
  const experimentRecords = run(`SELECT COUNT(*) AS count_value FROM experience_learning_experiment_records${goalClause}`, goalParams);
  const experimentOutcomes = run(`
    SELECT COUNT(*) AS count_value
    FROM experience_learning_experiment_value_outcomes o
    JOIN experience_learning_experiment_records r ON r.record_id = o.record_id
    ${goalId ? "WHERE r.goal_id = ?" : ""}
  `, goalParams);
  const trialReuseAttempts = run(`
    SELECT COUNT(*) AS count_value
    FROM experience_learning_trial_reuse_budget_consumptions c
    JOIN experience_learning_generalization_candidates g ON g.candidate_id = c.candidate_id
    ${goalId ? "WHERE g.goal_id = ?" : ""}
  `, goalParams);
  const trialReuseSuccess = run(`
    SELECT COUNT(*) AS count_value
    FROM experience_learning_experiment_value_outcomes o
    JOIN experience_learning_experiment_records r ON r.record_id = o.record_id
    WHERE json_extract(o.outcome_json, '$.transferOutcome') = 'exact_success'${goalId ? " AND r.goal_id = ?" : ""}
  `, goalParams);
  const negativeTransfer = run(`
    SELECT COUNT(*) AS count_value
    FROM experience_learning_experiment_value_outcomes o
    JOIN experience_learning_experiment_records r ON r.record_id = o.record_id
    WHERE json_extract(o.outcome_json, '$.transferOutcome') = 'negative_transfer'${goalId ? " AND r.goal_id = ?" : ""}
  `, goalParams);
  const staleSuppressions = run(`
    SELECT COUNT(DISTINCT consumption_id) AS count_value
    FROM experience_learning_prior_consumption_events c
    JOIN experience_learning_prior_snapshots p ON p.prior_id = c.prior_id,
      json_each(c.consumption_json, '$.reasonCodes')
    WHERE c.stage = 'suppressed' AND json_each.value = 'stale_or_expired'${goalId ? " AND p.goal_id = ?" : ""}
  `, goalParams);
  const falsifiedArtifacts = run(`SELECT COUNT(*) AS count_value FROM experience_learning_artifacts${goalId ? " WHERE source_goal_id = ? AND" : " WHERE"} status = 'falsified'`, goalParams);
  const falsifiedHypotheses = run(`SELECT COUNT(*) AS count_value FROM experience_learning_hypotheses${goalClause}${goalId ? " AND" : " WHERE"} status = 'falsified'`, goalParams);
  const microProbeFalsified = run(`
    SELECT COUNT(*) AS count_value
    FROM experience_learning_micro_probe_records r
    JOIN experience_learning_micro_probe_plans p ON p.plan_id = r.plan_id
    WHERE r.outcome = 'falsified'${goalId ? " AND p.goal_id = ?" : ""}
  `, goalParams);
  const microProbeDeferred = run(`
    SELECT COUNT(*) AS count_value
    FROM experience_learning_micro_probe_records r
    JOIN experience_learning_micro_probe_plans p ON p.plan_id = r.plan_id
    WHERE r.outcome = 'deferred'${goalId ? " AND p.goal_id = ?" : ""}
  `, goalParams);
  const falsifiedExperimentRecords = run(`SELECT COUNT(*) AS count_value FROM experience_learning_experiment_records${goalClause}${goalId ? " AND" : " WHERE"} outcome = 'falsified'`, goalParams);
  return {
    experience_frames_created: frames,
    hypotheses_created: run(`SELECT COUNT(*) AS count_value FROM experience_learning_hypotheses${goalClause}`, goalParams),
    hypotheses_falsified: falsifiedHypotheses,
    generalization_candidates_created: candidates,
    micro_probe_eligible_candidates: candidates,
    micro_probe_attempted: probes,
    micro_probe_falsified: microProbeFalsified,
    micro_probe_deferred: microProbeDeferred,
    micro_probe_self_confirmation_rejections: 0,
    micro_probe_replay_drift_count: 0,
    experiences_to_trial_reuse_ready: trialReady,
    experiences_to_promoted_generalization: promotedCandidates,
    generalization_counterexample_capture_rate: run(`SELECT COUNT(*) AS count_value FROM experience_learning_generalization_candidates${goalClause}${goalId ? " AND" : " WHERE"} status IN ('narrowed', 'falsified')`, goalParams),
    pre_registered_experiment_rate: experimentPlans,
    hypothesis_to_experiment_rate: experimentPlans,
    experiment_value_calibration: experimentOutcomes,
    trial_reuse_attempts: trialReuseAttempts,
    trial_reuse_success_rate_by_scope: trialReuseSuccess,
    negative_transfer_rate: negativeTransfer,
    action_savings_after_reuse: priorsApplied,
    interaction_policy_bias_outcome_delta: 0,
    unsupported_compression_rejections: 0,
    artifacts_created: artifacts,
    artifacts_promoted: promotedArtifacts,
    artifacts_falsified: falsifiedArtifacts,
    learning_prior_injections: priorsApplied,
    stale_prior_suppression_count: staleSuppressions,
    prior_suppressed_at_consumption: priorsSuppressed,
    prior_consumed_by_phase: priorsApplied,
    prior_outcome_delta: experimentRecords,
    repeated_failed_action_rate: falsifiedExperimentRecords,
    avoidable_loop_count: priorsApplied,
    falsification_latency: falsifiedHypotheses + falsifiedArtifacts + falsifiedExperimentRecords,
    contradiction_to_demotion_latency: falsifiedHypotheses + falsifiedArtifacts,
    artifact_reuse_success_rate: trialReuseSuccess,
    delayed_false_promotion_rate: 0,
  };
}

function denominatorForMetric(
  name: ExperienceLearningMetricName,
  counts: Partial<Record<ExperienceLearningMetricName, number>>,
): number {
  switch (name) {
    case "micro_probe_attempted":
    case "micro_probe_falsified":
    case "micro_probe_deferred":
      return counts.micro_probe_eligible_candidates ?? 0;
    case "experiences_to_trial_reuse_ready":
    case "experiences_to_promoted_generalization":
    case "generalization_counterexample_capture_rate":
      return counts.generalization_candidates_created ?? 0;
    case "pre_registered_experiment_rate":
    case "hypothesis_to_experiment_rate":
      return counts.hypotheses_created ?? 0;
    case "experiment_value_calibration":
    case "trial_reuse_success_rate_by_scope":
    case "negative_transfer_rate":
    case "prior_outcome_delta":
    case "artifact_reuse_success_rate":
      return counts.trial_reuse_attempts ?? counts.experiment_value_calibration ?? 0;
    case "artifacts_promoted":
    case "artifacts_falsified":
      return counts.artifacts_created ?? 0;
    case "stale_prior_suppression_count":
    case "prior_suppressed_at_consumption":
    case "prior_consumed_by_phase":
      return (counts.learning_prior_injections ?? 0) + (counts.prior_suppressed_at_consumption ?? 0);
    default:
      return Math.max(1, counts[name] ?? 0);
  }
}
