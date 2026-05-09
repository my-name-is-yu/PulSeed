import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { z } from "zod";
import { getPulseedDirPath } from "../../../base/utils/paths.js";
import { ProcessSessionStateStore } from "../../../runtime/store/process-session-state-store.js";
import { StrategyDreamStateStore } from "../../../runtime/store/strategy-dream-state-store.js";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../../types.js";

const MAX_BUFFER_CHARS = 1_000_000;
const DEFAULT_MAX_READ_CHARS = 12_000;
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const ProcessSessionStartInputSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  label: z.string().min(1).max(120).optional(),
  task_id: z.string().optional(),
  strategy_id: z.string().optional(),
  artifact_refs: z.array(z.string().min(1)).optional(),
}).strict();
export type ProcessSessionStartInput = z.infer<typeof ProcessSessionStartInputSchema>;

export const ProcessSessionReadInputSchema = z.object({
  session_id: z.string().min(1),
  maxChars: z.number().int().min(1).max(100_000).default(DEFAULT_MAX_READ_CHARS),
  waitMs: z.number().int().min(0).max(30_000).default(0),
  consume: z.boolean().default(true),
}).strict();
export type ProcessSessionReadInput = z.infer<typeof ProcessSessionReadInputSchema>;

export const ProcessSessionWriteInputSchema = z.object({
  session_id: z.string().min(1),
  input: z.string(),
  appendNewline: z.boolean().default(true),
}).strict();
export type ProcessSessionWriteInput = z.infer<typeof ProcessSessionWriteInputSchema>;

export const ProcessSessionStopInputSchema = z.object({
  session_id: z.string().min(1),
  signal: z.enum(["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL"]).default("SIGTERM"),
  waitMs: z.number().int().min(0).max(30_000).default(1_000),
}).strict();
export type ProcessSessionStopInput = z.infer<typeof ProcessSessionStopInputSchema>;

export const ProcessSessionListInputSchema = z.object({
  includeExited: z.boolean().default(true),
}).strict();
export type ProcessSessionListInput = z.infer<typeof ProcessSessionListInputSchema>;

export interface ProcessSessionSnapshot {
  session_id: string;
  label?: string;
  command: string;
  args: string[];
  cwd: string;
  goal_id?: string;
  task_id?: string;
  strategy_id?: string;
  pid?: number;
  running: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  exitedAt?: string;
  bufferedChars: number;
  metadataRef?: string;
  metadataPath?: string;
  metadataRelativePath?: string;
  artifactRefs?: string[];
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
  goalId?: string;
  taskId?: string;
  strategyId?: string;
  artifactRefs: string[];
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

  constructor(private readonly baseDir?: string) {}

