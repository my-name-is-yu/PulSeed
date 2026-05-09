import { describe, it, expect, afterEach } from "vitest";
import {
  ProcessSessionListTool,
  ProcessSessionManager,
  ProcessSessionListInputSchema,
  ProcessSessionReadInputSchema,
  ProcessSessionReadTool,
  ProcessSessionStartInputSchema,
  ProcessSessionStartTool,
  ProcessSessionStopInputSchema,
  ProcessSessionStopTool,
  ProcessSessionWriteInputSchema,
  ProcessSessionWriteTool,
  type ProcessSessionSnapshot,
  type ProcessSessionReadOutput,
} from "../ProcessSessionTool.js";
import type { ToolCallContext } from "../../../types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import { toToolDefinition } from "../../../tool-definition-adapter.js";
import { ProcessSessionStateStore } from "../../../../runtime/store/process-session-state-store.js";
import { StrategyDreamStateStore } from "../../../../runtime/store/strategy-dream-state-store.js";

const makeContext = (cwd = process.cwd()): ToolCallContext => ({
  goalId: "goal-1",
  cwd,
  trustBalance: 0,
  preApproved: false,
  approvalFn: async () => false,
});

async function readUntil(
  readTool: ProcessSessionReadTool,
  sessionId: string,
  expected: string,
): Promise<string> {
  let output = "";
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const read = await readTool.call({
      session_id: sessionId,
      waitMs: 100,
      maxChars: 1000,
      consume: true,
    }, makeContext());
    output += (read.data as ProcessSessionReadOutput).output;
    if (output.includes(expected)) return output;
  }
  return output;
}

async function waitForWaitMetadata(
  baseDir: string,
  goalId: string,
  strategyId: string,
  predicate: (metadata: Record<string, unknown>) => boolean = () => true,
): Promise<Record<string, unknown>> {
  const store = new StrategyDreamStateStore(baseDir);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const raw = await store.loadWaitMetadata(goalId, strategyId);
    if (raw && typeof raw === "object") {
      const metadata = raw as Record<string, unknown>;
      if (predicate(metadata)) return metadata;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`wait metadata not linked for ${goalId}/${strategyId}`);
}

