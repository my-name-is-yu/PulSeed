import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DataSourceConfig } from "../../base/types/data-source.js";

export type CurrentProgressPolicy = "legacy" | "completed_fresh_only" | "allow_live";
export type FreshnessScope = "none" | "goal" | "task" | "run";
export type FreshnessStatus = "fresh" | "stale" | "pre_scope";

export interface MetricCandidate {
  path: string;
  relativePath: string;
  updatedTime: string;
  artifactAgeMs: number;
  candidateScore: number;
  reasons: string[];
  stale: boolean;
  freshnessStatus: FreshnessStatus;
  currentRun: boolean | null;
  freshnessScope: FreshnessScope;
  freshnessScopeId: string | null;
}

export interface MetricCandidateSnapshot {
  candidates: MetricCandidate[];
}

export interface ScanOptions {
  metricFileNames: Set<string>;
  artifactRoots: string[];
  includePaths: string[];
  parserHints: Set<string>;
  excludeDirs: Set<string>;
  excludePaths: Set<string>;
  maxMetricFiles: number;
  maxArtifactFiles: number;
  maxCandidates: number;
  staleAfterMs?: number;
  freshAfterTime?: string;
  freshAfterMs?: number;
  freshnessScope: FreshnessScope;
  freshnessScopeId?: string;
  currentProgressPolicy: CurrentProgressPolicy;
  nowMs: number;
}

const DEFAULT_METRIC_FILE_NAMES = ["metrics.json", "result.json"];
const DEFAULT_ARTIFACT_ROOTS = ["artifacts", "experiments", "runs", "reports", "outputs", "results", "logs"];
const DEFAULT_EXCLUDE_DIRS = new Set([
  ".cache",
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".venv",
  "__pycache__",
  "env",
  "node_modules",
  "venv",
]);
const DEFAULT_EXCLUDE_PATHS = new Set(["data/raw"]);
const DEFAULT_MAX_METRIC_FILES = 5_000;
const DEFAULT_MAX_ARTIFACT_FILES = 100_000;
const DEFAULT_MAX_CANDIDATES = 200;

export function buildArtifactMetricScanOptions(config: DataSourceConfig): ScanOptions {
  return {
    metricFileNames: new Set(config.connection.metric_file_names ?? DEFAULT_METRIC_FILE_NAMES),
    artifactRoots: unique([
      ...(config.connection.artifact_roots ?? []),
      ...(config.connection.artifact_roots ? [] : DEFAULT_ARTIFACT_ROOTS),
    ].map(normalizeRelativePath)),
    includePaths: unique((config.connection.include_paths ?? []).map(normalizeRelativePath)),
    parserHints: new Set(config.connection.parser_hints ?? ["json"]),
    excludeDirs: new Set([...(config.connection.exclude_dirs ?? []), ...DEFAULT_EXCLUDE_DIRS]),
    excludePaths: new Set([
      ...Array.from(DEFAULT_EXCLUDE_PATHS),
      ...(config.connection.exclude_paths ?? []),
    ].map(normalizeRelativePath)),
    maxMetricFiles: config.connection.max_metric_files ?? DEFAULT_MAX_METRIC_FILES,
    maxArtifactFiles: config.connection.max_artifact_files ?? DEFAULT_MAX_ARTIFACT_FILES,
    maxCandidates: config.connection.max_candidates ?? DEFAULT_MAX_CANDIDATES,
    staleAfterMs: config.connection.stale_after_ms,
    currentProgressPolicy: config.connection.current_progress_policy ?? "legacy",
    freshAfterTime: config.connection.fresh_after_time,
    freshAfterMs: parseIsoMs(config.connection.fresh_after_time),
    freshnessScope: config.connection.freshness_scope ?? "none",
    freshnessScopeId: config.connection.freshness_scope_id,
    nowMs: Date.now(),
  };
}

export async function discoverMetricCandidates(
  root: string,
  options: ScanOptions,
  keys: string[],
): Promise<MetricCandidate[]> {
  const discovered = new Map<string, MetricCandidate>();

  for (const includePath of options.includePaths) {
    if (discovered.size >= options.maxMetricFiles) break;
    const absolute = path.resolve(root, includePath);
    if (!isInsideRoot(root, absolute) || !(await isFile(absolute))) continue;
    if (!options.metricFileNames.has(path.basename(absolute))) continue;
    const candidate = await buildMetricCandidate(root, absolute, options, keys);
    discovered.set(candidate.path, candidate);
  }

  const searchRoots = await resolveSearchRoots(root, options);

  for (const searchRoot of searchRoots) {
    if (discovered.size >= options.maxMetricFiles) break;
    await walkFiles(root, searchRoot, options, async (filePath) => {
      if (discovered.size >= options.maxMetricFiles) return;
      if (!options.metricFileNames.has(path.basename(filePath))) return;
      const candidate = await buildMetricCandidate(root, filePath, options, keys);
      discovered.set(candidate.path, candidate);
    });
  }

  return Array.from(discovered.values())
    .sort(compareCandidates)
    .slice(0, keys.length === 0 ? options.maxMetricFiles : options.maxCandidates);
}

export function selectCandidatesForKeys(
  candidates: MetricCandidate[],
  keys: string[],
  options: ScanOptions,
): MetricCandidate[] {
  return candidates
    .map((candidate) => applyMetricKeyScore(candidate, keys))
    .sort(compareCandidates)
    .slice(0, options.maxCandidates);
}

