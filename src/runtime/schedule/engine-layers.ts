/**
 * Phase 3 layer executors: Cron and GoalTrigger.
 * Extracted to keep schedule-engine.ts under 500 lines.
 */
import {
  ScheduleInternalAttentionProjectionSchema,
  ScheduleResultSchema,
  type ScheduleEntry,
  type ScheduleInternalAttentionProjection,
  type ScheduleResult,
} from "../types/schedule.js";
import type { IDataSourceAdapter } from "../../platform/observation/data-source-adapter.js";
import type { DataSourceRegistry } from "../../platform/observation/data-source-adapter.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { HookManager } from "../hook-manager.js";
import type { MemoryLifecycleManager } from "../../platform/knowledge/memory/memory-lifecycle.js";
import type { KnowledgeManager } from "../../platform/knowledge/knowledge-manager.js";
import { detectChange } from "../change-detector.js";
import { executeReflectionCronJob, executeSoilPublishCronJob } from "./engine-cron-reflection.js";
import type { GoalRunActivationContext } from "../../base/types/goal-activation.js";
import {
  buildSchedulerWakeSignalContext,
  ref,
  type AttentionReevaluationPort,
  type AttentionReevaluationResult,
} from "../attention/index.js";
import { assembleScheduleOperationPlans } from "../capability-operation-planner.js";

interface LayerDeps {
  baseDir?: string;
  dataSourceRegistry?: Map<string, IDataSourceAdapter> | DataSourceRegistry;
  llmClient?: ILLMClient;
  notificationDispatcher?: { dispatch(report: Record<string, unknown>): Promise<any> };
  coreLoop?: { run(goalId: string, options?: { maxIterations?: number | null; runPolicy?: "bounded" | "resident"; activation?: GoalRunActivationContext }): Promise<any> };
  stateManager?: StateManager;
  reportingEngine?: { generateNotification(type: string, context: Record<string, unknown>): Promise<any> };
  hookManager?: HookManager;
  memoryLifecycle?: MemoryLifecycleManager;
  knowledgeManager?: KnowledgeManager;
  attentionReevaluation?: AttentionReevaluationPort;
  logger: {
    info: (msg: string, ctx?: Record<string, unknown>) => void;
    warn: (msg: string, ctx?: Record<string, unknown>) => void;
    error: (msg: string, ctx?: Record<string, unknown>) => void;
  };
  /** Callback for probe to update baseline_results on the owning entry. */
  updateBaseline?: (entryId: string, value: unknown, windowSize: number) => void;
}

async function getAdapter(
  sourceId: string,
  registry: Map<string, IDataSourceAdapter> | DataSourceRegistry | undefined
): Promise<IDataSourceAdapter | undefined> {
  if (!registry) return undefined;
  if (registry instanceof Map) return registry.get(sourceId);
  try {
    return (registry as DataSourceRegistry).getSource(sourceId);
  } catch {
    return undefined;
  }
}

function buildWaitResumeAttentionProjection(
  value: unknown,
  projectedAt: string
): ScheduleInternalAttentionProjection | undefined {
  if (!isAttentionReevaluationResult(value)) return undefined;

  const gateStatuses = value.gate_decisions.map((decision) => decision.status);
  const runtimeItems = value.runtime_items.map((item) => ({
    ref: item.item_id,
    type: item.type,
    status: item.status,
    posture: item.posture,
    visibility_display: item.visibility_policy.display,
    inspectable: item.visibility_policy.inspectable,
    auditable: item.visibility_policy.auditable,
  }));
  const nonExecutionStates = new Set<ScheduleInternalAttentionProjection["non_execution_states"][number]>();
  for (const decision of value.inhibition_decisions) {
    if (decision.decision === "suppress") nonExecutionStates.add("suppressed");
    if (decision.decision === "hold" || decision.decision === "watch" || decision.decision === "wait_for_opportunity") {
      nonExecutionStates.add("held");
    }
    if (decision.decision === "decay") nonExecutionStates.add("decayed");
    if (decision.decision === "reject_stale") nonExecutionStates.add("rejected_stale");
  }
  for (const decision of value.gate_decisions) {
    if (decision.status === "blocked") nonExecutionStates.add("blocked");
    if (decision.status === "delayed") nonExecutionStates.add("delayed");
  }
  for (const item of runtimeItems) {
    if (item.inspectable && item.posture === "holding") nonExecutionStates.add("held");
    if (item.inspectable && item.posture === "suppressed") nonExecutionStates.add("suppressed");
    if (item.inspectable && item.posture === "stale") nonExecutionStates.add("rejected_stale");
    if (item.inspectable && item.visibility_display === "hidden") nonExecutionStates.add("inspectable_hidden");
  }
  if (runtimeItems.length > 0) {
    nonExecutionStates.add("silent_runtime_item");
  }

  return ScheduleInternalAttentionProjectionSchema.parse({
    kind: "wait_resume_attention_projection",
    projected_at: projectedAt,
    signal_context_id: value.signal_context.signal_context_id,
    signal_sources: value.signal_context.signal_sources,
    urge_candidate_refs: value.urge_candidates.map((urge) => urge.urge_id),
    agenda_item_refs: value.agenda_items.map((item) => item.agenda_item_id),
    inhibition_decisions: value.inhibition_decisions.map((decision) => ({
      ref: decision.decision_id,
      decision: decision.decision,
    })),
    initiative_gate_decisions: value.gate_decisions.map((decision) => ({
      ref: decision.decision_id,
      status: decision.status,
      ...(decision.selected_outcome ? { selected_outcome: decision.selected_outcome } : {}),
    })),
    runtime_items: runtimeItems,
    non_execution_states: [...nonExecutionStates],
    summary: [
      `${value.signal_context.signal_sources.length} signal source(s)`,
      `${value.urge_candidates.length} urge candidate(s)`,
      `${value.agenda_items.length} agenda item(s)`,
      `gate=${gateStatuses.length > 0 ? gateStatuses.join(",") : "none"}`,
      `${runtimeItems.length} inspectable runtime item(s)`,
    ].join("; "),
  });
}

