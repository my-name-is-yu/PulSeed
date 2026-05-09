import { isReasoningEffort, type ProviderConfig } from "../../base/llm/provider-config.js";
import {
  withExecutionPolicyOverrides,
  type ExecutionPolicy,
} from "../../orchestrator/execution/agent-loop/execution-policy.js";

export const COMMAND_HELP = `Available commands:
Session
  /help                 Show this help message
  /clear                Clear conversation history
  /sessions             List prior chat sessions
  /history [id]         Show saved chat history
  /title <title>        Rename the current session
  /resume [id]          Resume native agentloop state for the current or selected session
  /cleanup [--dry-run]  Clean up stale chat sessions
  /compact              Summarize older chat turns and keep the latest turns
  /context              Show active working context and session assumptions
  /exit                 Exit chat mode

Goals and tasks
  /status [goal-id]     Show active goal status, or one goal when an id is provided
  /goals                List goals
  /tasks [goal-id]      List tasks for a goal; uses the only active goal when unambiguous
  /task <task-id> [goal-id]
                        Show one task; searches goals when no goal id is provided
  /track                Promote session to Tier 2 goal pursuit (not yet implemented)
  /tend                 Generate a goal from chat history and start autonomous daemon execution

Configuration
  /config               Show provider configuration with secrets masked
  /model                Show model and reasoning choices
  /model <model> [effort]
                        Select OpenAI model and optional reasoning effort
  /permissions [args]   Show or update session execution policy
  /plugins              List installed plugins when plugin metadata is available
  /usage [scope]        Show usage summary (session, goal <id>, daemon <goal-id>, schedule [7d|24h|2w])

Review and branching
  /review               Show current diff summary and verification context
  /fork [title]         Fork the current chat session into a new session
  /undo                 Remove the latest chat turn from session history

Deferred
  /retry is intentionally not supported yet.`;

export const CLEANUP_USAGE = "Usage: /cleanup [--dry-run]";
export const MODEL_USAGE = "Usage: /model <model> [none|minimal|low|medium|high|xhigh]";
export const PERMISSIONS_USAGE = "Usage: /permissions [read-only|workspace-write|full-access] [network on|off] [approval on_request|never|untrusted]";
export const STATUS_USAGE = "Usage: /status [goal-id] [--details]";

export type CleanupArgsParseResult =
  | { success: true; dryRun: boolean }
  | { success: false; output: string };

export function parseCleanupArgs(args: string): CleanupArgsParseResult {
  const argTokens = args.trim() ? args.trim().split(/\s+/) : [];
  if (argTokens.length === 0) return { success: true, dryRun: false };
  if (argTokens.length === 1 && argTokens[0] === "--dry-run") return { success: true, dryRun: true };
  return { success: false, output: CLEANUP_USAGE };
}

function isDetailFlag(token: string): boolean {
  return token === "--details" || token === "--diagnostic";
}

export type DetailOnlyArgsParseResult =
  | { success: true; diagnostic: boolean }
  | { success: false; output: string };

export function parseDetailOnlyArgs(args: string, command: string): DetailOnlyArgsParseResult {
  const tokens = args.trim() ? args.trim().split(/\s+/) : [];
  let diagnostic = false;
  for (const token of tokens) {
    if (!isDetailFlag(token)) {
      return { success: false, output: `Usage: ${command} [--details]` };
    }
    diagnostic = true;
  }
  return { success: true, diagnostic };
}

export type StatusArgsParseResult =
  | { success: true; goalId?: string; diagnostic: boolean }
  | { success: false; output: string };

export function parseStatusArgs(args: string): StatusArgsParseResult {
  const tokens = args.trim() ? args.trim().split(/\s+/) : [];
  let goalId: string | undefined;
  let diagnostic = false;
  for (const token of tokens) {
    if (isDetailFlag(token)) {
      diagnostic = true;
      continue;
    }
    if (goalId) {
      return { success: false, output: STATUS_USAGE };
    }
    goalId = token;
  }
  return goalId ? { success: true, goalId, diagnostic } : { success: true, diagnostic };
}

export interface ModelArgsParseResult {
  model?: string;
  reasoning?: ProviderConfig["reasoning_effort"];
  error?: string;
}

export function parseModelArgs(args: string): ModelArgsParseResult {
  const tokens = args.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return {};

  if (tokens.length === 1 && isReasoningEffort(tokens[0])) {
    return { reasoning: tokens[0] };
  }

  const model = tokens[0];
  if (tokens.length > 2) {
    return { error: MODEL_USAGE };
  }
  const reasoning = tokens[1];
  if (reasoning !== undefined && !isReasoningEffort(reasoning)) {
    return { error: `Invalid reasoning effort "${reasoning}". Valid: none, minimal, low, medium, high, xhigh` };
  }
  return { model, reasoning };
}

export type PermissionArgsParseResult =
  | { success: true; policy: ExecutionPolicy }
  | { success: false; output: string };

export function parsePermissionArgs(policy: ExecutionPolicy, args: string): PermissionArgsParseResult {
  const tokens = args.toLowerCase().split(/\s+/).filter(Boolean);
  let nextPolicy = policy;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "read-only" || token === "readonly" || token === "read_only") {
      nextPolicy = withExecutionPolicyOverrides(nextPolicy, { sandboxMode: "read_only" });
      continue;
    }
    if (token === "workspace-write" || token === "workspace_write") {
      nextPolicy = withExecutionPolicyOverrides(nextPolicy, { sandboxMode: "workspace_write" });
      continue;
    }
    if (token === "full-access" || token === "danger-full-access" || token === "danger_full_access") {
      nextPolicy = withExecutionPolicyOverrides(nextPolicy, { sandboxMode: "danger_full_access" });
      continue;
    }
    if (token === "network" && tokens[index + 1]) {
      nextPolicy = withExecutionPolicyOverrides(nextPolicy, { networkAccess: tokens[index + 1] === "on" });
      index += 1;
      continue;
    }
    if (token === "approval" && tokens[index + 1]) {
      const approvalPolicy = tokens[index + 1];
      if (approvalPolicy === "never" || approvalPolicy === "on_request" || approvalPolicy === "untrusted") {
        nextPolicy = withExecutionPolicyOverrides(nextPolicy, { approvalPolicy });
        index += 1;
        continue;
      }
    }
    return { success: false, output: PERMISSIONS_USAGE };
  }
  return { success: true, policy: nextPolicy };
}
