import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadRelationshipProfile,
  upsertRelationshipProfileItem,
} from "../relationship-profile.js";
import {
  createRelationshipSurfaceRepairProposal,
} from "../relationship-surface-repair.js";
import {
  loadRelationshipProfileProposalStore,
} from "../profile-change-proposal.js";

const NOW = "2026-05-14T02:00:00.000Z";

let baseDir: string;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-relationship-surface-repair-"));
});

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe("relationship surface repair proposals", () => {
  it("creates a pending owner correction proposal without patching the active profile item", async () => {
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "operator.status_style",
      kind: "preference",
      value: "Prefer verbose updates.",
      source: "cli_update",
      allowedScopes: ["memory_retrieval"],
      sensitivity: "private",
      now: NOW,
    });

    const result = await createRelationshipSurfaceRepairProposal({
      baseDir,
      action: "correct",
      stableKey: "operator.status_style",
      replacement: {
        kind: "preference",
        value: "Prefer concise updates.",
        allowedScopes: ["memory_retrieval"],
      },
      evidenceRefs: ["relationship-normal-surface:turn:1"],
      rationale: "User corrected the normal-surface relationship reason.",
      now: "2026-05-14T02:01:00.000Z",
    });

    expect(result.proposal).toMatchObject({
      operation: "upsert_item",
      approval_state: "pending",
      proposed_item: {
        stable_key: "operator.status_style",
        value: "Prefer concise updates.",
      },
      evidence_refs: ["relationship-normal-surface:turn:1"],
    });
    const profile = await loadRelationshipProfile(baseDir);
    expect(profile.items.filter((item) => item.status === "active").map((item) => item.value)).toEqual([
      "Prefer verbose updates.",
    ]);
  });

  it("routes suppress, revoke, and forget as pending owner retractions", async () => {
    for (const action of ["suppress", "revoke", "forget"] as const) {
      await createRelationshipSurfaceRepairProposal({
        baseDir,
        action,
        stableKey: `operator.memory.${action}`,
        evidenceRefs: [`relationship-normal-surface:${action}`],
        rationale: "User requested this normal-surface memory not be used.",
        now: NOW,
      });
    }

    const store = await loadRelationshipProfileProposalStore(baseDir);
    expect(store.proposals.map((proposal) => proposal.operation)).toEqual([
      "retract_item",
      "retract_item",
      "retract_item",
    ]);
    expect(store.proposals.map((proposal) => proposal.approval_state)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(store.proposals.map((proposal) => proposal.rationale)).toEqual([
      expect.stringContaining("Suppress normal-surface projection"),
      expect.stringContaining("Revoke allowed relationship use"),
      expect.stringContaining("Forget relationship memory"),
    ]);
  });
});