export function scanCacheKey(root: string, options: ScanOptions): string {
  return JSON.stringify({
    root,
    metricFileNames: [...options.metricFileNames].sort(),
    artifactRoots: options.artifactRoots,
    includePaths: options.includePaths,
    parserHints: [...options.parserHints].sort(),
    excludeDirs: [...options.excludeDirs].sort(),
    excludePaths: [...options.excludePaths].sort(),
    maxMetricFiles: options.maxMetricFiles,
    maxArtifactFiles: options.maxArtifactFiles,
    maxCandidates: options.maxCandidates,
    staleAfterMs: options.staleAfterMs,
    freshAfterTime: options.freshAfterTime,
    freshnessScope: options.freshnessScope,
    freshnessScopeId: options.freshnessScopeId,
    currentProgressPolicy: options.currentProgressPolicy,
  });
}

export async function countArtifactFiles(root: string, options: ScanOptions): Promise<number> {
  let count = 0;
  await walkFiles(root, root, options, async () => {
    if (count < options.maxArtifactFiles) count += 1;
  });
  return count;
}

function applyMetricKeyScore<T extends MetricCandidate>(candidate: T, keys: string[]): T {
  let score = candidate.candidateScore;
  const reasons = [...candidate.reasons];
  for (const key of keys) {
    if (candidate.relativePath.toLowerCase().includes(key.toLowerCase())) {
      score += 8;
      reasons.push(`path metric hint: ${key}`);
      break;
    }
  }
  return { ...candidate, candidateScore: score, reasons };
}

async function resolveSearchRoots(root: string, options: ScanOptions): Promise<string[]> {
  const roots: string[] = [];
  for (const includePath of [...options.includePaths, ...options.artifactRoots]) {
    const absolute = path.resolve(root, includePath);
    if (!isInsideRoot(root, absolute)) continue;
    if (await isDirectory(absolute)) roots.push(absolute);
  }
  if (roots.length === 0) roots.push(root);
  return unique(roots);
}

async function buildMetricCandidate(
  root: string,
  filePath: string,
  options: ScanOptions,
  keys: string[],
): Promise<MetricCandidate> {
  const stats = await fs.stat(filePath);
  const relativePath = normalizeRelativePath(path.relative(root, filePath));
  const reasons: string[] = [];
  let score = 0;

  if (options.metricFileNames.has(path.basename(filePath))) {
    score += 35;
    reasons.push("metric filename match");
  }
  const matchedRoot = options.artifactRoots.find((rootHint) => relativePath === rootHint || relativePath.startsWith(`${rootHint}/`));
  if (matchedRoot) {
    score += 20;
    reasons.push(`artifact root match: ${matchedRoot}`);
  }
  for (const key of keys) {
    if (relativePath.toLowerCase().includes(key.toLowerCase())) {
      score += 8;
      reasons.push(`path metric hint: ${key}`);
      break;
    }
  }
  const mtime = stats.mtime;
  const artifactAgeMs = Math.max(0, options.nowMs - mtime.getTime());
  if (artifactAgeMs < 24 * 60 * 60 * 1000) {
    score += 10;
    reasons.push("recent artifact");
  }
  const beforeFreshnessScope = options.freshAfterMs !== undefined && mtime.getTime() < options.freshAfterMs;
  const staleByAge = options.staleAfterMs !== undefined && artifactAgeMs > options.staleAfterMs;
  const stale = beforeFreshnessScope || staleByAge;
  const freshnessStatus: FreshnessStatus = beforeFreshnessScope ? "pre_scope" : staleByAge ? "stale" : "fresh";
  const currentRun = options.freshAfterMs === undefined ? null : !beforeFreshnessScope;
  if (stale) {
    score -= 30;
    reasons.push(beforeFreshnessScope
      ? `artifact precedes ${options.freshnessScope} freshness scope`
      : "stale artifact");
  }

  return {
    path: filePath,
    relativePath,
    updatedTime: mtime.toISOString(),
    artifactAgeMs,
    candidateScore: score,
    reasons,
    stale,
    freshnessStatus,
    currentRun,
    freshnessScope: options.freshnessScope,
    freshnessScopeId: options.freshnessScopeId ?? null,
  };
}

async function walkFiles(
  root: string,
  startDir: string,
  options: ScanOptions,
  onFile: (filePath: string) => Promise<void>,
): Promise<void> {
  async function visit(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = normalizeRelativePath(path.relative(root, fullPath));
      if (entry.isDirectory()) {
        if (shouldSkipDirectory(entry.name, relPath, options)) continue;
        await visit(fullPath);
      } else if (entry.isFile()) {
        await onFile(fullPath);
      }
    }
  }

  await visit(startDir);
}

function shouldSkipDirectory(name: string, relPath: string, options: ScanOptions): boolean {
  if (options.excludeDirs.has(name)) return true;
  for (const excludedPath of options.excludePaths) {
    if (relPath === excludedPath || relPath.startsWith(`${excludedPath}/`)) return true;
  }
  return false;
}

function compareCandidates(left: MetricCandidate, right: MetricCandidate): number {
  if (left.candidateScore !== right.candidateScore) return right.candidateScore - left.candidateScore;
  return Date.parse(right.updatedTime) - Date.parse(left.updatedTime);
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function parseIsoMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
