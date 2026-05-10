import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TrustStateStore } from "../trust-state-store.js";
import { EthicsLogStore } from "../ethics-log-store.js";
import { importLegacyTrustState } from "../trust-state-migration.js";
import { importLegacyEthicsLogState } from "../ethics-log-migration.js";
import { importLegacyRelationshipProfileProposalState } from "../relationship-profile-proposal-state-migration.js";
import {
  createRelationshipProfileChangeProposal,
  loadRelationshipProfileProposalStore,
} from "../../../platform/profile/profile-change-proposal.js";
import type { TrustStore } from "../../../base/types/trust.js";
import type { EthicsLog } from "../../../base/types/ethics.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "trust-ethics-profile-state-"));
}

function makeTrustStore(): TrustStore {
  return {
    balances: {
      shell: {
        domain: "shell",
        balance: 25,
        success_delta: 3,
        failure_delta: -10,
      },
    },
    permanent_gates: {
      shell: ["file_delete"],
    },
    override_log: [
      {
        timestamp: "2026-05-10T00:00:00.000Z",
        override_type: "permanent_gate",
        domain: "shell",
        target_category: "file_delete",
        balance_before: null,
        balance_after: null,
      },
    ],
  };
}

function makeEthicsLog(): EthicsLog {
  return {
    log_id: "ethics-log-1",
    timestamp: "2026-05-10T00:00:00.000Z",
    subject_type: "task",
    subject_id: "task-1",
    subject_description: "Inspect typed persistence",
    verdict: {
      verdict: "pass",
      category: "safe",
      reasoning: "No safety issue.",
      risks: [],
      confidence: 0.95,
    },
    layer1_triggered: false,
  };
}

