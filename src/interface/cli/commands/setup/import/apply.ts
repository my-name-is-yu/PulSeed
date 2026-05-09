import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../../../../base/utils/json-io.js";
import type { MCPServerConfig, MCPServersConfig } from "../../../../../base/types/mcp.js";
import { getGatewayChannelDir } from "../../../../../base/utils/paths.js";
import { AssetRegistry } from "../../../../../runtime/assets/registry.js";
import { checksumPath } from "../../../../../runtime/assets/checksum.js";
import {
  classifySkillBundleMutationTarget,
  describeSkillBundle,
} from "../../../../../runtime/skills/skill-bundle.js";
import {
  createAssetRecord,
  toAssetId,
  type AssetKind,
  type AssetRecordInput,
  type AssetRecordStatus,
  type AssetSourceAgent,
} from "../../../../../runtime/assets/types.js";
import { copyDirectoryNoSymlinks, safeImportName, uniqueImportPath } from "./fs-utils.js";
import type {
  SetupImportAppliedItem,
  SetupImportItem,
  SetupImportReport,
  SetupImportSelection,
} from "./types.js";

interface TelegramGatewayConfig {
  bot_token?: string;
  chat_id?: number;
  allowed_user_ids?: number[];
  runtime_control_allowed_user_ids?: number[];
  allow_all?: boolean;
  polling_timeout?: number;
  identity_key?: string;
}