  start(input: ProcessSessionStartInput, cwd: string, context?: Pick<ToolCallContext, "goalId">): ProcessSessionSnapshot {
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
      goalId: context?.goalId,
      taskId: input.task_id,
      strategyId: input.strategy_id,
      artifactRefs: input.artifact_refs ?? [],
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
      this.persistSnapshot(record);
    });

    this.sessions.set(id, record);
    const snapshot = this.snapshot(record);
    this.persistSnapshot(record);
    void this.linkWaitMetadata(record, snapshot);
    return snapshot;
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
    this.persistSnapshot(record);
    return { ...this.snapshot(record), output, truncated };
  }

  write(input: ProcessSessionWriteInput): ProcessSessionSnapshot | null {
    const record = this.sessions.get(input.session_id);
    if (!record || record.child.killed || record.exitCode !== null) return null;
    record.child.stdin.write(input.appendNewline ? `${input.input}\n` : input.input);
    this.persistSnapshot(record);
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
    this.persistSnapshot(record);
    return this.snapshot(record);
  }

  list(includeExited: boolean): ProcessSessionSnapshot[] {
    return [...this.sessions.values()]
      .filter((record) => includeExited || record.exitCode === null)
      .map((record) => this.snapshot(record));
  }

  linkArtifacts(sessionId: string, artifactRefs: string[]): ProcessSessionSnapshot | null {
    const record = this.sessions.get(sessionId);
    if (!record) return null;
    record.artifactRefs = dedupeStrings([...record.artifactRefs, ...artifactRefs]);
    this.persistSnapshot(record);
    return this.snapshot(record);
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
      goal_id: record.goalId,
      task_id: record.taskId,
      strategy_id: record.strategyId,
      pid: record.child.pid,
      running: record.exitCode === null && !record.child.killed,
      exitCode: record.exitCode,
      signal: record.signal,
      startedAt: record.startedAt.toISOString(),
      exitedAt: record.exitedAt?.toISOString(),
      bufferedChars: record.combined.length,
      metadataRef: this.processSessionStore().metadataRef(record.id),
      artifactRefs: record.artifactRefs,
    };
  }

  private getBaseDir(): string {
    return this.baseDir ?? getPulseedDirPath();
  }

  private processSessionStore(): ProcessSessionStateStore {
    return new ProcessSessionStateStore(this.getBaseDir());
  }

  private persistSnapshot(record: ProcessSessionRecord): void {
    try {
      this.processSessionStore().saveSnapshotSync(this.snapshot(record));
    } catch {
      // Process metadata is best-effort; tool behavior must not depend on the DB projection write.
    }
  }

  private async linkWaitMetadata(record: ProcessSessionRecord, snapshot: ProcessSessionSnapshot): Promise<void> {
    if (!record.goalId || !record.strategyId) return;
    try {
      const store = new StrategyDreamStateStore(this.getBaseDir());
      const existingRaw = await store.loadWaitMetadata(record.goalId, record.strategyId);
      const parsedExisting = JsonObjectSchema.safeParse(existingRaw);
      const existing = parsedExisting.success ? parsedExisting.data : {};
      const processRefs = readJsonObjectArray(existing["process_refs"]);
      const artifactRefs = readJsonObjectArray(existing["artifact_refs"]);
      const processRef = {
        session_id: snapshot.session_id,
        metadata_ref: snapshot.metadataRef,
        command: snapshot.command,
        args: snapshot.args,
        cwd: snapshot.cwd,
        pid: snapshot.pid,
        started_at: snapshot.startedAt,
        task_id: snapshot.task_id ?? null,
        strategy_id: snapshot.strategy_id ?? null,
      };
      await store.saveWaitMetadata(record.goalId, record.strategyId, {
        ...existing,
        schema_version: 1,
        process_refs: dedupeByJson([...processRefs, processRef]),
        artifact_refs: dedupeByJson([
          ...artifactRefs,
          ...record.artifactRefs.map((artifactPath) => ({
            kind: "process_artifact",
            path: artifactPath,
            relative_path: relativePulseedPath(artifactPath),
            session_id: snapshot.session_id,
          })),
        ]),
      });
    } catch {
      // Wait metadata linkage is best-effort; the process session snapshot remains authoritative.
    }
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
      const data = this.manager.start(input, context.cwd, context);
      return {
        success: true,
        data,
        summary: `Started process session ${data.session_id}${data.pid ? ` (pid ${data.pid})` : ""}: ${data.command} ${data.args.join(" ")}`.trim(),
        durationMs: Date.now() - startTime,
        artifacts: data.artifactRefs,
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
      artifacts: data.artifactRefs,
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
      artifacts: data.artifactRefs,
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
      artifacts: data.flatMap((session) => session.artifactRefs ?? []),
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

function readJsonObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = JsonObjectSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function dedupeByJson(items: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const item of items) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function dedupeStrings(items: string[]): string[] {
  return [...new Set(items)];
}

function relativePulseedPath(filePath: string): string | null {
  const base = path.resolve(getPulseedDirPath());
  const resolved = path.resolve(filePath);
  const relativePath = path.relative(base, resolved);
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
  return relativePath;
}
