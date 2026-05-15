import { z } from "zod/v3";
import {
  RuntimeEvidenceEntrySchema,
  type RuntimeEvidenceEntry,
} from "../store/evidence-ledger.js";

export const DeepResearchSourcePriorityKindSchema = z.enum([
  "running_code",
  "test_result",
  "type_schema",
  "git_history",
  "project_docs",
  "official_external_source",
  "secondary_external_source",
]);
export type DeepResearchSourcePriorityKind = z.infer<typeof DeepResearchSourcePriorityKindSchema>;

export const DeepResearchSourcePrioritySchema = z.object({
  rank: z.number().int().positive(),
  source_kind: DeepResearchSourcePriorityKindSchema,
  rationale: z.string().min(1),
}).strict();
export type DeepResearchSourcePriority = z.infer<typeof DeepResearchSourcePrioritySchema>;

export const DEFAULT_DEEP_RESEARCH_SOURCE_PRIORITY: readonly DeepResearchSourcePriority[] = [
  { rank: 1, source_kind: "running_code", rationale: "Running code and actual file contents are primary evidence." },
  { rank: 2, source_kind: "test_result", rationale: "Executed checks verify observed behavior." },
  { rank: 3, source_kind: "type_schema", rationale: "Typed contracts define accepted shape and boundaries." },
  { rank: 4, source_kind: "git_history", rationale: "Recent history explains intent after direct code evidence." },
  { rank: 5, source_kind: "project_docs", rationale: "Project docs guide design when they match current code." },
  { rank: 6, source_kind: "official_external_source", rationale: "Official external sources are used for ecosystem facts." },
  { rank: 7, source_kind: "secondary_external_source", rationale: "Secondary sources are supporting context only." },
];

export const DeepResearchExcludedActionSchema = z.enum([
  "runtime_execution",
  "owner_store_write",
  "memory_auto_apply",
  "external_action_without_approval",
  "raw_prompt_export",
  "raw_memory_export",
  "new_research_runtime",
]);
export type DeepResearchExcludedAction = z.infer<typeof DeepResearchExcludedActionSchema>;

export const DeepResearchEvidenceRefSchema = z.object({
  kind: z.literal("runtime_evidence_entry"),
  ref: z.string().min(1),
  supports: z.enum(["supports", "contradicts", "context_only", "unknown"]).default("supports"),
  freshness: z.enum(["current", "stale", "unknown"]).default("current"),
  note: z.string().min(1).optional(),
}).strict();
export type DeepResearchEvidenceRef = z.infer<typeof DeepResearchEvidenceRefSchema>;

export const DeepResearchEvidenceLedgerRefSchema = z.object({
  schema_version: z.literal("deep-research-evidence-ledger-ref/v1"),
  ledger_kind: z.literal("runtime_evidence_ledger"),
  scope: z.object({
    goal_id: z.string().min(1).optional(),
    run_id: z.string().min(1).optional(),
  }).strict(),
  evidence_refs: z.array(DeepResearchEvidenceRefSchema).default([]),
}).strict().refine((ledger) => ledger.scope.goal_id || ledger.scope.run_id, {
  message: "Deep Research evidence ledger refs require goal_id or run_id scope",
  path: ["scope"],
});
export type DeepResearchEvidenceLedgerRef = z.infer<typeof DeepResearchEvidenceLedgerRefSchema>;

