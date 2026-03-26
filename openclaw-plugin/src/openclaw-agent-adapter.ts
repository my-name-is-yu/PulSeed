// ─── OpenClawAgentAdapter ───
// Wraps OpenClaw's Pi Agent as a SeedPulse IAdapter.
// CoreLoop sends tasks by posting messages and polling for new assistant replies.

// Local type definitions — no seedpulse import (independent package)

interface AgentTask {
  prompt: string;
  timeout_ms: number;
  adapter_type: string;
  allowed_tools?: readonly string[];
}

interface AgentResult {
  success: boolean;
  output: string;
  error: string | null;
  exit_code: number | null;
  elapsed_ms: number;
  stopped_reason: "completed" | "timeout" | "error";
  filesChanged?: boolean;
}

interface IAdapter {
  execute(task: AgentTask): Promise<AgentResult>;
  readonly adapterType: string;
  readonly capabilities?: readonly string[];
}

interface OpenClawPluginApi {
  sendMessage(sessionKey: string, message: string): Promise<void>;
  getSessionHistory(sessionKey: string): Promise<Array<{ role: string; content: string }>>;
  createSession?(profile?: string): Promise<{ sessionKey: string }>;
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string, err?: unknown): void };
}

// ─── Adapter ───

export class OpenClawAgentAdapter implements IAdapter {
  readonly adapterType = "openclaw_gateway";
  readonly capabilities = ["execute_code", "read_files", "write_files", "run_commands", "browse_web"] as const;

  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly sessionKey: string,
    private readonly options?: {
      pollIntervalMs?: number;    // default: 2000
      createNewSession?: boolean; // create a fresh session per execute() (parallel use)
    }
  ) {}

  async execute(task: AgentTask): Promise<AgentResult> {
    const startedAt = Date.now();
    try {
      let sessionKey = this.sessionKey;
      if (this.options?.createNewSession && this.api.createSession) {
        const s = await this.api.createSession();
        sessionKey = s.sessionKey;
        this.api.log.info(`OpenClawAgentAdapter: created session ${sessionKey}`);
      }

      const beforeCount = (await this.api.getSessionHistory(sessionKey)).length;

      this.api.log.info(`OpenClawAgentAdapter: sending task to session ${sessionKey}`);
      await this.api.sendMessage(sessionKey, task.prompt);

      const response = await this.waitForResponse(sessionKey, beforeCount, task.timeout_ms, startedAt);
      const elapsed = Date.now() - startedAt;

      if (response === null) {
        this.api.log.warn(`OpenClawAgentAdapter: timeout after ${elapsed}ms`);
        return { success: false, output: "", error: "Timeout waiting for OpenClaw response", exit_code: null, elapsed_ms: elapsed, stopped_reason: "timeout" };
      }

      const hasError = /\b(error|failed|exception|cannot|unable)\b/i.test(response);
      return {
        success: !hasError,
        output: response,
        error: hasError ? "Task execution reported errors" : null,
        exit_code: null,
        elapsed_ms: elapsed,
        stopped_reason: "completed",
      };
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      this.api.log.error("OpenClawAgentAdapter: unexpected error", err);
      return { success: false, output: "", error: message, exit_code: null, elapsed_ms: elapsed, stopped_reason: "error" };
    }
  }

  private async waitForResponse(
    sessionKey: string,
    beforeCount: number,
    timeoutMs: number,
    startedAt: number
  ): Promise<string | null> {
    const pollInterval = this.options?.pollIntervalMs ?? 2000;
    while (Date.now() - startedAt < timeoutMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, pollInterval));
      const history = await this.api.getSessionHistory(sessionKey);
      const newAssistant = history.slice(beforeCount).filter((m) => m.role === "assistant");
      if (newAssistant.length > 0) return newAssistant[newAssistant.length - 1].content;
    }
    return null;
  }
}

// ─── Factory ───

export function createAdapter(api: OpenClawPluginApi, sessionKey: string, parallel?: boolean): OpenClawAgentAdapter {
  return new OpenClawAgentAdapter(api, sessionKey, { createNewSession: parallel });
}
