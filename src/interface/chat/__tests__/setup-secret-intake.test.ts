import { describe, expect, it } from "vitest";
import { intakeSetupSecrets } from "../setup-secret-intake.js";

describe("setup secret intake", () => {
  it("redacts URL query secret values while preserving the query key", () => {
    const result = intakeSetupSecrets("https://example.test/callback?token=abcdef1234567890&ok=1");

    expect(result.redactedText).toBe("https://example.test/callback?token=[REDACTED:url_token_secret:setup_secret_1]&ok=1");
    expect(result.suppliedSecrets).toEqual([
      expect.objectContaining({
        kind: "url_token_secret",
        value: "abcdef1234567890",
      }),
    ]);
  });
});
