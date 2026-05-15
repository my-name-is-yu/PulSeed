import { z } from "zod/v3";

export const ShutdownMarkerSchema = z.object({
  goal_ids: z.array(z.string().min(1)),
  loop_index: z.number().finite().int().nonnegative().safe(),
  timestamp: z.string().datetime(),
  reason: z.enum(["signal", "stop", "max_retries", "startup"]),
  state: z.enum(["running", "clean_shutdown"]),
});
export type ShutdownMarker = z.infer<typeof ShutdownMarkerSchema>;
