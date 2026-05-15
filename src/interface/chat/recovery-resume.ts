import { z } from "zod/v3";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { ChatSessionCatalogEntry } from "./chat-session-store.js";

export const RecoveryResumeIntentSchema = z.object({
  kind: z.enum(["none", "continue_latest", "inspect_running", "start_new", "show_sessions"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(240).optional(),
});

export type RecoveryResumeIntent = z.infer<typeof RecoveryResumeIntentSchema>;

export interface RecoveryResumeCandidate {
  index: number;
  sessionId: string;
  title: string;
  updatedAt: string;
  cwd: string;
  summary: string | null;
  agentLoopSessionId: string;
  agentLoopStatePath: string;
}

const MIN_RECOVERY_CONFIDENCE = 0.7;

export async function classifyRecoveryResumeIntent(
  input: string,
  llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">,
): Promise<RecoveryResumeIntent | null> {
  if (!llmClient) return null;
  try {
    const response = await llmClient.sendMessage(
      [{ role: "user", content: input }],
      {
        system: recoveryResumeSystemPrompt(),
        max_tokens: 320,
        temperature: 0,
        model_tier: "light",
      },
    );
    const parsed = llmClient.parseJSON(response.content, RecoveryResumeIntentSchema);
    const decision = parsed instanceof Promise ? await parsed : parsed;
    return decision.confidence >= MIN_RECOVERY_CONFIDENCE ? decision : null;
  } catch {
    return null;
  }
}

export function toRecoveryResumeCandidates(entries: ChatSessionCatalogEntry[]): RecoveryResumeCandidate[] {
  return entries
    .filter((entry) =>
      entry.agentLoopResumable
      && entry.agentLoopStatus === "running"
      && typeof (entry.agentLoopSessionId ?? entry.agentLoopStatePath) === "string"
      && (entry.agentLoopSessionId ?? entry.agentLoopStatePath ?? "").length > 0
    )
    .map((entry, index) => ({
      index: index + 1,
      sessionId: entry.id,
      title: entry.title?.trim() || "Untitled chat",
      updatedAt: entry.agentLoopUpdatedAt ?? entry.updatedAt,
      cwd: entry.cwd,
      summary: entry.sessionSummary ?? null,
      agentLoopSessionId: (entry.agentLoopSessionId ?? entry.agentLoopStatePath)!,
      agentLoopStatePath: entry.agentLoopStatePath ?? "",
    }));
}

export function chooseSingleRecoveryResumeCandidate(candidates: RecoveryResumeCandidate[]): RecoveryResumeCandidate | null {
  return candidates.length === 1 ? candidates[0]! : null;
}

export function formatRecoveryResumeChoices(candidates: RecoveryResumeCandidate[]): string {
  if (candidates.length === 0) return formatNoRecoveryResumeCandidates();
  const intro = candidates.length === 1
    ? "I found one chat that can continue."
    : "I found more than one chat that can continue.";
  return [
    intro,
    "Reply with the number to resume one:",
    ...candidates.map((candidate) => `${candidate.index}. ${formatRecoveryResumeCandidate(candidate)}`),
    "",
    "Other options: ask me to inspect what was running, start a new attempt, or show recent sessions.",
  ].join("\n");
}

export function formatNoRecoveryResumeCandidates(): string {
  return [
    "I could not find a chat that can safely continue.",
    "You can:",
    "1. Continue from the latest chat if one becomes available.",
    "2. Inspect what was running.",
    "3. Start a new attempt with the missing context.",
    "4. Show recent sessions.",
  ].join("\n");
}

function formatRecoveryResumeCandidate(candidate: RecoveryResumeCandidate): string {
  const summary = candidate.summary ? ` — ${candidate.summary}` : "";
  return `${candidate.title} · updated ${candidate.updatedAt} · ${candidate.cwd}${summary}`;
}

function recoveryResumeSystemPrompt(): string {
  return `Classify whether this chat message is asking PulSeed to recover or resume prior chat work.

Return only JSON:
{
  "kind": "none" | "continue_latest" | "inspect_running" | "start_new" | "show_sessions",
  "confidence": 0.0-1.0,
  "rationale": "short"
}

Rules:
- Use continue_latest when the user wants to continue a previous chat or pick up where the prior conversation/work left off.
- Use inspect_running when the user asks what is still running or what happened before resuming.
- Use start_new when the user asks to start over or make a fresh attempt instead of resuming.
- Use show_sessions when the user asks to see recent chats/sessions.
- Use none for ordinary implementation, status Q&A, explanations, or new work.
- Do not invent a session id. This classifier only chooses the recovery action; typed session selection happens outside the model.`;
}
