import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../types.js";
import { loadProviderConfig } from "../../base/llm/provider-config.js";
import { ArcAgi3ArtifactStore } from "./artifacts.js";
import { ArcAgi3HttpClient, type ArcAgi3RestClient } from "./client.js";
import {
  ARC_AGI3_CLAIM_MODE,
  ARC_AGI3_TOOL_POLICY_VERSION,
  ArcAgi3ActInputSchema,
  ArcAgi3FinishInputSchema,
  ArcAgi3ListGamesInputSchema,
  ArcAgi3ModelIdentitySchema,
  ArcAgi3ObserveInputSchema,
  ArcAgi3PolicyInputSchema,
  ArcAgi3ScorecardInputSchema,
  ArcAgi3StartInputSchema,
  type ArcAgi3ActInput,
  type ArcAgi3FinishInput,
  type ArcAgi3ListGamesInput,
  type ArcAgi3ModelIdentity,
  type ArcAgi3ObserveInput,
  type ArcAgi3PolicyInput,
  type ArcAgi3ScorecardInput,
  type ArcAgi3StartInput,
} from "./types.js";

export interface ArcAgi3ToolDeps {
  client?: ArcAgi3RestClient;
  clientFactory?: () => ArcAgi3RestClient;
  artifactStore?: ArcAgi3ArtifactStore;
  pulseedCommit?: string | null;
  providerConfigLoader?: typeof loadProviderConfig;
}

abstract class ArcAgi3ToolBase<TInput> implements ITool<TInput> {
  abstract readonly metadata: ToolMetadata;
  abstract readonly inputSchema: ITool<TInput>["inputSchema"];
  protected readonly artifactStore: ArcAgi3ArtifactStore;
  private cachedClient?: ArcAgi3RestClient;

  constructor(protected readonly deps: ArcAgi3ToolDeps = {}) {
    this.artifactStore = deps.artifactStore ?? new ArcAgi3ArtifactStore();
  }

  protected client(): ArcAgi3RestClient {
    this.cachedClient ??= this.deps.client ?? this.deps.clientFactory?.() ?? new ArcAgi3HttpClient();
    return this.cachedClient;
  }

  protected ok(data: unknown, summary: string, startTime: number, artifacts?: string[]): ToolResult {
    return {
      success: true,
      data,
      summary,
      durationMs: Date.now() - startTime,
      ...(artifacts ? { artifacts } : {}),
    };
  }

  protected fail(error: string, startTime: number, artifacts?: string[]): ToolResult {
    return {
      success: false,
      data: null,
      summary: error,
      error,
      durationMs: Date.now() - startTime,
      ...(artifacts ? { artifacts } : {}),
    };
  }

  abstract call(input: TInput, context: ToolCallContext): Promise<ToolResult>;

  checkPermissions(_input: TInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return Promise.resolve({ status: "allowed" });
  }

  isConcurrencySafe(_input: TInput): boolean {
    return false;
  }

  description(_context?: ToolDescriptionContext): string {
    return [
      "ARC-AGI-3 official-online benchmark tool.",
      "Use only within the arc_agi_3 profile; this tool enforces the ARC action interface and writes PulSeed ARC artifacts.",
    ].join(" ");
  }
}

export class ArcAgi3ListGamesTool extends ArcAgi3ToolBase<ArcAgi3ListGamesInput> {
  readonly metadata: ToolMetadata = {
    name: "arc_agi3_list_games",
    aliases: [],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 2,
    maxOutputChars: 20_000,
    tags: ["arc_agi_3", "benchmark", "network", "read"],
    requiresNetwork: true,
    activityCategory: "read",
  };
  readonly inputSchema = ArcAgi3ListGamesInputSchema;

  description(): string {
    return "List ARC-AGI-3 online games using the official API. This does not expose generic web or HTTP access.";
  }

  async call(_input: ArcAgi3ListGamesInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const games = await this.client().listGames(context.abortSignal);
      return this.ok({ games }, `Found ${games.length} ARC-AGI-3 game(s).`, startTime);
    } catch (err) {
      return this.fail(formatError(err), startTime);
    }
  }
}

export class ArcAgi3StartTool extends ArcAgi3ToolBase<ArcAgi3StartInput> {
  readonly metadata: ToolMetadata = {
    name: "arc_agi3_start",
    aliases: [],
    permissionLevel: "write_remote",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 30_000,
    tags: ["arc_agi_3", "benchmark", "network", "remote"],
    requiresNetwork: true,
    activityCategory: "command",
  };
  readonly inputSchema = ArcAgi3StartInputSchema;

