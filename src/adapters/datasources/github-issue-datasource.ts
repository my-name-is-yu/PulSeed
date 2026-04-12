// ─── GitHubIssueDataSourceAdapter ───
//
// IDataSourceAdapter implementation that observes GitHub issue state via the `gh` CLI.
//
// Supported dimension_name values:
//   "open_issue_count"   — number of open issues matching the configured label
//   "closed_issue_count" — number of closed issues matching the configured label
//   "total_issue_count"  — open + closed
//   "completion_ratio"   — closed / (open + closed); returns 0 if no issues exist
//
// Config fields used from DataSourceConfig:
//   connection.repo   — "owner/name" repo identifier (optional; gh CLI auto-detects)
//   dimension_mapping — optional map; key "_label" overrides the default label filter

import { spawn } from "node:child_process";
import type { IDataSourceAdapter } from "../../platform/observation/data-source-adapter.js";
import type {
  DataSourceType,
  DataSourceConfig,
  DataSourceQuery,
  DataSourceResult,
} from "../../base/types/data-source.js";

// ─── Extended DataSourceResult to include optional error ───

interface GhDataSourceResult extends DataSourceResult {
  error?: string;
}

// ─── Internal types ───

interface GhIssue {
  number: number;
  title?: string;
  state?: string;
  labels?: Array<{ name: string }>;
  createdAt?: string;
}

type QueryPlan =
  | { kind: "single"; state: "open" | "closed" }
  | { kind: "aggregate"; dimension: "total_issue_count" | "completion_ratio" };

// ─── Adapter ───

export class GitHubIssueDataSourceAdapter implements IDataSourceAdapter {
  readonly sourceType: DataSourceType = "custom";
  readonly config: DataSourceConfig;

  private ghPath: string;

  constructor(config: DataSourceConfig, ghPath: string = "gh") {
    this.config = config;
    this.ghPath = ghPath;
  }

  get sourceId(): string {
    return this.config.id;
  }

  /**
   * Store the DataSourceConfig. Does not make network calls.
   * gh CLI availability is checked at query/healthCheck time.
   */
  async connect(): Promise<void> {
    // No-op network validation — gh CLI availability is checked at query/healthCheck time.
  }

  query(params: DataSourceQuery): Promise<GhDataSourceResult> {
    const { repo, label, timeoutMs, resolvedDimension, sourceId } = this.resolveQueryContext(params);

    const queryPlan = this.resolveQueryPlan(resolvedDimension);
    if (queryPlan === null) {
      return Promise.resolve(this.buildUnknownDimensionResult(sourceId));
    }

    if (queryPlan.kind === "single") {
      return this.queryOneState(
        queryPlan.state,
        repo,
        label,
        timeoutMs,
        this.createSingleStateResultBuilder(sourceId)
      );
    }

    return this.queryBothStates(
      repo,
      label,
      timeoutMs,
      this.createAggregateResultBuilder(sourceId, queryPlan.dimension)
    );
  }

