import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getPulseedDirPath } from "../../base/utils/paths.js";
import {
  ARC_AGI3_CLAIM_MODE,
  ARC_AGI3_REPLAY_BASE_URL,
  ARC_AGI3_RUN_SCHEMA_VERSION,
  ARC_AGI3_TOOL_POLICY_VERSION,
  ArcAgi3ActionLogEntrySchema,
  ArcAgi3RunArtifactSchema,
  ArcAgi3ScorecardSchema,
  type ArcAgi3ActionLogEntry,
  type ArcAgi3ModelIdentity,
  type ArcAgi3RunArtifact,
  type ArcAgi3Scorecard,
  type ArcAgi3Snapshot,
  type ArcAgi3StartInput,
} from "./types.js";

export interface ArcAgi3UsageMetadata {
  modelTurns?: number | null;
  toolCalls?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  agentLoopTotalTokens?: number | null;
  taskCycleTotalTokens?: number | null;
}

export class ArcAgi3ArtifactStore {
  constructor(private readonly baseDir: string = path.join(getPulseedDirPath(), "arc-agi-3", "runs")) {}

  newRunId(): string {
    return `arc3-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  }

  runDir(runId: string): string {
    return path.join(this.baseDir, runId);
  }

  runPath(runId: string): string {
    return path.join(this.runDir(runId), "run.json");
  }

  scorecardPath(runId: string): string {
    return path.join(this.runDir(runId), "scorecard.json");
  }

  async exists(runId: string): Promise<boolean> {
    try {
      await fs.access(this.runDir(runId));
      return true;
    } catch {
      return false;
    }
  }

  async assertRunIdAvailable(runId: string): Promise<void> {
    if (await this.exists(runId)) {
      throw new Error(`ARC-AGI-3 run_id already exists: ${runId}`);
    }
  }

  async create(input: {
    runId: string;
    startInput: ArcAgi3StartInput;
    modelIdentity: ArcAgi3ModelIdentity;
    cardId: string;
    snapshot: ArcAgi3Snapshot;
    pulseedCommit: string | null;
  }): Promise<ArcAgi3RunArtifact> {
    await this.assertRunIdAvailable(input.runId);
    const now = new Date().toISOString();
    const resetEntry = ArcAgi3ActionLogEntrySchema.parse({
      at: now,
      action: "RESET",
      state_after: input.snapshot.state,
      levels_completed_after: input.snapshot.levels_completed,
      available_actions_after: input.snapshot.available_actions,
      reasoning_provided: false,
    });
    const artifact = ArcAgi3RunArtifactSchema.parse({
      schema_version: ARC_AGI3_RUN_SCHEMA_VERSION,
      claim_mode: ARC_AGI3_CLAIM_MODE,
      run_id: input.runId,
      mode: "online_api",
      game_id: input.startInput.game_id,
      model_provider: input.modelIdentity.model_provider,
      model_id: input.modelIdentity.model_id,
      pulseed_commit: input.pulseedCommit,
      tool_policy_version: ARC_AGI3_TOOL_POLICY_VERSION,
      created_at: now,
      updated_at: now,
      card_id: input.cardId,
      guid: input.snapshot.guid,
      replay_url: replayUrl(input.cardId),
      action_count: 0,
      reset_count: 1,
      submitted_action_log: [resetEntry],
      latest_snapshot: input.snapshot,
      official_scorecard_id: input.cardId,
      official_score: null,
      scorecard: null,
      model_turns: null,
      tool_calls: null,
      token_usage: null,
      cost: null,
      failure_reason: null,
    });
    await this.writeArtifact(artifact);
    await this.appendAction(input.runId, resetEntry);
    await this.writeLatestFrame(input.runId, input.snapshot);
    return artifact;
  }

  async load(runId: string): Promise<ArcAgi3RunArtifact> {
    return ArcAgi3RunArtifactSchema.parse(JSON.parse(await fs.readFile(this.runPath(runId), "utf8")));
  }

  async recordAction(input: {
    runId: string;
    action: ArcAgi3ActionLogEntry["action"];
    x?: number;
    y?: number;
    snapshot: ArcAgi3Snapshot;
    reasoningProvided: boolean;
  }): Promise<ArcAgi3RunArtifact> {
    const current = await this.load(input.runId);
    const entry = ArcAgi3ActionLogEntrySchema.parse({
      at: new Date().toISOString(),
      action: input.action,
      ...(input.x !== undefined ? { x: input.x } : {}),
      ...(input.y !== undefined ? { y: input.y } : {}),
      state_after: input.snapshot.state,
      levels_completed_after: input.snapshot.levels_completed,
      available_actions_after: input.snapshot.available_actions,
      reasoning_provided: input.reasoningProvided,
    });
    const updated = ArcAgi3RunArtifactSchema.parse({
      ...current,
      guid: input.snapshot.guid,
      updated_at: entry.at,
      action_count: current.action_count + (input.action === "RESET" ? 0 : 1),
      reset_count: current.reset_count + (input.action === "RESET" ? 1 : 0),
      submitted_action_log: [...current.submitted_action_log, entry],
      latest_snapshot: input.snapshot,
      failure_reason: null,
    });
    await this.writeArtifact(updated);
    await this.appendAction(input.runId, entry);
    await this.writeLatestFrame(input.runId, input.snapshot);
    return updated;
  }

  async recordScorecard(runId: string, scorecard: ArcAgi3Scorecard): Promise<ArcAgi3RunArtifact> {
    const current = await this.load(runId);
    const sanitizedScorecard = sanitizeScorecard(scorecard);
    const updated = ArcAgi3RunArtifactSchema.parse({
      ...current,
      updated_at: new Date().toISOString(),
      official_score: typeof sanitizedScorecard.score === "number" ? sanitizedScorecard.score : current.official_score,
      scorecard: sanitizedScorecard,
      failure_reason: null,
    });
    await this.writeArtifact(updated);
    await this.writeScorecard(runId, sanitizedScorecard);
    return updated;
  }

  async recordFailure(runId: string, reason: string): Promise<ArcAgi3RunArtifact | null> {
    try {
      const current = await this.load(runId);
      const updated = ArcAgi3RunArtifactSchema.parse({
        ...current,
        updated_at: new Date().toISOString(),
        failure_reason: reason,
      });
      await this.writeArtifact(updated);
      return updated;
    } catch {
      return null;
    }
  }

  async recordUsage(runId: string, usage: ArcAgi3UsageMetadata): Promise<ArcAgi3RunArtifact | null> {
    try {
      const current = await this.load(runId);
      const updated = ArcAgi3RunArtifactSchema.parse({
        ...current,
        updated_at: new Date().toISOString(),
        model_turns: finiteNonNegativeIntegerOrNull(usage.modelTurns, current.model_turns),
        tool_calls: finiteNonNegativeIntegerOrNull(usage.toolCalls, current.tool_calls),
        token_usage: {
          input_tokens: finiteNonNegativeIntegerOrNull(usage.inputTokens, current.token_usage?.input_tokens ?? null),
          output_tokens: finiteNonNegativeIntegerOrNull(usage.outputTokens, current.token_usage?.output_tokens ?? null),
          agent_loop_total_tokens: finiteNonNegativeIntegerOrNull(
            usage.agentLoopTotalTokens,
            current.token_usage?.agent_loop_total_tokens ?? null
          ),
          task_cycle_total_tokens: finiteNonNegativeIntegerOrNull(
            usage.taskCycleTotalTokens,
            current.token_usage?.task_cycle_total_tokens ?? null
          ),
          recorded_at: new Date().toISOString(),
        },
      });
      await this.writeArtifact(updated);
      return updated;
    } catch {
      return null;
    }
  }

  private async writeArtifact(artifact: ArcAgi3RunArtifact): Promise<void> {
    await fs.mkdir(this.runDir(artifact.run_id), { recursive: true });
    await fs.writeFile(this.runPath(artifact.run_id), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  }

  private async writeScorecard(runId: string, scorecard: ArcAgi3Scorecard): Promise<void> {
    await fs.mkdir(this.runDir(runId), { recursive: true });
    await fs.writeFile(this.scorecardPath(runId), `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
  }

