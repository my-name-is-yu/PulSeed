import { z } from "zod/v3";

export const MAX_AUTONOMY_TTL_MS = 24 * 60 * 60 * 1000;

export const AutonomyTtlMsSchema = z.number()
  .finite()
  .int()
  .positive()
  .max(MAX_AUTONOMY_TTL_MS);
