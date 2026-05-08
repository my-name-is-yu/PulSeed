import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { z } from "zod";
import { RuntimeJournal } from "./runtime-journal.js";
import {
  RuntimeControlOperationSchema,
  isTerminalRuntimeControlState,
  type RuntimeControlOperation,
} from "./runtime-operation-schemas.js";
import { RuntimeEventSchema, type RuntimeEvent, type RuntimeItem } from "../types/companion-state.js";
import {
  runtimeEventFromOperationTransition,
  runtimeItemFromOperation,
} from "./runtime-operation-companion.js";
import { createRuntimeStorePaths, type RuntimeStorePaths } from "./runtime-paths.js";

const RuntimeEventJournalSchema = RuntimeEventSchema as z.ZodType<RuntimeEvent>;

export class RuntimeOperationStore {
  private readonly rootDir: string;
  private readonly pendingDir: string;
  private readonly completedDir: string;
  private readonly eventsDir: string;
  private readonly journal: RuntimeJournal;

  constructor(runtimeRootOrPaths?: string | RuntimeStorePaths) {
    const paths = typeof runtimeRootOrPaths === "string"
      ? createRuntimeStorePaths(runtimeRootOrPaths)
      : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.rootDir = path.join(paths.rootDir, "operations");
    this.pendingDir = path.join(this.rootDir, "pending");
    this.completedDir = path.join(this.rootDir, "completed");
    this.eventsDir = path.join(this.rootDir, "events");
    this.journal = new RuntimeJournal(paths);
  }

  async ensureReady(): Promise<void> {
    await this.journal.ensureReady();
    await Promise.all([
      fsp.mkdir(this.rootDir, { recursive: true }),
      fsp.mkdir(this.pendingDir, { recursive: true }),
      fsp.mkdir(this.completedDir, { recursive: true }),
      fsp.mkdir(this.eventsDir, { recursive: true }),
    ]);
  }

  async load(operationId: string): Promise<RuntimeControlOperation | null> {
    return (
      await this.journal.load(this.pendingPath(operationId), RuntimeControlOperationSchema)
    ) ?? (
      await this.journal.load(this.completedPath(operationId), RuntimeControlOperationSchema)
    );
  }

  async listPending(): Promise<RuntimeControlOperation[]> {
    return this.journal.list(this.pendingDir, RuntimeControlOperationSchema);
  }

  async listCompleted(): Promise<RuntimeControlOperation[]> {
    return this.journal.list(this.completedDir, RuntimeControlOperationSchema);
  }

  async listRuntimeItems(): Promise<RuntimeItem[]> {
    return [...await this.listPending(), ...await this.listCompleted()]
      .map(runtimeItemFromOperation);
  }

  async listRuntimeEvents(): Promise<RuntimeEvent[]> {
    return (await this.journal.list(this.eventsDir, RuntimeEventJournalSchema))
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  }

  async save(operation: RuntimeControlOperation): Promise<RuntimeControlOperation> {
    await this.ensureReady();
    const parsed = RuntimeControlOperationSchema.parse(operation);
    const previous = await this.load(parsed.operation_id);
    const targetPath = isTerminalRuntimeControlState(parsed.state)
      ? this.completedPath(parsed.operation_id)
      : this.pendingPath(parsed.operation_id);
    const stalePath = isTerminalRuntimeControlState(parsed.state)
      ? this.pendingPath(parsed.operation_id)
      : this.completedPath(parsed.operation_id);
    await this.journal.save(targetPath, RuntimeControlOperationSchema, parsed);
    await this.journal.remove(stalePath);
    await this.appendRuntimeEventForSave(parsed, previous);
    return parsed;
  }

  private async appendRuntimeEventForSave(
    operation: RuntimeControlOperation,
    previous: RuntimeControlOperation | null,
  ): Promise<void> {
    const event = runtimeEventFromOperationTransition(operation, previous);
    if (!event) return;
    await this.journal.save(this.eventPath(event.event_id), RuntimeEventJournalSchema, event);
  }

  private pendingPath(operationId: string): string {
    return path.join(this.pendingDir, `${encodeURIComponent(operationId)}.json`);
  }

  private completedPath(operationId: string): string {
    return path.join(this.completedDir, `${encodeURIComponent(operationId)}.json`);
  }

  private eventPath(eventId: string): string {
    return path.join(this.eventsDir, `${encodeURIComponent(eventId)}.json`);
  }
}
