// ─── pulseed suggest and improve commands ───

import * as path from "node:path";
import { parseArgs } from "node:util";

import { StateManager } from "../../../base/state/state-manager.js";
import { CharacterConfigManager } from "../../../platform/traits/character-config.js";
import { ensureProviderConfig } from "../ensure-api-key.js";
import { buildLLMClient } from "../../../base/llm/provider-factory.js";
import { ReportingEngine } from "../../../reporting/reporting-engine.js";
import { CapabilityDetector } from "../../../platform/observation/capability-detector.js";
import { buildDeps } from "../setup.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";
import {
  normalizeSuggestPayload,
  generateSuggestOutput,
  gatherProjectContext,
  hasRepositorySuggestionSurface,
} from "./suggest-normalizer.js";
import { SuggestTimeoutError } from "../../../orchestrator/goal/goal-suggest.js";
import type { GoalSuggestionSurface } from "../../../orchestrator/goal/goal-suggest.js";
import {
  buildAutoApprovalFn,
  buildLoopLogger,
  buildProgressHandler,
  runLoopWithSignals,
} from "../utils/loop-runner.js";
import { recordExplicitCommandDecision, stableId } from "../../../runtime/personal-agent/index.js";
import {
  allocateCliGoalId,
  recordCliGoalCommandDecision,
} from "./goal-personal-agent-trace.js";

// ─── Shared setup helper ───

async function buildSuggestContext(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager
): Promise<{
  deps: Awaited<ReturnType<typeof buildDeps>>;
  existingTitles: string[];
  capabilityDetector: CapabilityDetector;
}> {
  const deps = await buildDeps(stateManager, characterConfigManager);

  const existingGoalIds = await deps.stateManager.listGoalIds();
  const existingTitles: string[] = [];
  for (const id of existingGoalIds) {
    const goal = await deps.stateManager.loadGoal(id);
    if (goal?.title) {
      existingTitles.push(goal.title);
    }
  }

  const llmClient = await buildLLMClient();
  const reportingEngine = new ReportingEngine(stateManager);
  const capabilityDetector = new CapabilityDetector(stateManager, llmClient, reportingEngine);

  return { deps, existingTitles, capabilityDetector };
}

// ─── cmdSuggest ───