describe("trust/ethics/profile control DB state stores", () => {
  it("persists trust state without legacy trust-store.json", async () => {
    const tmpDir = makeTmpDir();
    try {
      await new TrustStateStore(tmpDir).saveStore(makeTrustStore());

      await expect(new TrustStateStore(tmpDir).loadStore()).resolves.toMatchObject({
        balances: { shell: { balance: 25 } },
        permanent_gates: { shell: ["file_delete"] },
        override_log: [expect.objectContaining({ override_type: "permanent_gate" })],
      });
      expect(fs.existsSync(path.join(tmpDir, "trust", "trust-store.json"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("imports legacy trust state only through the explicit repair boundary", async () => {
    const tmpDir = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmpDir, "trust"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "trust", "trust-store.json"), JSON.stringify(makeTrustStore()));

      const report = await importLegacyTrustState(tmpDir);

      expect(report).toMatchObject({
        trustStoreFiles: 1,
        importedBalances: 1,
        importedPermanentGates: 1,
        importedOverrideEvents: 1,
        blockedSources: [],
      });
      await expect(new TrustStateStore(tmpDir).loadStore()).resolves.toMatchObject({
        balances: { shell: { balance: 25 } },
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("persists ethics logs without legacy ethics-log.json", async () => {
    const tmpDir = makeTmpDir();
    try {
      await new EthicsLogStore(tmpDir).appendLog(makeEthicsLog());

      await expect(new EthicsLogStore(tmpDir).loadLogs()).resolves.toEqual([makeEthicsLog()]);
      expect(fs.existsSync(path.join(tmpDir, "ethics", "ethics-log.json"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("imports legacy ethics logs only through the explicit repair boundary", async () => {
    const tmpDir = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmpDir, "ethics"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "ethics", "ethics-log.json"), JSON.stringify([makeEthicsLog()]));

      const report = await importLegacyEthicsLogState(tmpDir);

      expect(report).toMatchObject({
        ethicsLogFiles: 1,
        importedLogs: 1,
        blockedSources: [],
      });
      await expect(new EthicsLogStore(tmpDir).loadLogs()).resolves.toEqual([makeEthicsLog()]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("persists relationship profile proposals without legacy proposal JSON", async () => {
    const tmpDir = makeTmpDir();
    try {
      const created = await createRelationshipProfileChangeProposal(tmpDir, {
        operation: "upsert_item",
        stableKey: "user.preference.status",
        kind: "preference",
        value: "Prefer concise status reports.",
        source: "cli_proposal",
        rationale: "Operator wants governed profile updates.",
        now: "2026-05-10T00:00:00.000Z",
      });

      await expect(loadRelationshipProfileProposalStore(tmpDir)).resolves.toMatchObject({
        proposals: [expect.objectContaining({ id: created.proposal.id })],
      });
      expect(fs.existsSync(path.join(tmpDir, "relationship-profile-proposals.json"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("imports legacy relationship profile proposals only through the explicit repair boundary", async () => {
    const tmpDir = makeTmpDir();
    try {
      const proposalStore = {
        schema_version: 1,
        profile_id: "default",
        proposals: [
          {
            id: "proposal-1",
            operation: "upsert_item",
            proposed_item: {
              stable_key: "user.preference.status",
              kind: "preference",
              value: "Prefer concise status reports.",
              sensitivity: "private",
              allowed_scopes: ["local_planning", "user_facing_review"],
            },
            source: "cli_proposal",
            confidence: 0.7,
            sensitivity: "private",
            consent_scopes: ["user_facing_review"],
            evidence_refs: [],
            rationale: "Operator wants governed profile updates.",
            approval_state: "pending",
            applied_at: null,
            expires_at: null,
            created_at: "2026-05-10T00:00:00.000Z",
            updated_at: "2026-05-10T00:00:00.000Z",
          },
        ],
        audit_events: [
          {
            id: "event-1",
            proposal_id: "proposal-1",
            at: "2026-05-10T00:00:00.000Z",
            action: "created",
          },
        ],
        updated_at: "2026-05-10T00:00:00.000Z",
      };
      fs.writeFileSync(path.join(tmpDir, "relationship-profile-proposals.json"), JSON.stringify(proposalStore));

      const report = await importLegacyRelationshipProfileProposalState(tmpDir);

      expect(report).toMatchObject({
        proposalStoreFiles: 1,
        importedProposals: 1,
        importedAuditEvents: 1,
        blockedSources: [],
      });
      await expect(loadRelationshipProfileProposalStore(tmpDir)).resolves.toMatchObject({
        proposals: [expect.objectContaining({ id: "proposal-1" })],
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("honors control DB options when importing legacy relationship profile proposals", async () => {
    const tmpDir = makeTmpDir();
    const customControlDbPath = path.join(tmpDir, "custom-control.sqlite");
    try {
      const proposalStore = {
        schema_version: 1,
        profile_id: "default",
        proposals: [
          {
            id: "proposal-custom-db",
            operation: "retract_item",
            proposed_item: {
              stable_key: "user.preference.status",
              sensitivity: "private",
              allowed_scopes: ["local_planning"],
            },
            source: "system_migration",
            confidence: 0.7,
            sensitivity: "private",
            consent_scopes: ["user_facing_review"],
            evidence_refs: [],
            rationale: "Legacy proposal import preserves pending workflow state.",
            approval_state: "pending",
            applied_at: null,
            expires_at: null,
            created_at: "2026-05-10T00:00:00.000Z",
            updated_at: "2026-05-10T00:00:00.000Z",
          },
        ],
        audit_events: [
          {
            id: "event-custom-db",
            proposal_id: "proposal-custom-db",
            at: "2026-05-10T00:00:00.000Z",
            action: "created",
          },
        ],
        updated_at: "2026-05-10T00:00:00.000Z",
      };
      fs.writeFileSync(path.join(tmpDir, "relationship-profile-proposals.json"), JSON.stringify(proposalStore));

      await importLegacyRelationshipProfileProposalState(tmpDir, { controlDbPath: customControlDbPath });

      await expect(loadRelationshipProfileProposalStore(tmpDir, { controlDbPath: customControlDbPath }))
        .resolves.toMatchObject({
          proposals: [expect.objectContaining({ id: "proposal-custom-db" })],
        });
      await expect(loadRelationshipProfileProposalStore(tmpDir)).resolves.toMatchObject({
        proposals: [],
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
