import { z } from "zod/v3";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import {
  createRelationshipProfileChangeProposal,
  RelationshipProfileProposalOperationSchema,
  type RelationshipProfileChangeProposal,
} from "./profile-change-proposal.js";
import {
  RelationshipProfileConsentScopeSchema,
  RelationshipProfileItemKindSchema,
  RelationshipProfileSensitivitySchema,
} from "./relationship-profile.js";

const UserMdRelationshipProfileCandidateSchema = z.object({
  operation: RelationshipProfileProposalOperationSchema.default("upsert_item"),
  stable_key: z.string().min(1),
  kind: RelationshipProfileItemKindSchema,
  value: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.7),
  sensitivity: RelationshipProfileSensitivitySchema.default("private"),
  allowed_scopes: z.array(RelationshipProfileConsentScopeSchema).min(1).default(["user_facing_review"]),
  consent_scopes: z.array(RelationshipProfileConsentScopeSchema).min(1).default(["user_facing_review"]),
  evidence_refs: z.array(z.string().min(1)).default([]),
  rationale: z.string().min(1),
});

const UserMdRelationshipProfileBlockSchema = z.object({
  relationship_profile_proposals: z.array(UserMdRelationshipProfileCandidateSchema).default([]),
});

const UserMdExtractionSchema = z.object({
  candidates: z.array(UserMdRelationshipProfileCandidateSchema).default([]),
});

export type UserMdRelationshipProfileCandidate = z.infer<typeof UserMdRelationshipProfileCandidateSchema>;

export interface UserMdProfileImportProposalResult {
  proposals: RelationshipProfileChangeProposal[];
  candidate_count: number;
  skipped_blocks: Array<{ index: number; reason: string }>;
  extraction_source: "structured_block" | "classifier" | "review_only_fallback";
}

const USER_MD_PROFILE_EXTRACTION_SYSTEM = `Extract relationship-profile proposal candidates from imported USER.md content.

Return JSON only:
{
  "candidates": [
    {
      "operation": "upsert_item",
      "stable_key": "user.preference.status_reports",
      "kind": "preference" | "boundary" | "value" | "communication_style" | "long_term_goal" | "life_context" | "intervention_policy",
      "value": "one durable profile statement",
      "confidence": 0.0-1.0,
      "sensitivity": "public" | "private" | "sensitive",
      "allowed_scopes": ["local_planning" | "resident_behavior" | "memory_retrieval" | "user_facing_review"],
      "consent_scopes": ["user_facing_review"],
      "evidence_refs": ["setup:USER.md"],
      "rationale": "why this candidate follows from the USER.md text"
    }
  ]
}

Rules:
- Produce typed candidates only when the USER.md text directly supports them.
- Keep uncertain or sensitive candidates approval-required by using consent_scopes ["user_facing_review"].
- Do not invent private facts, medical facts, legal facts, secrets, identities, or operational permissions.
- Prefer stable_key values under user.preference.*, user.boundary.*, user.value.*, user.communication_style.*, user.long_term_goal.*, user.life_context.*, or user.intervention_policy.*.
- If no durable relationship-profile item is supported, return {"candidates":[]}.`;

function extractJsonCodeBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const lines = markdown.split(/\r?\n/);
  let inJsonBlock = false;
  let current: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inJsonBlock && trimmed.startsWith("```")) {
      const info = trimmed.slice(3).trim().toLowerCase();
      inJsonBlock = info === "json" || info === "relationship_profile";
      current = [];
      continue;
    }
    if (inJsonBlock && trimmed === "```") {
      blocks.push(current.join("\n"));
      inJsonBlock = false;
      current = [];
      continue;
    }
    if (inJsonBlock) {
      current.push(line);
    }
  }
  return blocks;
}

function buildReviewOnlyFallbackCandidate(markdown: string): UserMdRelationshipProfileCandidate {
  return UserMdRelationshipProfileCandidateSchema.parse({
    operation: "upsert_item",
    stable_key: "user.imported_user_md.review",
    kind: "life_context",
    value: markdown.trim(),
    confidence: 0.45,
    sensitivity: "private",
    allowed_scopes: ["user_facing_review"],
    consent_scopes: ["user_facing_review"],
    evidence_refs: ["setup:USER.md"],
    rationale: "Imported USER.md contained unstructured content. It is kept as a review-only relationship profile proposal until an operator approves or refines it.",
  });
}