function isAttentionReevaluationResult(value: unknown): value is AttentionReevaluationResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AttentionReevaluationResult>;
  return Boolean(
    candidate.signal_context &&
    typeof candidate.signal_context === "object" &&
    typeof candidate.signal_context.signal_context_id === "string" &&
    Array.isArray(candidate.signal_context.signal_sources) &&
    Array.isArray(candidate.urge_candidates) &&
    Array.isArray(candidate.agenda_items) &&
    Array.isArray(candidate.inhibition_decisions) &&
    Array.isArray(candidate.gate_decisions) &&
    Array.isArray(candidate.runtime_items)
  );
}

export async function executeCron(entry: ScheduleEntry, deps: LayerDeps): Promise<ScheduleResult> {
  const firedAt = new Date().toISOString();
  const start = Date.now();
  const cfg = entry.cron;

  if (!cfg) {
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: 0,
      error_message: "No cron config",
      fired_at: firedAt,
      failure_kind: "permanent",
    });
  }

  // Check daily budget
  if ((entry.tokens_used_today ?? 0) >= entry.max_tokens_per_day) {
    deps.logger.info(`Cron "${entry.name}" skipped: daily budget exceeded`);
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "skipped",
      duration_ms: 0,
      error_message: "daily budget exceeded",
      fired_at: firedAt,
    });
  }

  try {
    if (cfg.job_kind === "reflection") {
      if (!cfg.reflection_kind) {
        return ScheduleResultSchema.parse({
          entry_id: entry.id,
          status: "error",
          duration_ms: 0,
          error_message: "Reflection cron is missing reflection_kind",
          fired_at: firedAt,
          failure_kind: "permanent",
        });
      }
      return executeReflectionCronJob(entry, deps, firedAt, start, cfg.reflection_kind);
    }

    if (cfg.job_kind === "soil_publish") {
      return executeSoilPublishCronJob(entry, deps, firedAt, start);
    }

    // Gather context from data sources
    const contextMap: Record<string, string> = {};
    for (const sourceId of cfg.context_sources) {
      const adapter = await getAdapter(sourceId, deps.dataSourceRegistry);
      if (adapter) {
        try {
          const result = await adapter.query({
            timeout_ms: 10000,
            dimension_name: sourceId,
          } as Parameters<typeof adapter.query>[0]);
          contextMap[sourceId] = JSON.stringify(result.value ?? result.raw);
        } catch (err) {
          deps.logger.warn(`Cron "${entry.name}" context source "${sourceId}" failed: ${err instanceof Error ? err.message : String(err)}`);
          contextMap[sourceId] = "";
        }
      } else {
        deps.logger.warn(`Cron "${entry.name}" context source "${sourceId}" not found`);
        contextMap[sourceId] = "";
      }
    }

    // Interpolate prompt template
    let prompt = cfg.prompt_template;
    for (const [key, value] of Object.entries(contextMap)) {
      prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    // Call LLM
    let tokensUsed = 0;
    let outputSummary: string | undefined;

    if (deps.llmClient) {
      const llmResponse = await deps.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { model_tier: "light", max_tokens: cfg.max_tokens }
      );
      tokensUsed = (llmResponse.usage?.input_tokens ?? 0) + (llmResponse.usage?.output_tokens ?? 0);
      outputSummary = llmResponse.content;
    }

    // Report output via ReportingEngine
    // output_format "report" intentionally skips notificationDispatcher — 
    // report output is delivered only through ReportingEngine
    if (cfg.output_format === "report" || cfg.output_format === "both") {
      if (deps.reportingEngine) {
        await deps.reportingEngine.generateNotification("schedule_report", {
          entry_name: entry.name,
          entry_id: entry.id,
          output: outputSummary,
          report_type: cfg.report_type || "schedule_cron",
        });
      } else {
        deps.logger.warn('ReportingEngine not available for output_format report');
      }
    }

    // Dispatch notification if configured
    if ((cfg.output_format === "notification" || cfg.output_format === "both") && deps.notificationDispatcher) {
      try {
        await deps.notificationDispatcher.dispatch({
          report_type: "schedule_report_ready",
          entry_id: entry.id,
          entry_name: entry.name,
          output_summary: outputSummary,
        });
      } catch (err) {
        deps.logger.warn(`Cron "${entry.name}" notification dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "ok",
      duration_ms: Date.now() - start,
      fired_at: firedAt,
      tokens_used: tokensUsed,
      output_summary: outputSummary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger.error(`Cron "${entry.name}" failed: ${msg}`);
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: Date.now() - start,
      error_message: msg,
      fired_at: firedAt,
      failure_kind: "transient",
    });
  }
}

export async function executeGoalTrigger(entry: ScheduleEntry, deps: LayerDeps): Promise<ScheduleResult> {
  const firedAt = new Date().toISOString();
  const start = Date.now();
  const cfg = entry.goal_trigger;

  if (!cfg) {
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: 0,
      error_message: "No goal_trigger config",
      fired_at: firedAt,
      failure_kind: "permanent",
    });
  }

  // Check daily budget
  if ((entry.tokens_used_today ?? 0) >= entry.max_tokens_per_day) {
    deps.logger.info(`GoalTrigger "${entry.name}" skipped: daily budget exceeded`);
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "skipped",
      duration_ms: 0,
      error_message: "daily budget exceeded",
      fired_at: firedAt,
    });
  }

  // Check if goal is already active
  if (cfg.skip_if_active && deps.stateManager) {
    try {
      const goal = await deps.stateManager.loadGoal(cfg.goal_id);
      if (goal && goal.status === "active") {
        deps.logger.info(`GoalTrigger "${entry.name}" skipped: goal ${cfg.goal_id} is already active`);
        return ScheduleResultSchema.parse({
          entry_id: entry.id,
          status: "skipped",
          duration_ms: 0,
          error_message: `goal ${cfg.goal_id} is already active`,
          fired_at: firedAt,
        });
      }
    } catch (err) {
      deps.logger.warn(`GoalTrigger "${entry.name}" could not check goal state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    if (entry.metadata?.activation_kind === "wait_resume") {
      if (!deps.attentionReevaluation) {
        return ScheduleResultSchema.parse({
          entry_id: entry.id,
          status: "error",
          duration_ms: Date.now() - start,
          error_message: "No attention re-evaluation port provided for wait_resume wake",
          fired_at: firedAt,
          failure_kind: "permanent",
        });
      }

      const signalContext = buildSchedulerWakeSignalContext({
        signal_context_id: `signal:schedule-wake:${entry.id}:${firedAt}`,
        assembled_at: firedAt,
        schedule_tick_ref: ref("schedule_tick", entry.id),
        wait_ref: ref("wait", entry.metadata.wait_strategy_id ?? entry.metadata.strategy_id ?? entry.id),
        active_surface_ref: null,
        current_goal_refs: [ref("goal", cfg.goal_id)],
        runtime_state_refs: [ref("runtime_event", `runtime-event:schedule-wake:${entry.id}`)],
      });

      const reevaluation = await deps.attentionReevaluation.reevaluate(signalContext, {
        entry_id: entry.id,
        entry_name: entry.name,
        activation_kind: "wait_resume",
        fired_at: firedAt,
      });
      const projection = buildWaitResumeAttentionProjection(reevaluation, firedAt);
      const capabilityOperationPlanAssembly = assembleScheduleOperationPlans({
        entry,
        firedAt,
        ...(projection ? { projection } : {}),
      });

      return ScheduleResultSchema.parse({
        entry_id: entry.id,
        status: "ok",
        duration_ms: Date.now() - start,
        fired_at: firedAt,
        goal_id: cfg.goal_id,
        output_summary: "wait wake re-evaluated through attention",
        ...(projection ? { internal_attention_projection: projection } : {}),
        capability_operation_plan_assembly: capabilityOperationPlanAssembly,
      });
    }

    if (!deps.coreLoop) {
      return ScheduleResultSchema.parse({
        entry_id: entry.id,
        status: "error",
        duration_ms: 0,
        error_message: "No coreLoop provided",
        fired_at: firedAt,
        failure_kind: "permanent",
      });
    }

    const result = cfg.run_policy === "resident"
      ? await deps.coreLoop.run(cfg.goal_id, { maxIterations: null, runPolicy: "resident" })
      : await deps.coreLoop.run(cfg.goal_id, { maxIterations: cfg.max_iterations ?? 10, runPolicy: "bounded" });
    const tokensUsed = result?.tokensUsed ?? 0;
    if (result) {
      deps.logger.info(`GoalTrigger "${entry.name}" completed: status=${result.finalStatus}, iterations=${result.totalIterations}`);
    }

    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "ok",
      duration_ms: Date.now() - start,
      fired_at: firedAt,
      goal_id: cfg.goal_id,
      tokens_used: tokensUsed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger.error(`GoalTrigger "${entry.name}" failed: ${msg}`);
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: Date.now() - start,
      error_message: msg,
      fired_at: firedAt,
      failure_kind: "transient",
    });
  }
}

