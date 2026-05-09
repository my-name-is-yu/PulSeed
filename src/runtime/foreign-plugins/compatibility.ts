import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import yaml from "js-yaml";
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
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../base/utils/json-io.js";

const MANIFEST_FILENAMES = ["plugin.yaml", "plugin.json"] as const;
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

function readManifest(filePath: string): unknown | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    if (filePath.endsWith(".yaml")) {
      return yaml.load(raw) as unknown;
    }
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function findManifestPath(pluginDir: string): string | undefined {
  for (const filename of MANIFEST_FILENAMES) {
    const candidate = path.join(pluginDir, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
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
  const manifestPath = findManifestPath(pluginDir);
  if (!manifestPath) {
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

  const raw = readManifest(manifestPath);
  if (raw === undefined) {
    return {
      ...compatibilityReport(
        source,
        "incompatible",
        [`failed to parse manifest: ${path.basename(manifestPath)}`],
        defaultPermissions(),
        { manifestPath, sourceProvenance: { source_path: pluginDir, manifest_path: manifestPath } }
      ),
    };
  }

  const report = analyzeForeignPluginManifest(source, raw, { pluginDir, manifestPath });
  return withForeignPluginProvenance(report, {
    source_path: pluginDir,
    manifest_path: manifestPath,
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
  const reportPath = path.join(pluginDir, FOREIGN_PLUGIN_COMPATIBILITY_REPORT_FILENAME);
  const reviewRecordPath = path.join(pluginDir, FOREIGN_PLUGIN_REVIEW_RECORD_FILENAME);
  await writeJsonFileAtomic(reportPath, report);
  const reviewRecord = createPendingCompatibilityReviewRecord(report, {
    reportRef: reportPath,
    createdAt: options.createdAt,
  });
  await writeJsonFileAtomic(reviewRecordPath, reviewRecord);
  return { reportPath, reviewRecordPath, reviewRecord };
}

export async function hasForeignPluginCompatibilityArtifact(pluginDir: string): Promise<boolean> {
  try {
    await fsp.access(path.join(pluginDir, FOREIGN_PLUGIN_COMPATIBILITY_REPORT_FILENAME));
    return true;
  } catch {
    return false;
  }
}

export async function readForeignPluginCompatibilityArtifact(
  pluginDir: string
): Promise<ForeignPluginCompatibilityReport | null> {
  return await readJsonFileOrNull<ForeignPluginCompatibilityReport>(
    path.join(pluginDir, FOREIGN_PLUGIN_COMPATIBILITY_REPORT_FILENAME)
  );
}
