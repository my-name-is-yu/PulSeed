import type { z } from "zod/v3";
import { ToolExecutionTimeoutError, type ToolExecutor } from "../../../tools/executor.js";
import type { ToolCallContext } from "../../../tools/types.js";
import type { AgentLoopTurnContext } from "./agent-loop-turn-context.js";
import type { AgentLoopToolRouter } from "./agent-loop-tool-router.js";
import type {
  FunctionToolCallResponseItem,
  ToolErrorResponseItem,
  ToolObservationResponseItem,
  UnknownToolResponseItem,
} from "./response-item.js";
import { toolResultResponseItem } from "./response-item.js";

export interface ResponseItemToolRouterDeps {
  executor: ToolExecutor;
  toolRouter: AgentLoopToolRouter;
}

type PreparedToolCall =
  | {
      status: "ready";
      item: FunctionToolCallResponseItem;
      arguments: unknown;
      index: number;
    }
  | {
      status: "observation";
      observation: ToolObservationResponseItem;
      index: number;
    };

export class ResponseItemToolRouter {
  constructor(private readonly deps: ResponseItemToolRouterDeps) {}

  async executeBatch(
    calls: FunctionToolCallResponseItem[],
    turn: AgentLoopTurnContext<unknown>,
  ): Promise<ToolObservationResponseItem[]> {
    const prepared = calls.map((item, index) => this.prepare(item, turn, index));
    const observations = new Array<ToolObservationResponseItem>(calls.length);
    const safe: Extract<PreparedToolCall, { status: "ready" }>[] = [];
    const unsafe: Extract<PreparedToolCall, { status: "ready" }>[] = [];

    for (const item of prepared) {
      if (item.status === "observation") {
        observations[item.index] = item.observation;
        continue;
      }
      if (this.deps.toolRouter.supportsParallel(item.item.name, item.arguments)) {
        safe.push(item);
      } else {
        unsafe.push(item);
      }
    }

    const safeResults = await Promise.all(
      safe.map((item) => this.executePrepared(item.item, item.arguments, turn)),
    );
    for (let index = 0; index < safe.length; index++) {
      observations[safe[index].index] = safeResults[index];
    }
    for (const item of unsafe) {
      observations[item.index] = await this.executePrepared(item.item, item.arguments, turn);
    }

    return observations;
  }

  private prepare(
    item: FunctionToolCallResponseItem,
    turn: AgentLoopTurnContext<unknown>,
    index: number,
  ): PreparedToolCall {
    const tool = this.deps.toolRouter.resolveTool(item.name);
    if (!tool) {
      return {
        status: "observation",
        index,
        observation: this.unknownTool(item),
      };
    }

    if (!this.deps.toolRouter.isToolAllowed(item.name, turn)) {
      return {
        status: "observation",
        index,
        observation: this.toolError(item, {
          code: "not_allowed",
          message: `Tool "${item.name}" is not allowed in this turn.`,
          executionReason: "policy_blocked",
        }),
      };
    }

    const parsed = tool.inputSchema.safeParse(item.arguments);
    if (!parsed.success) {
      return {
        status: "observation",
        index,
        observation: this.toolError(item, {
          code: "invalid_arguments",
          message: `Invalid arguments for tool "${item.name}": ${this.formatZodError(parsed.error)}`,
          details: parsed.error.issues.map((issue) => ({
            path: issue.path,
            code: issue.code,
            message: issue.message,
          })),
          executionReason: "tool_error",
        }),
      };
    }

    return {
      status: "ready",
      item,
      arguments: parsed.data,
      index,
    };
  }

  private async executePrepared(
    item: FunctionToolCallResponseItem,
    parsedArguments: unknown,
    turn: AgentLoopTurnContext<unknown>,
  ): Promise<ToolObservationResponseItem> {
    const start = Date.now();
    const context: ToolCallContext = {
      ...turn.toolCallContext,
      ...(turn.taskId ? { taskId: turn.taskId } : {}),
      callId: item.id,
      sessionId: turn.session.sessionId,
      abortSignal: turn.abortSignal,
    };

    try {
      const result = await this.deps.executor.execute(item.name, parsedArguments, context);
      const durationMs = result.durationMs || Date.now() - start;
      if (!result.success) {
        return this.toolError(item, {
          code: "execution_failed",
          message: result.error ?? result.summary,
          result,
          durationMs,
          execution: result.execution ?? { status: "executed" },
        });
      }
      return toolResultResponseItem({
        call: item,
        arguments: parsedArguments,
        result,
        durationMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.toolError(item, {
        code: "execution_failed",
        message,
        durationMs: Date.now() - start,
        execution: this.executionForException(message, turn, err),
      });
    }
  }

  private unknownTool(item: FunctionToolCallResponseItem): UnknownToolResponseItem {
    return {
      type: "unknown_tool",
      callId: item.id,
      toolName: item.name,
      arguments: item.arguments,
      message: `Tool "${item.name}" is not registered.`,
      execution: {
        status: "not_executed",
        reason: "tool_error",
        message: `Tool "${item.name}" is not registered.`,
      },
      durationMs: 0,
    };
  }

  private toolError(
    item: FunctionToolCallResponseItem,
    input: {
      code: ToolErrorResponseItem["error"]["code"];
      message: string;
      details?: unknown;
      result?: ToolErrorResponseItem["result"];
      durationMs?: number;
      execution?: ToolErrorResponseItem["execution"];
      executionReason?: NonNullable<ToolErrorResponseItem["execution"]>["reason"];
    },
  ): ToolErrorResponseItem {
    return {
      type: "tool_error",
      callId: item.id,
      toolName: item.name,
      arguments: item.arguments,
      error: {
        code: input.code,
        message: input.message,
        ...(input.details === undefined ? {} : { details: input.details }),
      },
      ...(input.result ? { result: input.result } : {}),
      execution: input.execution ?? {
        status: "not_executed",
        ...(input.executionReason ? { reason: input.executionReason } : {}),
        message: input.message,
      },
      durationMs: input.durationMs ?? 0,
    };
  }

  private formatZodError(error: z.ZodError): string {
    return error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
  }

  private executionForException(
    message: string,
    turn: AgentLoopTurnContext<unknown>,
    error?: unknown,
  ): ToolErrorResponseItem["execution"] {
    if (turn.abortSignal?.aborted) {
      return {
        status: "executed",
        reason: "interrupted",
        message,
      };
    }
    if (error instanceof ToolExecutionTimeoutError) {
      return {
        status: "executed",
        reason: "timed_out",
        message,
      };
    }
    return {
      status: "not_executed",
      reason: "tool_error",
      message,
    };
  }
}