  description(): string {
    return "Open an ARC-AGI-3 online scorecard, RESET the requested game, and create a PulSeed run artifact. API keys are read only from host env/config.";
  }

  async call(input: ArcAgi3StartInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const runId = input.run_id ?? this.artifactStore.newRunId();
    let openedCardId: string | null = null;
    let client: ArcAgi3RestClient | null = null;
    let artifactCreateStarted = false;
    try {
      await this.artifactStore.assertRunIdAvailable(runId);
      client = this.client();
      const modelIdentity = await resolveArcAgi3ModelIdentity(this.deps, context);
      const scorecard = await client.openScorecard({
        source_url: input.source_url,
        tags: unique(["pulseed", "arc_agi_3", ARC_AGI3_CLAIM_MODE, ...(input.tags ?? [])]),
        opaque: {
          claim_mode: ARC_AGI3_CLAIM_MODE,
          tool_policy_version: ARC_AGI3_TOOL_POLICY_VERSION,
          model_provider: modelIdentity.model_provider,
          model_id: modelIdentity.model_id,
        },
      }, context.abortSignal);
      openedCardId = scorecard.card_id;
      const snapshot = await client.reset({
        game_id: input.game_id,
        card_id: scorecard.card_id,
      }, context.abortSignal);
      artifactCreateStarted = true;
      const artifact = await this.artifactStore.create({
        runId,
        startInput: input,
        modelIdentity,
        cardId: scorecard.card_id,
        snapshot,
        pulseedCommit: this.deps.pulseedCommit ?? process.env["PULSEED_COMMIT"] ?? null,
      });
      return this.ok({
        run_id: runId,
        game_id: input.game_id,
        model_provider: modelIdentity.model_provider,
        model_id: modelIdentity.model_id,
        card_id: scorecard.card_id,
        guid: snapshot.guid,
        replay_url: artifact.replay_url,
        latest_snapshot: snapshot,
        artifact_path: this.artifactStore.runPath(runId),
        claim_mode: ARC_AGI3_CLAIM_MODE,
      }, `Started ARC-AGI-3 online run ${runId} for ${input.game_id}.`, startTime, [this.artifactStore.runPath(runId)]);
    } catch (err) {
      if (client && openedCardId) {
        await client.closeScorecard(openedCardId).catch(() => undefined);
      }
      if (artifactCreateStarted && openedCardId) {
        const currentArtifact = await this.artifactStore.load(runId).catch(() => null);
        if (currentArtifact?.card_id === openedCardId) {
          await this.artifactStore.recordFailure(runId, formatError(err));
        }
      }
      return this.fail(formatError(err), startTime);
    }
  }
}

export class ArcAgi3ObserveTool extends ArcAgi3ToolBase<ArcAgi3ObserveInput> {
  readonly metadata: ToolMetadata = {
    name: "arc_agi3_observe",
    aliases: [],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 4,
    maxOutputChars: 40_000,
    tags: ["arc_agi_3", "benchmark", "read"],
    activityCategory: "read",
  };
  readonly inputSchema = ArcAgi3ObserveInputSchema;

  description(): string {
    return "Read the latest local ARC-AGI-3 frame/state artifact for a PulSeed ARC run.";
  }

  async call(input: ArcAgi3ObserveInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const artifact = await this.artifactStore.load(input.run_id);
      return this.ok({
        run_id: input.run_id,
        game_id: artifact.game_id,
        guid: artifact.guid,
        state: artifact.latest_snapshot?.state ?? null,
        levels_completed: artifact.latest_snapshot?.levels_completed ?? null,
        win_levels: artifact.latest_snapshot?.win_levels ?? null,
        available_actions: artifact.latest_snapshot?.available_actions ?? [],
        latest_snapshot: artifact.latest_snapshot,
        action_count: artifact.action_count,
        reset_count: artifact.reset_count,
        replay_url: artifact.replay_url,
        claim_mode: artifact.claim_mode,
      }, `Observed ARC-AGI-3 run ${input.run_id}.`, startTime, [this.artifactStore.runPath(input.run_id)]);
    } catch (err) {
      return this.fail(formatError(err), startTime);
    }
  }
}