export function parseSuggestionLimit(raw: string | undefined, label = "--max"): number {
  const normalized = raw?.trim() ?? "";
  if (!/^[0-9]+$/.test(normalized)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export async function cmdSuggest(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager,
  args: string[]
): Promise<number> {
  const logger = getCliLogger();
  let values: { max?: string; path?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: {
        max: { type: "string", short: "n", default: "5" },
        path: { type: "string", short: "p", default: "." },
      },
      allowPositionals: true,
      strict: false,
    }) as { values: { max?: string; path?: string }; positionals: string[] });
  } catch (err) {
    logger.error(formatOperationError("parse suggest command arguments", err));
    return 1;
  }

  const context = positionals[0];
  if (!context) {
    logger.error('Usage: pulseed suggest "<context>" [--max N] [--path <dir>]');
    return 1;
  }

  let maxSuggestions: number;
  try {
    maxSuggestions = parseSuggestionLimit(values.max ?? "5");
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  try {
    await ensureProviderConfig();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let setupResult: Awaited<ReturnType<typeof buildSuggestContext>>;
  try {
    setupResult = await buildSuggestContext(stateManager, characterConfigManager);
  } catch (err) {
    logger.error(formatOperationError("initialise suggest dependencies", err));
    return 1;
  }

  const { deps, existingTitles, capabilityDetector } = setupResult;
  const targetPath = values.path?.trim() ? values.path : ".";
  const targetFsPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(process.cwd(), targetPath);
  const repoFiles: string[] = [];
  const repositorySurface = hasRepositorySuggestionSurface(targetFsPath);
  const suggestionSurface: GoalSuggestionSurface = repositorySurface ? "repository" : "general";

  console.log("Generating goal suggestions...\n");

  let suggestRaw: unknown;
  try {
    suggestRaw = await generateSuggestOutput(
      deps.goalNegotiator.suggestGoals.bind(deps.goalNegotiator),
      context,
      { maxSuggestions, existingGoals: existingTitles, repoPath: targetPath, suggestionSurface, capabilityDetector }
    );
  } catch (err) {
    if (err instanceof SuggestTimeoutError) {
      logger.error(`[PulSeed Suggest] Error: ${(err as Error).message}. The model may be slow or unreachable — try again or increase the timeout.`);
    } else {
      logger.error(formatOperationError("generate goal suggestions", err));
    }
    return 1;
  }

  const suggestions = Array.isArray(suggestRaw) ? { suggestions: suggestRaw } : suggestRaw;
  const finalPayload = normalizeSuggestPayload(suggestions, targetPath, targetPath, context, maxSuggestions, repoFiles, repositorySurface, repositorySurface);
  console.log(JSON.stringify(finalPayload, null, 2));

  return 0;
}

// ─── cmdImprove ───

export async function cmdImprove(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager,
  args: string[]
): Promise<number> {
  const logger = getCliLogger();
  let values: { auto?: boolean; max?: string; yes?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: {
        auto: { type: "boolean", default: false },
        max: { type: "string", short: "n", default: "3" },
        yes: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: false,
    }) as { values: { auto?: boolean; max?: string; yes?: boolean }; positionals: string[] });
  } catch (err) {
    logger.error(formatOperationError("parse improve command arguments", err));
    return 1;
  }

  const targetPath = positionals[0] || ".";
  const targetFsPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(process.cwd(), targetPath);
  let maxSuggestions: number;
  try {
    maxSuggestions = parseSuggestionLimit(values.max ?? "3");
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  console.log(`\n[PulSeed Improve] Analyzing ${targetPath}...\n`);

  try {
    await ensureProviderConfig();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let setupResult: Awaited<ReturnType<typeof buildSuggestContext>>;
  try {
    setupResult = await buildSuggestContext(stateManager, characterConfigManager);
  } catch (err) {
    logger.error(formatOperationError("initialise improve dependencies", err));
    return 1;
  }

  const { deps, existingTitles, capabilityDetector } = setupResult;
  const context = await gatherProjectContext(targetPath);
  const repoFiles: string[] = [];
  const repositorySurface = hasRepositorySuggestionSurface(targetFsPath);
  const suggestionSurface: GoalSuggestionSurface = repositorySurface ? "repository" : "general";

  let rawSuggestOutput: unknown;
  try {
    rawSuggestOutput = await generateSuggestOutput(
      deps.goalNegotiator.suggestGoals.bind(deps.goalNegotiator),
      context,
      { maxSuggestions, existingGoals: existingTitles, repoPath: targetPath, suggestionSurface, capabilityDetector }
    );
  } catch (err) {
    if (err instanceof SuggestTimeoutError) {
      logger.error(`[PulSeed Improve] Error: ${(err as Error).message}. The model may be slow or unreachable — try again or increase the timeout.`);
    } else {
      logger.error(formatOperationError("generate improvement suggestions", err));
    }
    return 1;
  }

  const rawSuggestions = Array.isArray(rawSuggestOutput) ? { suggestions: rawSuggestOutput } : rawSuggestOutput;
  const normalizedPayload = normalizeSuggestPayload(rawSuggestions, targetPath, targetPath, context, maxSuggestions, repoFiles, repositorySurface, repositorySurface);
  const suggestions = normalizedPayload.suggestions;

  if (suggestions.length === 0) {
    console.log("No improvement goals found for the given path.");
    return 0;
  }

  // Select goal
  let selectedIndex = 0;
  if (values.auto) {
    console.log(`[Auto] Selected: ${suggestions[0]?.title ?? ""}`);
  } else {
    console.log("=== Suggested Improvements ===\n");
    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i];
      if (!s) continue;
      console.log(`${i + 1}. ${s.title}`);
      console.log(`   ${s.rationale}\n`);
    }
    if (values.yes) {
      selectedIndex = 0;
      console.log(`[--yes] Auto-selecting: ${suggestions[0]?.title ?? ""}\n`);
    } else {
      selectedIndex = 0;
      console.log(`Selected: ${suggestions[0]?.title ?? ""}\n`);
    }
  }

  const selected = suggestions[selectedIndex];
  if (!selected) {
    logger.error("Error: no suggestion available at index 0.");
    return 1;
  }

  // Negotiate the selected goal
  const selectedDescription = selected.steps.join("\n");
  console.log(`[PulSeed Improve] Negotiating goal: "${selected.title}"...`);
  let goal: Awaited<ReturnType<typeof deps.goalNegotiator.negotiate>>["goal"];
  let response: Awaited<ReturnType<typeof deps.goalNegotiator.negotiate>>["response"];
  try {
    const goalId = await allocateCliGoalId(stateManager, {
      command: "pulseed improve",
      selectedTitle: selected.title,
      selectedDescription,
      maxSuggestions,
    });
    if (!(await recordCliGoalCommandDecision(stateManager, {
      command: "pulseed improve goal",
      goalId,
      effect: "create_goal",
      targetSummary: `Create improvement goal "${selected.title}".`,
      sourceId: `pulseed improve goal:${goalId}`,
      sourceEpoch: goalId,
      decisionReason: "Explicit CLI improve command was allowed to create a durable improvement goal.",
      currentRefs: [{ kind: "suggestion", ref: selected.title }],
    }))) {
      return 1;
    }
    ({ goal, response } = await deps.goalNegotiator.negotiate(selectedDescription, {
      constraints: [],
      timeoutMs: 120_000,
      goalId,
    }));
  } catch (err) {
    const isTimeout = err instanceof Error && err.message.includes("timed out");
    if (isTimeout) {
      logger.warn(`Goal negotiation timed out for "${selected.title}". Skipping.`);
      return 1;
    }
    logger.error(formatOperationError(`negotiate goal "${selected.title}"`, err));
    return 1;
  }

  const responseType = (response as { type: string }).type;
  if (responseType === "reject") {
    logger.error(`Goal negotiation rejected: ${response.message}`);
    return 1;
  }

  console.log(`[PulSeed Improve] Goal registered: ${goal.id}`);
  console.log(`  Response: ${responseType} — ${response.message}\n`);

  // Run the loop if --auto or --yes
  if (values.auto || values.yes) {
    console.log(`[PulSeed Improve] Starting improvement loop for goal ${goal.id}...`);
    const loopLogger = buildLoopLogger();
    const loopDeps = await buildDeps(
      stateManager,
      characterConfigManager,
      { maxIterations: maxSuggestions },
      buildAutoApprovalFn(),
      loopLogger,
      buildProgressHandler()
    );
    try {
      const runReplayKey = [
        "cli_improve_run",
        goal.id,
        maxSuggestions,
      ].join(":");
      await recordExplicitCommandDecision({
        baseDir: stateManager.getBaseDir(),
        surface: "cli",
        command: "pulseed improve --auto",
        sourceId: `pulseed improve --auto:${goal.id}`,
        sourceEpoch: goal.updated_at,
        replayKey: runReplayKey,
        target: {
          kind: "run",
          ref: { kind: "run", ref: `run:cli:${stableId(runReplayKey)}` },
          effect: "create_run",
          summary: `Run improvement goal "${goal.title}" from CLI.`,
        },
        decisionReason: "Explicit CLI improve auto-run was allowed to start durable goal work.",
        capabilityRefs: [{ kind: "capability", ref: "durable_loop_goal_run" }],
        currentRefs: [{ kind: "goal", ref: goal.id }],
      });
      const result = await runLoopWithSignals(loopDeps.coreLoop, goal.id);
      console.log(`[PulSeed Improve] Loop completed for goal ${goal.id}`);
      if (result.finalStatus === "stalled") {
        logger.error("Improvement loop stalled. No further progress detected.");
        return 2;
      }
      if (result.finalStatus === "error") {
        logger.error("Improvement loop ended with an error.");
        return 1;
      }
    } catch (err) {
      logger.error(formatOperationError(`run improvement loop for goal "${goal.id}"`, err));
      return 1;
    }
  } else {
    console.log(`Goal created. Run with: pulseed run --goal ${goal.id}`);
  }

  return 0;
}
