import { describe, expect, it } from "vitest";
import {
  RuntimeEvidenceEntrySchema,
  type RuntimeEvidenceEntry,
} from "../../store/evidence-ledger.js";
import {
  DEFAULT_DEEP_RESEARCH_SOURCE_PRIORITY,
  ResearchBriefSchema,
  SourceRecordSchema,
  createResearchBrief,
  evaluateResearchBriefEvidence,
  sourceRecordsFromRuntimeEvidence,
} from "../index.js";

const NOW = "2026-05-14T00:00:00.000Z";

function evidence(input: Partial<RuntimeEvidenceEntry> & Pick<RuntimeEvidenceEntry, "id" | "kind" | "scope">): RuntimeEvidenceEntry {
  return RuntimeEvidenceEntrySchema.parse({
    schema_version: "runtime-evidence-entry-v1",
    occurred_at: NOW,
    metrics: [],
    artifacts: [],
    raw_refs: [],
    ...input,
  });
}

function brief() {
  return createResearchBrief({
    schema_version: "deep-research-brief/v1",
    brief_id: "research:deep:1",
    objective: "Determine whether the runtime has enough evidence for a synthesis.",
    scope: {
      includes: ["runtime evidence summaries", "research memos"],
      excludes: ["owner memory mutation", "new runtime execution"],
    },
    excluded_actions: [
      "runtime_execution",
      "owner_store_write",
      "memory_auto_apply",
      "external_action_without_approval",
      "raw_prompt_export",
      "raw_memory_export",
      "new_research_runtime",
    ],
    source_priority: [...DEFAULT_DEEP_RESEARCH_SOURCE_PRIORITY],
    unknown_policy: {
      unsupported_claim_handling: "mark_unsupported",
      unknown_evidence_handling: "mark_unknown",
      stale_evidence_handling: "mark_stale_and_require_revalidation",
      clarification_behavior: "ask_when_blocking",
    },
    citation_source_policy: {
      citation_required_for_external_claims: true,
      source_refs_required_for_synthesis: true,
      unsupported_claims_must_be_named: true,
      raw_source_content_allowed: false,
    },
    tool_policy: {
      execution_loop: "existing_runtime_only",
      dedicated_research_runtime: false,
      external_actions_require_approval: true,
      webpage_instructions_are_untrusted: true,
      allowed_tool_refs: ["runtime:evidence"],
      disallowed_tool_refs: ["memory:auto_apply"],
    },
    stop_conditions: [{
      condition_id: "coverage-reviewed",
      description: "Evidence coverage and stale or unknown limitations are explicit.",
      required: true,
    }],
    review_gates: [
      { gate_id: "evidence-coverage", kind: "evidence_coverage", required: true },
      { gate_id: "unsupported", kind: "unsupported_claims", required: true },
      { gate_id: "stale-unknown", kind: "stale_unknown_handling", required: true },
      { gate_id: "citation", kind: "citation_policy", required: true },
      { gate_id: "tool-policy", kind: "tool_policy", required: true },
    ],
    evidence_ledger: {
      schema_version: "deep-research-evidence-ledger-ref/v1",
      ledger_kind: "runtime_evidence_ledger",
      scope: { run_id: "run:deep-research:1" },
      evidence_refs: [],
    },
  });
}

