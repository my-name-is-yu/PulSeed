import { z } from "zod";

export const AssetKindSchema = z.enum([
  "skill_bundle",
  "native_plugin",
  "foreign_plugin",
  "mcp_server",
  "builtin_integration",
  "interactive_automation_provider",
  "notifier",
  "cli_tool",
  "dream_procedural_hint",
  "soil_surface",
  "knowledge_surface",
  "runtime_tool",
  "external_connector",
]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

export const AssetSourceAgentSchema = z.enum([
  "pulseed",
  "codex",
  "claude",
  "openclaw",
  "hermes",
  "unknown",
]);
export type AssetSourceAgent = z.infer<typeof AssetSourceAgentSchema>;

export const AssetRecordStatusSchema = z.enum([
  "recorded",
  "imported",
  "disabled",
  "quarantined",
  "invalid",
]);
export type AssetRecordStatus = z.infer<typeof AssetRecordStatusSchema>;

export const AssetRecordSchema = z.object({
  id: z.string().min(1),
  kind: AssetKindSchema,
  label: z.string().min(1),
  source_agent: AssetSourceAgentSchema,
  source_path: z.string().min(1).optional(),
  imported_path: z.string().min(1).optional(),
  checksum: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  compatibility_report_ref: z.string().min(1).optional(),
  readiness_ref: z.string().min(1).optional(),
  status: AssetRecordStatusSchema,
  recorded_at: z.string().min(1),
  updated_at: z.string().min(1),
  provenance: z.object({
    source_label: z.string().min(1).optional(),
    import_batch_id: z.string().min(1).optional(),
    evidence_refs: z.array(z.string().min(1)).optional(),
    notes: z.array(z.string().min(1)).optional(),
  }).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AssetRecord = z.infer<typeof AssetRecordSchema>;

export type AssetRecordInput =
  Omit<AssetRecord, "recorded_at" | "updated_at"> &
  Partial<Pick<AssetRecord, "recorded_at" | "updated_at">>;

export const AssetRegistryFileSchema = z.object({
  version: z.literal(1),
  updated_at: z.string().min(1),
  assets: z.array(AssetRecordSchema),
});
export type AssetRegistryFile = z.infer<typeof AssetRegistryFileSchema>;

export const AssetExecutionClaimSchema = z.object({
  executable: z.literal(false),
  reason: z.literal("asset_record_only"),
  readiness_ref: z.string().min(1).optional(),
});
export type AssetExecutionClaim = z.infer<typeof AssetExecutionClaimSchema>;

export type AssetView = AssetRecord & {
  execution: AssetExecutionClaim;
};

export function createAssetRecord(input: AssetRecordInput, now = new Date().toISOString()): AssetRecord {
  return AssetRecordSchema.parse({
    recorded_at: now,
    updated_at: now,
    ...input,
  });
}

export function toAssetView(record: AssetRecord): AssetView {
  return {
    ...record,
    execution: AssetExecutionClaimSchema.parse({
      executable: false,
      reason: "asset_record_only",
      ...(record.readiness_ref ? { readiness_ref: record.readiness_ref } : {}),
    }),
  };
}

export function toAssetId(kind: AssetKind, parts: string[]): string {
  const body = parts
    .join("/")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => part.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter((part) => part.length > 0 && part !== "." && part !== "..")
    .join("/");
  return `${kind}:${body || "unknown"}`;
}
