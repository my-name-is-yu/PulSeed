import { z } from "zod/v3";
import {
  RelationshipStateProjectionSchema,
  type RelationshipStateProjection,
} from "./contracts.js";

export const RelationshipMemoryNormalSummarySchema = z.object({
  schema_version: z.literal("relationship-memory-normal-summary/v1"),
  surface_target: z.literal("normal_user"),
  posture: z.enum(["neutral", "concise", "careful", "encouraging", "boundary_first"]),
  overreach_risk: z.enum(["none", "low", "medium", "high", "unknown"]),
  included_count: z.number().int().nonnegative(),
  withheld_count: z.number().int().nonnegative(),
  included: z.array(z.object({
    role: z.string().min(1),
    allowed_surface_use: z.string().min(1),
    user_readable_reason: z.string().min(1),
    confidence: z.number().min(0).max(1),
    sensitivity: z.enum(["public", "private"]),
    repair_paths: z.array(z.string().min(1)),
  }).strict()).default([]),
  withheld: z.array(z.object({
    role: z.string().min(1),
    withheld_reason: z.string().min(1),
    user_readable_reason: z.string().min(1),
    sensitivity: z.enum(["public", "private", "sensitive", "redacted"]),
    repair_paths: z.array(z.string().min(1)),
  }).strict()).default([]),
  read_only: z.literal(true).default(true),
  mutation_performed: z.literal(false).default(false),
  raw_memory_refs_visible: z.literal(false).default(false),
  raw_source_refs_visible: z.literal(false).default(false),
  sensitive_content_visible: z.literal(false).default(false),
}).strict();
export type RelationshipMemoryNormalSummary = z.infer<typeof RelationshipMemoryNormalSummarySchema>;

export function projectRelationshipMemoryNormalSummary(
  projection: RelationshipStateProjection
): RelationshipMemoryNormalSummary {
  const parsed = RelationshipStateProjectionSchema.parse(projection);
  return RelationshipMemoryNormalSummarySchema.parse({
    schema_version: "relationship-memory-normal-summary/v1",
    surface_target: "normal_user",
    posture: parsed.posture,
    overreach_risk: parsed.overreach_risk,
    included_count: parsed.included.length,
    withheld_count: parsed.withheld.length,
    included: parsed.included.map((fact) => ({
      role: fact.role,
      allowed_surface_use: fact.allowed_surface_use,
      user_readable_reason: fact.user_readable_reason,
      confidence: fact.confidence,
      sensitivity: fact.sensitivity,
      repair_paths: fact.repair_paths,
    })),
    withheld: parsed.withheld.map((fact) => ({
      role: fact.role,
      withheld_reason: fact.withheld_reason,
      user_readable_reason: fact.user_readable_reason,
      sensitivity: fact.sensitivity,
      repair_paths: fact.repair_paths,
    })),
    read_only: true,
    mutation_performed: false,
    raw_memory_refs_visible: false,
    raw_source_refs_visible: false,
    sensitive_content_visible: false,
  });
}