describe("ProcessSessionTool", () => {
  const manager = new ProcessSessionManager();
  const startTool = new ProcessSessionStartTool(manager);
  const readTool = new ProcessSessionReadTool(manager);
  const writeTool = new ProcessSessionWriteTool(manager);
  const stopTool = new ProcessSessionStopTool(manager);
  const listTool = new ProcessSessionListTool(manager);

  afterEach(async () => {
    await manager.stopAll();
  });

  describe("inputSchema validation", () => {
    it("rejects unknown fields instead of silently stripping them", () => {
      expect(ProcessSessionStartInputSchema.safeParse({ command: process.execPath, unexpected: true }).success).toBe(false);
      expect(ProcessSessionStartInputSchema.safeParse({ command: process.execPath, artifact_refs: [""] }).success).toBe(false);
      expect(ProcessSessionReadInputSchema.safeParse({ session_id: "session-1", unexpected: true }).success).toBe(false);
      expect(ProcessSessionWriteInputSchema.safeParse({ session_id: "session-1", input: "x", unexpected: true }).success).toBe(false);
      expect(ProcessSessionStopInputSchema.safeParse({ session_id: "session-1", unexpected: true }).success).toBe(false);
      expect(ProcessSessionListInputSchema.safeParse({ includeExited: true, unexpected: true }).success).toBe(false);
    });

    it("keeps runtime validation aligned with the model-facing closed object schema", () => {
      const tools = [startTool, readTool, writeTool, stopTool, listTool];

      for (const tool of tools) {
        const parameters = toToolDefinition(tool).function.parameters as Record<string, unknown>;
        expect(parameters.additionalProperties).toBe(false);
      }
    });
  });

  it("starts, reads, lists, and stops a persistent process", async () => {
    const start = await startTool.call({
      command: process.execPath,
      args: ["-e", "console.log('ready'); setInterval(() => {}, 1000);"],
      label: "test-node",
    }, makeContext());
    expect(start.success).toBe(true);
    const started = start.data as ProcessSessionSnapshot;
    expect(started.session_id).toBeTruthy();
    expect(started.running).toBe(true);

    const output = await readUntil(readTool, started.session_id, "ready");
    expect(output).toContain("ready");

    const list = await listTool.call({ includeExited: false }, makeContext());
    expect((list.data as ProcessSessionSnapshot[]).map((session) => session.session_id)).toContain(started.session_id);

    const stop = await stopTool.call({ session_id: started.session_id, signal: "SIGTERM", waitMs: 500 }, makeContext());
    expect(stop.success).toBe(true);
    expect((stop.data as ProcessSessionSnapshot).running).toBe(false);
  });

  it("writes stdin to a running session", async () => {
    const start = await startTool.call({
      command: process.execPath,
      args: ["-e", "process.stdin.on('data', (chunk) => { console.log('echo:' + chunk.toString().trim()); });"],
    }, makeContext());
    const started = start.data as ProcessSessionSnapshot;

    const write = await writeTool.call({ session_id: started.session_id, input: "hello", appendNewline: true }, makeContext());
    expect(write.success).toBe(true);

    const output = await readUntil(readTool, started.session_id, "echo:hello");
    expect(output).toContain("echo:hello");
  });

  it("uses approval gates for process start/write/stop", async () => {
    await expect(startTool.checkPermissions({
      command: process.execPath,
      args: [],
    })).resolves.toMatchObject({ status: "needs_approval" });
    await expect(writeTool.checkPermissions({
      session_id: "session",
      input: "x",
      appendNewline: true,
    })).resolves.toMatchObject({ status: "needs_approval" });
    await expect(stopTool.checkPermissions({
      session_id: "session",
      signal: "SIGTERM",
      waitMs: 1_000,
    })).resolves.toMatchObject({ status: "needs_approval" });
  });

  it("persists process metadata and links it from wait metadata for restart-time observation", async () => {
    const originalHome = process.env["PULSEED_HOME"];
    const tmpHome = makeTempDir();
    process.env["PULSEED_HOME"] = tmpHome;
    try {
      const start = await startTool.call({
        command: process.execPath,
        args: ["-e", "console.log('done')"],
        label: "durable-session",
        strategy_id: "wait-1",
        task_id: "task-1",
        artifact_refs: [path.join(tmpHome, "artifacts", "train.log")],
      }, makeContext(tmpHome));
      expect(start.success).toBe(true);
      const started = start.data as ProcessSessionSnapshot;
      expect(started.metadataRef).toBe(`control-db://process-sessions/${encodeURIComponent(started.session_id)}`);
      expect(start.artifacts ?? []).not.toContain(started.metadataRef);

      const output = await readUntil(readTool, started.session_id, "done");
      expect(output).toContain("done");

      const metadata = await new ProcessSessionStateStore(tmpHome).loadSnapshot(started.session_id);
      expect(metadata).toMatchObject({
        session_id: started.session_id,
        goal_id: "goal-1",
        strategy_id: "wait-1",
        task_id: "task-1",
        label: "durable-session",
      });

      const waitMetadata = await waitForWaitMetadata(tmpHome, "goal-1", "wait-1") as {
        process_refs: Array<Record<string, unknown>>;
        artifact_refs: Array<Record<string, unknown>>;
      };
      expect(waitMetadata.process_refs).toEqual([
        expect.objectContaining({
          session_id: started.session_id,
          metadata_ref: started.metadataRef,
          task_id: "task-1",
          strategy_id: "wait-1",
        }),
      ]);
      expect(waitMetadata.artifact_refs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "process_artifact",
            path: path.join(tmpHome, "artifacts", "train.log"),
            relative_path: path.join("artifacts", "train.log"),
          }),
        ])
      );
      expect(fs.existsSync(path.join(tmpHome, "runtime", "process-sessions", `${started.session_id}.json`))).toBe(false);
    } finally {
      if (originalHome === undefined) {
        delete process.env["PULSEED_HOME"];
      } else {
        process.env["PULSEED_HOME"] = originalHome;
      }
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("drops malformed persisted wait metadata refs before linking process metadata", async () => {
    const originalHome = process.env["PULSEED_HOME"];
    const tmpHome = makeTempDir();
    process.env["PULSEED_HOME"] = tmpHome;
    try {
      await new StrategyDreamStateStore(tmpHome).saveWaitMetadata(
        "goal-1",
        "wait-1",
        {
          schema_version: 1,
          keep_existing_field: true,
          process_refs: [
            "bad-ref",
            { session_id: "existing-session", metadata_ref: "control-db://process-sessions/existing-session" },
          ],
          artifact_refs: [
            42,
            { kind: "existing_artifact", path: path.join(tmpHome, "artifacts", "existing.log") },
          ],
        },
      );

      const start = await startTool.call({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000);"],
        strategy_id: "wait-1",
        artifact_refs: [path.join(tmpHome, "artifacts", "train.log")],
      }, makeContext(tmpHome));
      expect(start.success).toBe(true);
      const started = start.data as ProcessSessionSnapshot;

      const waitMetadata = await waitForWaitMetadata(tmpHome, "goal-1", "wait-1", (metadata) =>
        Array.isArray(metadata["process_refs"]) &&
        metadata["process_refs"].some((ref) =>
          ref && typeof ref === "object" && (ref as Record<string, unknown>)["session_id"] === started.session_id
        )
      ) as {
        keep_existing_field?: boolean;
        process_refs: unknown[];
        artifact_refs: unknown[];
      };
      expect(waitMetadata.keep_existing_field).toBe(true);
      expect(waitMetadata.process_refs).toEqual([
        { session_id: "existing-session", metadata_ref: "control-db://process-sessions/existing-session" },
        expect.objectContaining({
          session_id: started.session_id,
          metadata_ref: `control-db://process-sessions/${encodeURIComponent(started.session_id)}`,
        }),
      ]);
      expect(waitMetadata.artifact_refs).toEqual(
        expect.arrayContaining([
          { kind: "existing_artifact", path: path.join(tmpHome, "artifacts", "existing.log") },
          expect.objectContaining({
            kind: "process_artifact",
            path: path.join(tmpHome, "artifacts", "train.log"),
          }),
        ])
      );
      expect(waitMetadata.process_refs).not.toContain("bad-ref");
      expect(waitMetadata.artifact_refs).not.toContain(42);
    } finally {
      if (originalHome === undefined) {
        delete process.env["PULSEED_HOME"];
      } else {
        process.env["PULSEED_HOME"] = originalHome;
      }
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
