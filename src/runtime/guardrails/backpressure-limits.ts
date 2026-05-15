import { z } from "zod/v3";

export const DEFAULT_BACKPRESSURE_MAX_CONCURRENT_PER_PROVIDER = 2;
export const DEFAULT_BACKPRESSURE_MAX_CONCURRENT_PER_SERVICE = 1;
export const DEFAULT_BACKPRESSURE_LEASE_TTL_MS = 10 * 60_000;

const BackpressurePositiveSafeIntSchema = z.number().int().positive().safe();

export function parseBackpressurePositiveSafeInt(value: number, fieldName: string): number {
  const parsed = BackpressurePositiveSafeIntSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${fieldName} must be a positive safe integer`);
  }
  return parsed.data;
}