  private async writeLatestFrame(runId: string, snapshot: ArcAgi3Snapshot): Promise<void> {
    await fs.mkdir(this.runDir(runId), { recursive: true });
    await fs.writeFile(path.join(this.runDir(runId), "latest-frame.json"), `${JSON.stringify(snapshot)}\n`, "utf8");
  }

  private async appendAction(runId: string, entry: ArcAgi3ActionLogEntry): Promise<void> {
    await fs.mkdir(this.runDir(runId), { recursive: true });
    await fs.appendFile(path.join(this.runDir(runId), "actions.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  }
}

function finiteNonNegativeIntegerOrNull(value: number | null | undefined, fallback: number | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

export function replayUrl(cardId: string): string {
  return `${ARC_AGI3_REPLAY_BASE_URL}/${encodeURIComponent(cardId)}`;
}

function sanitizeScorecard(scorecard: ArcAgi3Scorecard): ArcAgi3Scorecard {
  return ArcAgi3ScorecardSchema.parse(redactSensitiveScorecardFields(scorecard));
}

function redactSensitiveScorecardFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveScorecardFields(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSensitiveScorecardKey(key))
      .map(([key, entry]) => [key, redactSensitiveScorecardFields(entry)]),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensitiveScorecardKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized === "apikey"
    || normalized === "authorization"
    || normalized === "auth"
    || normalized === "cookie"
    || normalized === "session"
    || normalized === "token"
    || normalized === "accesstoken"
    || normalized === "refreshtoken"
    || normalized === "secret"
    || normalized === "userid"
    || normalized === "user"
    || normalized === "username"
    || normalized === "email"
    || normalized === "account"
    || normalized === "accountid"
    || normalized === "identity";
}
