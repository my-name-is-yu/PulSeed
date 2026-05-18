import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentCompletionArtifact } from "../../orchestrator/execution/adapter-layer.js";
import type {
  TaskCompletionArtifactFinalizer,
  TaskCompletionArtifactFinalizerResult,
} from "../../orchestrator/execution/task/task-completion-finalizer.js";
import { ArcAgi3ArtifactStore, type ArcAgi3UsageMetadata } from "./artifacts.js";
import { ArcAgi3HttpClient, type ArcAgi3RestClient } from "./client.js";
import { ARC_AGI3_RUN_SCHEMA_VERSION, ArcAgi3RunArtifactSchema, type ArcAgi3RunArtifact } from "./types.js";

export interface ArcAgi3CompletionArtifactVerification {
  applicable: boolean;
  passed: boolean;
  description: string;
  artifacts: string[];
  metricValues: Map<string, number>;
}

export interface ArcAgi3CompletionFinalizerDeps {
  client?: ArcAgi3RestClient;
  clientFactory?: () => ArcAgi3RestClient;
}

export async function verifyArcAgi3CompletionArtifacts(
  artifacts: readonly AgentCompletionArtifact[] | undefined,
): Promise<ArcAgi3CompletionArtifactVerification> {
  const refs = await resolveArcAgi3RunArtifactRefs(artifacts);
  if (refs.length === 0) {
    return {
      applicable: false,
      passed: false,
      description: "No ARC-AGI-3 completion artifact was produced.",
      artifacts: [],
      metricValues: new Map(),
    };
  }

  const passed = refs.filter((ref) => isFinishedArcAgi3RunArtifact(ref.artifact));
  const failures = refs
    .filter((ref) => !isFinishedArcAgi3RunArtifact(ref.artifact))
    .map((ref) => {
      const reason = ref.artifact.failure_reason
        ? `failure_reason=${ref.artifact.failure_reason}`
        : "scorecard/official_score is missing";
      return `${ref.path}: ${reason}`;
    });

  const metricValues = new Map<string, number>();
  for (const ref of passed) {
    if (typeof ref.artifact.official_score === "number") {
      metricValues.set("official_score", ref.artifact.official_score);
      metricValues.set("score", ref.artifact.official_score);
    }
    metricValues.set("action_count", ref.artifact.action_count);
    const levelsCompleted = ref.artifact.latest_snapshot?.levels_completed;
    if (typeof levelsCompleted === "number") metricValues.set("levels_completed", levelsCompleted);
  }

  return {
    applicable: true,
    passed: passed.length > 0,
    description: passed.length > 0
      ? `ARC-AGI-3 completion artifact verified: ${passed.map((ref) => `${ref.artifact.run_id} score=${ref.artifact.official_score} actions=${ref.artifact.action_count}`).join("; ")}`
      : `ARC-AGI-3 completion artifact is incomplete: ${failures.join("; ")}`,
    artifacts: refs.map((ref) => ref.path),
    metricValues,
  };
}

export async function recordArcAgi3UsageForCompletionArtifacts(input: {
  artifacts: readonly AgentCompletionArtifact[] | undefined;
  usage: ArcAgi3UsageMetadata;
}): Promise<string[]> {
  const refs = await resolveArcAgi3RunArtifactRefs(input.artifacts);
  const updated: string[] = [];
  for (const ref of refs) {
    const store = new ArcAgi3ArtifactStore(ref.baseDir);
    const result = await store.recordUsage(ref.artifact.run_id, input.usage);
    if (result) updated.push(ref.path);
  }
  return [...new Set(updated)];
}

