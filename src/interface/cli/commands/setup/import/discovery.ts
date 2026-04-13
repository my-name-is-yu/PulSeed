import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_FILENAMES, MCP_FILENAMES, SOURCE_LABELS } from "./constants.js";
import {
  listImmediateDirs,
  pathExists,
  readJson,
  unique,
} from "./fs-utils.js";
import { extractMcpServers } from "./mcp.js";
import { buildProviderItem, extractProviderSettings } from "./provider.js";
import type {
  SetupImportItem,
  SetupImportSource,
  SetupImportSourceId,
} from "./types.js";

function candidateFiles(rootDir: string, filenames: readonly string[]): string[] {
  return unique([
    ...filenames.map((name) => path.join(rootDir, name)),
    ...filenames.map((name) => path.join(rootDir, "config", name)),
  ]).filter(pathExists);
}

function findSkillDirs(rootDir: string): string[] {
  const roots = unique([
    path.join(rootDir, "skills"),
    path.join(rootDir, "agent", "skills"),
    path.join(rootDir, "agents", "skills"),
  ]);
  const candidates: string[] = [];
  for (const skillRoot of roots) {
    for (const dir of listImmediateDirs(skillRoot)) {
      if (pathExists(path.join(dir, "SKILL.md"))) candidates.push(dir);
      for (const nested of listImmediateDirs(dir)) {
        if (pathExists(path.join(nested, "SKILL.md"))) candidates.push(nested);
      }
    }
  }
  return unique(candidates);
}

function findPluginDirs(rootDir: string): string[] {
  const candidates: string[] = [];
  for (const pluginRoot of [path.join(rootDir, "plugins"), path.join(rootDir, "extensions")]) {
    for (const dir of listImmediateDirs(pluginRoot)) {
      if (pathExists(path.join(dir, "plugin.yaml")) || pathExists(path.join(dir, "plugin.json"))) {
        candidates.push(dir);
      }
    }
  }
  return unique(candidates);
}

function sourceRoots(source: SetupImportSourceId): string[] {
  const home = os.homedir();
  if (source === "hermes") {
    return unique([
      process.env["PULSEED_IMPORT_HERMES_HOME"] ?? "",
      process.env["PULSEED_HERMES_HOME"] ?? "",
      process.env["HERMES_HOME"] ?? "",
      path.join(home, ".hermes"),
      path.join(home, ".hermes-agent"),
      path.join(home, "Library", "Application Support", "Hermes Agent"),
    ].filter(Boolean));
  }
  return unique([
    process.env["PULSEED_IMPORT_OPENCLAW_HOME"] ?? "",
    process.env["PULSEED_OPENCLAW_HOME"] ?? "",
    process.env["OPENCLAW_HOME"] ?? "",
    path.join(home, ".openclaw"),
    path.join(home, ".config", "openclaw"),
    path.join(home, "Library", "Application Support", "OpenClaw"),
  ].filter(Boolean));
}

function providerItems(source: SetupImportSourceId, rootDir: string): SetupImportItem[] {
  return candidateFiles(rootDir, CONFIG_FILENAMES).flatMap((configPath) => {
    const settings = extractProviderSettings(readJson(configPath), source);
    return settings ? [buildProviderItem(source, configPath, settings)] : [];
  });
}

function skillItems(source: SetupImportSourceId, rootDir: string): SetupImportItem[] {
  return findSkillDirs(rootDir).map((skillDir) => {
    const name = path.basename(skillDir);
    return {
      id: `${source}:skill:${name}`,
      source,
      sourceLabel: SOURCE_LABELS[source],
      kind: "skill",
      label: name,
      sourcePath: skillDir,
      decision: "import",
      reason: "SKILL.md found",
    };
  });
}

function mcpItems(source: SetupImportSourceId, rootDir: string): SetupImportItem[] {
  return candidateFiles(rootDir, MCP_FILENAMES).flatMap((mcpPath) =>
    extractMcpServers(readJson(mcpPath), source).map((server) => ({
      id: `${source}:mcp:${server.id}`,
      source,
      sourceLabel: SOURCE_LABELS[source],
      kind: "mcp",
      label: server.name,
      sourcePath: mcpPath,
      decision: "copy_disabled",
      reason: "MCP servers are imported disabled until reviewed",
      mcpServer: server,
    }))
  );
}

function pluginItems(source: SetupImportSourceId, rootDir: string): SetupImportItem[] {
  return findPluginDirs(rootDir).map((pluginDir) => {
    const name = path.basename(pluginDir);
    return {
      id: `${source}:plugin:${name}`,
      source,
      sourceLabel: SOURCE_LABELS[source],
      kind: "plugin",
      label: name,
      sourcePath: pluginDir,
      decision: "copy_disabled",
      reason: "plugins are quarantined until PulSeed compatibility is reviewed",
    };
  });
}

function detectSource(source: SetupImportSourceId): SetupImportSource | undefined {
  for (const rootDir of sourceRoots(source)) {
    if (!pathExists(rootDir)) continue;
    const items = [
      ...providerItems(source, rootDir),
      ...skillItems(source, rootDir),
      ...mcpItems(source, rootDir),
      ...pluginItems(source, rootDir),
    ];
    if (items.length > 0) {
      return {
        id: source,
        label: SOURCE_LABELS[source],
        rootDir,
        items,
      };
    }
  }
  return undefined;
}

export function detectSetupImportSources(): SetupImportSource[] {
  return (["hermes", "openclaw"] as const).flatMap((source) => {
    const detected = detectSource(source);
    return detected ? [detected] : [];
  });
}
