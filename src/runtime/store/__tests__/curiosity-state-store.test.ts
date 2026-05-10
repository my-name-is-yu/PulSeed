import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CuriosityStateStore } from "../curiosity-state-store.js";
import { importLegacyCuriosityState } from "../curiosity-state-migration.js";
import { openControlDatabase } from "../control-db/index.js";
import type { CuriosityState } from "../../../base/types/curiosity.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "curiosity-state-"));
}

function makeState(): CuriosityState {
  return {
    proposals: [
      {
        id: "proposal-1",
        trigger: {
          type: "periodic_exploration",
          detected_at: "2026-05-10T00:00:00.000Z",
          source_goal_id: null,
          details: "Periodic review",
          severity: 0.4,
        },
        proposed_goal: {
          description: "Inspect runtime store behavior",
          rationale: "Typed persistence should own curiosity state",
          suggested_dimensions: [],
          scope_domain: "runtime",
          detection_method: "periodic_review",
        },
        status: "pending",
        created_at: "2026-05-10T00:00:00.000Z",
        expires_at: "2026-05-10T12:00:00.000Z",
        reviewed_at: null,
        rejection_cooldown_until: null,
        loop_count: 0,
        goal_id: null,
      },
    ],
    learning_records: [
      {
        goal_id: "goal-1",
        dimension_name: "quality",
        approach: "typed store",
        outcome: "success",
        improvement_ratio: 0.5,
        recorded_at: "2026-05-10T00:01:00.000Z",
      },
    ],
    last_exploration_at: "2026-05-10T00:00:00.000Z",
    rejected_proposal_hashes: ["hash-1"],
  };
}

describe("CuriosityStateStore", () => {
  it("persists curiosity state in the control database without legacy state JSON", async () => {
    const tmpDir = makeTmpDir();
    try {
      const store = new CuriosityStateStore(tmpDir);
      const state = makeState();

      store.saveSync(state);

      await expect(store.load()).resolves.toEqual(state);
      expect(fs.existsSync(path.join(tmpDir, "curiosity", "state.json"))).toBe(false);

      const db = await openControlDatabase({ baseDir: tmpDir });
      try {
        const proposalCount = db.read((sqlite) =>
          (sqlite.prepare("SELECT COUNT(*) AS count FROM curiosity_proposals").get() as { count: number }).count
        );
        const learningCount = db.read((sqlite) =>
          (sqlite.prepare("SELECT COUNT(*) AS count FROM curiosity_learning_records").get() as { count: number }).count
        );
        expect(proposalCount).toBe(1);
        expect(learningCount).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("imports legacy curiosity state only through the explicit repair boundary", async () => {
    const tmpDir = makeTmpDir();
    try {
      const legacyDir = path.join(tmpDir, "curiosity");
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, "state.json"), JSON.stringify(makeState()));

      const report = await importLegacyCuriosityState(tmpDir);

      expect(report).toMatchObject({
        stateFiles: 1,
        importedProposals: 1,
        importedLearningRecords: 1,
        importedRejectedHashes: 1,
        blockedSources: [],
      });
      await expect(new CuriosityStateStore(tmpDir).load()).resolves.toMatchObject({
        proposals: [expect.objectContaining({ id: "proposal-1" })],
        rejected_proposal_hashes: ["hash-1"],
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("records malformed legacy curiosity state as a blocked import", async () => {
    const tmpDir = makeTmpDir();
    try {
      const legacyDir = path.join(tmpDir, "curiosity");
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, "state.json"), "{not-json");

      const report = await importLegacyCuriosityState(tmpDir);

      expect(report.stateFiles).toBe(0);
      expect(report.blockedSources).toEqual([
        expect.objectContaining({
          sourceKind: "curiosity_state",
          sourcePath: path.join("curiosity", "state.json"),
        }),
      ]);
      await expect(new CuriosityStateStore(tmpDir).load()).resolves.toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
