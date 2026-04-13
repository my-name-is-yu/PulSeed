import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../../types.js";

const MAX_BUFFER_CHARS = 1_000_000;
const DEFAULT_MAX_READ_CHARS = 12_000;

export const ProcessSessionStartInputSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  label: z.string().min(1).max(120).optional(),
});
export type ProcessSessionStartInput = z.infer<typeof ProcessSessionStartInputSchema>;

export const ProcessSessionReadInputSchema = z.object({
  session_id: z.string().min(1),
  maxChars: z.number().int().min(1).max(100_000).default(DEFAULT_MAX_READ_CHARS),
  waitMs: z.number().int().min(0).max(30_000).default(0),
  consume: z.boolean().default(true),
});
export type ProcessSessionReadInput = z.infer<typeof ProcessSessionReadInputSchema>;

export const ProcessSessionWriteInputSchema = z.object({
  session_id: z.string().min(1),
  input: z.string(),
  appendNewline: z.boolean().default(true),
});
export type ProcessSessionWriteInput = z.infer<typeof ProcessSessionWriteInputSchema>;

export const ProcessSessionStopInputSchema = z.object({
  session_id: z.string().min(1),
  signal: z.enum(["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL"]).default("SIGTERM"),
  waitMs: z.number().int().min(0).max(30_000).default(1_000),
});
export type ProcessSessionStopInput = z.infer<typeof ProcessSessionStopInputSchema>;

export const ProcessSessionListInputSchema = z.object({
  includeExited: z.boolean().default(true),
});
export type ProcessSessionListInput = z.infer<typeof ProcessSessionListInputSchema>;

export interface ProcessSessionSnapshot {
  session_id: string;
  label?: string;
  command: string;
  args: string[];
  cwd: string;
  pid?: number;
  running: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  exitedAt?: string;
  bufferedChars: number;
}

export interface ProcessSessionReadOutput extends ProcessSessionSnapshot {
  output: string;
  truncated: boolean;
}

interface ProcessSessionRecord {
  id: string;
  label?: string;
  command: string;
  args: string[];
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  startedAt: Date;
  exitedAt?: Date;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  combined: string;
  readOffset: number;
}

export class ProcessSessionManager {
  private readonly sessions = new Map<string, ProcessSessionRecord>();

  start(input: ProcessSessionStartInput, cwd: string): ProcessSessionSnapshot {
    const id = randomUUID();
    const resolvedCwd = input.cwd ?? cwd;
    const child = spawn(input.command, input.args, {
      cwd: resolvedCwd,
      env: input.env ? { ...process.env, ...input.env } : process.env,
      stdio: "pipe",
    });
    const record: ProcessSessionRecord = {
      id,
      label: input.label,
      command: input.command,
      args: input.args,
      cwd: resolvedCwd,
      child,
      startedAt: new Date(),
      exitCode: null,
      signal: null,
      combined: "",
      readOffset: 0,
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.append(record, String(chunk)));
    child.stderr.on("data", (chunk) => this.append(record, String(chunk)));
    child.on("error", (err) => {
      this.append(record, `[process error] ${err.message}\n`);
    });
    child.on("exit", (code, signal) => {
      record.exitCode = code;
      record.signal = signal;
      record.exitedAt = new Date();
      this.append(record, `[process exited code=${code ?? "null"} signal=${signal ?? "null"}]\n`);
    });

    this.sessions.set(id, record);
    return this.snapshot(record);
  }

  async read(input: ProcessSessionReadInput): Promise<ProcessSessionReadOutput | null> {
    const record = this.sessions.get(input.session_id);
    if (!record) return null;
    if (input.waitMs > 0) {
      await delay(input.waitMs);
    }
    const unread = record.combined.slice(record.readOffset);
    const truncated = unread.length > input.maxChars;
    const output = truncated ? unread.slice(0, input.maxChars) : unread;
    if (input.consume) {
      record.readOffset += output.length;
    }
    return { ...this.snapshot(record), output, truncated };
  }

  write(input: ProcessSessionWriteInput): ProcessSessionSnapshot | null {
    const record = this.sessions.get(input.session_id);
    if (!record || record.child.killed || record.exitCode !== null) return null;
    record.child.stdin.write(input.appendNewline ? `${input.input}\n` : input.input);
    return this.snapshot(record);
  }

