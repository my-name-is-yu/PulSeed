import type { z } from "zod";
import type { ScheduleEngine } from "../../../../runtime/schedule/engine.js";
import { resolveScheduleEntry } from "../../../../runtime/schedule/entry-resolver.js";
import type { ScheduleEntry, ScheduleTriggerInput } from "../../../../runtime/types/schedule.js";

export function getScheduleOrPrintError(engine: ScheduleEngine, id: string | undefined): ScheduleEntry | null {
  if (!id) {
    console.error("Error: schedule entry ID is required");
    return null;
  }
  try {
    const match = resolveScheduleEntry(engine.getEntries(), id);
    if (!match) {
      console.error(`No schedule entry found matching: ${id}`);
      return null;
    }
    return match;
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return null;
  }
}

export function parsePositiveInteger(value: string | undefined, label: string): number {
  const normalized = value?.trim() ?? "";
  if (!/^[0-9]+$/.test(normalized)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseNonEmptyCliValue(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

export function parseJsonConfig<T>(
  raw: unknown,
  parser: Pick<z.ZodType<T>, "parse">,
  label: string,
): T | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`${label} must be a non-empty JSON string`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${(err as Error).message}`);
  }
  try {
    return parser.parse(parsed);
  } catch (err) {
    throw new Error(`${label} failed schema validation: ${(err as Error).message}`);
  }
}

export function resolveTriggerPatch(values: {
  cron?: string;
  interval?: string;
  timezone?: string;
}): ScheduleTriggerInput | undefined {
  const cron = values.cron;
  const interval = values.interval;
  if (cron !== undefined && interval !== undefined) {
    throw new Error("Use only one of --cron or --interval");
  }
  if (cron !== undefined) {
    return {
      type: "cron",
      expression: parseNonEmptyCliValue(cron, "--cron"),
      timezone: values.timezone !== undefined ? parseNonEmptyCliValue(values.timezone, "--timezone") : "UTC",
    };
  }
  if (interval !== undefined) {
    return { type: "interval", seconds: parsePositiveInteger(interval, "--interval"), jitter_factor: 0 };
  }
  if (values.timezone !== undefined) {
    throw new Error("--timezone can only be used with --cron");
  }
  return undefined;
}
