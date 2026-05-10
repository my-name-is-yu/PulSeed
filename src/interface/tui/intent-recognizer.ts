import { z } from "zod";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import { getInternalIdentityPrefix } from "../../base/config/identity-loader.js";
import {
  parseExactSlashCommand,
  parseExactSlashCommandToken,
  type ExactSlashCommandDefinition,
} from "../../base/protocol/exact-protocol.js";

// ─── Types ───

export type IntentType =
  | "loop_start"
  | "loop_stop"
  | "status"
  | "report"
  | "goal_list"
  | "goal_create"
  | "help"
  | "dashboard"
  | "chat"
  | "unknown";

export interface RecognizedIntent {
  intent: IntentType;
  params?: Record<string, string>; // e.g., { description: "write a README" }
  response?: string; // conversational response text for "chat" intent
  raw: string; // original user input
  source?: "command" | "classifier" | "unavailable";
  confidence?: number;
}

// ─── Exact command grammar ───

const COMMAND_DEFINITIONS: readonly ExactSlashCommandDefinition<IntentType>[] = [
  { command: "help", aliases: ["/?", "/help"] },
  { command: "loop_stop", aliases: ["/stop", "/quit", "/exit"] },
  { command: "loop_start", aliases: ["/run", "/start"], allowArguments: true },
  {
    command: "status",
    aliases: [
      "/status",
      "/status details",
      "/status --details",
      "/status diagnostic",
      "/status --diagnostic",
    ],
  },
  {
    command: "report",
    aliases: [
      "/report",
      "/report details",
      "/report --details",
      "/report diagnostic",
      "/report --diagnostic",
    ],
  },
  {
    command: "goal_list",
    aliases: [
      "/goals",
      "/goal",
      "/goals list",
      "/goal list",
      "/goals details",
      "/goals --details",
      "/goal details",
      "/goal --details",
      "/goals diagnostic",
      "/goals --diagnostic",
      "/goal diagnostic",
      "/goal --diagnostic",
    ],
  },
  { command: "dashboard", aliases: ["/dashboard", "/d"] },
];

const DIAGNOSTIC_DETAIL_ALIASES = new Set([
  "/status details",
  "/status --details",
  "/status diagnostic",
  "/status --diagnostic",
  "/report details",
  "/report --details",
  "/report diagnostic",
  "/report --diagnostic",
  "/goals details",
  "/goals --details",
  "/goal details",
  "/goal --details",
  "/goals diagnostic",
  "/goals --diagnostic",
  "/goal diagnostic",
  "/goal --diagnostic",
]);

// ─── LLM response schema ───

const LLMIntentSchema = z.object({
  intent: z.enum([
    "loop_start",
    "loop_stop",
    "goal_create",
    "chat",
    "unknown",
  ]),
  confidence: z.number().min(0).max(1),
  response: z.string().optional(),
  params: z.object({
    description: z.string().optional(),
    goalId: z.string().optional(),
  }).optional(),
});

const MIN_CLASSIFIER_CONFIDENCE = 0.7;

function getSystemPrompt(): string {
  return `${getInternalIdentityPrefix("assistant")} PulSeed is a lifelong personal agent that manages goals with measurable dimensions.

Available actions you can trigger:
- goal_create: When the user clearly wants to create a new goal. Extract the description.
- loop_start: When the user wants to start executing a goal.
- loop_stop: When the user wants to stop execution.

For any other input, respond conversationally. Explain PulSeed's state, answer questions, or suggest what to do. If the user's intent is ambiguous or too low-confidence to act on, return unknown.

Respond in JSON: { "intent": "chat" | "goal_create" | "loop_start" | "loop_stop" | "unknown", "confidence": 0.0-1.0, "response": "your response text", "params": { "description": "..." } }`;
}

// ─── IntentRecognizer ───

/**
 * TUI intent recognizer.
 *
 * Exact slash/symbol commands are parsed as command grammar. Freeform
 * natural-language input is classified through the structured LLM contract.
 */
export class IntentRecognizer {
  constructor(private llmClient?: ILLMClient) {}

  async recognize(input: string): Promise<RecognizedIntent> {
    const commandResult = this.parseExactCommand(input);
    if (commandResult) return commandResult;

    if (parseExactSlashCommandToken(input)) {
      return { intent: "unknown", raw: input, source: "command", confidence: 1 };
    }

    if (this.llmClient) return this.classifyNaturalLanguage(input);

    return { intent: "unknown", raw: input, source: "unavailable" };
  }

  private parseExactCommand(input: string): RecognizedIntent | null {
    const parsed = parseExactSlashCommand(input, COMMAND_DEFINITIONS, {
      bareSymbolCommands: { "?": "help" },
    });
    if (!parsed) return null;

    if (parsed.command === "loop_start") {
      const goalArg = parsed.rawArgs;
      return {
        intent: parsed.command,
        params: goalArg ? { goalArg } : undefined,
        raw: input,
        source: "command",
        confidence: 1,
      };
    }

    const params = DIAGNOSTIC_DETAIL_ALIASES.has(parsed.alias)
      ? { detail: "diagnostic" }
      : undefined;

    return {
      intent: parsed.command,
      params,
      raw: input,
      source: "command",
      confidence: 1,
    };
  }

  private async classifyNaturalLanguage(input: string): Promise<RecognizedIntent> {
    const llmClient = this.llmClient;
    if (!llmClient) return { intent: "unknown", raw: input, source: "unavailable" };
    try {
      const llmResponse = await llmClient.sendMessage(
        [{ role: "user", content: input }],
        { system: getSystemPrompt(), max_tokens: 512, temperature: 0 }
      );

      const parsed = llmClient.parseJSON(llmResponse.content, LLMIntentSchema);

      if (parsed.intent === "unknown" || parsed.confidence < MIN_CLASSIFIER_CONFIDENCE) {
        return {
          intent: "unknown",
          raw: input,
          source: "classifier",
          confidence: parsed.confidence,
          response: parsed.response,
        };
      }

      const params: Record<string, string> = {};
      if (parsed.params?.description) params["description"] = parsed.params.description;
      if (parsed.params?.goalId) params["goalId"] = parsed.params.goalId;
      if (parsed.response) params["response"] = parsed.response;

      return {
        intent: parsed.intent,
        params: Object.keys(params).length > 0 ? params : undefined,
        response: parsed.response,
        raw: input,
        source: "classifier",
        confidence: parsed.confidence,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[IntentRecognizer] natural-language classifier failed: ${msg}`);
      return { intent: "unknown", raw: input, source: "unavailable" };
    }
  }
}