  getSupportedDimensions(): string[] {
    return ["open_issue_count", "closed_issue_count", "total_issue_count", "completion_ratio"];
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  healthCheck(): Promise<boolean> {
    return new Promise((resolve) => {
      let timedOut = false;
      let resolved = false;

      const child = spawn(this.ghPath, ["auth", "status"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, 8_000);

      child.on("error", () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutHandle);
        resolve(false);
      });

      child.on("close", (code: number | null) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutHandle);
        if (timedOut) {
          resolve(false);
          return;
        }
        resolve(code === 0);
      });
    });
  }

  // ─── Private helpers ───

  private resolveRepo(config: DataSourceConfig): string | undefined {
    // Use connection.repo if available, fallback to connection.url
    const conn = config.connection as Record<string, unknown>;
    const repo = conn["repo"];
    if (typeof repo === "string" && repo.trim()) return repo.trim();
    if (typeof config.connection.url === "string" && config.connection.url.trim()) {
      return config.connection.url.trim();
    }
    return undefined;
  }

  private resolveLabel(config: DataSourceConfig): string | undefined {
    const mapping = config.dimension_mapping ?? {};
    return mapping["_label"] ?? "pulseed";
  }

  private resolveQueryContext(params: DataSourceQuery): {
    repo: string | undefined;
    label: string | undefined;
    timeoutMs: number;
    resolvedDimension: string;
    sourceId: string;
  } {
    const config = this.config;
    const repo = this.resolveRepo(config);
    const label = this.resolveLabel(config);
    const timeoutMs = params.timeout_ms ?? 10_000;
    const sourceId = this.sourceId;
    const dimMapping: Record<string, string> = config.dimension_mapping ?? {};
    const dimension = params.expression ?? params.dimension_name;
    const resolvedDimension = dimMapping[dimension] ?? dimension;

    return {
      repo,
      label,
      timeoutMs,
      resolvedDimension,
      sourceId,
    };
  }

  private resolveQueryPlan(resolvedDimension: string): QueryPlan | null {
    switch (resolvedDimension) {
      case "open_issue_count":
        return { kind: "single", state: "open" };
      case "closed_issue_count":
        return { kind: "single", state: "closed" };
      case "total_issue_count":
      case "completion_ratio":
        return { kind: "aggregate", dimension: resolvedDimension };
      default:
        return null;
    }
  }

  /**
   * Spawn `gh issue list` for a single state and call back with results.
   * Uses a callback so the result can be returned synchronously inside
   * the close handler — enabling proper test sequencing.
   */
  private queryOneState(
    state: "open" | "closed",
    repo: string | undefined,
    label: string | undefined,
    timeoutMs: number,
    cb: (issues: GhIssue[], err: string | null) => GhDataSourceResult
  ): Promise<GhDataSourceResult> {
    return new Promise<GhDataSourceResult>((resolve) => {
      this.spawnList(state, repo, label, timeoutMs, (issues, err) => {
        resolve(cb(issues, err));
      });
    });
  }

  /**
   * Spawn two `gh issue list` calls in sequence (open then closed) using
   * nested callbacks so both spawns happen synchronously in the close handler
   * chain — enabling proper test sequencing without microtask gaps.
   */
  private queryBothStates(
    repo: string | undefined,
    label: string | undefined,
    timeoutMs: number,
    cb: (
      openIssues: GhIssue[],
      closedIssues: GhIssue[],
      err: string | null
    ) => GhDataSourceResult
  ): Promise<GhDataSourceResult> {
    return new Promise<GhDataSourceResult>((resolve) => {
      // First: fetch open issues
      this.spawnList("open", repo, label, timeoutMs, (openIssues, openErr) => {
        if (openErr !== null) {
          resolve(cb([], [], openErr));
          return;
        }
        // Second: fetch closed issues (spawned inside close handler of first)
        this.spawnList("closed", repo, label, timeoutMs, (closedIssues, closedErr) => {
          if (closedErr !== null) {
            resolve(cb([], [], closedErr));
            return;
          }
          resolve(cb(openIssues, closedIssues, null));
        });
      });
    });
  }

  /**
   * Low-level spawn helper using raw callbacks. The callback fires synchronously
   * inside the close event handler so that nested spawns can be chained without
   * microtask gaps.
   */
  private spawnList(
    state: "open" | "closed",
    repo: string | undefined,
    label: string | undefined,
    timeoutMs: number,
    cb: (issues: GhIssue[], err: string | null) => void
  ): void {
    const child = this.createListProcess(state, repo, label);
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err: Error) => {
      clearTimeout(timeoutHandle);
      cb([], err.message);
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timeoutHandle);
      if (timedOut) {
        cb([], `gh issue list timed out after ${timeoutMs}ms`);
        return;
      }
      if (code !== 0) {
        cb([], stderr.trim() || `gh issue list exited with code ${code}`);
        return;
      }
      cb(this.parseIssueList(stdout), null);
    });
  }

  private createListProcess(
    state: "open" | "closed",
    repo: string | undefined,
    label: string | undefined
  ) {
    const args = this.buildListArgs(state, repo, label);
    return spawn(this.ghPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  }

  private buildCountResult(sourceId: string, issues: GhIssue[]): GhDataSourceResult {
    return this.buildMetricResult(sourceId, issues.length, issues);
  }

  private createSingleStateResultBuilder(
    sourceId: string
  ): (issues: GhIssue[], err: string | null) => GhDataSourceResult {
    return (issues, err) => this.buildSingleStateResult(sourceId, issues, err);
  }

  private createAggregateResultBuilder(
    sourceId: string,
    dimension: "total_issue_count" | "completion_ratio"
  ): (openIssues: GhIssue[], closedIssues: GhIssue[], err: string | null) => GhDataSourceResult {
    return (openIssues, closedIssues, err) =>
      this.buildAggregateResult(sourceId, dimension, openIssues, closedIssues, err);
  }

  private buildSingleStateResult(
    sourceId: string,
    issues: GhIssue[],
    err: string | null
  ): GhDataSourceResult {
    return err !== null ? this.buildErrorResult(sourceId, err) : this.buildCountResult(sourceId, issues);
  }

  private buildAggregateResult(
    sourceId: string,
    dimension: "total_issue_count" | "completion_ratio",
    openIssues: GhIssue[],
    closedIssues: GhIssue[],
    err: string | null
  ): GhDataSourceResult {
    if (err !== null) {
      return this.buildErrorResult(sourceId, err);
    }

    const aggregate = this.buildAggregateMetrics(openIssues, closedIssues);
    const value = dimension === "total_issue_count" ? aggregate.totalCount : aggregate.completionRatio;

    return {
      ...this.buildMetricResult(sourceId, value, aggregate.allIssues),
      metadata: this.buildCompletionMetadata(
        aggregate.openCount,
        aggregate.closedCount,
        aggregate.totalCount,
        aggregate.completionRatio
      ),
    };
  }

  private buildErrorResult(sourceId: string, error: string): GhDataSourceResult {
    return {
      value: null,
      raw: [],
      timestamp: new Date().toISOString(),
      source_id: sourceId,
      error,
    };
  }

  private buildMetricResult(sourceId: string, value: number, raw: GhIssue[]): GhDataSourceResult {
    return {
      value,
      raw,
      timestamp: new Date().toISOString(),
      source_id: sourceId,
    };
  }

  private buildUnknownDimensionResult(sourceId: string): GhDataSourceResult {
    return {
      value: null,
      raw: [],
      timestamp: new Date().toISOString(),
      source_id: sourceId,
    };
  }

  private buildCompletionMetadata(
    openCount: number,
    closedCount: number,
    totalCount: number,
    completionRatio: number
  ): NonNullable<GhDataSourceResult["metadata"]> {
    return {
      open_count: openCount,
      closed_count: closedCount,
      total_count: totalCount,
      completion_ratio: completionRatio,
    };
  }

  private buildAggregateMetrics(openIssues: GhIssue[], closedIssues: GhIssue[]): {
    openCount: number;
    closedCount: number;
    totalCount: number;
    completionRatio: number;
    allIssues: GhIssue[];
  } {
    const openCount = openIssues.length;
    const closedCount = closedIssues.length;
    const totalCount = openCount + closedCount;
    const completionRatio = totalCount === 0 ? 0 : closedCount / totalCount;
    const allIssues = [...openIssues, ...closedIssues];

    return {
      openCount,
      closedCount,
      totalCount,
      completionRatio,
      allIssues,
    };
  }

  private buildListArgs(
    state: "open" | "closed",
    repo: string | undefined,
    label: string | undefined
  ): string[] {
    const args = [
      "issue",
      "list",
      "--state",
      state,
      "--json",
      "number,title,state,labels,createdAt",
      "--limit",
      "1000",
    ];

    if (label) {
      args.push("--label", label);
    }

    if (repo) {
      args.push("--repo", repo);
    }

    return args;
  }

  private parseIssueList(stdout: string): GhIssue[] {
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === "null") return [];
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed as GhIssue[];
    } catch {
      return [];
    }
  }
}
