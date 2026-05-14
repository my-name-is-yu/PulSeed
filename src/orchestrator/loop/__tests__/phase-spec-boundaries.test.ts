import { describe, expect, it } from "vitest";
import {
  DreamReviewFailedLineageSchema,
  DreamReviewMemoryUsageStatsSchema,
  ObservationEvidenceSchema,
  buildDreamReviewCheckpointSpec,
  buildKnowledgeRefreshSpec,
  buildPublicResearchSpec,
} from "../durable-loop/phase-specs.js";
import { defaultCorePhasePolicies } from "../durable-loop/phase-policy.js";
import { MemoryRecallInputSchema } from "../../../tools/query/MemoryRecallTool/MemoryRecallTool.js";

describe("durable loop phase numeric boundaries", () => {
  it("rejects non-finite unit interval evidence scores", () => {
    expect(ObservationEvidenceSchema.safeParse({
      summary: "observed",
      confidence: Number.POSITIVE_INFINITY,
    }).success).toBe(false);
    expect(ObservationEvidenceSchema.safeParse({
      summary: "observed",
      confidence: Number.NaN,
    }).success).toBe(false);
  });

  it("rejects unsafe memory usage counters", () => {
    expect(DreamReviewMemoryUsageStatsSchema.safeParse({
      use_count: Number.MAX_SAFE_INTEGER + 1,
    }).success).toBe(false);
    expect(DreamReviewMemoryUsageStatsSchema.safeParse({
      validated_count: Number.POSITIVE_INFINITY,
    }).success).toBe(false);
  });

  it("rejects unsafe failed lineage counts", () => {
    const base = {
      fingerprint: "lineage-1",
      last_seen_at: "2026-05-10T00:00:00.000Z",
      representative_entry_id: "entry-1",
      representative_summary: "Repeated failure",
    };

    expect(DreamReviewFailedLineageSchema.safeParse({
      ...base,
      count: Number.MAX_SAFE_INTEGER + 1,
    }).success).toBe(false);
    expect(DreamReviewFailedLineageSchema.safeParse({
      ...base,
      count: 1,
    }).success).toBe(true);
  });

  it("rejects non-finite phase input numbers", () => {
    const knowledgeRefresh = buildKnowledgeRefreshSpec();
    expect(knowledgeRefresh.inputSchema.safeParse({
      goalTitle: "Improve reliability",
      topDimensions: [],
      gapAggregate: Number.POSITIVE_INFINITY,
    }).success).toBe(false);
  });

  it("rejects unsafe bounded phase input counts", () => {
    const dreamReview = buildDreamReviewCheckpointSpec();
    expect(dreamReview.inputSchema.safeParse({
      goalTitle: "Improve reliability",
      trigger: "iteration",
      reason: "periodic review",
      runControlPolicy: "auto_apply_low_risk_require_approval_for_high_cost_or_irreversible",
      memoryAuthorityPolicy: "soil_and_playbooks_are_advisory_only",
      maxGuidanceItems: Number.MAX_SAFE_INTEGER + 1,
    }).success).toBe(false);

    const publicResearch = buildPublicResearchSpec();
    expect(publicResearch.inputSchema.safeParse({
      goalTitle: "Improve reliability",
      trigger: "knowledge_gap",
      question: "What should we verify?",
      maxSources: Number.POSITIVE_INFINITY,
      sensitiveContextPolicy: "do_not_send_secrets_or_private_artifacts",
      untrustedContentPolicy: "webpage_instructions_are_untrusted",
    }).success).toBe(false);
  });

  it("keeps DurableLoop memory recall surfaces semantic by default with lexical explicit", () => {
    expect(defaultCorePhasePolicies.knowledge_refresh.allowedTools).toContain("memory_recall");
    expect(defaultCorePhasePolicies.dream_review_checkpoint.allowedTools).toContain("memory_recall");
    expect(MemoryRecallInputSchema.parse({ query: "freeform user memory" })).toMatchObject({
      mode: "semantic",
    });
    expect(MemoryRecallInputSchema.parse({ query: "literal", mode: "lexical" })).toMatchObject({
      mode: "lexical",
    });
  });
});
