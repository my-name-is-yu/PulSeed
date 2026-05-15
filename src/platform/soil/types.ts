import { z } from "zod/v3";

export const SoilRouteSchema = z.enum([
  "index",
  "status",
  "health",
  "report",
  "schedule",
  "memory",
  "knowledge",
  "decision",
  "identity",
  "goal",
  "task",
  "timeline",
  "operations",
  "inbox",
]);
export type SoilRoute = z.infer<typeof SoilRouteSchema>;

export const SoilKindSchema = z.enum([
  "index",
  "status",
  "health",
  "report",
  "schedule",
  "memory",
  "knowledge",
  "decision",
  "identity",
  "goal",
  "task",
  "timeline",
  "operations",
  "inbox",
  "overlay",
  "note",
]);
export type SoilKind = z.infer<typeof SoilKindSchema>;

export const SoilStatusSchema = z.enum([
  "draft",
  "candidate",
  "confirmed",
  "stale",
  "superseded",
  "rejected",
  "deprecated",
  "archived",
]);
export type SoilStatus = z.infer<typeof SoilStatusSchema>;

export const SoilSourceSchema = z.enum(["runtime", "compiled", "manual", "imported"]);
export type SoilSource = z.infer<typeof SoilSourceSchema>;

export const SoilSourceTruthSchema = z.enum(["runtime_json", "runtime_db", "soil", "mixed"]);
export type SoilSourceTruth = z.infer<typeof SoilSourceTruthSchema>;

export const SoilImportStatusSchema = z.enum(["none", "pending", "approved", "rejected"]);
export type SoilImportStatus = z.infer<typeof SoilImportStatusSchema>;

export const SoilApprovalStatusSchema = z.enum(["none", "pending", "approved", "rejected"]);
export type SoilApprovalStatus = z.infer<typeof SoilApprovalStatusSchema>;

export const SoilSourceTypeSchema = z.enum([
  "runtime_json",
  "runtime_db",
  "control_db",
  "controlled_md",
  "soil_md",
  "manual_overlay",
  "web",
  "tool_output",
  "log",
]);
export type SoilSourceType = z.infer<typeof SoilSourceTypeSchema>;

const ISO_DATETIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

export function isSoilDatetime(value: string): boolean {
  const match = ISO_DATETIME_PATTERN.exec(value);
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, millisecondText, timezoneText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number((millisecondText ?? "0").padEnd(3, "0"));

  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    !isValidTimezoneOffset(timezoneText)
  ) {
    return false;
  }

  const candidate = new Date(0);
  candidate.setUTCFullYear(year, month - 1, day);
  candidate.setUTCHours(hour, minute, second, millisecond);

  return (
    Number.isFinite(Date.parse(value)) &&
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day &&
    candidate.getUTCHours() === hour &&
    candidate.getUTCMinutes() === minute &&
    candidate.getUTCSeconds() === second &&
    candidate.getUTCMilliseconds() === millisecond
  );
}

export const SoilDatetimeSchema = z.preprocess((value) => {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      return value;
    }
    return value.toISOString();
  }
  return value;
}, z.string().refine(isSoilDatetime, "Must be a valid ISO-8601 datetime string"));

function isValidTimezoneOffset(value: string): boolean {
  if (value === "Z") return true;
  const hour = Number(value.slice(1, 3));
  const minute = Number(value.slice(4, 6));
  return hour <= 23 && minute <= 59;
}

export const SoilSourceRefSchema = z.object({
  source_type: SoilSourceTypeSchema,
  source_path: z.string().min(1),
  source_id: z.string().min(1).optional(),
  source_hash: z.string().min(1).optional(),
  source_version: z.string().min(1).optional(),
  source_uri: z.string().min(1).optional(),
  fetched_at: SoilDatetimeSchema.optional(),
  committed_at: SoilDatetimeSchema.optional(),
  reliability: z.enum(["high", "medium", "low"]).optional(),
});
export type SoilSourceRef = z.infer<typeof SoilSourceRefSchema>;

export const SoilGenerationWatermarkSchema = z.object({
  scope: z.string().min(1),
  source_path: z.string().min(1).optional(),
  source_paths: z.array(z.string().min(1)).default([]),
  source_hash: z.string().min(1).optional(),
  source_hashes: z.array(z.string().min(1)).default([]),
  source_version: z.string().min(1).optional(),
  source_updated_at: SoilDatetimeSchema.optional(),
  generated_at: SoilDatetimeSchema,
  projection_version: z.string().min(1),
  input_commit_ids: z.array(z.string().min(1)).default([]),
  input_checksums: z.record(z.string()).default({}),
});
export type SoilGenerationWatermark = z.infer<typeof SoilGenerationWatermarkSchema>;

export const SoilManualOverlayStatusSchema = z.enum([
  "candidate",
  "confirmed",
  "rejected",
  "superseded",
]);
export type SoilManualOverlayStatus = z.infer<typeof SoilManualOverlayStatusSchema>;

export const SoilManualOverlaySchema = z.object({
  enabled: z.boolean().default(false),
  status: SoilManualOverlayStatusSchema.default("candidate"),
  overlay_id: z.string().min(1).optional(),
  author: z.string().min(1).optional(),
  target_ref: z.string().min(1).optional(),
  created_at: SoilDatetimeSchema.optional(),
  updated_at: SoilDatetimeSchema.optional(),
  notes: z.string().optional(),
});
export type SoilManualOverlay = z.infer<typeof SoilManualOverlaySchema>;

export const SoilPageFrontmatterSchema = z
  .object({
    soil_id: z.string().min(1),
    kind: SoilKindSchema,
    status: SoilStatusSchema,
    title: z.string().min(1),
    route: SoilRouteSchema,
    source: SoilSourceSchema,
    version: z.string().min(1),
    created_at: SoilDatetimeSchema,
    updated_at: SoilDatetimeSchema,
    generated_at: SoilDatetimeSchema,
    source_refs: z.array(SoilSourceRefSchema).default([]),
    generation_watermark: SoilGenerationWatermarkSchema,
    stale: z.boolean().default(false),
    manual_overlay: SoilManualOverlaySchema.default({ enabled: false, status: "candidate" }),
    goal_id: z.string().min(1).optional(),
    task_id: z.string().min(1).optional(),
    schedule_id: z.string().min(1).optional(),
    decision_id: z.string().min(1).optional(),
    entry_id: z.string().min(1).optional(),
    domain: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    priority: z.number().int().optional(),
    summary: z.string().optional(),
    owner: z.string().min(1).optional(),
    source_truth: SoilSourceTruthSchema.optional(),
    rendered_from: z.string().min(1).optional(),
    import_status: SoilImportStatusSchema.default("none"),
    approval_status: SoilApprovalStatusSchema.default("none"),
    approved_at: SoilDatetimeSchema.optional(),
    approved_by: z.string().min(1).optional(),
    supersedes: z.array(z.string().min(1)).default([]),
    superseded_by: z.string().min(1).optional(),
    checksum: z.string().min(1).optional(),
    page_format_version: z.string().min(1).optional(),
  })
  .passthrough();
export type SoilPageFrontmatter = z.infer<typeof SoilPageFrontmatterSchema>;
