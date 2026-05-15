import { z } from "zod/v3";
import {
  PermissionGrantCapabilitySchema,
  PermissionGrantExcludedCapabilitySchema,
} from "../runtime/store/permission-grant-store.js";

export const PermissionGrantEvaluationStatusSchema = z.enum([
  "matched",
  "missing_grant",
  "expired_grant",
  "revoked_grant",
  "stale_grant",
  "superseded_grant",
  "excluded_capability",
  "unknown_capability",
  "hard_boundary",
  "fresh_approval_required",
]);
export type PermissionGrantEvaluationStatus = z.infer<typeof PermissionGrantEvaluationStatusSchema>;

export const PermissionGrantEvaluationSchema = z.object({
  status: PermissionGrantEvaluationStatusSchema,
  allowed: z.boolean(),
  reason: z.string().min(1),
  requiredCapabilities: z.array(PermissionGrantCapabilitySchema),
  excludedCapabilities: z.array(PermissionGrantExcludedCapabilitySchema),
  matchedGrantId: z.string().min(1).optional(),
  consideredGrantIds: z.array(z.string().min(1)),
}).strict();
export type PermissionGrantEvaluation = z.infer<typeof PermissionGrantEvaluationSchema>;

