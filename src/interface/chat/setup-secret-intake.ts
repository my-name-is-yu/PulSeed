import { z } from "zod/v3";

export const SetupSecretKindSchema = z.enum([
  "telegram_bot_token",
  "openai_api_key",
  "slack_bot_token",
  "discord_bot_token",
  "url_token_secret",
]);
export type SetupSecretKind = z.infer<typeof SetupSecretKindSchema>;

export const SetupSecretIntakeItemSchema = z.object({
  id: z.string(),
  kind: SetupSecretKindSchema,
  redaction: z.string(),
  suppliedAt: z.string(),
  value: z.string(),
});
export type SetupSecretIntakeItem = z.infer<typeof SetupSecretIntakeItemSchema>;

export const SetupSecretIntakeResultSchema = z.object({
  redactedText: z.string(),
  suppliedSecrets: z.array(SetupSecretIntakeItemSchema),
});
export type SetupSecretIntakeResult = z.infer<typeof SetupSecretIntakeResultSchema>;

type SecretDetector = {
  kind: SetupSecretKind;
  pattern: RegExp;
  replacement: "whole_match" | "query_value";
};

const SECRET_DETECTORS: SecretDetector[] = [
  {
    kind: "telegram_bot_token",
    pattern: /\b\d{6,12}:[A-Za-z0-9_-]{30,80}\b/g,
    replacement: "whole_match",
  },
  {
    kind: "openai_api_key",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replacement: "whole_match",
  },
  {
    kind: "slack_bot_token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: "whole_match",
  },
  {
    kind: "discord_bot_token",
    pattern: /\b[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g,
    replacement: "whole_match",
  },
  {
    kind: "url_token_secret",
    pattern: /([?&](?:access_token|api_key|token|key|secret)=)([^&\s"'<>]{8,})/gi,
    replacement: "query_value",
  },
];

export function intakeSetupSecrets(text: string, suppliedAt = new Date().toISOString()): SetupSecretIntakeResult {
  const suppliedSecrets: SetupSecretIntakeItem[] = [];
  let redactedText = text;

  for (const detector of SECRET_DETECTORS) {
    redactedText = redactedText.replace(detector.pattern, (...args: unknown[]) => {
      const match = String(args[0]);
      const prefix = detector.replacement === "query_value" ? String(args[1] ?? "") : "";
      const value = detector.replacement === "query_value" ? String(args[2] ?? "") : match;
      const id = `setup_secret_${suppliedSecrets.length + 1}`;
      const redaction = `[REDACTED:${detector.kind}:${id}]`;
      suppliedSecrets.push({
        id,
        kind: detector.kind,
        redaction,
        suppliedAt,
        value,
      });
      return detector.replacement === "query_value" ? `${prefix}${redaction}` : redaction;
    });
  }

  return { redactedText, suppliedSecrets };
}

export function redactSetupSecrets(value: string): string {
  return intakeSetupSecrets(value).redactedText;
}

export function redactSetupSecretsDeep<T>(value: T): T {
  if (typeof value === "string") {
    return redactSetupSecrets(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSetupSecretsDeep(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactSetupSecretsDeep(entry)])
    ) as T;
  }
  return value;
}
