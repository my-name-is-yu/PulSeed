import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { checksumPath } from "../assets/checksum.js";
import type { AssetSourceAgent } from "../assets/types.js";
import { isPathInside, parseSkillFrontmatter } from "./skill-parser.js";

export const SKILL_BUNDLE_DIRECTORIES = [
  "scripts",
  "examples",
  "templates",
  "assets",
  "references",
] as const;
export type SkillBundleDirectory = typeof SKILL_BUNDLE_DIRECTORIES[number];

export type SkillBundleFileRole =
  | "skill_root"
  | "script"
  | "example"
  | "template"
  | "asset"
  | "reference"
  | "other";

export type SkillExecutionMappingStatus =
  | "advisory_only"
  | "blocked_unresolved_references";

export interface SkillBundleFileManifest {
  relativePath: string;
  checksum: string;
  role: SkillBundleFileRole;
}

export interface SkillBundleCompatibilityMetadata {
  source_agent: AssetSourceAgent;
  frontmatter_fields: string[];
  referenced_tools: string[];
  referenced_connectors: string[];
  referenced_paths: string[];
  referenced_commands: string[];
  unsupported_references: string[];
  advisory_safe: boolean;
  execution_mapping_status: SkillExecutionMappingStatus;
}

export interface SkillBundleManifest {
  rootPath: string;
  skillFilePath: string;
  bundleChecksum: string;
  files: SkillBundleFileManifest[];
  directories: Record<SkillBundleDirectory, boolean>;
  compatibility: SkillBundleCompatibilityMetadata;
}

export interface SkillMutationTargetClassification {
  protected: boolean;
  reason: "user_authored_skill" | "outside_skill_bundle";
  defaultAutonomousWrite: "blocked" | "not_applicable";
  requiredDisposition: "quarantine_or_review_or_approval" | "none";
}

export async function describeSkillBundle(
  skillFilePath: string,
  options: { sourceAgent?: AssetSourceAgent } = {}
): Promise<SkillBundleManifest> {
  const rootPath = path.dirname(skillFilePath);
  const content = await fsp.readFile(skillFilePath, "utf-8");
  const frontmatter = parseSkillFrontmatter(content);
  const files = await listSkillBundleFiles(rootPath);
  const directories = Object.fromEntries(
    await Promise.all(SKILL_BUNDLE_DIRECTORIES.map(async (dir) => [
      dir,
      await pathExists(path.join(rootPath, dir)),
    ] as const))
  ) as Record<SkillBundleDirectory, boolean>;
  const referencedPaths = referencedSkillPaths(content, frontmatter);
  const referencedTools = stringListFields(frontmatter, ["tools", "required_tools", "referenced_tools"]);
  const referencedConnectors = stringListFields(frontmatter, ["connectors", "required_connectors", "referenced_connectors"]);
  const referencedCommands = stringListFields(frontmatter, ["commands", "required_commands", "referenced_commands"]);
  const missingPaths = referencedPaths.filter((relativePath) => !fileManifestContains(files, relativePath));
  const unsupportedReferences = [
    ...referencedTools.map((value) => `tool:${value}`),
    ...referencedConnectors.map((value) => `connector:${value}`),
    ...referencedCommands.map((value) => `command:${value}`),
    ...missingPaths.map((value) => `path:${value}`),
  ];

  return {
    rootPath,
    skillFilePath,
    bundleChecksum: await checksumPath(rootPath),
    files,
    directories,
    compatibility: {
      source_agent: options.sourceAgent ?? "unknown",
      frontmatter_fields: Object.keys(frontmatter).sort((a, b) => a.localeCompare(b)),
      referenced_tools: referencedTools,
      referenced_connectors: referencedConnectors,
      referenced_paths: referencedPaths,
      referenced_commands: referencedCommands,
      unsupported_references: unsupportedReferences,
      advisory_safe: true,
      execution_mapping_status: unsupportedReferences.length > 0
        ? "blocked_unresolved_references"
        : "advisory_only",
    },
  };
}

