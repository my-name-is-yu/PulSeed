import type * as http from "node:http";
import { z } from "zod";
import { createEnvelope, type Envelope } from "../types/envelope.js";
import type { SlackChannelAdapter } from "../gateway/slack-channel-adapter.js";
import { RuntimeControlOperationKindSchema } from "../store/index.js";
import { isPayloadTooLargeError, readBody, writeJson, writeJsonError } from "./server-http.js";

const BackgroundRunMetadataSchema = z.object({
  backgroundRunId: z.string().min(1),
  parentSessionId: z.string().min(1).nullable().optional(),
  notifyPolicy: z.string().min(1).optional(),
  replyTargetSource: z.string().min(1).optional(),
  pinnedReplyTarget: z.record(z.unknown()).nullable().optional(),
}).passthrough();

const GoalStartRequestSchema = z.object({
  backgroundRun: BackgroundRunMetadataSchema.optional(),
}).passthrough();

const ApprovalResponseRequestSchema = z.object({
  requestId: z.string().min(1),
  approved: z.boolean(),
}).passthrough();

const ChatMessageRequestSchema = z.object({
  message: z.string().min(1),
}).passthrough();

const RuntimeControlRequestSchema = z.object({
  operationId: z.string().min(1),
  kind: RuntimeControlOperationKindSchema,
  reason: z.string().default(""),
}).passthrough();

const ScheduleRunNowRequestSchema = z.object({
  allowEscalation: z.boolean().default(false),
}).passthrough();

export class EventServerCommandHandler {
  constructor(
    private readonly broadcast: (eventType: string, data: unknown) => Promise<void>,
    private readonly getCommandEnvelopeHook: () => ((envelope: Envelope) => void | Promise<void>) | undefined,
    private readonly canResolveApproval: (requestId: string) => Promise<boolean>,
    private readonly resolveApproval: (requestId: string, approved: boolean) => Promise<boolean>,
    private readonly getSlackChannelAdapter: () => SlackChannelAdapter | undefined
  ) {}