  async stop(input: ProcessSessionStopInput): Promise<ProcessSessionSnapshot | null> {
    const record = this.sessions.get(input.session_id);
    if (!record) return null;
    if (record.exitCode === null && !record.child.killed) {
      record.child.kill(input.signal);
      if (input.waitMs > 0) {
        await Promise.race([
          onceExit(record),
          delay(input.waitMs),
        ]);
      }
    }
    return this.snapshot(record);
  }

  list(includeExited: boolean): ProcessSessionSnapshot[] {
    return [...this.sessions.values()]
      .filter((record) => includeExited || record.exitCode === null)
      .map((record) => this.snapshot(record));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(async (record) => {
      if (record.exitCode === null && !record.child.killed) {
        record.child.kill("SIGTERM");
        await Promise.race([onceExit(record), delay(500)]);
      }
    }));
  }

  private append(record: ProcessSessionRecord, chunk: string): void {
    record.combined += chunk;
    if (record.combined.length <= MAX_BUFFER_CHARS) return;
    const overflow = record.combined.length - MAX_BUFFER_CHARS;
    record.combined = record.combined.slice(overflow);
    record.readOffset = Math.max(0, record.readOffset - overflow);
  }

  private snapshot(record: ProcessSessionRecord): ProcessSessionSnapshot {
    return {
      session_id: record.id,
      label: record.label,
      command: record.command,
      args: record.args,
      cwd: record.cwd,
      pid: record.child.pid,
      running: record.exitCode === null && !record.child.killed,
      exitCode: record.exitCode,
      signal: record.signal,
      startedAt: record.startedAt.toISOString(),
      exitedAt: record.exitedAt?.toISOString(),
      bufferedChars: record.combined.length,
    };
  }
}

export const defaultProcessSessionManager = new ProcessSessionManager();

abstract class ProcessSessionBaseTool<TInput, TOutput> implements ITool<TInput, TOutput> {
  abstract readonly metadata: ToolMetadata;
  abstract readonly inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;

  constructor(protected readonly manager: ProcessSessionManager = defaultProcessSessionManager) {}

  abstract description(): string;
  abstract call(input: TInput, context: ToolCallContext): Promise<ToolResult>;
  abstract checkPermissions(input: TInput, context: ToolCallContext): Promise<PermissionCheckResult>;
  abstract isConcurrencySafe(input: TInput): boolean;
}

export class ProcessSessionStartTool extends ProcessSessionBaseTool<ProcessSessionStartInput, ProcessSessionSnapshot> {
  readonly metadata: ToolMetadata = {
    name: "process_session_start",
    aliases: ["start_process_session", "start_session_process"],
    permissionLevel: "execute",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 2,
    maxOutputChars: DEFAULT_MAX_READ_CHARS,
    tags: ["process", "session", "agentloop", "dev-server"],
  };
  readonly inputSchema = ProcessSessionStartInputSchema;

  description(): string {
    return "Start a persistent process session without a shell. Use for dev servers, watchers, and REPL-like commands.";
  }

  async call(input: ProcessSessionStartInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const data = this.manager.start(input, context.cwd);
      return {
        success: true,
        data,
        summary: `Started process session ${data.session_id}${data.pid ? ` (pid ${data.pid})` : ""}: ${data.command} ${data.args.join(" ")}`.trim(),
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return failureResult(`Failed to start process session: ${(err as Error).message}`, startTime);
    }
  }

  async checkPermissions(_input: ProcessSessionStartInput): Promise<PermissionCheckResult> {
    return { status: "needs_approval", reason: "Starting a persistent process can execute arbitrary local code." };
  }

  isConcurrencySafe(_input: ProcessSessionStartInput): boolean {
    return false;
  }
}

export class ProcessSessionReadTool extends ProcessSessionBaseTool<ProcessSessionReadInput, ProcessSessionReadOutput> {
  readonly metadata: ToolMetadata = {
    name: "process_session_read",
    aliases: ["read_process_session"],
    permissionLevel: "read_metrics",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 5,
    maxOutputChars: DEFAULT_MAX_READ_CHARS,
    tags: ["process", "session", "agentloop", "dev-server"],
  };
  readonly inputSchema = ProcessSessionReadInputSchema;