export async function copySkillBundleNoSymlinks(sourceDir: string, targetDir: string): Promise<void> {
  const stat = await fsp.lstat(sourceDir);
  if (stat.isSymbolicLink()) {
    throw new Error("refusing to copy symlinked skill bundle");
  }
  if (!stat.isDirectory()) {
    throw new Error("skill bundle source is not a directory");
  }

  await fsp.mkdir(targetDir, { recursive: true });
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    const entryStat = await fsp.lstat(sourcePath);
    if (entryStat.isSymbolicLink()) continue;
    if (entryStat.isDirectory()) {
      await copySkillBundleNoSymlinks(sourcePath, targetPath);
    } else if (entryStat.isFile()) {
      await fsp.copyFile(sourcePath, targetPath);
    }
  }
}

export function classifySkillBundleMutationTarget(
  targetPath: string,
  options: { homeSkillsDir?: string; workspaceRoot?: string }
): SkillMutationTargetClassification {
  const roots = [
    options.homeSkillsDir,
    options.workspaceRoot ? path.join(options.workspaceRoot, "skills") : undefined,
  ].filter((root): root is string => typeof root === "string" && root.length > 0);

  const protectedTarget = roots.some((root) => isPathInside(root, targetPath));
  if (!protectedTarget) {
    return {
      protected: false,
      reason: "outside_skill_bundle",
      defaultAutonomousWrite: "not_applicable",
      requiredDisposition: "none",
    };
  }

  return {
    protected: true,
    reason: "user_authored_skill",
    defaultAutonomousWrite: "blocked",
    requiredDisposition: "quarantine_or_review_or_approval",
  };
}

export function inferSkillSourceAgent(relativePath: string): AssetSourceAgent {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  if (parts.includes("codex")) return "codex";
  if (parts.includes("claude")) return "claude";
  if (parts.includes("openclaw")) return "openclaw";
  if (parts.includes("hermes")) return "hermes";
  return "unknown";
}

async function listSkillBundleFiles(rootPath: string): Promise<SkillBundleFileManifest[]> {
  const files: SkillBundleFileManifest[] = [];
  await walk(rootPath, async (filePath) => {
    const relativePath = path.relative(rootPath, filePath).replace(/\\/g, "/");
    files.push({
      relativePath,
      checksum: await checksumPath(filePath),
      role: fileRole(relativePath),
    });
  });
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function walk(root: string, visit: (filePath: string) => Promise<void>): Promise<void> {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    const stat = await fsp.lstat(fullPath);
    if (stat.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walk(fullPath, visit);
    } else if (entry.isFile()) {
      await visit(fullPath);
    }
  }
}

function fileRole(relativePath: string): SkillBundleFileRole {
  if (relativePath === "SKILL.md") return "skill_root";
  const [top] = relativePath.split("/");
  if (top === "scripts") return "script";
  if (top === "examples") return "example";
  if (top === "templates") return "template";
  if (top === "assets") return "asset";
  if (top === "references") return "reference";
  return "other";
}

function stringListFields(frontmatter: Record<string, unknown>, keys: string[]): string[] {
  return unique(keys.flatMap((key) => stringList(frontmatter[key])));
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []);
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((part) => part.trim()).filter(Boolean);
  }
  return [];
}

function referencedSkillPaths(content: string, frontmatter: Record<string, unknown>): string[] {
  const frontmatterPaths = stringListFields(frontmatter, ["paths", "referenced_paths"]);
  const markdownPaths: string[] = [];
  const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const match of content.matchAll(linkPattern)) {
    const candidate = normalizeRelativeReference(match[1] ?? "");
    if (candidate) markdownPaths.push(candidate);
  }
  return unique([...frontmatterPaths.flatMap((value) => normalizeRelativeReference(value) ?? []), ...markdownPaths]);
}

function normalizeRelativeReference(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  const normalized = trimmed.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith("../") || path.isAbsolute(normalized)) return normalized;
  if (SKILL_BUNDLE_DIRECTORIES.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`))) {
    return normalized;
  }
  return null;
}

function fileManifestContains(files: SkillBundleFileManifest[], relativePath: string): boolean {
  return files.some((file) => file.relativePath === relativePath || file.relativePath.startsWith(`${relativePath}/`));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}
