import { z } from "zod";

export const EnvelopePrioritySchema = z.enum(["critical", "high", "normal", "low"]);
export type EnvelopePriority = z.infer<typeof EnvelopePrioritySchema>;

export const EnvelopeTypeSchema = z.enum(["command", "event"]);
export type EnvelopeType = z.infer<typeof EnvelopeTypeSchema>;

export const AuthContextSchema = z.object({
  principal: z.string(),
  roles: z.array(z.string()).optional(),
});
export type AuthContext = z.infer<typeof AuthContextSchema>;

export const EnvelopeSchema = z.object({
  id: z.string(),
  type: EnvelopeTypeSchema,
  name: z.string(),
  source: z.string(),
  goal_id: z.string().optional(),
  correlation_id: z.string().optional(),
  dedupe_key: z.string().optional(),
  priority: EnvelopePrioritySchema,
  payload: z.unknown(),
  reply_channel_id: z.string().optional(),
  created_at: z.number(),
  ttl_ms: z.number().optional(),
  auth: AuthContextSchema.optional(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** Helper to create an Envelope with defaults */
export function createEnvelope(partial: {
  type: EnvelopeType;
  name: string;
  source: string;
  payload: unknown;
  goal_id?: string;
  priority?: EnvelopePriority;
  correlation_id?: string;
  dedupe_key?: string;
  reply_channel_id?: string;
  ttl_ms?: number;
  auth?: AuthContext;
}): Envelope {
  return {
    id: crypto.randomUUID(),
    type: partial.type,
    name: partial.name,
    source: partial.source,
    goal_id: partial.goal_id,
    correlation_id: partial.correlation_id,
    dedupe_key: partial.dedupe_key,
    priority: partial.priority ?? "normal",
    payload: partial.payload,
    reply_channel_id: partial.reply_channel_id,
    created_at: Date.now(),
    ttl_ms: partial.ttl_ms,
    auth: partial.auth,
  };
}
