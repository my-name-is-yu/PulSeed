import type { RuntimeEvidenceEntry } from "./evidence-types.js";
import {
  summarizeMetricTrends,
  type MetricDirection,
  type MetricObservation,
  type MetricTrendClassificationOptions,
  type MetricTrendContext,
} from "../../platform/drive/metric-history.js";

export {
  classifyMetricTrend,
  summarizeMetricTrends,
  type MetricDirection,
  type MetricObservation,
  type MetricTrendClassificationOptions,
  type MetricTrendContext,
} from "../../platform/drive/metric-history.js";

export function extractMetricObservationsFromEvidence(
  entries: RuntimeEvidenceEntry[],
  options: { metricKey?: string; direction?: MetricDirection } = {}
): MetricObservation[] {
  const observations: MetricObservation[] = [];
  for (const entry of entries) {
    for (const metric of entry.metrics) {
      if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) continue;
      if (options.metricKey && metric.label !== options.metricKey) continue;
      const direction = resolveMetricDirection(metric.direction, options.direction);
      if (!direction) continue;
      observations.push({
        observed_at: metric.observed_at ?? entry.occurred_at,
        metric_key: metric.label,
        value: metric.value,
        direction,
        confidence: metric.confidence ?? entry.verification?.confidence ?? 1,
        source: {
          entry_id: entry.id,
          kind: entry.kind,
          ...(entry.summary ? { summary: entry.summary } : {}),
          ...(metric.source ? { metric_source: metric.source } : {}),
          artifacts: entry.artifacts.map((artifact) => ({
            label: artifact.label,
            ...(artifact.path ? { path: artifact.path } : {}),
            ...(artifact.state_relative_path ? { state_relative_path: artifact.state_relative_path } : {}),
            ...(artifact.url ? { url: artifact.url } : {}),
          })),
          raw_refs: entry.raw_refs.map((ref) => ({
            kind: ref.kind,
            ...(ref.id ? { id: ref.id } : {}),
            ...(ref.path ? { path: ref.path } : {}),
            ...(ref.state_relative_path ? { state_relative_path: ref.state_relative_path } : {}),
            ...(ref.url ? { url: ref.url } : {}),
          })),
        },
      });
    }
  }
  return observations;
}

export function summarizeEvidenceMetricTrends(
  entries: RuntimeEvidenceEntry[],
  options: MetricTrendClassificationOptions = {}
): MetricTrendContext[] {
  return summarizeMetricTrends(extractMetricObservationsFromEvidence(entries), options);
}

export interface MetricTrendDimensionSelectionOptions {
  metricKeys?: readonly string[];
}

export function selectMetricTrendForDimension(
  trends: MetricTrendContext[],
  dimensionName: string,
  options: MetricTrendDimensionSelectionOptions = {}
): MetricTrendContext | undefined {
  const candidateMetricKeys = uniqueMetricKeys([...(options.metricKeys ?? []), dimensionName]);
  for (const metricKey of candidateMetricKeys) {
    const trend = trends.find((entry) => entry.metric_key === metricKey);
    if (trend) return trend;
  }
  return undefined;
}

function resolveMetricDirection(
  direction: "maximize" | "minimize" | "neutral" | undefined,
  fallback: MetricDirection | undefined
): MetricDirection | null {
  if (direction === "maximize" || direction === "minimize") return direction;
  return fallback ?? null;
}

function uniqueMetricKeys(metricKeys: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const metricKey of metricKeys) {
    const normalized = metricKey.trim();
    if (normalized.length === 0) continue;
    unique.add(normalized);
  }
  return [...unique];
}
