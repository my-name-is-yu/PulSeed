import { describe, it, expect, afterEach } from "vitest";
import {
  ProcessSessionListTool,
  ProcessSessionManager,
  ProcessSessionReadTool,
  ProcessSessionStartTool,
  ProcessSessionStopTool,
  ProcessSessionWriteTool,
  type ProcessSessionSnapshot,
  type ProcessSessionReadOutput,
} from "../ProcessSessionTool.js";
import type { ToolCallContext } from "../../../types.js";

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
});
