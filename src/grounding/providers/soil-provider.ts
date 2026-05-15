import type { ToolCallContext } from "../../tools/types.js";
import { SoilQueryTool } from "../../tools/query/SoilQueryTool/SoilQueryTool.js";
import { TOOL_NAME as SOIL_QUERY_TOOL_NAME } from "../../tools/query/SoilQueryTool/constants.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolPermissionManager } from "../../tools/permission.js";
import { ConcurrencyController } from "../../tools/concurrency.js";
import {
  stableId,
  type PersonalAgentCallerPath,
  type PersonalAgentSourceKind,
  type RuntimeGraphRef,
} from "../../runtime/personal-agent/index.js";
import { SqliteSoilRepository } from "../../platform/soil/sqlite-repository.js";
import {
  correctionStateForTarget,
  summarizeMemoryCorrectionState,
  type MemoryCorrectionTargetState,
} from "../../platform/corrections/memory-correction-ledger.js";
import type { SoilRecord, SoilRecordStatus } from "../../platform/soil/contracts.js";
import type {
  GroundingProvider,
  GroundingProviderContext,
  GroundingPurpose,
  GroundingSoilResult,
  GroundingSurface,
} from "../contracts.js";
import { makeSection, makeSource, soilRootFromHome, resolveHomeDir } from "./helpers.js";

function buildToolContext(input: {
  context: GroundingProviderContext;
  cwd: string;
  homeDir: string;
  soilRootDir: string;
  query: string;
}): ToolCallContext {
  const sourceId = input.context.request.goalId
    ?? input.context.request.taskId
    ?? `soil-grounding:${stableId(`${input.context.profile.id}:${input.query}`)}`;
  const groundingRefs: RuntimeGraphRef[] = [
    { kind: "grounding_profile", ref: input.context.profile.id },
    { kind: "grounding_surface", ref: input.context.request.surface },
    { kind: "grounding_purpose", ref: input.context.request.purpose },
  ];
  return {
    cwd: input.cwd,
    goalId: input.context.request.goalId ?? "grounding",
    ...(input.context.request.taskId ? { taskId: input.context.request.taskId } : {}),
    trustBalance: 0,
    preApproved: false,
    approvalFn: async () => false,
    providerConfigBaseDir: input.homeDir,
    callId: `grounding:soil_query:${stableId(`${input.context.profile.id}:${input.soilRootDir}:${input.query}`)}`,
    personalAgentTrace: {
      callerPath: callerPathForGrounding(input.context.request.surface, input.context.request.purpose),
      sourceKind: sourceKindForGrounding(input.context.request.surface, input.context.request.purpose),
      sourceId,
      sourceEpoch: input.context.request.goalId ?? input.context.request.taskId ?? input.context.profile.id,
      highWatermark: input.context.request.workspaceRoot ?? input.homeDir,
      summary: "Soil grounding query assembled production memory context.",
      sourceRef: { kind: "grounding_query", ref: sourceId },
      currentRefs: groundingRefs,
      auditRefs: [{ kind: "soil_root", ref: input.soilRootDir }],
    },
  };
}

function buildSoilQueryExecutor(traceBaseDir: string): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(new SoilQueryTool());
  return new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({}),
    concurrency: new ConcurrencyController(),
    traceBaseDir,
  });
}

function callerPathForGrounding(surface: GroundingSurface, purpose: GroundingPurpose): PersonalAgentCallerPath {
  if (surface === "chat") return "chat_gateway_turn";
  if (purpose === "task_execution") return "task_execution";
  if (purpose === "verification") return "reflection";
  return "task_execution";
}

function sourceKindForGrounding(surface: GroundingSurface, purpose: GroundingPurpose): PersonalAgentSourceKind {
  if (surface === "chat") return "user_message";
  if (purpose === "verification") return "reflection_cycle";
  return "task_execution";
}

function shouldQuerySoil(query: string | undefined): query is string {
  return Boolean(query && query.trim().length >= 8);
}

function usageSummary(hit: { usageStats?: GroundingSoilResult["hits"][number]["usageStats"] }): string | null {
  const usage = hit.usageStats;
  if (!usage) return null;
  return `usage used=${usage.use_count} validated=${usage.validated_count} negative=${usage.negative_outcome_count}`;
}

const PROMPT_ELIGIBLE_SQLITE_STATUSES = new Set<SoilRecordStatus>([
  "active",
  "confirmed",
  "completed",
]);

function soilTargetRef(recordId: string) {
  return { kind: "soil_record" as const, id: recordId };
}

