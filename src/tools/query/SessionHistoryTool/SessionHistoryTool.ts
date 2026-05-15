import { z } from "zod/v3";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS } from "./constants.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import { ExecutionSessionStateStore } from "../../../runtime/store/execution-session-state-store.js";
import type { Session } from "../../../base/types/session.js";

export const SESSION_HISTORY_DEFAULT_LIMIT = 5;
export const SESSION_HISTORY_MAX_LIMIT = 100;

export const SessionHistoryInputSchema = z.object({
  goalId: z.string().optional(),
  limit: z.number().int().min(1).max(SESSION_HISTORY_MAX_LIMIT).default(SESSION_HISTORY_DEFAULT_LIMIT),
  includeObservations: z.boolean().default(true),
}).strict();
export type SessionHistoryInput = z.infer<typeof SessionHistoryInputSchema>;

interface SessionSummary {
  sessionId: string;
  goalId: string;
  strategy?: string;
  taskSummary?: string;
  observations?: unknown;
  outcome?: string;
  timestamp: string;
}

export class SessionHistoryTool implements ITool<SessionHistoryInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "session_history",
    aliases: ["get_session_history", "observe_sessions"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };
  readonly inputSchema = SessionHistoryInputSchema;

  private sessionStore: ExecutionSessionStateStore | null;

  constructor(
    private readonly stateManager: StateManager,
    sessionStore?: ExecutionSessionStateStore,
  ) {
    this.sessionStore = sessionStore ?? null;
  }

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: SessionHistoryInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const sessions = await this._loadSessions(input);
      return {
        success: true,
        data: { sessions },
        summary: `Found ${sessions.length} session(s)`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `SessionHistoryTool failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  private async _loadSessions(input: SessionHistoryInput): Promise<SessionSummary[]> {
    const sessions = await this.getSessionStore().list({
      goalId: input.goalId,
      limit: input.limit,
    });
    return sessions.map((session) => this._toSummary(session, input.includeObservations));
  }

  private getSessionStore(): ExecutionSessionStateStore {
    this.sessionStore ??= new ExecutionSessionStateStore(this.stateManager.getBaseDir());
    return this.sessionStore;
  }

  private _toSummary(session: Session, includeObservations: boolean): SessionSummary {
    const summary: SessionSummary = {
      sessionId: session.id,
      goalId: session.goal_id,
      timestamp: session.started_at,
    };

    if (typeof session.result_summary === "string") {
      summary.taskSummary = session.result_summary;
    }
    if (typeof session.session_type === "string") {
      summary.strategy = session.session_type;
    }
    if (session.ended_at !== null) {
      summary.outcome = "completed";
    }

    if (includeObservations) {
      summary.observations = session.context_slots;
    }

    return summary;
  }

  async checkPermissions(_input: SessionHistoryInput, _context?: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input?: SessionHistoryInput): boolean {
    return true;
  }
}
