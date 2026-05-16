import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface ProductGauntletContext {
  scenarioId: string;
  rootDir: string;
  runtimeRoot: string;
  controlBaseDir: string;
  recordEvidence(evidence: ProductGauntletEvidence): void;
}

export interface ProductGauntletEvidence {
  authorityDecision?: unknown;
  authorityDecisions?: unknown[];
  visibleProjection?: unknown;
  dbSummary?: unknown;
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
    rootDir,
    runtimeRoot: path.join(rootDir, "runtime"),
    controlBaseDir: rootDir,
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
    root_dir: context.rootDir,
    runtime_root: context.runtimeRoot,
    control_base_dir: context.controlBaseDir,
  }, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(dir, "authority-decision.json"), `${JSON.stringify({
    authority_decision: evidence.authorityDecision ?? null,
    authority_decisions: evidence.authorityDecisions ?? [],
  }, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(dir, "visible-projection.json"), `${JSON.stringify(
    evidence.visibleProjection ?? null,
    null,
    2,
  )}\n`, "utf8");
  await fsp.writeFile(path.join(dir, "db-summary.json"), `${JSON.stringify(
    evidence.dbSummary ?? null,
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
  return `Failure: ${message}\n\nInspect ${files} and compare authority-decision.json with the expected invariant.`;
}