export const ResearchBriefSchema = z.object({
  schema_version: z.literal("deep-research-brief/v1"),
  brief_id: z.string().min(1),
  objective: z.string().min(1),
  scope: z.object({
    includes: z.array(z.string().min(1)).min(1),
    excludes: z.array(z.string().min(1)).default([]),
  }).strict(),
  excluded_actions: z.array(DeepResearchExcludedActionSchema).min(1),
  source_priority: z.array(DeepResearchSourcePrioritySchema).min(1),
  unknown_policy: z.object({
    unsupported_claim_handling: z.literal("mark_unsupported").default("mark_unsupported"),
    unknown_evidence_handling: z.literal("mark_unknown").default("mark_unknown"),
    stale_evidence_handling: z.literal("mark_stale_and_require_revalidation").default("mark_stale_and_require_revalidation"),
    clarification_behavior: z.enum(["ask_when_blocking", "continue_with_explicit_unknowns"]).default("ask_when_blocking"),
  }).strict(),
  citation_source_policy: z.object({
    citation_required_for_external_claims: z.literal(true).default(true),
    source_refs_required_for_synthesis: z.literal(true).default(true),
    unsupported_claims_must_be_named: z.literal(true).default(true),
    raw_source_content_allowed: z.literal(false).default(false),
  }).strict(),
  tool_policy: z.object({
    execution_loop: z.enum(["durable_loop", "agent_loop", "existing_runtime_only"]).default("existing_runtime_only"),
    dedicated_research_runtime: z.literal(false).default(false),
    external_actions_require_approval: z.literal(true).default(true),
    webpage_instructions_are_untrusted: z.literal(true).default(true),
    allowed_tool_refs: z.array(z.string().min(1)).default([]),
    disallowed_tool_refs: z.array(z.string().min(1)).default([]),
  }).strict(),
  stop_conditions: z.array(z.object({
    condition_id: z.string().min(1),
    description: z.string().min(1),
    required: z.boolean().default(true),
  }).strict()).min(1),
  review_gates: z.array(z.object({
    gate_id: z.string().min(1),
    kind: z.enum(["evidence_coverage", "unsupported_claims", "stale_unknown_handling", "citation_policy", "tool_policy"]),
    required: z.boolean().default(true),
  }).strict()).min(1),
  evidence_ledger: DeepResearchEvidenceLedgerRefSchema,
  implementation_status: z.literal("contract_only_first_slice").default("contract_only_first_slice"),
  uses_existing_runtime_loops: z.literal(true).default(true),
}).strict().superRefine((brief, ctx) => {
  const excluded = new Set(brief.excluded_actions);
  if (!excluded.has("new_research_runtime")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["excluded_actions"],
      message: "Deep Research briefs must exclude a dedicated research runtime",
    });
  }
  if (!excluded.has("memory_auto_apply")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["excluded_actions"],
      message: "Deep Research briefs must exclude memory auto-apply",
    });
  }
});
export type ResearchBrief = z.infer<typeof ResearchBriefSchema>;

export const DeepResearchClaimSchema = z.object({
  claim_id: z.string().min(1),
  statement: z.string().min(1),
  required: z.boolean().default(true),
  evidence_refs: z.array(DeepResearchEvidenceRefSchema).default([]),
  citation_refs: z.array(z.object({
    kind: z.enum(["url", "runtime_evidence_entry", "artifact"]),
    ref: z.string().min(1),
  }).strict()).default([]),
}).strict();
export type DeepResearchClaim = z.infer<typeof DeepResearchClaimSchema>;

export const DeepResearchClaimCoverageSchema = z.object({
  claim_id: z.string().min(1),
  statement: z.string().min(1),
  evidence_refs: z.array(DeepResearchEvidenceRefSchema).default([]),
  citation_refs: z.array(z.object({
    kind: z.enum(["url", "runtime_evidence_entry", "artifact"]),
    ref: z.string().min(1),
  }).strict()).default([]),
}).strict();
export type DeepResearchClaimCoverage = z.infer<typeof DeepResearchClaimCoverageSchema>;

export const DeepResearchUnsupportedClaimSchema = DeepResearchClaimCoverageSchema.extend({
  reason: z.enum(["no_evidence_refs", "no_current_supporting_evidence", "contradicted", "citation_missing"]),
  required: z.boolean(),
}).strict();
export type DeepResearchUnsupportedClaim = z.infer<typeof DeepResearchUnsupportedClaimSchema>;

export const DeepResearchStaleOrUnknownSchema = z.object({
  claim_id: z.string().min(1),
  kind: z.enum(["stale", "unknown"]),
  evidence_ref: DeepResearchEvidenceRefSchema,
  handling: z.enum(["mark_stale_and_require_revalidation", "mark_unknown"]),
  reason: z.string().min(1),
}).strict();
export type DeepResearchStaleOrUnknown = z.infer<typeof DeepResearchStaleOrUnknownSchema>;

