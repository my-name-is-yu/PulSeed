import { z } from "zod/v3";

const FORBIDDEN_RAW_TEXT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(password|passwd|secret|credential|api[_-]?key|token)\b/i, label: "credential-like text" },
  { pattern: /\b(raw user text|raw tool output|prompt snippet|hidden model context)\b/i, label: "raw private context" },
  { pattern: /-----BEGIN [A-Z ]+-----/, label: "encoded secret block" },
];

export const RedactedLearningTextSchema = z.object({
  label: z.string().min(1),
  redactionClass: z.enum(["diagnostic_label", "redacted_summary"]),
  sourceRefs: z.array(z.string().min(1)).min(1),
  maxLength: z.number().int().positive().max(512),
}).strict().superRefine((value, ctx) => {
  if (value.label.length > value.maxLength) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["label"],
      message: `redacted learning text exceeds maxLength ${value.maxLength}`,
    });
  }
  for (const { pattern, label } of FORBIDDEN_RAW_TEXT_PATTERNS) {
    if (pattern.test(value.label)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["label"],
        message: `redacted learning text must not persist ${label}`,
      });
    }
  }
});
export type RedactedLearningText = z.infer<typeof RedactedLearningTextSchema>;

export function redactedLearningLabel(input: {
  label: string;
  sourceRefs: readonly string[];
  redactionClass?: RedactedLearningText["redactionClass"];
  maxLength?: number;
}): RedactedLearningText {
  return RedactedLearningTextSchema.parse({
    label: input.label,
    redactionClass: input.redactionClass ?? "diagnostic_label",
    sourceRefs: [...input.sourceRefs],
    maxLength: input.maxLength ?? 160,
  });
}
