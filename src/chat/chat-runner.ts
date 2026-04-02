// ─── ChatRunner ───
//
// Central coordinator for 1-shot chat execution (Tier 1).
// Bypasses TaskLifecycle — calls adapter.execute() directly.

import type { StateManager } from "../state-manager.js";
import type { IAdapter, AgentTask } from "../execution/adapter-layer.js";
import type { ILLMClient } from "../llm/llm-client.js";
import { ChatHistory } from "./chat-history.js";
import { buildChatContext, resolveGitRoot } from "../observation/context-provider.js";

// ─── Types ───

export interface ChatRunnerDeps {
  stateManager: StateManager;
  adapter: IAdapter;
  /** Optional: reserved for future escalation support (Phase 1c). */
  llmClient?: ILLMClient;
}

export interface ChatRunResult {
  success: boolean;
  output: string;
  elapsed_ms: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

// ─── Command help text ───

const COMMAND_HELP = `Available commands:
  /help    Show this help message
  /clear   Clear conversation history
  /exit    Exit chat mode
  /track   Promote session to Tier 2 goal pursuit (not yet implemented)`;

// ─── ChatRunner ───

export class ChatRunner {
  private readonly deps: ChatRunnerDeps;
  private history: ChatHistory | null = null;

  constructor(deps: ChatRunnerDeps) {
    this.deps = deps;
  }

  private handleCommand(input: string): ChatRunResult | null {
    const cmd = input.trim().toLowerCase();
    if (!cmd.startsWith("/")) return null;

    const start = Date.now();

    if (cmd === "/help") {
      return { success: true, output: COMMAND_HELP, elapsed_ms: Date.now() - start };
    }
    if (cmd === "/clear") {
      this.history?.clear();
      return { success: true, output: "Conversation history cleared.", elapsed_ms: Date.now() - start };
    }
    if (cmd === "/exit") {
      return { success: true, output: "Exiting chat mode.", elapsed_ms: Date.now() - start };
    }
    if (cmd === "/track") {
      return { success: false, output: "/track: not yet implemented", elapsed_ms: Date.now() - start };
    }

    return {
      success: false,
      output: `Unknown command: ${input.trim()}. Type /help for available commands.`,
      elapsed_ms: Date.now() - start,
    };
  }

  /**
   * Execute a single chat turn.
   *
   * Flow:
   *  1. Intercept slash commands before adapter dispatch
   *  2. Resolve git root → create ChatHistory
   *  3. Build chat context and assemble prompt
   *  4. Persist user message BEFORE calling adapter (crash-safe)
   *  5. Execute via adapter
   *  6. Persist assistant response (fire-and-forget)
   */
  async execute(input: string, cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ChatRunResult> {
    // Intercept commands before any adapter call
    const commandResult = this.handleCommand(input);
    if (commandResult !== null) {
      return commandResult;
    }

    const gitRoot = resolveGitRoot(cwd);
    const sessionId = crypto.randomUUID();
    this.history = new ChatHistory(this.deps.stateManager, sessionId, gitRoot);

    // Persist-before-execute: user message written to disk first
    await this.history.appendUserMessage(input);

    const context = buildChatContext(input, gitRoot);
    const prompt = context ? `${context}\n\n${input}` : input;

    const task: AgentTask = {
      prompt,
      timeout_ms: timeoutMs,
      adapter_type: this.deps.adapter.adapterType,
      cwd,
    };

    const start = Date.now();
    const result = await this.deps.adapter.execute(task);
    const elapsed_ms = Date.now() - start;

    // Fire-and-forget: persist assistant response after completion
    this.history.appendAssistantMessage(result.output);

    return {
      success: result.success,
      output: result.output,
      elapsed_ms,
    };
  }
}
