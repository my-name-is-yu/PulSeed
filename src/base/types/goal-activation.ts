import { z } from "zod/v3";

export const WaitResumeActivationSchema = z.object({
  type: z.literal("wait_resume"),
  strategyId: z.string(),
  scheduleEntryId: z.string().optional(),
  nextObserveAt: z.string().nullable().optional(),
  waitReason: z.string().nullable().optional(),
});

export type WaitResumeActivation = z.infer<typeof WaitResumeActivationSchema>;

export const BackgroundRunActivationSchema = z.object({
  backgroundRunId: z.string(),
  parentSessionId: z.string().nullable().optional(),
});

export type BackgroundRunActivation = z.infer<typeof BackgroundRunActivationSchema>;

export interface GoalRunActivationContext {
  waitResume?: WaitResumeActivation;
  backgroundRun?: BackgroundRunActivation;
}
