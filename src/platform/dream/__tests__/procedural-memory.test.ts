import { describe, expect, it } from "vitest";
import {
  createProceduralMemoryCandidate,
  createProceduralMemoryWritebackProposal,
  proceduralMemoryToGadgetPlanningRef,
  ProceduralMemoryRecordSchema,
} from "../index.js";

const traceRef = {
  ref: "tool:trace:1",
  source_store: "runtime_operation" as const,
  source_event_type: "tool_trace",
  schema_version: 1,
  replay_key: "tool:trace:1",
  redaction_policy: "metadata_only" as const,
};

describe("procedural memory", () => {
  it("creates procedural candidates as planning evidence without execution authority", () => {
    const candidate = createProceduralMemoryCandidate({
      proceduralMemoryId: "procedural:provider-config-boundary",
      kind: "playbook",
      title: "Repair provider config boundary",
      sourceTraceRefs: [traceRef],
      confidence: 0.82,
      scopeRefs: ["goal:1"],
      createdAt: "2026-05-14T00:00:00.000Z",
    });
    const proposal = createProceduralMemoryWritebackProposal({
      proposalId: "writeback:procedural:1",
      proceduralMemory: candidate,
    });

    expect(candidate).toMatchObject({
      status: "owner_review_required",
      planning_evidence_only: true,
      execution_authority: false,
      admission_required_before_use: true,
    });
    expect(proposal).toMatchObject({
      proposal_kind: "procedural_skill_candidate",
      proposed_target: "reflection",
      auto_apply: false,
      source_content_materialized: false,
    });
  });

  it("requires repair evidence before failed traces become reusable repair recipes", () => {
    expect(() => createProceduralMemoryCandidate({
      proceduralMemoryId: "procedural:repair-missing-evidence",
      kind: "repair_recipe",
      title: "Retry failed command",
      sourceTraceRefs: [traceRef],
      confidence: 0.76,
      createdAt: "2026-05-14T00:00:00.000Z",
    })).toThrow(/repair evidence/);

    expect(ProceduralMemoryRecordSchema.parse(createProceduralMemoryCandidate({
      proceduralMemoryId: "procedural:repair-with-evidence",
      kind: "repair_recipe",
      title: "Retry failed command after config fix",
      sourceTraceRefs: [traceRef],
      repairEvidenceRefs: [{
        ...traceRef,
        ref: "tool:trace:repair",
        replay_key: "tool:trace:repair",
      }],
      confidence: 0.76,
      createdAt: "2026-05-14T00:00:00.000Z",
    })).repair_evidence_refs).toHaveLength(1);
  });

  it("binds procedural memory into gadget planning only as memory evidence refs", () => {
    const candidate = createProceduralMemoryCandidate({
      proceduralMemoryId: "procedural:planning-only",
      kind: "tool_policy",
      title: "Prefer focused typecheck after provider config edits",
      sourceTraceRefs: [traceRef],
      confidence: 0.7,
      createdAt: "2026-05-14T00:00:00.000Z",
    });

    expect(proceduralMemoryToGadgetPlanningRef(candidate)).toEqual({
      kind: "procedural_memory",
      ref: "procedural:planning-only",
      role: "memory",
    });
  });
});