export function createArcAgi3CompletionArtifactFinalizer(
  deps: ArcAgi3CompletionFinalizerDeps = {},
): TaskCompletionArtifactFinalizer {
  let sharedClient = deps.client;
  const client = () => {
    sharedClient ??= deps.clientFactory?.() ?? new ArcAgi3HttpClient();
    return sharedClient;
  };

  return async (input): Promise<TaskCompletionArtifactFinalizerResult> => {
    const refs = await resolveArcAgi3RunArtifactRefs(input.agentLoopResult.toolResults?.flatMap((entry) =>
      (entry.artifacts ?? []).map((artifactPath) => ({
        path: artifactPath,
        sourceTool: entry.toolName,
      }))
    ));
    const unfinished = refs.filter((ref) => !isFinishedArcAgi3RunArtifact(ref.artifact));
    if (unfinished.length === 0) {
      return refs.length > 0
        ? {
            handled: true,
            success: true,
            summary: `ARC-AGI-3 completion artifact already finalized: ${refs.map((ref) => ref.artifact.run_id).join(", ")}`,
            artifacts: refs.flatMap((ref) => [ref.path, new ArcAgi3ArtifactStore(ref.baseDir).scorecardPath(ref.artifact.run_id)]),
          }
        : { handled: false, success: true, summary: "No ARC-AGI-3 artifacts to finalize." };
    }

    const finished: string[] = [];
    const failures: string[] = [];
    for (const ref of unfinished) {
      const store = new ArcAgi3ArtifactStore(ref.baseDir);
      try {
        let scorecard;
        try {
          scorecard = await client().closeScorecard(ref.artifact.card_id, input.abortSignal);
        } catch (closeErr) {
          try {
            scorecard = await client().retrieveScorecard(ref.artifact.card_id, input.abortSignal);
          } catch (retrieveErr) {
            if (ref.artifact.scorecard) {
              finished.push(ref.path);
              continue;
            }
            const reason = `close failed: ${formatError(closeErr)}; retrieve failed: ${formatError(retrieveErr)}`;
            await store.recordFailure(ref.artifact.run_id, reason);
            failures.push(`${ref.artifact.run_id}: ${reason}`);
            continue;
          }
        }
        await store.recordScorecard(ref.artifact.run_id, scorecard);
        finished.push(ref.path);
      } catch (err) {
        const reason = formatError(err);
        await store.recordFailure(ref.artifact.run_id, reason);
        failures.push(`${ref.artifact.run_id}: ${reason}`);
      }
    }

    return {
      handled: true,
      success: failures.length === 0 && finished.length > 0,
      summary: failures.length === 0
        ? `ARC-AGI-3 completion finalizer closed ${finished.length} scorecard artifact(s).`
        : `ARC-AGI-3 completion finalizer had failures: ${failures.join("; ")}`,
      artifacts: [...new Set([
        ...finished,
        ...refs.flatMap((ref) => [new ArcAgi3ArtifactStore(ref.baseDir).scorecardPath(ref.artifact.run_id)]),
      ])],
      ...(failures.length > 0 ? { error: failures.join("; ") } : {}),
    };
  };
}

interface ArcAgi3RunArtifactRef {
  path: string;
  baseDir: string;
  artifact: ArcAgi3RunArtifact;
}

async function resolveArcAgi3RunArtifactRefs(
  artifacts: readonly AgentCompletionArtifact[] | undefined,
): Promise<ArcAgi3RunArtifactRef[]> {
  const refs: ArcAgi3RunArtifactRef[] = [];
  const seen = new Set<string>();
  for (const artifact of artifacts ?? []) {
    const resolvedPath = path.resolve(artifact.path);
    if (seen.has(resolvedPath)) continue;
    seen.add(resolvedPath);
    const parsed = await readArcAgi3RunArtifact(resolvedPath);
    if (!parsed) continue;
    const parent = path.dirname(resolvedPath);
    if (path.basename(resolvedPath) !== "run.json") continue;
    if (path.basename(parent) !== parsed.run_id) continue;
    const baseDir = path.dirname(parent);
    refs.push({ path: resolvedPath, baseDir, artifact: parsed });
  }
  return refs;
}

async function readArcAgi3RunArtifact(filePath: string): Promise<ArcAgi3RunArtifact | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if ((parsed as Record<string, unknown>)["schema_version"] !== ARC_AGI3_RUN_SCHEMA_VERSION) return null;
  const result = ArcAgi3RunArtifactSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function isFinishedArcAgi3RunArtifact(artifact: ArcAgi3RunArtifact): boolean {
  return artifact.scorecard !== null && typeof artifact.official_score === "number";
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