export class ArcAgi3ActTool extends ArcAgi3ToolBase<ArcAgi3ActInput> {
  readonly metadata: ToolMetadata = {
    name: "arc_agi3_act",
    aliases: [],
    permissionLevel: "write_remote",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 40_000,
    tags: ["arc_agi_3", "benchmark", "network", "remote"],
    requiresNetwork: true,
    activityCategory: "command",
  };
  readonly inputSchema = ArcAgi3ActInputSchema;

  description(): string {
    return "Submit exactly one ARC-AGI-3 action: RESET or ACTION1..ACTION7. ACTION6 requires x,y coordinates in the 0-63 range.";
  }

  async call(input: ArcAgi3ActInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const artifact = await this.artifactStore.load(input.run_id);
      if (!artifact.guid) {
        throw new Error("ARC run has no active guid. Start the run before acting.");
      }
      const client = this.client();
      const snapshot = input.action === "RESET"
        ? await client.reset({
            game_id: artifact.game_id,
            card_id: artifact.card_id,
            guid: artifact.guid,
          }, context.abortSignal)
        : await client.action({
            action: input.action,
            game_id: artifact.game_id,
            guid: artifact.guid,
            ...(input.x !== undefined ? { x: input.x } : {}),
            ...(input.y !== undefined ? { y: input.y } : {}),
            ...(input.reasoning ? { reasoning: input.reasoning } : {}),
          }, context.abortSignal);
      const updated = await this.artifactStore.recordAction({
        runId: input.run_id,
        action: input.action,
        ...(input.x !== undefined ? { x: input.x } : {}),
        ...(input.y !== undefined ? { y: input.y } : {}),
        snapshot,
        reasoningProvided: input.reasoning !== undefined,
      });
      return this.ok({
        run_id: input.run_id,
        action: input.action,
        latest_snapshot: snapshot,
        action_count: updated.action_count,
        reset_count: updated.reset_count,
        replay_url: updated.replay_url,
        claim_mode: updated.claim_mode,
      }, `Submitted ${input.action} for ARC-AGI-3 run ${input.run_id}.`, startTime, [this.artifactStore.runPath(input.run_id)]);
    } catch (err) {
      await this.artifactStore.recordFailure(input.run_id, formatError(err));
      return this.fail(formatError(err), startTime, [this.artifactStore.runPath(input.run_id)]);
    }
  }
}

export class ArcAgi3FinishTool extends ArcAgi3ToolBase<ArcAgi3FinishInput> {
  readonly metadata: ToolMetadata = {
    name: "arc_agi3_finish",
    aliases: [],
    permissionLevel: "write_remote",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 30_000,
    tags: ["arc_agi_3", "benchmark", "network", "remote"],
    requiresNetwork: true,
    activityCategory: "command",
  };
  readonly inputSchema = ArcAgi3FinishInputSchema;

  description(): string {
    return "Close or retrieve the ARC-AGI-3 scorecard and persist the final PulSeed run artifact.";
  }

  async call(input: ArcAgi3FinishInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const artifact = await this.artifactStore.load(input.run_id);
      const scorecard = input.close_scorecard
        ? await this.client().closeScorecard(artifact.card_id, context.abortSignal)
        : await this.client().retrieveScorecard(artifact.card_id, context.abortSignal);
      const updated = await this.artifactStore.recordScorecard(input.run_id, scorecard);
      return this.ok({
        run_id: input.run_id,
        card_id: artifact.card_id,
        replay_url: updated.replay_url,
        official_score: updated.official_score,
        scorecard: updated.scorecard,
        artifact_path: this.artifactStore.runPath(input.run_id),
        claim_mode: updated.claim_mode,
      }, `Finished ARC-AGI-3 run ${input.run_id} with community online scorecard ${artifact.card_id}.`, startTime, [
        this.artifactStore.runPath(input.run_id),
        this.artifactStore.scorecardPath(input.run_id),
      ]);
    } catch (err) {
      await this.artifactStore.recordFailure(input.run_id, formatError(err));
      return this.fail(formatError(err), startTime, [this.artifactStore.runPath(input.run_id)]);
    }
  }
}

export class ArcAgi3ScorecardTool extends ArcAgi3ToolBase<ArcAgi3ScorecardInput> {
  readonly metadata: ToolMetadata = {
    name: "arc_agi3_scorecard",
    aliases: [],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 2,
    maxOutputChars: 30_000,
    tags: ["arc_agi_3", "benchmark", "network", "read"],
    requiresNetwork: true,
    activityCategory: "read",
  };
  readonly inputSchema = ArcAgi3ScorecardInputSchema;