  description(): string {
    return "Read buffered output from a persistent process session.";
  }

  async call(input: ProcessSessionReadInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const data = await this.manager.read(input);
    if (!data) {
      return failureResult(`Process session not found: ${input.session_id}`, startTime);
    }
    return {
      success: true,
      data,
      summary: `Read ${data.output.length} chars from process session ${input.session_id}${data.truncated ? " (truncated)" : ""}`,
      durationMs: Date.now() - startTime,
    };
  }

  async checkPermissions(_input: ProcessSessionReadInput): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: ProcessSessionReadInput): boolean {
    return true;
  }
}

export class ProcessSessionWriteTool extends ProcessSessionBaseTool<ProcessSessionWriteInput, ProcessSessionSnapshot> {
  readonly metadata: ToolMetadata = {
    name: "process_session_write",
    aliases: ["write_process_session"],
    permissionLevel: "execute",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: DEFAULT_MAX_READ_CHARS,
    tags: ["process", "session", "agentloop", "dev-server"],
  };
  readonly inputSchema = ProcessSessionWriteInputSchema;

  description(): string {
    return "Write stdin to a running persistent process session.";
  }

  async call(input: ProcessSessionWriteInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const data = this.manager.write(input);
    if (!data) {
      return failureResult(`Process session not found or not running: ${input.session_id}`, startTime);
    }
    return {
      success: true,
      data,
      summary: `Wrote stdin to process session ${input.session_id}`,
      durationMs: Date.now() - startTime,
    };
  }

  async checkPermissions(_input: ProcessSessionWriteInput): Promise<PermissionCheckResult> {
    return { status: "needs_approval", reason: "Writing stdin to a process can trigger local side effects." };
  }

  isConcurrencySafe(_input: ProcessSessionWriteInput): boolean {
    return false;
  }
}

export class ProcessSessionStopTool extends ProcessSessionBaseTool<ProcessSessionStopInput, ProcessSessionSnapshot> {
  readonly metadata: ToolMetadata = {
    name: "process_session_stop",
    aliases: ["stop_process_session"],
    permissionLevel: "execute",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: DEFAULT_MAX_READ_CHARS,
    tags: ["process", "session", "agentloop", "dev-server"],
  };
  readonly inputSchema = ProcessSessionStopInputSchema;

  description(): string {
    return "Stop a persistent process session.";
  }

  async call(input: ProcessSessionStopInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const data = await this.manager.stop(input);
    if (!data) {
      return failureResult(`Process session not found: ${input.session_id}`, startTime);
    }
    return {
      success: true,
      data,
      summary: `Stopped process session ${input.session_id}`,
      durationMs: Date.now() - startTime,
    };
  }

  async checkPermissions(_input: ProcessSessionStopInput): Promise<PermissionCheckResult> {
    return { status: "needs_approval", reason: "Stopping a process changes local runtime state." };
  }

  isConcurrencySafe(_input: ProcessSessionStopInput): boolean {
    return false;
  }
}

export class ProcessSessionListTool extends ProcessSessionBaseTool<ProcessSessionListInput, ProcessSessionSnapshot[]> {
  readonly metadata: ToolMetadata = {
    name: "process_session_list",
    aliases: ["list_process_sessions"],
    permissionLevel: "read_metrics",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 5,
    maxOutputChars: DEFAULT_MAX_READ_CHARS,
    tags: ["process", "session", "agentloop", "dev-server"],
  };
  readonly inputSchema = ProcessSessionListInputSchema;

  description(): string {
    return "List persistent process sessions started by this PulSeed process.";
  }

  async call(input: ProcessSessionListInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const data = this.manager.list(input.includeExited);
    return {
      success: true,
      data,
      summary: `Found ${data.length} process session(s)`,
      durationMs: Date.now() - startTime,
    };
  }

  async checkPermissions(_input: ProcessSessionListInput): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: ProcessSessionListInput): boolean {
    return true;
  }
}

function onceExit(record: ProcessSessionRecord): Promise<void> {
  if (record.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => record.child.once("exit", () => resolve()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failureResult(message: string, startTime: number): ToolResult {
  return {
    success: false,
    data: null,
    summary: message,
    error: message,
    durationMs: Date.now() - startTime,
  };
}
