// ─── goal-raw.ts: cmdGoalAddRaw — add a goal without LLM negotiation ───

import { z } from "zod/v3";
import { StateManager } from "../../../base/state/state-manager.js";
import { getCliLogger } from "../cli-logger.js";
import {
  RawDimensionSpec,
  parseRawDim,
  buildThreshold,
  autoRegisterFileExistenceDataSources,
  autoRegisterShellDataSources,
} from "./goal-utils.js";
import {
  allocateCliGoalId,
  recordCliGoalCommandDecision,
} from "./goal-personal-agent-trace.js";

const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T.+/;
const DeadlineDateTimeSchema = z.string().datetime();

function normalizeDeadlineOption(deadline: string | undefined): string | null {
  if (!deadline) return null;
  if (ISO_DATE_ONLY_RE.test(deadline)) {
    const normalized = `${deadline}T00:00:00.000Z`;
    const parsed = new Date(normalized);
    if (parsed.toISOString().slice(0, 10) !== deadline) {
      throw new Error(`invalid --deadline value "${deadline}". Expected an ISO date or datetime.`);
    }
    return normalized;
  }
  if (!ISO_DATETIME_RE.test(deadline)) {
    throw new Error(`invalid --deadline value "${deadline}". Expected an ISO date or datetime.`);
  }
  const parsed = DeadlineDateTimeSchema.safeParse(deadline);
  if (!parsed.success) {
    throw new Error(`invalid --deadline value "${deadline}". Expected an ISO date or datetime.`);
  }
  return new Date(parsed.data).toISOString();
}

export async function cmdGoalAddRaw(
  stateManager: StateManager,
  opts: {
    title?: string;
    description?: string;
    rawDimensions: string[];
    parent_id?: string;
    constraints?: string[];
    deadline?: string;
    json?: boolean;
  }
): Promise<number> {
  const title = opts.title || opts.description;
  if (!title) {
    getCliLogger().error("Error: --title or description is required for raw goal add.");
    return 1;
  }

  // Parse and validate all dim specs upfront
  const dimSpecs: RawDimensionSpec[] = [];
  for (const raw of opts.rawDimensions) {
    const spec = parseRawDim(raw);
    if (!spec) {
      getCliLogger().error(`Error: invalid --dim format "${raw}". Expected "name:type:value" (e.g. "tsc_error_count:min:0")`);
      return 1;
    }
    const threshold = buildThreshold(spec);
    if (!threshold) {
      getCliLogger().error(`Error: invalid value in --dim "${raw}". Check type/value combination.`);
      return 1;
    }
    dimSpecs.push(spec);
  }

  const now = new Date().toISOString();
  const goalId = await allocateCliGoalId(stateManager, {
    command: "pulseed goal add",
    mode: "raw",
    title,
    description: opts.description ?? null,
    rawDimensions: opts.rawDimensions,
    parent_id: opts.parent_id ?? null,
    constraints: opts.constraints ?? [],
    deadline: opts.deadline ?? null,
  });
  let deadline: string | null;
  try {
    deadline = normalizeDeadlineOption(opts.deadline);
  } catch (err) {
    getCliLogger().error(err instanceof Error ? `Error: ${err.message}` : String(err));
    return 1;
  }

  const dimensions = dimSpecs.map((spec) => {
    const threshold = buildThreshold(spec)!;
    return {
      name: spec.name,
      label: spec.name.replace(/_/g, " "),
      current_value: null,
      threshold,
      confidence: 0,
      observation_method: {
        type: "mechanical" as const,
        source: "auto",
        schedule: null,
        endpoint: null,
        confidence_tier: "mechanical" as const,
      },
      last_updated: null,
      history: [],
      weight: 1.0,
      uncertainty_weight: null,
      state_integrity: "ok" as const,
      dimension_mapping: null,
    };
  });

  const goal = {
    id: goalId,
    parent_id: opts.parent_id ?? null,
    node_type: "goal" as const,
    title,
    description: opts.description || title,
    status: "active" as const,
    loop_status: "idle" as const,
    dimensions,
    gap_aggregation: "max" as const,
    dimension_mapping: null,
    constraints: opts.constraints ?? [],
    children_ids: [],
    target_date: deadline,
    origin: "manual" as const,
    pace_snapshot: null,
    deadline,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    decomposition_depth: 0,
    specificity_score: null,
    created_at: now,
    updated_at: now,
  };

  if (!(await recordCliGoalCommandDecision(stateManager, {
    command: "pulseed goal add --dim",
    goalId,
    effect: "create_goal",
    targetSummary: `Create raw CLI goal "${title}".`,
    sourceId: `pulseed goal add --dim:${goalId}`,
    sourceEpoch: goalId,
    decisionReason: "Explicit CLI raw goal add was allowed to create a durable goal.",
    currentRefs: [
      ...(opts.parent_id ? [{ kind: "goal", ref: opts.parent_id }] : []),
      ...goal.constraints.map((constraint) => ({ kind: "constraint", ref: constraint })),
    ],
  }))) {
    return 1;
  }
  await stateManager.saveGoal(goal);

  if (opts.parent_id) {
    const parent = await stateManager.loadGoal(opts.parent_id);
    if (parent) {
      if (!(await recordCliGoalCommandDecision(stateManager, {
        command: "pulseed goal add --dim parent-link",
        goalId: parent.id,
        effect: "mutate_runtime_control",
        targetSummary: `Link raw CLI goal "${title}" under parent "${parent.title}".`,
        sourceId: `pulseed goal add --dim parent-link:${parent.id}:${goalId}`,
        sourceEpoch: goalId,
        decisionReason: "Explicit CLI raw goal add was allowed to update the parent goal lineage.",
        currentRefs: [
          { kind: "goal", ref: parent.id },
          { kind: "goal", ref: goalId },
        ],
      }))) {
        return 1;
      }
      await stateManager.saveGoal({
        ...parent,
        children_ids: [...parent.children_ids, goalId],
        updated_at: now,
      });
    } else {
      getCliLogger().warn(`Warning: parent goal not found: ${opts.parent_id}. Goal saved without parent link.`);
    }
  }

  await autoRegisterFileExistenceDataSources(stateManager, dimensions, opts.description || title, goalId, opts.constraints);
  await autoRegisterShellDataSources(stateManager, dimensions, goalId, opts.constraints);

  if (opts.json) {
    console.log(JSON.stringify({
      schema_version: "goal-add-result-v1",
      goal_id: goalId,
      title,
      status: goal.status,
      dimensions: dimensions.map((dimension) => ({
        name: dimension.name,
        label: dimension.label,
        threshold: dimension.threshold,
      })),
      goal,
      run_command: `pulseed run --goal ${goalId}`,
    }, null, 2));
    return 0;
  }

  console.log(`Goal registered successfully!`);
  console.log(`Goal ID:    ${goalId}`);
  console.log(`Title:      ${title}`);
  console.log(`Status:     active`);
  console.log(`Dimensions: ${dimensions.length}`);

  if (dimensions.length > 0) {
    console.log(`\nDimensions:`);
    for (const dim of dimensions) {
      console.log(`  - ${dim.label} (${dim.name}): ${JSON.stringify(dim.threshold)}`);
    }
  }

  console.log(`\nTo run the loop: pulseed run --goal ${goalId}`);
  return 0;
}