export async function executeProbe(entry: ScheduleEntry, deps: LayerDeps): Promise<ScheduleResult> {
  const firedAt = new Date().toISOString();
  const start = Date.now();
  const cfg = entry.probe;

  if (!cfg) {
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: 0,
      error_message: "No probe config",
      fired_at: firedAt,
      failure_kind: "permanent",
    });
  }

  // Look up data source adapter
  const adapter = await getAdapter(cfg.data_source_id, deps.dataSourceRegistry);
  if (!adapter) {
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: 0,
      error_message: `Data source not found: ${cfg.data_source_id}`,
      fired_at: firedAt,
      failure_kind: "permanent",
    });
  }

  try {
    const dimensionName = cfg.probe_dimension
      ?? (typeof cfg.query_params.dimension_name === "string" ? cfg.query_params.dimension_name : undefined)
      ?? cfg.data_source_id;

    // Execute probe query
    const queryResult = await adapter.query({
      timeout_ms: 10000,
      ...cfg.query_params,
      dimension_name: dimensionName,
    } as Parameters<typeof adapter.query>[0]);

    const currentValue = queryResult.value ?? queryResult.raw;

    // Detect change
    const { changed, details } = detectChange(
      cfg.change_detector.mode,
      currentValue,
      entry.baseline_results,
      cfg.change_detector.threshold_value
    );

    deps.logger.info(`Probe "${entry.name}": ${details}`);

    let tokensUsed = 0;
    let outputSummary: string | undefined;

    // Optional LLM analysis on change
    if (changed && cfg.llm_on_change && deps.llmClient) {
      const prompt = cfg.llm_prompt_template
        ? cfg.llm_prompt_template.replace("{{result}}", JSON.stringify(currentValue))
        : `A scheduled probe detected a change. Current result: ${JSON.stringify(currentValue)}. Previous baselines: ${JSON.stringify(entry.baseline_results.slice(-3))}. Is this change significant? Respond concisely.`;

      try {
        const llmResponse = await deps.llmClient.sendMessage(
          [{ role: "user", content: prompt }],
          { model_tier: "light" }
        );
        tokensUsed = (llmResponse.usage?.input_tokens ?? 0) + (llmResponse.usage?.output_tokens ?? 0);
        outputSummary = llmResponse.content;
      } catch (err) {
        deps.logger.warn(`Probe "${entry.name}" LLM analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Update baseline_results via callback
    if (deps.updateBaseline) {
      deps.updateBaseline(entry.id, currentValue, cfg.change_detector.baseline_window);
    }

    // Dispatch change notification
    if (changed && deps.notificationDispatcher) {
      try {
        await deps.notificationDispatcher.dispatch({
          report_type: "schedule_change",
          entry_id: entry.id,
          entry_name: entry.name,
          details,
          output_summary: outputSummary,
        });
      } catch (err) {
        deps.logger.warn(`Probe "${entry.name}" notification dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "ok",
      duration_ms: Date.now() - start,
      fired_at: firedAt,
      tokens_used: tokensUsed,
      change_detected: changed,
      output_summary: outputSummary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger.error(`Probe "${entry.name}" failed: ${msg}`);
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: Date.now() - start,
      error_message: msg,
      fired_at: firedAt,
      failure_kind: "transient",
    });
  }
}
