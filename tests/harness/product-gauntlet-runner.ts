import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface ProductGauntletContext {
  scenarioId: string;
  pulseedHome: string;
  rootDir: string;
  runtimeRoot: string;
  controlBaseDir: string;
  fakeClock: { now: string; nowMs: number };
  recordEvidence(evidence: ProductGauntletEvidence): void;
}

export interface ProductGauntletEvidence {
  authorityDecision?: unknown;
  authorityDecisions?: unknown[];
  visibleProjection?: unknown;
  normalProjection?: unknown;
  operatorDebugEvidence?: unknown;
  dbSummary?: unknown;
  replaySummary?: unknown;
  safetyInvariants?: unknown;
  expectedAuthorityDecisions?: unknown;
  expectedNormalProjection?: unknown;
  candidateFixPlan?: string;
  nextFiles?: string[];
}

export async function runProductGauntletScenario(
  scenarioId: string,
  run: (context: ProductGauntletContext) => Promise<ProductGauntletEvidence | void>,
): Promise<ProductGauntletEvidence | void> {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), `pulseed-product-gauntlet-${scenarioId}-`));
  let evidence: ProductGauntletEvidence = {};
  const context: ProductGauntletContext = {
    scenarioId,
    pulseedHome: rootDir,
    rootDir,
    runtimeRoot: path.join(rootDir, "runtime"),
    controlBaseDir: rootDir,
    fakeClock: {
      now: "2026-05-16T00:00:00.000Z",
      nowMs: Date.parse("2026-05-16T00:00:00.000Z"),
    },
    recordEvidence(nextEvidence) {
      evidence = mergeProductGauntletEvidence(evidence, nextEvidence);
    },
  };
  try {
    const returnedEvidence = await run(context);
    if (returnedEvidence) {
      context.recordEvidence(returnedEvidence);
    }
    if (process.env["PULSEED_PRODUCT_GAUNTLET_DEBUG"] === "1") {
      await writeProductGauntletEvidence(context, evidence);
    }
    return evidence;
  } catch (error) {
    await writeProductGauntletEvidence(context, {
      ...evidence,
      candidateFixPlan: failurePlanFor(error, evidence),
    });
    throw error;
  } finally {
    if (process.env["PULSEED_PRODUCT_GAUNTLET_KEEP_TMP"] !== "1") {
      await fsp.rm(rootDir, { recursive: true, force: true });
    }
  }
}

function mergeProductGauntletEvidence(
  current: ProductGauntletEvidence,
  next: ProductGauntletEvidence,
): ProductGauntletEvidence {
  return {
    ...current,
    ...next,
    authorityDecisions: next.authorityDecisions ?? current.authorityDecisions,
    normalProjection: next.normalProjection ?? next.visibleProjection ?? current.normalProjection ?? current.visibleProjection,
    operatorDebugEvidence: next.operatorDebugEvidence ?? current.operatorDebugEvidence,
    replaySummary: next.replaySummary ?? current.replaySummary,
    safetyInvariants: next.safetyInvariants ?? current.safetyInvariants,
    expectedAuthorityDecisions: next.expectedAuthorityDecisions ?? current.expectedAuthorityDecisions,
    expectedNormalProjection: next.expectedNormalProjection ?? current.expectedNormalProjection,
    nextFiles: next.nextFiles ?? current.nextFiles,
  };
}

async function writeProductGauntletEvidence(
  context: ProductGauntletContext,
  evidence: ProductGauntletEvidence,
): Promise<void> {
  const dir = path.resolve("tmp", "eval-failures", context.scenarioId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "scenario.json"), `${JSON.stringify({
    scenario_id: context.scenarioId,
    pulseed_home: context.pulseedHome,
    root_dir: context.rootDir,
    runtime_root: context.runtimeRoot,
    control_base_dir: context.controlBaseDir,
    fake_clock: context.fakeClock,
    safety_invariants: evidence.safetyInvariants ?? null,
    expected_authority_decisions: evidence.expectedAuthorityDecisions ?? null,
    expected_normal_projection: evidence.expectedNormalProjection ?? null,
  }, null, 2)}\n`, "utf8");
  const authoritySnapshot = {
    authority_decision: evidence.authorityDecision ?? null,
    authority_decisions: evidence.authorityDecisions ?? [],
  };
  await fsp.writeFile(path.join(dir, "authority-decisions.json"), `${JSON.stringify(authoritySnapshot, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(dir, "authority-decision.json"), `${JSON.stringify(authoritySnapshot, null, 2)}\n`, "utf8");
  const normalProjection = evidence.normalProjection ?? evidence.visibleProjection ?? null;
  await fsp.writeFile(path.join(dir, "normal-projection.json"), `${JSON.stringify(
    normalProjection,
    null,
    2,
  )}\n`, "utf8");
  await fsp.writeFile(path.join(dir, "visible-projection.json"), `${JSON.stringify(normalProjection, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(dir, "operator-debug-evidence.json"), `${JSON.stringify(
    evidence.operatorDebugEvidence ?? {
      note: "No operator/debug evidence was recorded before the failure.",
      next_files: evidence.nextFiles ?? [],
    },
    null,
    2,
  )}\n`, "utf8");
  await fsp.writeFile(path.join(dir, "db-summary.json"), `${JSON.stringify(
    evidence.dbSummary ?? {
      note: "No DB summary was recorded before the failure.",
      next_files: evidence.nextFiles ?? [],
    },
    null,
    2,
  )}\n`, "utf8");
  await fsp.writeFile(path.join(dir, "replay-summary.json"), `${JSON.stringify(
    evidence.replaySummary ?? {
      replay_checked: false,
      note: "This scenario did not record restart/replay evidence before the failure.",
    },
    null,
    2,
  )}\n`, "utf8");
  await fsp.writeFile(path.join(dir, "candidate-fix-plan.md"), [
    "# Candidate Fix Plan",
    "",
    evidence.candidateFixPlan ?? "Inspect the failing invariant and authority decision snapshot.",
    "",
    "Next files:",
    ...(evidence.nextFiles ?? []).map((file) => `- ${file}`),
    "",
  ].join("\n"), "utf8");
}

function failurePlanFor(error: unknown, evidence: ProductGauntletEvidence | void): string {
  const message = error instanceof Error ? error.message : String(error);
  const files = evidence?.nextFiles?.length ? evidence.nextFiles.join(", ") : "see scenario nextFiles";
  return [
    `Failure: ${message}`,
    "",
    `Inspect ${files}.`,
    "Compare authority-decisions.json, normal-projection.json, operator-debug-evidence.json, db-summary.json, and replay-summary.json against scenario.json safety_invariants.",
  ].join("\n");
}
