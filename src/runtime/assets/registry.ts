import * as path from "node:path";
import { getPulseedDirPath } from "../../base/utils/paths.js";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../base/utils/json-io.js";
import {
  AssetRegistryFileSchema,
  createAssetRecord,
  toAssetView,
  type AssetRecord,
  type AssetRecordInput,
  type AssetRegistryFile,
  type AssetView,
} from "./types.js";

export interface AssetRegistryOptions {
  baseDir?: string;
  filePath?: string;
}

export class AssetRegistry {
  private readonly filePath: string;

  constructor(options: AssetRegistryOptions = {}) {
    const baseDir = options.baseDir ?? getPulseedDirPath();
    this.filePath = options.filePath ?? path.join(baseDir, "runtime", "assets", "registry.json");
  }

  async list(): Promise<AssetView[]> {
    const registry = await this.loadFile();
    return registry.assets
      .map((asset) => toAssetView(asset))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<AssetView | null> {
    const registry = await this.loadFile();
    const asset = registry.assets.find((candidate) => candidate.id === id);
    return asset ? toAssetView(asset) : null;
  }

  async search(query: string): Promise<AssetView[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    const assets = await this.list();
    return assets.filter((asset) => searchableText(asset).includes(normalized));
  }

  async record(input: AssetRecordInput): Promise<AssetView> {
    const [record] = await this.recordMany([input]);
    if (!record) throw new Error("asset record write produced no record");
    return record;
  }

  async recordMany(inputs: AssetRecordInput[]): Promise<AssetView[]> {
    if (inputs.length === 0) return [];
    const current = await this.loadFile();
    const now = new Date().toISOString();
    const byId = new Map(current.assets.map((asset) => [asset.id, asset]));
    const written: AssetRecord[] = [];

    for (const input of inputs) {
      const id = nextRecordId(input.id, byId, input.provenance?.import_batch_id ?? now);
      const record = createAssetRecord({
        ...input,
        id,
        ...(id !== input.id ? {
          metadata: {
            ...(input.metadata ?? {}),
            logical_asset_id: input.id,
          },
        } : {}),
        recorded_at: input.recorded_at ?? now,
        updated_at: now,
      }, now);
      byId.set(record.id, record);
      written.push(record);
    }

    const next: AssetRegistryFile = AssetRegistryFileSchema.parse({
      version: 1,
      updated_at: now,
      assets: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    });
    await writeJsonFileAtomic(this.filePath, next);
    return written.map((record) => toAssetView(record));
  }

  private async loadFile(): Promise<AssetRegistryFile> {
    const raw = await readJsonFileOrNull<unknown>(this.filePath);
    if (raw === null) {
      return {
        version: 1,
        updated_at: new Date().toISOString(),
        assets: [],
      };
    }
    return AssetRegistryFileSchema.parse(raw);
  }
}

function nextRecordId(
  requestedId: string,
  existing: Map<string, AssetRecord>,
  importBatchId: string
): string {
  if (!existing.has(requestedId)) return requestedId;
  const batchSuffix = importBatchId
    .replace(/\\/g, "/")
    .split("/")
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = `${requestedId}@${batchSuffix || "import"}`;
  if (!existing.has(base)) return base;
  let suffix = 2;
  for (;;) {
    const candidate = `${base}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
    suffix += 1;
  }
}

function searchableText(asset: AssetRecord): string {
  return [
    asset.id,
    asset.kind,
    asset.label,
    asset.source_agent,
    asset.source_path,
    asset.imported_path,
    asset.version,
    asset.compatibility_report_ref,
    asset.readiness_ref,
    asset.status,
    asset.provenance?.source_label,
    asset.provenance?.import_batch_id,
    ...(asset.provenance?.evidence_refs ?? []),
    ...(asset.provenance?.notes ?? []),
    ...Object.values(asset.metadata ?? {}).flatMap((value) =>
      typeof value === "string" ? [value] : []
    ),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n")
    .toLowerCase();
}