export function parseRelationshipProfileCandidatesFromUserMd(markdown: string): {
  candidates: UserMdRelationshipProfileCandidate[];
  skipped_blocks: Array<{ index: number; reason: string }>;
} {
  const candidates: UserMdRelationshipProfileCandidate[] = [];
  const skipped_blocks: Array<{ index: number; reason: string }> = [];
  const blocks = extractJsonCodeBlocks(markdown);
  blocks.forEach((block, index) => {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(block);
    } catch {
      skipped_blocks.push({ index, reason: "invalid JSON relationship profile import block" });
      return;
    }
    const parsed = UserMdRelationshipProfileBlockSchema.safeParse(parsedJson);
    if (!parsed.success) {
      skipped_blocks.push({ index, reason: "JSON block does not match relationship_profile_proposals schema" });
      return;
    }
    candidates.push(...parsed.data.relationship_profile_proposals);
  });
  return { candidates, skipped_blocks };
}

export async function extractRelationshipProfileCandidatesFromUserMd(params: {
  markdown: string;
  llmClient?: ILLMClient;
}): Promise<{
  candidates: UserMdRelationshipProfileCandidate[];
  skipped_blocks: Array<{ index: number; reason: string }>;
  extraction_source: UserMdProfileImportProposalResult["extraction_source"];
}> {
  const parsed = parseRelationshipProfileCandidatesFromUserMd(params.markdown);
  if (parsed.candidates.length > 0 || params.markdown.trim().length === 0) {
    return {
      candidates: parsed.candidates,
      skipped_blocks: parsed.skipped_blocks,
      extraction_source: "structured_block",
    };
  }

  if (params.llmClient) {
    try {
      const response = await params.llmClient.sendMessage(
        [{ role: "user", content: params.markdown }],
        {
          system: USER_MD_PROFILE_EXTRACTION_SYSTEM,
          max_tokens: 1400,
          temperature: 0,
          model_tier: "light",
        }
      );
      const extraction = params.llmClient.parseJSON(response.content, UserMdExtractionSchema);
      const extractedCandidates = z.array(UserMdRelationshipProfileCandidateSchema).parse(extraction.candidates ?? []);
      if (extractedCandidates.length > 0) {
        return {
          candidates: extractedCandidates,
          skipped_blocks: parsed.skipped_blocks,
          extraction_source: "classifier",
        };
      }
    } catch {
      // Fall through to the explicit review-only proposal. Setup should remain usable
      // even when the configured model is unavailable during import.
    }
  }

  return {
    candidates: [buildReviewOnlyFallbackCandidate(params.markdown)],
    skipped_blocks: parsed.skipped_blocks,
    extraction_source: "review_only_fallback",
  };
}

export async function createRelationshipProfileProposalsFromUserMdImport(params: {
  baseDir: string;
  importedUserContent: string;
  llmClient?: ILLMClient;
  now?: string;
}): Promise<UserMdProfileImportProposalResult> {
  const parsed = await extractRelationshipProfileCandidatesFromUserMd({
    markdown: params.importedUserContent,
    llmClient: params.llmClient,
  });
  const proposals: RelationshipProfileChangeProposal[] = [];
  for (const [index, candidate] of parsed.candidates.entries()) {
    const result = await createRelationshipProfileChangeProposal(params.baseDir, {
      operation: candidate.operation,
      stableKey: candidate.stable_key,
      kind: candidate.kind,
      value: candidate.value,
      source: "setup_import",
      confidence: candidate.confidence,
      sensitivity: candidate.sensitivity,
      consentScopes: candidate.consent_scopes,
      allowedScopes: candidate.allowed_scopes,
      evidenceRefs: candidate.evidence_refs.length > 0
        ? candidate.evidence_refs
        : [`setup:USER.md#relationship_profile_proposals[${index}]`],
      rationale: candidate.rationale,
      now: params.now,
    });
    proposals.push(result.proposal);
  }
  return {
    proposals,
    candidate_count: parsed.candidates.length,
    skipped_blocks: parsed.skipped_blocks,
    extraction_source: parsed.extraction_source,
  };
}
