import { randomUUID } from "node:crypto";
import type { RetentionConfig } from "../../../base/types/memory-lifecycle.js";

export function generateId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function getRetentionLimit(config: RetentionConfig, goalId: string): number {
  for (const [key, limit] of Object.entries(config.goal_type_overrides)) {
    if (goalId.startsWith(key) || goalId.includes(key)) {
      return limit;
    }
  }
  return config.default_retention_loops;
}
