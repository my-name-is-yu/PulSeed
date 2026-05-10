import { z } from "zod";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { ChatTurnContext } from "./turn-context.js";

const GatewayCommentaryPreambleResponseSchema = z.object({
  text_kind: z.literal("gateway_progress_preamble"),
  display_text: z.string().min(1).max(220),
  safety: z.object({
    verdict: z.enum(["safe", "unsafe", "uncertain"]),
    reason: z.string().min(1).max(240),
  }),
  claims: z.object({
    completed_work: z.boolean(),
    current_runtime_status: z.boolean(),
    internal_model_or_provider_detail: z.boolean(),
    raw_tool_trace_command_output_or_secret: z.boolean(),
  }),
});

type GatewayCommentaryPreambleResponse = z.infer<typeof GatewayCommentaryPreambleResponseSchema>;

export interface GatewayCommentaryPreambleInput {
  readonly turnContext: ChatTurnContext;
  readonly routeKind: "agent_loop" | "tool_loop";
  readonly llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">;
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
}

export async function generateGatewayCommentaryPreamble(
  input: GatewayCommentaryPreambleInput,
): Promise<string | null> {
  if (!input.llmClient) return null;
  if (input.turnContext.modelVisible.runtime.replyTarget?.surface !== "gateway") return null;
  if (input.abortSignal?.aborted) return null;

  try {
    const response = await withTimeout(input.llmClient.sendMessage([
      {
        role: "user",
        content: JSON.stringify({
          user_input: input.turnContext.modelVisible.input.text,
          route_kind: input.routeKind,
          selected_route: input.turnContext.modelVisible.tools.selectedRoute,
          cwd: input.turnContext.modelVisible.session.cwd,
        }),
      },
    ], {
      system: [
        "Create a structured PulSeed gateway progress preamble.",
        "The display_text is commentary before tool/runtime/workspace work, not the final answer.",
        "It should say what you are about to inspect or do at a user level.",
        "It must not claim work has already completed, that a check succeeded, or that current runtime status is known.",
        "It must not expose model/provider names, raw tool catalogs, trace ids, command output, secrets, or raw logs.",
        "Return only JSON with this shape:",
        JSON.stringify({
          text_kind: "gateway_progress_preamble",
          display_text: "one plain first-person sentence",
          safety: {
            verdict: "safe | unsafe | uncertain",
            reason: "short rationale",
          },
          claims: {
            completed_work: false,
            current_runtime_status: false,
            internal_model_or_provider_detail: false,
            raw_tool_trace_command_output_or_secret: false,
          },
        }),
        "Set safety.verdict to unsafe or uncertain unless the display_text is safe for a default Telegram/Slack gateway progress surface.",
        "Do not classify by keywords alone; judge the semantic claim and whether it depends on unavailable same-turn evidence.",
      ].join("\n"),
      max_tokens: 220,
      temperature: 0.2,
      model_tier: "light",
    }), input.timeoutMs ?? 1_500, input.abortSignal);
    if (input.abortSignal?.aborted) return null;
    const parsed = input.llmClient.parseJSON(response.content, GatewayCommentaryPreambleResponseSchema);
    return normalizeGatewayCommentaryPreamble(parsed);
  } catch {
    return null;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, abortSignal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;
  promise.catch(() => undefined);
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("gateway commentary preamble timed out")), timeoutMs);
        timer.unref?.();
      }),
      ...(abortSignal
        ? [
            new Promise<T>((_, reject) => {
              abortListener = () => reject(new Error("gateway commentary preamble aborted"));
              abortSignal.addEventListener("abort", abortListener, { once: true });
            }),
          ]
        : []),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (abortSignal && abortListener !== null) {
      abortSignal.removeEventListener("abort", abortListener);
    }
  }
}

function normalizeGatewayCommentaryPreamble(value: GatewayCommentaryPreambleResponse): string | null {
  if (value.safety.verdict !== "safe") return null;
  if (value.claims.completed_work) return null;
  if (value.claims.current_runtime_status) return null;
  if (value.claims.internal_model_or_provider_detail) return null;
  if (value.claims.raw_tool_trace_command_output_or_secret) return null;

  const normalized = value.display_text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const withoutQuotes = normalized.replace(/^["']|["']$/g, "").trim();
  if (!withoutQuotes || withoutQuotes.length > 220) return null;
  if (withoutQuotes.includes("\n") || withoutQuotes.includes("\r")) return null;
  if (withoutQuotes.includes("`")) return null;
  if (withoutQuotes.includes("{") || withoutQuotes.includes("}")) return null;
  if (withoutQuotes.includes("[") || withoutQuotes.includes("]")) return null;
  if (withoutQuotes.includes("<") || withoutQuotes.includes(">")) return null;
  return withoutQuotes;
}
