import { z } from "zod";

export const TurnLanguageHintSchema = z.object({
  language: z.enum(["en", "ja", "unknown"]),
  script: z.enum(["japanese", "latin", "other", "unknown"]).optional(),
  confidence: z.number().min(0).max(1),
  source: z.enum(["input_script", "caller", "unknown"]),
});

export type TurnLanguageHint = z.infer<typeof TurnLanguageHintSchema>;

export const UNKNOWN_TURN_LANGUAGE_HINT: TurnLanguageHint = {
  language: "unknown",
  script: "unknown",
  confidence: 0,
  source: "unknown",
};

export function detectTurnLanguageHint(input: string): TurnLanguageHint {
  const languageText = input.replace(/\[REDACTED:[^\]]+\]/g, " ");
  const letters = Array.from(languageText).filter((char) => /\p{Letter}/u.test(char));
  if (letters.length === 0) return UNKNOWN_TURN_LANGUAGE_HINT;

  const japanese = letters.filter((char) => /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(char)).length;
  const latin = letters.filter((char) => /\p{Script=Latin}/u.test(char)).length;
  const total = letters.length;

  if (japanese > 0 && japanese / total >= 0.25) {
    return { language: "ja", script: "japanese", confidence: Math.min(0.99, Math.max(0.75, japanese / total)), source: "input_script" };
  }
  if (latin > 0 && latin / total >= 0.6) {
    return { language: "unknown", script: "latin", confidence: Math.min(0.95, Math.max(0.7, latin / total)), source: "input_script" };
  }
  return { language: "unknown", script: "other", confidence: 0.65, source: "input_script" };
}

export function sameLanguageResponseInstruction(hint: TurnLanguageHint | null | undefined): string {
  const base = "Reply in the same language as the user's current input. Do not translate command names, slash commands, file paths, config keys, environment variables, protocol tokens, or code.";
  if (hint?.language === "ja") {
    return `${base} The current turn language hint is Japanese, so user-facing prose should be Japanese.`;
  }
  if (hint?.script === "latin") {
    return `${base} The current turn uses Latin script, but the exact language is not known; infer the user's language from the current message instead of defaulting to English.`;
  }
  if (hint?.script === "other") {
    return `${base} The current turn is not Japanese or Latin script; infer the user's language from the current message instead of defaulting to English or Japanese.`;
  }
  return base;
}
