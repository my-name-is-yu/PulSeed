import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod/v3";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import { getInternalIdentityPrefix } from "../../base/config/identity-loader.js";

const ACTIVITY_PREVIEW_CHARS = 40;
export const DIFF_ARTIFACT_MAX_LINES = 80;

export interface GitDiffArtifact {
  stat: string;
  nameStatus: string;
  patch: string;
  truncated: boolean;
}

export type ChatInterruptRedirectKind = "diff" | "review" | "summary" | "background" | "redirect";
const MIN_INTERRUPT_CONFIDENCE = 0.7;

const InterruptRedirectDecisionSchema = z.object({
  kind: z.enum(["diff", "review", "summary", "background", "redirect", "unknown"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().optional(),
});

export type ChatInterruptRedirectDecision = z.infer<typeof InterruptRedirectDecisionSchema>;

export interface ChatInterruptRedirectContext {
  llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">;
  cwd: string;
  activeTurnStartedAt: string;
  recentEvents: string[];
  sessionId?: string | null;
}

function runGit(cwd: string, args: string[], timeout = 5_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout }, (err, stdout, stderr) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve((stdout + stderr).trim());
    });
  });
}

export function checkGitChanges(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["diff", "HEAD", "--stat"], { cwd, timeout: 5_000 }, (err, stdout, stderr) => {
      resolve(err ? null : (stdout + stderr).trim());
    });
  });
}

function parseGitLines(output: string | null): string[] {
  return output ? output.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

async function buildUntrackedFilePatch(cwd: string, relativePath: string): Promise<string> {
  const absolutePath = path.resolve(cwd, relativePath);
  const relativeFromCwd = path.relative(cwd, absolutePath);
  if (relativeFromCwd.startsWith("..") || path.isAbsolute(relativeFromCwd)) {
    return `diff --git a/${relativePath} b/${relativePath}\nnew file skipped: path outside workspace`;
  }
  try {
    const stat = await fsp.stat(absolutePath);
    if (!stat.isFile()) {
      return `diff --git a/${relativePath} b/${relativePath}\nnew file skipped: not a regular file`;
    }
    if (stat.size > 100_000) {
      return `diff --git a/${relativePath} b/${relativePath}\nnew file skipped: ${stat.size} bytes`;
    }
    const content = await fsp.readFile(absolutePath, "utf-8");
    const lines = content.split("\n");
    const body = lines.map((line) => `+${line}`).join("\n");
    return [
      `diff --git a/${relativePath} b/${relativePath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${relativePath}`,
      `@@ -0,0 +1,${lines.length} @@`,
      body,
    ].join("\n");
  } catch {
    return `diff --git a/${relativePath} b/${relativePath}\nnew file skipped: unreadable`;
  }
}

export async function collectGitDiffArtifact(cwd: string): Promise<GitDiffArtifact | null> {
  const trackedStat = await runGit(cwd, ["diff", "HEAD", "--stat"]);
  const untrackedFiles = parseGitLines(await runGit(cwd, ["ls-files", "--others", "--exclude-standard"]));
  if (!trackedStat && untrackedFiles.length === 0) return null;
  const trackedNameStatus = await runGit(cwd, ["diff", "HEAD", "--name-status"]) ?? "";
  const trackedPatch = await runGit(cwd, ["diff", "HEAD", "--patch", "--unified=3"], 10_000) ?? "";
  const untrackedPatchParts = await Promise.all(
    untrackedFiles.slice(0, 10).map((file) => buildUntrackedFilePatch(cwd, file))
  );
  if (untrackedFiles.length > 10) {
    untrackedPatchParts.push(`... ${untrackedFiles.length - 10} additional untracked file(s) omitted`);
  }
  const stat = [
    trackedStat,
    untrackedFiles.length > 0
      ? ["Untracked files:", ...untrackedFiles.map((file) => `  ${file}`)].join("\n")
      : "",
  ].filter(Boolean).join("\n");
  const nameStatus = [
    trackedNameStatus,
    ...untrackedFiles.map((file) => `A\t${file}`),
  ].filter(Boolean).join("\n");
  const patch = [trackedPatch, ...untrackedPatchParts].filter(Boolean).join("\n");
  const patchLines = patch.split("\n");
  const truncated = patchLines.length > DIFF_ARTIFACT_MAX_LINES;
  return {
    stat,
    nameStatus,
    patch: patchLines.slice(0, DIFF_ARTIFACT_MAX_LINES).join("\n"),
    truncated,
  };
}

export function previewActivityText(value: string, maxChars = ACTIVITY_PREVIEW_CHARS): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized;
}

export async function classifyInterruptRedirect(
  input: string,
  context: ChatInterruptRedirectContext,
): Promise<ChatInterruptRedirectKind> {
  const exactCommand = parseExactInterruptRedirectCommand(input);
  if (exactCommand) return exactCommand;

  const trimmed = input.trim();
  const llmClient = context.llmClient;
  if (!trimmed || !llmClient) return "summary";

  try {
    const response = await llmClient.sendMessage(
      [{ role: "user", content: trimmed }],
      { system: getInterruptRedirectPrompt(context), max_tokens: 500, temperature: 0 },
    );
    const parsed = llmClient.parseJSON(response.content, InterruptRedirectDecisionSchema);
    if (parsed.kind === "unknown" || parsed.confidence < MIN_INTERRUPT_CONFIDENCE) return "summary";
    return parsed.kind;
  } catch {
    return "summary";
  }
}

function parseExactInterruptRedirectCommand(input: string): ChatInterruptRedirectKind | null {
  const command = input.trim();
  switch (command) {
    case "/diff":
      return "diff";
    case "/review":
      return "review";
    case "/summary":
    case "/interrupt":
      return "summary";
    case "/background":
      return "background";
    default:
      return null;
  }
}

function getInterruptRedirectPrompt(context: ChatInterruptRedirectContext): string {
  return `${getInternalIdentityPrefix("assistant")} Classify the operator's message while an active chat turn is running.

Return a typed interrupt redirect intent. Use the active turn context; do not infer a specialized route from vague text. If unclear, return unknown.

Kinds:
- background: operator explicitly wants the current active turn to continue in the background without aborting it.
- review: operator wants to stop and switch to read-only review mode.
- diff: operator wants to stop and inspect current working-tree changes.
- summary: operator wants to stop/pause/interrupt and receive a short status summary.
- redirect: operator wants to stop the current turn and redirect to a new instruction.
- unknown: ambiguous or not enough evidence.

Active turn:
- cwd: ${context.cwd}
- started_at: ${context.activeTurnStartedAt}
- session_id: ${context.sessionId ?? "unknown"}
- recent_events:
${context.recentEvents.length > 0 ? context.recentEvents.slice(-8).map((event) => `  - ${event}`).join("\n") : "  - none"}

Respond only as JSON:
{
  "kind": "diff" | "review" | "summary" | "background" | "redirect" | "unknown",
  "confidence": 0.0-1.0,
  "rationale": "short rationale"
}`;
}

export function formatToolActivity(action: "Running" | "Finished" | "Failed", toolName: string, detail?: string): string {
  const preview = detail ? previewActivityText(detail) : "";
  return preview ? `${action} tool: ${toolName} - ${preview}` : `${action} tool: ${toolName}`;
}

export function formatIntentInput(input: string, maxChars = 96): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 3)}...` : normalized;
}