  async handleGoalAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    goalId: string,
    action: string
  ): Promise<void> {
    if (action === "start") {
      try {
        const body = await readBody(req);
        const parsed = GoalStartRequestSchema.parse(parseJsonObjectBody(body));
        const backgroundRun = parsed.backgroundRun;
        await this.dispatchCommandEnvelope({
          name: "goal_start",
          goalId,
          payload: {
            goalId,
            ...(backgroundRun ? { backgroundRun } : {}),
          },
        });
        await this.broadcast("goal_start_requested", {
          goalId,
          ...(backgroundRun?.backgroundRunId ? { backgroundRunId: backgroundRun.backgroundRunId } : {}),
        });
        writeJson(res, 200, {
          ok: true,
          goalId,
          ...(backgroundRun?.backgroundRunId ? { backgroundRunId: backgroundRun.backgroundRunId } : {}),
        });
      } catch (err) {
        if (isPayloadTooLargeError(err)) {
          writeJsonError(res, 413, "Payload too large");
          return;
        }
        if (isCommandBodyValidationError(err)) {
          writeJsonError(res, 400, "Invalid goal start request", err);
          return;
        }
        writeJsonError(res, 500, "Command accept failed", err);
      }
      return;
    }

    if (action === "stop") {
      try {
        await this.dispatchCommandEnvelope({
          name: "goal_stop",
          goalId,
          payload: { goalId },
        });
        await this.broadcast("goal_stop_requested", { goalId });
        writeJson(res, 200, { ok: true, goalId });
      } catch (err) {
        writeJsonError(res, 500, "Command accept failed", err);
      }
      return;
    }

    if (action === "pause") {
      try {
        await this.dispatchCommandEnvelope({
          name: "goal_pause",
          goalId,
          dedupeKey: `goal_pause:${goalId}`,
          payload: { goalId },
        });
        await this.broadcast("goal_pause_requested", { goalId });
        writeJson(res, 200, { ok: true, goalId });
      } catch (err) {
        writeJsonError(res, 500, "Command accept failed", err);
      }
      return;
    }

    if (action === "resume") {
      try {
        await this.dispatchCommandEnvelope({
          name: "goal_resume",
          goalId,
          dedupeKey: `goal_resume:${goalId}`,
          payload: { goalId },
        });
        await this.broadcast("goal_resume_requested", { goalId });
        writeJson(res, 200, { ok: true, goalId });
      } catch (err) {
        writeJsonError(res, 500, "Command accept failed", err);
      }
      return;
    }

    if (action === "approve") {
      try {
        const body = await readBody(req);
        const { requestId, approved } = ApprovalResponseRequestSchema.parse(parseJsonObjectBody(body));
        if (!(await this.canResolveApproval(requestId))) {
          writeJson(res, 404, { ok: false });
          return;
        }
        await this.dispatchCommandEnvelope({
          name: "approval_response",
          goalId,
          priority: "high",
          dedupeKey: `approval_response:${requestId}`,
          payload: { goalId, requestId, approved },
      });
        const resolved = await this.resolveApproval(requestId, approved);
        writeJson(res, resolved ? 200 : 404, { ok: resolved });
      } catch (err) {
        if (isPayloadTooLargeError(err)) {
          writeJsonError(res, 413, "Payload too large");
          return;
        }
        writeJsonError(res, 400, "Invalid approval response", err);
      }
      return;
    }

    if (action === "chat") {
      try {
        const body = await readBody(req);
        const { message } = ChatMessageRequestSchema.parse(parseJsonObjectBody(body));
        await this.dispatchCommandEnvelope({
          name: "chat_message",
          goalId,
          payload: { goalId, message },
        });
        await this.broadcast("chat_message_received", { goalId, message });
        writeJson(res, 200, { ok: true });
      } catch (err) {
        if (isPayloadTooLargeError(err)) {
          writeJsonError(res, 413, "Payload too large");
          return;
        }
        writeJsonError(res, 400, "Invalid chat message", err);
      }
      return;
    }

    writeJsonError(res, 404, "Not found");
  }

  async handlePostDaemonRuntimeControl(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    try {
      const body = await readBody(req);
      const { operationId, kind, reason } = RuntimeControlRequestSchema.parse(parseJsonObjectBody(body));

      await this.dispatchCommandEnvelope({
        name: "runtime_control",
        priority: "critical",
        dedupeKey: `runtime_control:${operationId}`,
        payload: { operationId, kind, reason },
      });
      await this.broadcast("runtime_control_requested", { operationId, kind });
      writeJson(res, 200, { ok: true, operationId });
    } catch (err) {
      if (isPayloadTooLargeError(err)) {
        writeJson(res, 413, { ok: false, error: "Payload too large" });
        return;
      }
      writeJson(res, 400, { ok: false, error: "Invalid runtime control request", details: String(err) });
    }
  }

  async handlePostScheduleRunNow(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawScheduleId: string
  ): Promise<void> {
    const scheduleId = decodeURIComponent(rawScheduleId).trim();
    if (!scheduleId) {
      writeJson(res, 400, { ok: false, error: "scheduleId is required" });
      return;
    }

    try {
      const body = await readBody(req);
      const { allowEscalation } = ScheduleRunNowRequestSchema.parse(parseJsonObjectBody(body));
      await this.dispatchCommandEnvelope({
        name: "schedule_run_now",
        priority: "high",
        payload: { scheduleId, allowEscalation },
      });
      await this.broadcast("schedule_run_requested", { scheduleId, allowEscalation });
      writeJson(res, 200, { ok: true, scheduleId });
    } catch (err) {
      if (isPayloadTooLargeError(err)) {
        writeJson(res, 413, { ok: false, error: "Payload too large" });
        return;
      }
      writeJson(res, 400, { ok: false, error: "Invalid schedule run request", details: String(err) });
    }
  }

  async handlePostSlackEvents(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const slackChannelAdapter = this.getSlackChannelAdapter();
    if (!slackChannelAdapter) {
      writeJson(res, 404, { ok: false, error: "Slack adapter is not configured" });
      return;
    }

    try {
      const body = await readBody(req);
      const headers = Object.fromEntries(
        Object.entries(req.headers)
          .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
          .map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(",") : value])
      );
      const response = slackChannelAdapter.handleRequest(body, headers);
      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(response.body);
    } catch (err) {
      if (isPayloadTooLargeError(err)) {
        writeJson(res, 413, { ok: false, error: "Payload too large" });
        return;
      }
      writeJson(res, 400, { ok: false, error: "Invalid Slack event request", details: String(err) });
    }
  }

  private async dispatchCommandEnvelope(input: {
    name: string;
    goalId?: string;
    payload: Record<string, unknown>;
    priority?: Envelope["priority"];
    dedupeKey?: string;
  }): Promise<void> {
    const commandEnvelopeHook = this.getCommandEnvelopeHook();
    if (!commandEnvelopeHook) return;
    await commandEnvelopeHook(
      createEnvelope({
        type: "command",
        name: input.name,
        source: "http",
        goal_id: input.goalId,
        priority: input.priority,
        dedupe_key: input.dedupeKey,
        payload: input.payload,
      })
    );
  }
}

function parseJsonObjectBody(body: string): unknown {
  return body.trim() ? JSON.parse(body) : {};
}

function isCommandBodyValidationError(error: unknown): boolean {
  return error instanceof SyntaxError || error instanceof z.ZodError;
}
