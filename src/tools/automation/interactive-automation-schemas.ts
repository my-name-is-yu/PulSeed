import { z } from "zod";

function desktopCoordinateSchema() {
  return z.number()
    .finite()
    .min(Number.MIN_SAFE_INTEGER)
    .max(Number.MAX_SAFE_INTEGER);
}

const MAX_DESKTOP_CLICK_COUNT = 10;

const DesktopClickCountSchema = z.number()
  .finite()
  .int()
  .min(1)
  .max(MAX_DESKTOP_CLICK_COUNT)
  .default(1);

const ProviderInputSchema = z.object({
  providerId: z.string().optional(),
}).strict();

export const DesktopListAppsInputSchema = ProviderInputSchema;
export type DesktopListAppsInput = z.infer<typeof DesktopListAppsInputSchema>;

export const DesktopGetAppStateInputSchema = ProviderInputSchema.extend({
  app: z.string().min(1),
});
export type DesktopGetAppStateInput = z.infer<typeof DesktopGetAppStateInputSchema>;

export const DesktopClickInputSchema = ProviderInputSchema.extend({
  app: z.string().min(1),
  elementId: z.string().optional(),
  x: desktopCoordinateSchema().optional(),
  y: desktopCoordinateSchema().optional(),
  button: z.enum(["left", "right", "middle"]).default("left"),
  clickCount: DesktopClickCountSchema,
});
export type DesktopClickInput = z.infer<typeof DesktopClickInputSchema>;

export const DesktopTypeTextInputSchema = ProviderInputSchema.extend({
  app: z.string().min(1),
  text: z.string(),
});
export type DesktopTypeTextInput = z.infer<typeof DesktopTypeTextInputSchema>;

export const ResearchWebInputSchema = ProviderInputSchema.extend({
  query: z.string().min(1),
  maxResults: z.number().int().positive().max(20).optional(),
  domains: z.array(z.string().min(1)).optional(),
});
export type ResearchWebInput = z.infer<typeof ResearchWebInputSchema>;

export const ResearchAnswerInputSchema = ProviderInputSchema.extend({
  question: z.string().min(1),
  model: z.string().optional(),
});
export type ResearchAnswerInput = z.infer<typeof ResearchAnswerInputSchema>;

export const BrowserRunWorkflowInputSchema = ProviderInputSchema.extend({
  task: z.string().min(1),
  startUrl: z.string().url().optional(),
  sessionId: z.string().optional(),
  serviceKey: z.string().optional(),
});
export type BrowserRunWorkflowInput = z.infer<typeof BrowserRunWorkflowInputSchema>;

export const BrowserGetStateInputSchema = ProviderInputSchema.extend({
  sessionId: z.string().optional(),
  serviceKey: z.string().optional(),
  startUrl: z.string().url().optional(),
});
export type BrowserGetStateInput = z.infer<typeof BrowserGetStateInputSchema>;