export const EvaluatorReportSchema = z.object({
  schema_version: z.literal("deep-research-evaluator-report/v1"),
  report_id: z.string().min(1),
  brief_ref: z.string().min(1),
  evaluated_at: z.string().datetime(),
  evidence_ledger: DeepResearchEvidenceLedgerRefSchema,
  supported_claims: z.array(DeepResearchClaimCoverageSchema).default([]),
  unsupported_claims: z.array(DeepResearchUnsupportedClaimSchema).default([]),
  stale_or_unknown: z.array(DeepResearchStaleOrUnknownSchema).default([]),
  review_gate_results: z.array(z.object({
    gate_id: z.string().min(1),
    kind: z.enum(["evidence_coverage", "unsupported_claims", "stale_unknown_handling", "citation_policy", "tool_policy"]),
    required: z.boolean().default(true),
    status: z.enum(["passed", "blocked"]),
    reason: z.string().min(1),
  }).strict()).default([]),
  evidence_coverage: z.object({
    claim_count: z.number().int().nonnegative(),
    supported_count: z.number().int().nonnegative(),
    unsupported_count: z.number().int().nonnegative(),
    stale_or_unknown_count: z.number().int().nonnegative(),
  }).strict(),
  ready_for_synthesis: z.boolean(),
  dedicated_runtime_created: z.literal(false).default(false),
  mutation_performed: z.literal(false).default(false),
}).strict();
export type EvaluatorReport = z.infer<typeof EvaluatorReportSchema>;

export function createResearchBrief(input: z.input<typeof ResearchBriefSchema>): ResearchBrief {
  return ResearchBriefSchema.parse(input);
}

export function evaluateResearchBriefEvidence(input: {
  brief: ResearchBrief | z.input<typeof ResearchBriefSchema>;
  claims: Array<DeepResearchClaim | z.input<typeof DeepResearchClaimSchema>>;
  evidenceEntries: RuntimeEvidenceEntry[];
  evaluatedAt: string;
  reportId?: string;
}): EvaluatorReport {
  const brief = ResearchBriefSchema.parse(input.brief);
  const claims = input.claims.map((claim) => DeepResearchClaimSchema.parse(claim));
  const entriesById = new Map(input.evidenceEntries.map((entry) => {
    const parsed = RuntimeEvidenceEntrySchema.parse(entry);
    return [parsed.id, parsed];
  }));
  const supported: DeepResearchClaimCoverage[] = [];
  const unsupported: DeepResearchUnsupportedClaim[] = [];
  const staleOrUnknown: DeepResearchStaleOrUnknown[] = [];

  for (const claim of claims) {
    const classified = classifyClaimEvidence(claim, entriesById, brief);
    staleOrUnknown.push(...classified.staleOrUnknown);
    if (classified.supported) {
      supported.push(claimCoverage(claim));
    } else {
      unsupported.push({
        ...claimCoverage(claim),
        reason: classified.reason,
        required: claim.required,
      });
    }
  }

  const ledgerRefs = uniqueEvidenceRefs([
    ...brief.evidence_ledger.evidence_refs,
    ...claims.flatMap((claim) => claim.evidence_refs),
  ]);
  const evidenceLedger = DeepResearchEvidenceLedgerRefSchema.parse({
    ...brief.evidence_ledger,
    evidence_refs: ledgerRefs,
  });
  const reviewGateResults = brief.review_gates.map((gate) => {
    const blocked = gateStatus(gate.kind, unsupported, staleOrUnknown, brief);
    return {
      gate_id: gate.gate_id,
      kind: gate.kind,
      required: gate.required,
      status: blocked ? "blocked" as const : "passed" as const,
      reason: blocked ?? `Deep Research ${gate.kind} gate passed for contract-only evidence evaluation.`,
    };
  });
  const readyForSynthesis = reviewGateResults.every((gate) => gate.status === "passed" || !gate.required);

  return EvaluatorReportSchema.parse({
    schema_version: "deep-research-evaluator-report/v1",
    report_id: input.reportId ?? `${brief.brief_id}:evaluator:${input.evaluatedAt}`,
    brief_ref: brief.brief_id,
    evaluated_at: input.evaluatedAt,
    evidence_ledger: evidenceLedger,
    supported_claims: supported,
    unsupported_claims: unsupported,
    stale_or_unknown: staleOrUnknown,
    review_gate_results: reviewGateResults,
    evidence_coverage: {
      claim_count: claims.length,
      supported_count: supported.length,
      unsupported_count: unsupported.length,
      stale_or_unknown_count: staleOrUnknown.length,
    },
    ready_for_synthesis: readyForSynthesis,
    dedicated_runtime_created: false,
    mutation_performed: false,
  });
}

