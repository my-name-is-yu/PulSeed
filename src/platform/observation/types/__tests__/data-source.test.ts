import { describe, expect, it } from "vitest";
import {
  DataSourceConfigSchema,
  DataSourceQuerySchema,
  DataSourceResultSchema,
  PollingConfigSchema,
} from "../data-source.js";

describe("data source schemas", () => {
  it("accepts valid bounded numeric controls", () => {
    expect(PollingConfigSchema.parse({
      interval_ms: 30_000,
      change_threshold: 0.25,
    })).toEqual({
      interval_ms: 30_000,
      change_threshold: 0.25,
    });

    expect(DataSourceQuerySchema.parse({
      dimension_name: "latency",
      timeout_ms: 10_000,
    })).toEqual({
      dimension_name: "latency",
      timeout_ms: 10_000,
    });
  });

  it("rejects non-finite and unsafe numeric controls", () => {
    expect(PollingConfigSchema.safeParse({ interval_ms: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(PollingConfigSchema.safeParse({ interval_ms: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(PollingConfigSchema.safeParse({ interval_ms: 30_000.5 }).success).toBe(false);
    expect(PollingConfigSchema.safeParse({ interval_ms: 30_000, change_threshold: Number.NaN }).success).toBe(false);

    expect(DataSourceQuerySchema.safeParse({
      dimension_name: "latency",
      timeout_ms: Number.NEGATIVE_INFINITY,
    }).success).toBe(false);
    expect(DataSourceQuerySchema.safeParse({
      dimension_name: "latency",
      timeout_ms: Number.MAX_SAFE_INTEGER + 1,
    }).success).toBe(false);
  });

  it("rejects unsafe artifact scan limits in persisted datasource config", () => {
    const baseConfig = {
      id: "artifact-metric",
      name: "Artifact metrics",
      type: "artifact_metric",
      connection: {
        path: "/repo",
        max_metric_files: 100,
        max_artifact_files: 250,
        max_candidates: 25,
        stale_after_ms: 60_000,
      },
      created_at: "2026-05-09T00:00:00.000Z",
    };

    expect(DataSourceConfigSchema.safeParse(baseConfig).success).toBe(true);
    expect(DataSourceConfigSchema.safeParse({
      ...baseConfig,
      connection: { ...baseConfig.connection, max_metric_files: Number.POSITIVE_INFINITY },
    }).success).toBe(false);
    expect(DataSourceConfigSchema.safeParse({
      ...baseConfig,
      connection: { ...baseConfig.connection, stale_after_ms: Number.MAX_SAFE_INTEGER + 1 },
    }).success).toBe(false);
  });

  it("validates persisted shell datasource command specs before adapter construction", () => {
    const baseConfig = {
      id: "shell-source",
      name: "Shell Source",
      type: "shell",
      connection: {
        path: "/repo",
        commands: {
          todo_count: {
            argv: ["grep", "-rc", "TODO", "src/"],
            output_type: "number",
            timeout_ms: 15_000,
          },
        },
      },
      created_at: "2026-05-09T00:00:00.000Z",
    };

    expect(DataSourceConfigSchema.safeParse(baseConfig).success).toBe(true);
    expect(DataSourceConfigSchema.safeParse({
      ...baseConfig,
      connection: { ...baseConfig.connection, commands: { todo_count: {} } },
    }).success).toBe(false);
    expect(DataSourceConfigSchema.safeParse({
      ...baseConfig,
      connection: {
        ...baseConfig.connection,
        commands: { todo_count: { argv: [], output_type: "number" } },
      },
    }).success).toBe(false);
    expect(DataSourceConfigSchema.safeParse({
      ...baseConfig,
      connection: {
        ...baseConfig.connection,
        commands: {
          todo_count: {
            argv: ["echo", "1"],
            output_type: "raw",
            timeout_ms: Number.POSITIVE_INFINITY,
          },
        },
      },
    }).success).toBe(false);
    expect(DataSourceConfigSchema.safeParse({
      ...baseConfig,
      connection: {
        ...baseConfig.connection,
        commands: {
          todo_count: {
            argv: ["echo", "1"],
            output_type: "number",
            shell: true,
          },
        },
      },
    }).success).toBe(false);
  });

  it("rejects non-finite numeric observation results", () => {
    expect(DataSourceResultSchema.safeParse({
      value: 0.92,
      raw: { score: 0.92 },
      timestamp: "2026-05-09T00:00:00.000Z",
      source_id: "artifact-metric",
    }).success).toBe(true);

    expect(DataSourceResultSchema.safeParse({
      value: Number.NaN,
      raw: { score: "NaN" },
      timestamp: "2026-05-09T00:00:00.000Z",
      source_id: "artifact-metric",
    }).success).toBe(false);
  });
});
