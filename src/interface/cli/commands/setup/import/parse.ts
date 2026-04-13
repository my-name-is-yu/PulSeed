export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string");
  return values.length === value.length ? values : undefined;
}

export function nestedRecord(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

export function collectRecords(value: unknown, maxDepth = 3): Record<string, unknown>[] {
  if (!isRecord(value) || maxDepth < 0) return [];
  const records: Record<string, unknown>[] = [value];
  if (maxDepth === 0) return records;
  for (const child of Object.values(value)) {
    if (isRecord(child)) {
      records.push(...collectRecords(child, maxDepth - 1));
    }
  }
  return records;
}

export function firstString(
  records: Record<string, unknown>[],
  keys: string[]
): string | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = stringValue(record[key]);
      if (value) return value;
    }
  }
  return undefined;
}