function classifyClaimEvidence(
  claim: DeepResearchClaim,
  entriesById: Map<string, RuntimeEvidenceEntry>,
  brief: ResearchBrief,
): {
  supported: boolean;
  reason: DeepResearchUnsupportedClaim["reason"];
  staleOrUnknown: DeepResearchStaleOrUnknown[];
} {
  if (claim.evidence_refs.length === 0) {
    return { supported: false, reason: "no_evidence_refs", staleOrUnknown: [] };
  }

  const staleOrUnknown: DeepResearchStaleOrUnknown[] = [];
  let currentSupportingEvidence = 0;
  let contradicted = false;
  for (const evidenceRef of claim.evidence_refs) {
    const entry = entriesById.get(evidenceRef.ref);
    if (!entry) {
      staleOrUnknown.push({
        claim_id: claim.claim_id,
        kind: "unknown",
        evidence_ref: { ...evidenceRef, freshness: "unknown" },
        handling: brief.unknown_policy.unknown_evidence_handling,
        reason: `Runtime evidence entry ${evidenceRef.ref} was not found.`,
      });
      continue;
    }
    if (evidenceRef.freshness === "stale") {
      staleOrUnknown.push({
        claim_id: claim.claim_id,
        kind: "stale",
        evidence_ref: evidenceRef,
        handling: brief.unknown_policy.stale_evidence_handling,
        reason: `Runtime evidence entry ${evidenceRef.ref} is marked stale for this claim.`,
      });
      continue;
    }
    if (evidenceRef.freshness === "unknown" || entry.verification_status === "unknown" || entry.verification_status === "unverified") {
      staleOrUnknown.push({
        claim_id: claim.claim_id,
        kind: "unknown",
        evidence_ref: evidenceRef,
        handling: brief.unknown_policy.unknown_evidence_handling,
        reason: `Runtime evidence entry ${evidenceRef.ref} has unknown verification state.`,
      });
      continue;
    }
    if (evidenceRef.supports === "contradicts" || entry.verification_status === "contradicted") {
      contradicted = true;
      continue;
    }
    if (evidenceRef.supports === "supports") currentSupportingEvidence += 1;
  }

  if (contradicted) return { supported: false, reason: "contradicted", staleOrUnknown };
  if (currentSupportingEvidence === 0) return { supported: false, reason: "no_current_supporting_evidence", staleOrUnknown };
  if (brief.citation_source_policy.source_refs_required_for_synthesis && claim.citation_refs.length === 0) {
    return { supported: false, reason: "citation_missing", staleOrUnknown };
  }
  return { supported: true, reason: "no_current_supporting_evidence", staleOrUnknown };
}

function claimCoverage(claim: DeepResearchClaim): DeepResearchClaimCoverage {
  return {
    claim_id: claim.claim_id,
    statement: claim.statement,
    evidence_refs: claim.evidence_refs,
    citation_refs: claim.citation_refs,
  };
}

function uniqueEvidenceRefs(refs: DeepResearchEvidenceRef[]): DeepResearchEvidenceRef[] {
  const seen = new Set<string>();
  const unique: DeepResearchEvidenceRef[] = [];
  for (const ref of refs) {
    const parsed = DeepResearchEvidenceRefSchema.parse(ref);
    const key = `${parsed.kind}:${parsed.ref}:${parsed.supports}:${parsed.freshness}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(parsed);
  }
  return unique;
}

function gateStatus(
  kind: ResearchBrief["review_gates"][number]["kind"],
  unsupported: DeepResearchUnsupportedClaim[],
  staleOrUnknown: DeepResearchStaleOrUnknown[],
  brief: ResearchBrief,
): string | null {
  switch (kind) {
    case "evidence_coverage":
      return unsupported.length > 0 || staleOrUnknown.length > 0
        ? "Evidence coverage has unsupported, stale, or unknown claims."
        : null;
    case "unsupported_claims":
      return unsupported.some((claim) => claim.required)
        ? "Required claims remain unsupported."
        : null;
    case "stale_unknown_handling":
      return staleOrUnknown.length > 0
        ? "Stale or unknown evidence must be carried into synthesis as explicit limitations."
        : null;
    case "citation_policy":
      return unsupported.some((claim) => claim.reason === "citation_missing")
        ? "Supported-looking claims are missing citation refs."
        : null;
    case "tool_policy":
      return brief.tool_policy.dedicated_research_runtime === false
        && brief.tool_policy.external_actions_require_approval === true
        ? null
        : "Tool policy would bypass the existing runtime or approval boundary.";
  }
}