  description(): string {
    return "Retrieve the current ARC-AGI-3 scorecard for a PulSeed ARC run and persist it locally.";
  }

  async call(input: ArcAgi3ScorecardInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const artifact = await this.artifactStore.load(input.run_id);
      const scorecard = input.game_only
        ? await this.client().retrieveScorecardForGame(artifact.card_id, artifact.game_id, context.abortSignal)
        : await this.client().retrieveScorecard(artifact.card_id, context.abortSignal);
      const updated = await this.artifactStore.recordScorecard(input.run_id, scorecard);
      return this.ok({
        run_id: input.run_id,
        scorecard: updated.scorecard,
        official_score: updated.official_score,
        replay_url: updated.replay_url,
        claim_mode: updated.claim_mode,
      }, `Retrieved ARC-AGI-3 scorecard for ${input.run_id}.`, startTime, [
        this.artifactStore.runPath(input.run_id),
        this.artifactStore.scorecardPath(input.run_id),
      ]);
    } catch (err) {
      await this.artifactStore.recordFailure(input.run_id, formatError(err));
      return this.fail(formatError(err), startTime, [this.artifactStore.runPath(input.run_id)]);
    }
  }
}

export class ArcAgi3PolicyTool extends ArcAgi3ToolBase<ArcAgi3PolicyInput> {
  readonly metadata: ToolMetadata = {
    name: "arc_agi3_policy",
    aliases: [],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 4,
    maxOutputChars: 12_000,
    tags: ["arc_agi_3", "benchmark", "policy", "read"],
    activityCategory: "read",
  };
  readonly inputSchema = ArcAgi3PolicyInputSchema;

  description(): string {
    return "Explain the active PulSeed ARC-AGI-3 policy: community online scorecard, typed ARC actions only, no generic web research.";
  }

  async call(_input: ArcAgi3PolicyInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    return this.ok({
      profile: "arc_agi_3",
      claim_mode: ARC_AGI3_CLAIM_MODE,
      tool_policy_version: ARC_AGI3_TOOL_POLICY_VERSION,
      allowed_action_interface: ["RESET", "ACTION1", "ACTION2", "ACTION3", "ACTION4", "ACTION5", "ACTION6", "ACTION7"],
      action6_coordinate_range: { x: [0, 63], y: [0, 63] },
      prohibited_tools: [
        "research_web",
        "research_answer_with_sources",
        "http_fetch",
        "web_search",
        "browser tools",
        "shell",
        "kaggle tools",
      ],
      claim_boundary: "Community Online API scorecard only; not an official ARC Prize verification claim and not an official Kaggle submission run.",
    }, "ARC-AGI-3 policy is active.", startTime);
  }
}

export function createArcAgi3Tools(deps?: ArcAgi3ToolDeps): ITool[] {
  const sharedClientFactory = makeSharedArcAgi3ClientFactory(deps);
  const restDeps: ArcAgi3ToolDeps = { ...(deps ?? {}) };
  delete restDeps.client;
  delete restDeps.clientFactory;
  const sharedDeps: ArcAgi3ToolDeps = {
    ...restDeps,
    clientFactory: sharedClientFactory,
  };
  return [
    new ArcAgi3ListGamesTool(sharedDeps),
    new ArcAgi3StartTool(sharedDeps),
    new ArcAgi3ObserveTool(sharedDeps),
    new ArcAgi3ActTool(sharedDeps),
    new ArcAgi3FinishTool(sharedDeps),
    new ArcAgi3ScorecardTool(sharedDeps),
    new ArcAgi3PolicyTool(sharedDeps),
  ];
}

function makeSharedArcAgi3ClientFactory(deps?: ArcAgi3ToolDeps): () => ArcAgi3RestClient {
  let sharedClient = deps?.client;
  return () => {
    sharedClient ??= deps?.clientFactory?.() ?? new ArcAgi3HttpClient();
    return sharedClient;
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function resolveArcAgi3ModelIdentity(
  deps: ArcAgi3ToolDeps,
  context: ToolCallContext,
): Promise<ArcAgi3ModelIdentity> {
  const providerConfig = await (deps.providerConfigLoader ?? loadProviderConfig)({
    baseDir: context.providerConfigBaseDir,
    saveMigration: false,
  });
  return ArcAgi3ModelIdentitySchema.parse({
    model_provider: providerConfig.provider,
    model_id: providerConfig.model,
  });
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
