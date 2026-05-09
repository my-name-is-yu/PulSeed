import { describe, expect, it } from "vitest";
import {
  classifyFailureRecovery,
  classifyFailureRecoveryWithFallback,
  formatLifecycleFailureMessage,
} from "../failure-recovery.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";

describe("failure recovery guidance", () => {
  it("classifies verification failures from structured verification evidence", () => {
    const guidance = classifyFailureRecovery({
      error: "変更後の確認が通りませんでした。",
      signals: [{ kind: "verification", status: "failed" }],
    });

    expect(guidance.kind).toBe("verification");
    expect(guidance.label).toBe("Verification failure");
    expect(guidance.nextActions.join("\n")).toContain("/review");
  });

  it("classifies missing resumable state from exact stop code", () => {
    const guidance = classifyFailureRecovery({
      error: "I could not find a chat that can safely continue.",
      code: "resume_state_missing",
    });

    expect(guidance.kind).toBe("resume");
    expect(guidance.nextActions.join("\n")).toContain("Continue from the latest chat");
    expect(guidance.nextActions.join("\n")).toContain("Inspect what was running");
    expect(guidance.nextActions.join("\n")).toContain("Show recent sessions");
    expect(guidance.nextActions.join("\n")).not.toContain("/resume <id>");
  });

  it("classifies permission failures from approval and tool dispositions", () => {
    expect(classifyFailureRecovery({
      error: "action was not performed",
      signals: [{ kind: "approval", status: "denied", toolName: "apply_patch" }],
    }).kind).toBe("permission");

    expect(classifyFailureRecovery({
      error: "provider-specific denial text",
      signals: [{ kind: "tool", toolName: "shell", status: "approval_denied", disposition: "approval_denied" }],
    }).kind).toBe("permission");

    expect(classifyFailureRecovery({
      error: "provider-specific denial text",
      signals: [{ kind: "tool", toolName: "shell", status: "approval_denied" }],
    }).kind).toBe("permission");
  });

  it("classifies runtime interruption and adapter failures from typed stop metadata", () => {
    expect(classifyFailureRecovery({
      error: "ストリームが終了しました",
      stoppedReason: "timeout",
    }).kind).toBe("runtime_interruption");

    expect(classifyFailureRecovery({
      error: "localized provider text",
      code: "model_request_timeout",
    }).kind).toBe("runtime_interruption");

    expect(classifyFailureRecovery({
      error: "modelo no disponible temporalmente",
      signals: [{ kind: "adapter", adapterType: "codex", stoppedReason: "error" }],
    }).kind).toBe("adapter");

    expect(classifyFailureRecovery({
      error: "tool was cancelled",
      signals: [{ kind: "tool", toolName: "shell", status: "cancelled" }],
    }).kind).toBe("runtime_interruption");

    expect(classifyFailureRecovery({
      error: "timeout-looking provider text",
      code: "provider_failure",
    }).kind).toBe("adapter");
  });

  it("does not classify localized/provider-specific text without structured evidence", () => {
    const guidance = classifyFailureRecovery("権限っぽい失敗かもしれないが構造化シグナルがない");

    expect(guidance.kind).toBe("unknown");
  });

  it("uses confidence-aware model fallback only when structured evidence is absent", async () => {
    const llmClient = {
      sendMessage: async () => ({
        content: JSON.stringify({ kind: "adapter", confidence: 0.91, rationale: "provider outage" }),
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
      }),
      parseJSON: (content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content)),
    } as unknown as Pick<ILLMClient, "sendMessage" | "parseJSON">;

    await expect(classifyFailureRecoveryWithFallback("provider returned overloaded", llmClient)).resolves.toMatchObject({
      kind: "adapter",
    });
    await expect(classifyFailureRecoveryWithFallback({
      error: "model guessed adapter, but typed verification wins",
      signals: [{ kind: "verification", status: "failed" }],
    }, llmClient)).resolves.toMatchObject({
      kind: "verification",
    });
  });

  it("keeps low-confidence or unavailable model fallback unknown", async () => {
    const lowConfidenceClient = {
      sendMessage: async () => ({
        content: JSON.stringify({ kind: "permission", confidence: 0.4 }),
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
      }),
      parseJSON: (content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content)),
    } as unknown as Pick<ILLMClient, "sendMessage" | "parseJSON">;

    await expect(classifyFailureRecoveryWithFallback("ambiguous provider text", lowConfidenceClient)).resolves.toMatchObject({
      kind: "unknown",
    });
    await expect(classifyFailureRecoveryWithFallback("ambiguous provider text")).resolves.toMatchObject({
      kind: "unknown",
    });
  });

  it("formats lifecycle errors without hiding the original interruption", () => {
    const text = formatLifecycleFailureMessage(
      "stream aborted",
      "Partial answer",
      classifyFailureRecovery({ error: "stream aborted", stoppedReason: "aborted" })
    );

    expect(text).toContain("Partial answer");
    expect(text).toContain("[interrupted: stream aborted]");
    expect(text).toContain("Type: Runtime interruption");
    expect(text).toContain("Next actions:");
  });
});
