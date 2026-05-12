import type { JsonValue, NormalizerSpec } from "./types.js";

const isoTimestampPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

export function normalizeJson(value: JsonValue, spec: NormalizerSpec = {}): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item, spec));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeJson(item, spec)]),
    );
  }
  if (typeof value !== "string") return value;

  let normalized = value;
  if (spec.root) normalized = normalized.split(spec.root).join("<ROOT>");
  if (spec.timestamp) normalized = normalized.replaceAll(spec.timestamp, "<TIMESTAMP>");
  normalized = normalized.replace(isoTimestampPattern, "<TIMESTAMP>");
  for (const [raw, replacement] of Object.entries(spec.ids ?? {})) {
    normalized = normalized.split(raw).join(replacement);
  }
  return normalized;
}

export function stableJson(value: JsonValue): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}
