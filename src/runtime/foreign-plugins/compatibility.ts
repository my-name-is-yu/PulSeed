import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { PluginChannelRuntimeStateStore } from "../store/plugin-channel-runtime-state-store.js";
import { readRawPluginManifestSync } from "../plugin-manifest-reader.js";
import type {
  CompatibilityReviewRecord,
  ForeignPluginAdapterRequirement,
  ForeignPluginCompatibilityReport,
  ForeignPluginExecutionBlocker,
  ForeignPluginManifestSummary,
  ForeignPluginPermissions,
  ForeignPluginSmokeRequirement,
  ForeignPluginSource,
  ForeignPluginSourceProvenance,
} from "./types.js";
import {
  CompatibilityReviewRecordSchema,
  ForeignPluginCompatibilityReportSchema,
} from "./types.js";

export const FOREIGN_PLUGIN_COMPATIBILITY_REPORT_FILENAME = "pulseed-foreign-plugin-compatibility.json";
export const FOREIGN_PLUGIN_REVIEW_RECORD_FILENAME = "pulseed-foreign-plugin-review.json";
const NAME_PATTERN = /^[a-z0-9-]+$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SUPPORTED_TYPES = new Set(["adapter", "data_source", "notifier", "schedule_source"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) return undefined;
    result.push(item.trim());
  }
  return result.length > 0 ? result : undefined;
}

function defaultPermissions(): ForeignPluginPermissions {
  return {
    network: false,
    file_read: false,
    file_write: false,
    shell: false,
  };
}

function requestedPermissionBlockers(permissions: ForeignPluginPermissions): ForeignPluginExecutionBlocker[] {
  const blockers: ForeignPluginExecutionBlocker[] = [];
  if (permissions.network) blockers.push("requested_network_permission");
  if (permissions.file_read) blockers.push("requested_file_read_permission");
  if (permissions.file_write) blockers.push("requested_file_write_permission");
  if (permissions.shell) blockers.push("requested_shell_permission");
  return blockers;
}

function adapterRequirementsForManifest(
  manifest: ForeignPluginManifestSummary | undefined
): ForeignPluginAdapterRequirement[] {
  if (!manifest) return [];
  return [
    {
      kind: "native_plugin_conversion",
      required: true,
      reason: "Foreign manifests are asset evidence until converted into a native PulSeed plugin contract.",
    },
    {
      kind: "compatibility_adapter",
      required: true,
      reason: `Foreign ${manifest.type} implementations need an explicit adapter boundary before runtime loading.`,
    },
    {
      kind: "mcp_or_cli_bridge",
      required: true,
      reason: "Bridge execution requires explicit command, permission, and operation policy.",
    },
  ];
}

function smokeRequirementsForManifest(
  manifest: ForeignPluginManifestSummary | undefined
): ForeignPluginSmokeRequirement[] {
  if (!manifest) return [];
  const sideEffectProfile =
    manifest.type === "data_source" ? "read"
      : manifest.type === "notifier" ? "send"
        : manifest.type === "schedule_source" ? "read"
          : "mutate";
  const riskClass = sideEffectProfile === "read" ? "low" : "medium";
  return [{
    operation_kind: manifest.type,
    payload_class: "foreign_plugin_manifest",
    risk_class: riskClass,
    side_effect_profile: sideEffectProfile,
    required: true,
  }];
}

function compatibilityReport(
  source: ForeignPluginSource,
  status: ForeignPluginCompatibilityReport["status"],
  issues: string[],
  permissions: ForeignPluginPermissions,
  context: {
    manifestPath?: string;
    manifest?: ForeignPluginManifestSummary;
    sourceProvenance?: ForeignPluginSourceProvenance;
  } = {}
): ForeignPluginCompatibilityReport {
  const executionBlockers: ForeignPluginExecutionBlocker[] = status === "incompatible"
    ? ["manifest_incompatible", "foreign_plugin_imported_disabled"]
    : [
        "foreign_plugin_imported_disabled",
        "operator_review_required",
        "adapter_required",
        "smoke_verification_required",
        ...requestedPermissionBlockers(permissions),
      ];
  return {
    schema_version: "foreign-plugin-compatibility/v1",
    source,
    status,
    runtime_loadable: false,
    issues,
    permissions,
    execution_blockers: executionBlockers,
    adapter_requirements: adapterRequirementsForManifest(context.manifest),
    smoke_requirements: smokeRequirementsForManifest(context.manifest),
    ...(context.sourceProvenance ? { source_provenance: context.sourceProvenance } : {}),
    ...(context.manifestPath ? { manifestPath: context.manifestPath } : {}),
    ...(context.manifest ? { manifest: context.manifest } : {}),
  };
}

