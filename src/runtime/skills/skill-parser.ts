import * as path from "node:path";
import { load as parseYaml } from "js-yaml";

export type SkillSource = "home" | "workspace";

export interface ParsedSkillFile {
  id: string;
  name: string;
  description: string;
  path: string;
  relativePath: string;
  source: SkillSource;
}

export function parseSkillFile(
  content: string,
  filePath: string,
  source: SkillSource,
  root: string
): ParsedSkillFile {
  const parsed = splitFrontmatter(content);
  const firstHeading = parsed.body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const description = stringAttribute(parsed.attributes["description"]) ?? firstBodyText(parsed.body);
  const name = firstHeading ?? stringAttribute(parsed.attributes["name"]) ?? path.basename(path.dirname(filePath));
  const relativePath = path.relative(root, filePath);

  return {
    id: toSafeSkillId(path.dirname(relativePath)),
    name,
    description,
    path: filePath,
    relativePath,
    source,
  };
}

export function parseSkillFrontmatter(content: string): Record<string, unknown> {
  return splitFrontmatter(content).attributes;
}

export function toSafeSkillId(value: string): string {
  const normalized = value
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => part.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter((part) => part.length > 0 && part !== "." && part !== "..")
    .join("/");
  return normalized === "." ? "" : normalized;
}

export function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function splitFrontmatter(content: string): {
  attributes: Record<string, unknown>;
  body: string;
} {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { attributes: {}, body: content };
  }

  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) {
    return { attributes: {}, body: content };
  }

  const rawFrontmatter = lines.slice(1, end).join("\n");
  const attributes = parseFrontmatterAttributes(rawFrontmatter);

  return {
    attributes,
    body: lines.slice(end + 1).join("\n"),
  };
}

function parseFrontmatterAttributes(rawFrontmatter: string): Record<string, unknown> {
  try {
    const parsed = parseYaml(rawFrontmatter) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key.toLowerCase(), value])
      );
    }
  } catch {
    // Fall back to the stable scalar parser below.
  }

  const attributes: Record<string, unknown> = {};
  for (const line of rawFrontmatter.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2]!.trim().replace(/^['"]|['"]$/g, "");
    if (value.length > 0) attributes[match[1]!.toLowerCase()] = value;
  }
  return attributes;
}

function stringAttribute(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function firstBodyText(body: string): string {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("---")) ?? "";
}