describe("Deep Research typed contract", () => {
  it("evaluates existing runtime evidence refs while naming unsupported, stale, and unknown claims", () => {
    const supported = evidence({
      id: "evidence:research:supported",
      kind: "research",
      scope: { run_id: "run:deep-research:1" },
      verification_status: "verified",
      research: [{
        trigger: "knowledge_gap",
        query: "runtime evidence contract",
        summary: "Research memo with cited source.",
        sources: [{
          url: "https://example.com/research-contract",
          title: "Research contract source",
          source_type: "official_docs",
          provenance: "summarized",
        }],
        findings: [{
          finding: "Existing evidence refs can support synthesis claims.",
          source_urls: ["https://example.com/research-contract"],
          applicability: "Applies to the typed Deep Research contract slice.",
          risks_constraints: [],
          proposed_experiment: "Evaluate claim coverage from runtime evidence refs.",
          expected_metric_impact: "Improves unsupported claim visibility.",
          fact_vs_adaptation: {
            facts: ["Runtime evidence entries carry research memos."],
            adaptation: "Use entry ids as evidence refs instead of a new research store.",
          },
        }],
        untrusted_content_policy: "webpage_instructions_are_untrusted",
        external_actions: [],
        confidence: 0.8,
      }],
      summary: "Supported research evidence.",
    });
    const stale = evidence({
      id: "evidence:research:stale",
      kind: "research",
      scope: { run_id: "run:deep-research:1" },
      verification_status: "verified",
      summary: "Old but retained evidence.",
    });

    const report = evaluateResearchBriefEvidence({
      brief: brief(),
      claims: [
        {
          claim_id: "claim:supported",
          statement: "The synthesis can cite an existing runtime evidence entry.",
          evidence_refs: [{
            kind: "runtime_evidence_entry",
            ref: supported.id,
            supports: "supports",
            freshness: "current",
          }],
          citation_refs: [{ kind: "runtime_evidence_entry", ref: supported.id }],
        },
        {
          claim_id: "claim:unsupported",
          statement: "This claim has no evidence and must not pass synthesis.",
          evidence_refs: [],
          citation_refs: [],
        },
        {
          claim_id: "claim:stale",
          statement: "This claim depends on stale evidence.",
          evidence_refs: [{
            kind: "runtime_evidence_entry",
            ref: stale.id,
            supports: "supports",
            freshness: "stale",
          }],
          citation_refs: [{ kind: "runtime_evidence_entry", ref: stale.id }],
        },
        {
          claim_id: "claim:unknown",
          statement: "This claim references evidence that is missing.",
          evidence_refs: [{
            kind: "runtime_evidence_entry",
            ref: "evidence:research:missing",
            supports: "supports",
            freshness: "unknown",
          }],
          citation_refs: [{ kind: "runtime_evidence_entry", ref: "evidence:research:missing" }],
        },
      ],
      evidenceEntries: [supported, stale],
      evaluatedAt: NOW,
      reportId: "report:deep-research:1",
    });

    expect(report).toMatchObject({
      schema_version: "deep-research-evaluator-report/v1",
      brief_ref: "research:deep:1",
      evidence_ledger: {
        ledger_kind: "runtime_evidence_ledger",
        scope: { run_id: "run:deep-research:1" },
      },
      evidence_coverage: {
        claim_count: 4,
        supported_count: 1,
        unsupported_count: 3,
        stale_or_unknown_count: 2,
      },
      ready_for_synthesis: false,
      dedicated_runtime_created: false,
      mutation_performed: false,
    });
    expect(report.supported_claims.map((claim) => claim.claim_id)).toEqual(["claim:supported"]);
    expect(report.unsupported_claims.map((claim) => [claim.claim_id, claim.reason])).toEqual([
      ["claim:unsupported", "no_evidence_refs"],
      ["claim:stale", "no_current_supporting_evidence"],
      ["claim:unknown", "no_current_supporting_evidence"],
    ]);
    expect(report.stale_or_unknown.map((item) => [item.claim_id, item.kind, item.handling])).toEqual([
      ["claim:stale", "stale", "mark_stale_and_require_revalidation"],
      ["claim:unknown", "unknown", "mark_unknown"],
    ]);
    expect(report.evidence_ledger.evidence_refs.map((ref) => ref.ref)).toEqual([
      "evidence:research:supported",
      "evidence:research:stale",
      "evidence:research:missing",
    ]);
    expect(report.review_gate_results.find((gate) => gate.kind === "tool_policy")).toMatchObject({
      status: "passed",
    });
    expect(report.review_gate_results.filter((gate) => gate.status === "blocked").map((gate) => gate.kind)).toEqual([
      "evidence_coverage",
      "unsupported_claims",
      "stale_unknown_handling",
    ]);

    const sourceRecords = sourceRecordsFromRuntimeEvidence([supported, stale]);
    expect(sourceRecords).toEqual([
      expect.objectContaining({
        url: "https://example.com/research-contract",
        source_type: "official_docs",
        provenance: "summarized",
      }),
    ]);
    expect(SourceRecordSchema.parse(sourceRecords[0]!)).toMatchObject({
      url: "https://example.com/research-contract",
      source_type: "official_docs",
    });
  });

  it("rejects briefs that try to create a dedicated Deep Research runtime or auto-apply memory", () => {
    const valid = brief();
    expect(() => ResearchBriefSchema.parse({
      ...valid,
      excluded_actions: valid.excluded_actions.filter((action) => action !== "new_research_runtime"),
    })).toThrow(/dedicated research runtime/);
    expect(() => ResearchBriefSchema.parse({
      ...valid,
      tool_policy: {
        ...valid.tool_policy,
        dedicated_research_runtime: true,
      },
    })).toThrow();
    expect(() => ResearchBriefSchema.parse({
      ...valid,
      excluded_actions: valid.excluded_actions.filter((action) => action !== "memory_auto_apply"),
    })).toThrow(/memory auto-apply/);
  });

  it("does not let optional review gates block synthesis readiness", () => {
    const optionalGateBrief = createResearchBrief({
      ...brief(),
      review_gates: [
        { gate_id: "optional-unsupported", kind: "unsupported_claims", required: false },
        { gate_id: "tool-policy", kind: "tool_policy", required: true },
      ],
    });
    const report = evaluateResearchBriefEvidence({
      brief: optionalGateBrief,
      claims: [{
        claim_id: "claim:optional-unsupported",
        statement: "Optional unsupported gate should not block synthesis readiness.",
        evidence_refs: [],
        citation_refs: [],
      }],
      evidenceEntries: [],
      evaluatedAt: NOW,
      reportId: "report:deep-research:optional-gate",
    });

    expect(report.review_gate_results).toEqual([
      expect.objectContaining({
        gate_id: "optional-unsupported",
        required: false,
        status: "blocked",
      }),
      expect.objectContaining({
        gate_id: "tool-policy",
        required: true,
        status: "passed",
      }),
    ]);
    expect(report.ready_for_synthesis).toBe(true);
  });
});