function normalizePermissions(raw: unknown): { permissions: ForeignPluginPermissions; issues: string[] } {
  const permissions = defaultPermissions();
  if (raw === undefined) return { permissions, issues: [] };
  if (!isRecord(raw)) {
    return { permissions, issues: ["permissions block must be an object"] };
  }

  const issues: string[] = [];
  for (const key of Object.keys(permissions) as Array<keyof ForeignPluginPermissions>) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      issues.push(`permissions.${key} must be a boolean`);
      continue;
    }
    permissions[key] = value;
  }
  return { permissions, issues };
}

function summarizeManifest(
  raw: Record<string, unknown>,
  pluginDir?: string
): {
  summary?: ForeignPluginManifestSummary;
  issues: string[];
  permissions: ForeignPluginPermissions;
} {
  const issues: string[] = [];
  const name = stringValue(raw["name"]);
  if (!name) issues.push("missing plugin name");
  else if (!NAME_PATTERN.test(name)) issues.push("plugin name must use lowercase letters, digits, and hyphens");

  const version = stringValue(raw["version"]);
  if (!version) issues.push("missing plugin version");
  else if (!VERSION_PATTERN.test(version)) issues.push("plugin version must use semver major.minor.patch");

  const type = stringValue(raw["type"]);
  if (!type) issues.push("missing plugin type");
  else if (!SUPPORTED_TYPES.has(type)) issues.push(`unsupported plugin type: ${type}`);

  const capabilities = stringArray(raw["capabilities"]);
  if (!capabilities) issues.push("capabilities must be a non-empty array of strings");

  const description = stringValue(raw["description"]);
  if (!description) issues.push("missing plugin description");

  const rawEntryPoint = raw["entry_point"];
  let entryPoint = "dist/index.js";
  if (rawEntryPoint !== undefined) {
    const parsedEntryPoint = stringValue(rawEntryPoint);
    if (parsedEntryPoint) {
      entryPoint = parsedEntryPoint;
    } else {
      issues.push("entry_point must be a non-empty string");
    }
  }
  if (pluginDir) {
    const resolvedEntryPoint = path.resolve(pluginDir, entryPoint);
    const boundary = pluginDir.endsWith(path.sep) ? pluginDir : `${pluginDir}${path.sep}`;
    if (resolvedEntryPoint !== pluginDir && !resolvedEntryPoint.startsWith(boundary)) {
      issues.push(`entry_point escapes plugin directory: ${entryPoint}`);
    }
  }

  const { permissions, issues: permissionIssues } = normalizePermissions(raw["permissions"]);
  issues.push(...permissionIssues);

  if (issues.length > 0 || !name || !version || !type || !capabilities || !description) {
    return { issues, permissions };
  }

  return {
    summary: {
      name,
      version,
      type,
      capabilities,
      description,
      entry_point: entryPoint,
    },
    issues,
    permissions,
  };
}

export function analyzeForeignPluginManifest(
  source: ForeignPluginSource,
  raw: unknown,
  context: { pluginDir?: string; manifestPath?: string; sourceProvenance?: ForeignPluginSourceProvenance } = {}
): ForeignPluginCompatibilityReport {
  const permissions = defaultPermissions();
  if (!isRecord(raw)) {
    return {
      ...compatibilityReport(source, "incompatible", ["manifest is not an object"], permissions, context),
    };
  }

  const { summary, issues, permissions: parsedPermissions } = summarizeManifest(raw, context.pluginDir);
  if (issues.length > 0 || !summary) {
    return {
      ...compatibilityReport(
        source,
        "incompatible",
        issues.length > 0 ? issues : ["manifest is incompatible"],
        parsedPermissions,
        context
      ),
    };
  }

  const requestedPermissions = Object.entries(parsedPermissions)
    .flatMap(([key, value]) => (value ? [key] : []));
  const status = requestedPermissions.length > 0 ? "quarantined" : "convertible";
  const compatibilityIssues =
    status === "quarantined"
      ? [`requested permissions: ${requestedPermissions.join(", ")}`]
      : ["manifest is compatible and can be translated into a disabled PulSeed plugin"];

  return {
    ...compatibilityReport(source, status, compatibilityIssues, parsedPermissions, {
      ...context,
      manifest: summary,
    }),
  };
}

