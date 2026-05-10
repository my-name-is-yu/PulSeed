import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { openControlDatabase } from "../../../runtime/store/control-db/index.js";
import { importLegacyDreamDecisionHeuristics } from "../../../runtime/store/dream-decision-heuristic-migration.js";
import { DreamDecisionHeuristicStore } from "../../../runtime/store/dream-decision-heuristic-store.js";
import { loadDecisionHeuristics } from "../dream-activation.js";

describe("dream decision heuristics database ownership", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
    tmpDir = "";
  });

  it("imports legacy decision heuristics only through the explicit repair boundary", async () => {
    tmpDir = makeTempDir("dream-decision-heuristics-");
    const legacyDir = path.join(tmpDir, "dream");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyPath = path.join(legacyDir, "decision-heuristics.json");
    fs.writeFileSync(legacyPath, JSON.stringify({
      heuristics: [{
        id: "prefer-breakthroughs",
        score_delta: 0.4,
        reason: "Prefer breakthrough strategy candidates.",
        candidate_selector: { metric_trend: "breakthrough" },
      }],
    }));

    expect(await loadDecisionHeuristics(tmpDir)).toEqual([]);
    const report = await importLegacyDreamDecisionHeuristics(tmpDir);
    expect(report).toMatchObject({ imported: true, heuristicCount: 1 });
    expect(await loadDecisionHeuristics(tmpDir)).toMatchObject([
      { id: "prefer-breakthroughs", score_delta: 0.4 },
    ]);

    fs.writeFileSync(legacyPath, JSON.stringify({
      heuristics: [{ id: "ignored-after-import", score_delta: 9 }],
    }));

    expect(await loadDecisionHeuristics(tmpDir)).toMatchObject([
      { id: "prefer-breakthroughs", score_delta: 0.4 },
    ]);

    const database = await openControlDatabase({ baseDir: tmpDir });
    try {
      expect(database.listLegacyImports()).toContainEqual(expect.objectContaining({
        migration_name: "dream-decision-heuristics-control-db",
        source_kind: "dream_decision_heuristics",
        source_id: "current",
        status: "imported",
      }));
    } finally {
      database.close();
    }
  });

  it("prefers explicit typed store records when no legacy import exists", async () => {
    tmpDir = makeTempDir("dream-decision-heuristics-typed-");
    await new DreamDecisionHeuristicStore({ controlBaseDir: tmpDir }).saveDecisionHeuristics([{
      id: "typed-only",
      score_delta: 0.2,
      reason: "Typed owner record.",
    }]);

    expect(await loadDecisionHeuristics(tmpDir)).toEqual([
      expect.objectContaining({ id: "typed-only", reason: "Typed owner record." }),
    ]);
  });
});