async function loadSoilAdmissionState(rootDir: string, result: GroundingSoilResult | null): Promise<{
  records: Map<string, SoilRecord>;
  corrections: Record<string, MemoryCorrectionTargetState>;
}> {
  const recordIds = [...new Set((result?.hits ?? []).map((hit) => hit.recordId).filter((id): id is string => Boolean(id)))];
  if (result?.retrievalSource !== "sqlite" || recordIds.length === 0) {
    return { records: new Map(), corrections: {} };
  }
  const repository = await SqliteSoilRepository.openExisting({ rootDir });
  if (!repository) return { records: new Map(), corrections: {} };
  try {
    const records = await repository.loadRecords({ record_ids: recordIds, active_only: false });
    const corrections = await repository.loadCorrections(recordIds);
    return {
      records: new Map(records.map((record) => [record.record_id, record])),
      corrections: summarizeMemoryCorrectionState(corrections),
    };
  } finally {
    repository.close();
  }
}

function canAdmitSoilHitForGrounding(input: {
  hit: GroundingSoilResult["hits"][number];
  result: GroundingSoilResult;
  record?: SoilRecord;
  correction?: MemoryCorrectionTargetState;
  userVisibleSink: boolean;
}): boolean {
  if (input.userVisibleSink) return false;
  if (input.result.retrievalSource !== "sqlite") return true;
  if (!input.hit.recordId || !input.record || !input.correction) return false;
  if (!PROMPT_ELIGIBLE_SQLITE_STATUSES.has(input.record.status)) return false;
  return input.correction.status === "active" && input.correction.active;
}

async function recordGroundingUsage(rootDir: string, recordIds: string[]): Promise<void> {
  const ids = [...new Set(recordIds.filter((recordId) => recordId.length > 0))];
  if (ids.length === 0) return;
  const repository = await SqliteSoilRepository.create({ rootDir });
  try {
    await repository.recordUsage(ids);
  } finally {
    repository.close();
  }
}

export const soilKnowledgeProvider: GroundingProvider = {
  key: "soil_knowledge",
  kind: "dynamic",
  async build(context) {
    const query = context.request.query ?? context.request.userMessage;
    if (!shouldQuerySoil(query)) {
      return null;
    }

    let result: GroundingSoilResult | null = null;
    const userVisibleSink = context.request.userVisibleSink ?? context.request.surface === "chat";
    const homeDir = resolveHomeDir(context.request.homeDir ?? context.deps.stateManager?.getBaseDir?.());
    const soilRootDir = soilRootFromHome(homeDir);
    const toolResult = await buildSoilQueryExecutor(homeDir).execute(SOIL_QUERY_TOOL_NAME, {
      query,
      rootDir: soilRootDir,
      limit: context.profile.budgets.maxKnowledgeHits,
    }, buildToolContext({
      context,
      cwd: context.request.workspaceRoot ?? process.cwd(),
      homeDir,
      soilRootDir,
      query,
    }));
    if (toolResult.success) {
      const data = toolResult.data as {
        retrievalSource: "sqlite" | "index" | "manifest";
        warnings: string[];
        hits: GroundingSoilResult["hits"];
      };
      result = {
        retrievalSource: data.retrievalSource,
        warnings: data.warnings,
        hits: data.hits,
      };
    }

    const hits = result?.hits ?? [];
    const admission = await loadSoilAdmissionState(soilRootDir, result);
    const admittedHits = hits
      .slice(0, context.profile.budgets.maxKnowledgeHits)
      .filter((hit) => {
        const record = hit.recordId ? admission.records.get(hit.recordId) : undefined;
        const correction = hit.recordId
          ? correctionStateForTarget(admission.corrections, soilTargetRef(hit.recordId))
          : undefined;
        return result
          ? canAdmitSoilHitForGrounding({ hit, result, record, correction, userVisibleSink })
          : false;
      });
    context.runtime.set("soil_hit_count", admittedHits.length);
    if (result?.retrievalSource === "sqlite") {
      await recordGroundingUsage(soilRootDir, admittedHits.map((hit) => hit.recordId ?? ""));
    }
    const lines = admittedHits.map((hit) => {
      const detail = [hit.summary, hit.snippet, usageSummary(hit)].filter(Boolean).join(" | ");
      return `- ${hit.title} (${hit.soilId})${detail ? `: ${detail}` : ""}`;
    });
    const warnings = result?.warnings ?? [];
    const promptWarnings = userVisibleSink ? [] : warnings;
    if (userVisibleSink && hits.length === 0 && warnings.length === 0) {
      return null;
    }
    const content = [
      lines.length > 0 ? lines.join("\n") : "No relevant Soil knowledge found.",
      promptWarnings.length > 0 ? `Warnings: ${promptWarnings.join("; ")}` : "",
    ].filter(Boolean).join("\n");

    return makeSection(
      "soil_knowledge",
      content,
      [
        makeSource("soil_knowledge", "soil_query", {
          type: lines.length > 0 ? "tool" : "none",
          trusted: true,
          accepted: true,
          retrievalId: lines.length > 0 ? `soil:${result?.retrievalSource ?? "unknown"}` : "none:soil_knowledge",
          metadata: { warnings },
        }),
      ],
    );
  },
};