export function analyzeForeignPluginDirectory(
  source: ForeignPluginSource,
  pluginDir: string
): ForeignPluginCompatibilityReport {
  const manifest = readRawPluginManifestSync(pluginDir);
  if (!manifest.ok && manifest.failure === "missing") {
    return {
      ...compatibilityReport(
        source,
        "incompatible",
        ["plugin.yaml or plugin.json was not found"],
        defaultPermissions(),
        { sourceProvenance: { source_path: pluginDir } }
      ),
    };
  }

  if (!manifest.ok) {
    return {
      ...compatibilityReport(
        source,
        "incompatible",
        [`failed to ${manifest.failure} manifest: ${manifest.filename ?? "unknown"}`],
        defaultPermissions(),
        {
          manifestPath: manifest.manifestPath,
          sourceProvenance: {
            source_path: pluginDir,
            ...(manifest.manifestPath ? { manifest_path: manifest.manifestPath } : {}),
          },
        }
      ),
    };
  }

  const report = analyzeForeignPluginManifest(source, manifest.value, {
    pluginDir,
    manifestPath: manifest.manifestPath,
  });
  return withForeignPluginProvenance(report, {
    source_path: pluginDir,
    manifest_path: manifest.manifestPath,
  });
}

export function withForeignPluginProvenance(
  report: ForeignPluginCompatibilityReport,
  provenance: ForeignPluginSourceProvenance
): ForeignPluginCompatibilityReport {
  return {
    ...report,
    source_provenance: {
      ...report.source_provenance,
      ...provenance,
    },
  };
}

export function createPendingCompatibilityReviewRecord(
  report: ForeignPluginCompatibilityReport,
  options: { reportRef: string; createdAt?: string }
): CompatibilityReviewRecord {
  return {
    schema_version: "foreign-plugin-review/v1",
    source: report.source,
    plugin_name: report.manifest?.name ?? "unknown",
    status: "pending_operator_review",
    report_ref: options.reportRef,
    runtime_loadable: false,
    load_authority: "not_granted",
    requested_permissions: report.permissions,
    execution_blockers: report.execution_blockers,
    created_at: options.createdAt ?? new Date().toISOString(),
  };
}

export async function writeForeignPluginCompatibilityArtifacts(
  pluginDir: string,
  report: ForeignPluginCompatibilityReport,
  options: { createdAt?: string } = {}
): Promise<{
  reportPath: string;
  reviewRecordPath: string;
  reviewRecord: CompatibilityReviewRecord;
}> {
  await fsp.mkdir(pluginDir, { recursive: true });
  const parsedReport = ForeignPluginCompatibilityReportSchema.parse(report);
  const reportRef = foreignPluginRuntimeRef("foreign-plugin-compatibility", pluginDir);
  const reviewRecord = CompatibilityReviewRecordSchema.parse(createPendingCompatibilityReviewRecord(parsedReport, {
    reportRef,
    createdAt: options.createdAt,
  }));
  const artifact = await foreignPluginRuntimeStore(pluginDir).saveForeignPluginCompatibility(
    pluginDir,
    parsedReport,
    reviewRecord,
  );
  return {
    reportPath: artifact.reportRef,
    reviewRecordPath: artifact.reviewRecordRef,
    reviewRecord: artifact.reviewRecord,
  };
}

export async function hasForeignPluginCompatibilityArtifact(pluginDir: string): Promise<boolean> {
  return foreignPluginRuntimeStore(pluginDir).hasForeignPluginCompatibility(pluginDir);
}

export async function readForeignPluginCompatibilityArtifact(
  pluginDir: string
): Promise<ForeignPluginCompatibilityReport | null> {
  return foreignPluginRuntimeStore(pluginDir).loadForeignPluginCompatibility(pluginDir);
}

function foreignPluginRuntimeStore(pluginDir: string): PluginChannelRuntimeStateStore {
  return new PluginChannelRuntimeStateStore(inferForeignPluginBaseDir(pluginDir));
}

function foreignPluginRuntimeRef(kind: string, pluginDir: string): string {
  const digest = createHash("sha256").update(path.resolve(pluginDir), "utf8").digest("hex").slice(0, 24);
  return `sqlite://pulseed-control/${kind}/${digest}`;
}

function inferForeignPluginBaseDir(pluginDir: string): string {
  const parts = path.resolve(pluginDir).split(path.sep);
  for (const marker of ["plugins-imported-disabled", "plugins"]) {
    const index = parts.lastIndexOf(marker);
    if (index > 0) return parts.slice(0, index).join(path.sep) || path.sep;
  }
  return path.resolve(pluginDir);
}
