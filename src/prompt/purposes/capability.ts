/**
 * capability.ts
 * System prompts and response schemas for capability purposes.
 * Used by PromptGateway for CAPABILITY_DETECT, CAPABILITY_ASSESS, and CAPABILITY_PLAN.
 */

import { z } from "zod";

// ─── CAPABILITY_DETECT ────────────────────────────────────────────────────────

export const CAPABILITY_DETECT_SYSTEM_PROMPT =
  "You are a capability analyzer for an AI orchestration system. " +
  "Your job is to determine whether a given task can be executed with the available capabilities. " +
  "Respond with valid JSON only — no markdown, no explanation outside the JSON.";

export const CapabilityDetectResponseSchema = z.object({
  capability_name: z.string(),
  is_available: z.boolean(),
  reason: z.string(),
  alternatives: z.array(z.string()).optional(),
  impact_description: z.string().optional(),
});

export type CapabilityDetectResponse = z.infer<typeof CapabilityDetectResponseSchema>;

// ─── CAPABILITY_ASSESS ────────────────────────────────────────────────────────

export const CAPABILITY_GOAL_GAP_SYSTEM_PROMPT =
  "You are a capability analyzer for an AI orchestration system. " +
  "Your job is to determine whether a given goal can be achieved with the available capabilities. " +
  "Respond with valid JSON only — no markdown, no explanation outside the JSON.";

export const CapabilityAssessResponseSchema = z.object({
  capability_name: z.string(),
  is_available: z.boolean(),
  reason: z.string(),
  alternatives: z.array(z.string()).optional(),
  impact_description: z.string().optional(),
  acquirable: z.boolean().optional(),
});

export type CapabilityAssessResponse = z.infer<typeof CapabilityAssessResponseSchema>;

// ─── CAPABILITY_PLAN ──────────────────────────────────────────────────────────

export const CAPABILITY_VERIFY_SYSTEM_PROMPT =
  "You are a capability verifier for an AI orchestration system. " +
  "Your job is to assess whether a newly acquired capability is ready for use. " +
  "Respond with valid JSON only — no markdown, no explanation outside the JSON.";

export const CapabilityPlanResponseSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  reason: z.string(),
});

export type CapabilityPlanResponse = z.infer<typeof CapabilityPlanResponseSchema>;
