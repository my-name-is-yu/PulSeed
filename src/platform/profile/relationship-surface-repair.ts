import { z } from "zod/v3";
import {
  createRelationshipProfileChangeProposal,
  type RelationshipProfileChangeProposal,
} from "./profile-change-proposal.js";
import {
  RelationshipProfileConsentScopeSchema,
  RelationshipProfileItemKindSchema,
  RelationshipProfileSensitivitySchema,
  type RelationshipProfileConsentScope,
  type RelationshipProfileItemKind,
  type RelationshipProfileSensitivity,
} from "./relationship-profile.js";

export const RelationshipSurfaceRepairActionSchema = z.enum([
  "correct",
  "suppress",
  "revoke",
  "forget",
]);
export type RelationshipSurfaceRepairAction = z.infer<typeof RelationshipSurfaceRepairActionSchema>;

export const RelationshipSurfaceRepairRequestSchema = z.object({
  action: RelationshipSurfaceRepairActionSchema,
  stableKey: z.string().min(1),
  replacement: z.object({
    kind: RelationshipProfileItemKindSchema,
    value: z.string().min(1),
    sensitivity: RelationshipProfileSensitivitySchema.default("private"),
    allowedScopes: z.array(RelationshipProfileConsentScopeSchema).min(1).default(["memory_retrieval", "user_facing_review"]),
  }).strict().optional(),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  rationale: z.string().min(1),
  now: z.string().datetime().optional(),
}).strict().superRefine((request, ctx) => {
  if (request.action === "correct" && !request.replacement) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["replacement"],
      message: "correct relationship repair requests require a replacement proposal",
    });
  }
  if (request.action !== "correct" && request.replacement) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["replacement"],
      message: `${request.action} relationship repair requests must not carry replacement content`,
    });
  }
});
export type RelationshipSurfaceRepairRequest = z.infer<typeof RelationshipSurfaceRepairRequestSchema>;

export interface CreateRelationshipSurfaceRepairProposalInput {
  baseDir: string;
  action: RelationshipSurfaceRepairAction;
  stableKey: string;
  replacement?: {
    kind: RelationshipProfileItemKind;
    value: string;
    sensitivity?: RelationshipProfileSensitivity;
    allowedScopes?: RelationshipProfileConsentScope[];
  };
  evidenceRefs?: string[];
  rationale: string;
  now?: string;
}

export async function createRelationshipSurfaceRepairProposal(
  input: CreateRelationshipSurfaceRepairProposalInput,
): Promise<{
  action: RelationshipSurfaceRepairAction;
  proposal: RelationshipProfileChangeProposal;
}> {
  const request = RelationshipSurfaceRepairRequestSchema.parse({
    action: input.action,
    stableKey: input.stableKey,
    ...(input.replacement ? { replacement: input.replacement } : {}),
    evidenceRefs: input.evidenceRefs ?? [],
    rationale: input.rationale,
    ...(input.now ? { now: input.now } : {}),
  });

  if (request.action === "correct") {
    const replacement = request.replacement!;
    const result = await createRelationshipProfileChangeProposal(input.baseDir, {
      operation: "upsert_item",
      stableKey: request.stableKey,
      kind: replacement.kind,
      value: replacement.value,
      source: "cli_proposal",
      sensitivity: replacement.sensitivity,
      allowedScopes: replacement.allowedScopes,
      consentScopes: ["user_facing_review"],
      evidenceRefs: request.evidenceRefs,
      rationale: request.rationale,
      ...(request.now ? { now: request.now } : {}),
    });
    return { action: request.action, proposal: result.proposal };
  }

  const result = await createRelationshipProfileChangeProposal(input.baseDir, {
    operation: "retract_item",
    stableKey: request.stableKey,
    source: "cli_proposal",
    consentScopes: ["user_facing_review"],
    allowedScopes: ["user_facing_review"],
    evidenceRefs: request.evidenceRefs,
    rationale: retractionRationaleFor(request.action, request.rationale),
    ...(request.now ? { now: request.now } : {}),
  });
  return { action: request.action, proposal: result.proposal };
}

function retractionRationaleFor(action: RelationshipSurfaceRepairAction, rationale: string): string {
  if (action === "suppress") return `Suppress normal-surface projection: ${rationale}`;
  if (action === "revoke") return `Revoke allowed relationship use: ${rationale}`;
  if (action === "forget") return `Forget relationship memory: ${rationale}`;
  return rationale;
}