function nextMcpId(existing: Set<string>, requested: string): string {
  const base = safeImportName(requested);
  if (!existing.has(base)) return base;
  let suffix = 2;
  for (;;) {
    const candidate = `${base}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
    suffix += 1;
  }
}

async function mergeMcpServers(baseDir: string, servers: MCPServerConfig[]): Promise<string | undefined> {
  if (servers.length === 0) return undefined;
  const configPath = path.join(baseDir, "mcp-servers.json");
  const current = await readJsonFileOrNull<MCPServersConfig>(configPath);
  const existingServers = Array.isArray(current?.servers) ? current.servers : [];
  const existingIds = new Set<string>(existingServers.map((server) => server.id));
  const imported = servers.map((server) => {
    const id = nextMcpId(existingIds, server.id);
    existingIds.add(id);
    return { ...server, id, enabled: false };
  });

  await writeJsonFileAtomic(configPath, { servers: [...existingServers, ...imported] });
  return configPath;
}

async function applyFileItem(baseDir: string, item: SetupImportItem): Promise<SetupImportAppliedItem> {
  if (!item.sourcePath) {
    return {
      id: item.id,
      source: item.source,
      kind: item.kind,
      label: item.label,
      decision: item.decision,
      status: "skipped",
      reason: "no source path",
      ...(item.pluginCompatibility ? { pluginCompatibility: item.pluginCompatibility } : {}),
    };
  }

  if (item.kind === "skill") {
    const parentDir = path.join(baseDir, "skills", "imported", item.source);
    const targetPath = await uniqueImportPath(parentDir, item.label);
    await copyDirectoryNoSymlinks(item.sourcePath, targetPath);
    return {
      id: item.id,
      source: item.source,
      kind: item.kind,
      label: item.label,
      decision: item.decision,
      status: "applied",
      targetPath,
      ...(item.pluginCompatibility ? { pluginCompatibility: item.pluginCompatibility } : {}),
    };
  }

  if (item.kind === "plugin") {
    const parentDir = path.join(baseDir, "plugins-imported-disabled", item.source);
    const targetPath = await uniqueImportPath(parentDir, item.label);
    await copyDirectoryNoSymlinks(item.sourcePath, targetPath);
    return {
      id: item.id,
      source: item.source,
      kind: item.kind,
      label: item.label,
      decision: item.decision,
      status: "applied",
      targetPath,
      ...(item.pluginCompatibility ? { pluginCompatibility: item.pluginCompatibility } : {}),
    };
  }

  return {
    id: item.id,
    source: item.source,
    kind: item.kind,
    label: item.label,
    decision: item.decision,
    status: "skipped",
    reason: "not a file copy item",
  };
}

function reportItem(item: SetupImportItem, status: SetupImportAppliedItem["status"], reason?: string): SetupImportAppliedItem {
  return {
    id: item.id,
    source: item.source,
    kind: item.kind,
    label: item.label,
    decision: item.decision,
    status,
    ...(reason ? { reason } : {}),
    ...(item.pluginCompatibility ? { pluginCompatibility: item.pluginCompatibility } : {}),
  };
}

async function applyTelegramConfig(baseDir: string, items: SetupImportItem[]): Promise<string | undefined> {
  const selected = items.filter((item) => item.kind === "telegram" && item.telegramSettings);
  if (selected.length === 0) return undefined;
  const channelDir = getGatewayChannelDir("telegram-bot", baseDir);
  const configPath = path.join(channelDir, "config.json");
  const current = await readJsonFileOrNull<TelegramGatewayConfig>(configPath);
  const allowed = new Set<number>(current?.allowed_user_ids ?? []);
  const runtimeAllowed = new Set<number>(current?.runtime_control_allowed_user_ids ?? []);
  let botToken = current?.bot_token;

  for (const item of selected) {
    if (item.telegramSettings?.botToken) botToken = item.telegramSettings.botToken;
    for (const id of item.telegramSettings?.allowedUserIds ?? []) {
      allowed.add(id);
      runtimeAllowed.add(id);
    }
  }

  const config: TelegramGatewayConfig = {
    ...(current ?? {}),
    ...(botToken ? { bot_token: botToken } : {}),
    allowed_user_ids: [...allowed],
    runtime_control_allowed_user_ids: [...runtimeAllowed],
    allow_all: current?.allow_all ?? false,
    polling_timeout: current?.polling_timeout ?? 30,
  };
  await fsp.mkdir(channelDir, { recursive: true });
  await writeJsonFileAtomic(configPath, config);
  return configPath;
}

function assetKindForItem(item: SetupImportItem): AssetKind | null {
  if (item.kind === "skill") return "skill_bundle";
  if (item.kind === "plugin") return "foreign_plugin";
  if (item.kind === "mcp") return "mcp_server";
  if (item.kind === "telegram") return "notifier";
  if (item.kind === "provider") return "external_connector";
  return null;
}

function assetStatusForItem(item: SetupImportItem): AssetRecordStatus {
  if (item.kind === "plugin") return "quarantined";
  if (item.kind === "mcp") return "disabled";
  return "imported";
}

function assetSourceAgentForItem(item: SetupImportItem): AssetSourceAgent {
  return item.source === "hermes" || item.source === "openclaw" ? item.source : "unknown";
}

function metadataForItem(
  item: SetupImportItem,
  applied: SetupImportAppliedItem
): Record<string, unknown> {
  return {
    setup_import_item_id: item.id,
    setup_import_kind: item.kind,
    decision: item.decision,
    reason: item.reason,
    applied_status: applied.status,
    ...(item.providerSettings ? {
      provider: item.providerSettings.provider,
      model: item.providerSettings.model,
      adapter: item.providerSettings.adapter,
      base_url: item.providerSettings.baseUrl,
      api_key_present: item.providerSettings.apiKey !== undefined,
    } : {}),
    ...(item.telegramSettings ? {
      bot_token_present: item.telegramSettings.botToken !== undefined,
      allowed_user_count: item.telegramSettings.allowedUserIds?.length ?? 0,
    } : {}),
    ...(item.mcpServer ? {
      mcp_server_id: item.mcpServer.id,
      mcp_server_name: item.mcpServer.name,
      transport: item.mcpServer.transport,
      enabled: item.mcpServer.enabled,
      tool_mapping_count: item.mcpServer.tool_mappings?.length ?? 0,
    } : {}),
    ...(item.pluginCompatibility ? {
      compatibility_status: item.pluginCompatibility.status,
      compatibility_issues: item.pluginCompatibility.issues,
      permissions: item.pluginCompatibility.permissions,
      manifest: item.pluginCompatibility.manifest,
    } : {}),
  };
}

async function recordImportedAssets(
  baseDir: string,
  selectedItems: SetupImportItem[],
  appliedItems: SetupImportAppliedItem[],
  reportPath: string,
  createdAt: string
): Promise<void> {
  const selectedById = new Map(selectedItems.map((item) => [item.id, item]));
  const assets: AssetRecordInput[] = [];

  for (const applied of appliedItems) {
    if (applied.status !== "applied") continue;
    const item = selectedById.get(applied.id);
    if (!item) continue;
    const kind = assetKindForItem(item);
    if (!kind) continue;
    const checksumTarget = applied.targetPath ?? item.sourcePath;
    const checksum = checksumTarget ? await checksumPath(checksumTarget) : undefined;
    const skillBundle = kind === "skill_bundle" && applied.targetPath
      ? await describeSkillBundle(path.join(applied.targetPath, "SKILL.md"), { sourceAgent: assetSourceAgentForItem(item) })
      : undefined;
    assets.push(createAssetRecord({
      id: toAssetId(kind, [item.source, item.label, item.id]),
      kind,
      label: item.label,
      source_agent: assetSourceAgentForItem(item),
      ...(item.sourcePath ? { source_path: item.sourcePath } : {}),
      ...(applied.targetPath ? { imported_path: applied.targetPath } : {}),
      ...(checksum ? { checksum } : {}),
      ...(item.pluginCompatibility?.manifest?.version ? { version: item.pluginCompatibility.manifest.version } : {}),
      compatibility_report_ref: reportPath,
      status: assetStatusForItem(item),
      recorded_at: createdAt,
      updated_at: createdAt,
      provenance: {
        source_label: item.sourceLabel,
        import_batch_id: createdAt,
        evidence_refs: [item.id, reportPath],
      },
      metadata: metadataForItem(item, applied),
      ...(skillBundle ? {
        metadata: {
          ...metadataForItem(item, applied),
          bundle_manifest: skillBundle,
          compatibility: skillBundle.compatibility,
          protected_target: classifySkillBundleMutationTarget(path.join(applied.targetPath!, "SKILL.md"), {
            homeSkillsDir: path.join(baseDir, "skills"),
          }),
        },
      } : {}),
    }, createdAt));
  }

  if (assets.length > 0) {
    await new AssetRegistry({ baseDir }).recordMany(assets);
  }
}

export async function applySetupImportSelection(
  baseDir: string,
  selection: SetupImportSelection
): Promise<SetupImportReport> {
  const applied: SetupImportAppliedItem[] = [];
  const selectedItems = selection.items.filter((item) => item.decision !== "skip");

  for (const item of selectedItems) {
    try {
      if (item.kind === "provider") {
        applied.push(reportItem(item, "applied", "provider settings seeded into setup answers"));
      } else if (item.kind === "user") {
        applied.push(reportItem(item, "applied", "USER.md seeded into setup identity"));
      } else if (item.kind === "telegram") {
        applied.push(reportItem(item, "applied", "telegram settings seeded into gateway channel config"));
      } else if (item.kind === "skill" || item.kind === "plugin") {
        applied.push(await applyFileItem(baseDir, item));
      }
    } catch (err) {
      applied.push(reportItem(item, "failed", err instanceof Error ? err.message : String(err)));
    }
  }

  try {
    const targetPath = await applyTelegramConfig(baseDir, selectedItems);
    if (targetPath) {
      for (const item of selectedItems.filter((candidate) => candidate.kind === "telegram")) {
        const existing = applied.find((appliedItem) => appliedItem.id === item.id);
        if (existing) existing.targetPath = targetPath;
      }
    }
  } catch (err) {
    for (const item of selectedItems.filter((candidate) => candidate.kind === "telegram")) {
      const existing = applied.find((appliedItem) => appliedItem.id === item.id);
      const reason = err instanceof Error ? err.message : String(err);
      if (existing) {
        existing.status = "failed";
        existing.reason = reason;
      } else {
        applied.push(reportItem(item, "failed", reason));
      }
    }
  }

  const mcpItems = selectedItems.filter((item) => item.kind === "mcp" && item.mcpServer);
  try {
    const targetPath = await mergeMcpServers(
      baseDir,
      mcpItems.map((item) => item.mcpServer as MCPServerConfig)
    );
    for (const item of mcpItems) {
      applied.push({
        id: item.id,
        source: item.source,
        kind: item.kind,
        label: item.label,
        decision: item.decision,
        status: targetPath ? "applied" : "skipped",
        ...(targetPath ? { targetPath } : { reason: "no MCP server config" }),
      });
    }
  } catch (err) {
    for (const item of mcpItems) {
      applied.push(reportItem(item, "failed", err instanceof Error ? err.message : String(err)));
    }
  }

  const createdAt = new Date().toISOString();
  const report: SetupImportReport = {
    created_at: createdAt,
    sources: selection.sources.map(({ id, label, rootDir }) => ({ id, label, rootDir })),
    items: applied,
  };

  const reportName = createdAt.replace(/[:.]/g, "-");
  const sourceName = selection.sources.map((source) => source.id).join("-") || "import";
  const reportPath = path.join(baseDir, "imports", sourceName, reportName, "report.json");
  await writeJsonFileAtomic(reportPath, report);
  await recordImportedAssets(baseDir, selectedItems, applied, reportPath, createdAt);

  return report;
}
