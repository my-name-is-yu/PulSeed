import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { z } from "zod";
import type * as NodeFs from "node:fs";
import type * as NodeFsPromises from "node:fs/promises";

// ─── Mock child_process.spawn and fs ───
//
// vi.mock() is hoisted by vitest, so variables used inside factory functions
// must be declared via vi.hoisted().

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

// Track temp file contents for read simulation
const { mockTmpContents } = vi.hoisted(() => ({
  mockTmpContents: { value: "" },
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    mkdtempSync: vi.fn((_prefix: string) => "/tmp/pulseed-codex-test123"),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  return {
    ...actual,
    mkdtemp: vi.fn((_prefix: string) => Promise.resolve("/tmp/pulseed-codex-test123")),
    readFile: vi.fn((_path: string, _encoding: string) => Promise.resolve(mockTmpContents.value)),
    open: vi.fn(async () => {
      const bytes = Buffer.from(mockTmpContents.value, "utf-8");
      let position = 0;
      return {
        read: vi.fn(async (buffer: Buffer, offset: number, length: number) => {
          const chunk = bytes.subarray(position, position + length);
          chunk.copy(buffer, offset);
          position += chunk.length;
          return { bytesRead: chunk.length, buffer };
        }),
        close: vi.fn(() => Promise.resolve()),
      };
    }),
    access: vi.fn(() => Promise.resolve()),
    unlink: vi.fn(() => Promise.resolve()),
    rmdir: vi.fn(() => Promise.resolve()),
  };
});

import { CODEX_RESPONSE_TEXT_MAX_BYTES, CodexLLMClient } from "../codex-llm-client.js";

// ─── Helpers ───

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = {
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };
  readonly kill = vi.fn();
}

function makeFakeChild(): FakeChildProcess {
  const child = new FakeChildProcess();
  mockSpawn.mockReturnValueOnce(child);
  return child;
}

function sseResponse(events: Record<string, unknown>[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function fakeCodexOAuthToken(): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-1",
      },
    })).toString("base64url"),
    "signature",
  ].join(".");
}

/** Flush microtask queue so that async operations (e.g. fsp.mkdtemp) resolve before we emit child events */
const flushMicrotasks = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ─── Tests ───

describe("CodexLLMClient", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockTmpContents.value = "default response";
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  // ─── Constructor ───

  describe("constructor", () => {
    it("uses default cliPath 'codex'", async () => {
      const client = new CodexLLMClient();
      const child = makeFakeChild();
      mockTmpContents.value = "response";

      const promise = client.sendMessage([{ role: "user", content: "hi" }]);
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const [cliPath] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cliPath).toBe("codex");
    });

    it("uses custom cliPath when configured", async () => {
      const client = new CodexLLMClient({ cliPath: "/usr/local/bin/codex" });
      const child = makeFakeChild();

      const promise = client.sendMessage([{ role: "user", content: "hi" }]);
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const [cliPath] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cliPath).toBe("/usr/local/bin/codex");
    });
  });

  // ─── spawn arguments ───

  describe("sendMessage: spawn args", () => {
    it("spawns with exec -s workspace-write --skip-git-repo-check -o <path> - (stdin mode) and cwd set", async () => {
      const client = new CodexLLMClient();
      const child = makeFakeChild();

      const promise = client.sendMessage([{ role: "user", content: "do the task" }]);
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const [, spawnArgs, spawnOpts] = mockSpawn.mock.calls[0] as [string, string[], Record<string, unknown>];
      expect(spawnArgs[0]).toBe("exec");
      expect(spawnArgs).not.toContain("--ephemeral");
      expect(spawnArgs).not.toContain("--full-auto");
      expect(spawnArgs).toContain("-s");
      expect(spawnArgs).toContain("workspace-write");
      expect(spawnArgs).toContain("--skip-git-repo-check");
      // --path is not supported by codex-cli 0.114.0+; cwd is used instead
      expect(spawnArgs).not.toContain("--path");
      expect(spawnOpts.cwd).toBeTruthy();
      expect(spawnArgs).toContain("-o");
      // -o must be followed by a path
      const dashOIdx = spawnArgs.indexOf("-o");
      expect(spawnArgs[dashOIdx + 1]).toBeTruthy();
      // Last arg is "-" (read prompt from stdin)
      expect(spawnArgs[spawnArgs.length - 1]).toBe("-");
    });

    it("includes --model flag when model is configured", async () => {
      const client = new CodexLLMClient({ model: "o4-mini" });
      const child = makeFakeChild();

      const promise = client.sendMessage([{ role: "user", content: "hi" }]);
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const [, spawnArgs] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(spawnArgs).toContain("--model");
      const modelIdx = spawnArgs.indexOf("--model");
      expect(spawnArgs[modelIdx + 1]).toBe("o4-mini");
    });

    it("includes model_reasoning_effort config when reasoning effort is configured", async () => {
      const client = new CodexLLMClient({ model: "gpt-5.5", reasoningEffort: "low" });
      const child = makeFakeChild();

      const promise = client.sendMessage([{ role: "user", content: "hi" }]);
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const [, spawnArgs] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(spawnArgs).toContain("-c");
      expect(spawnArgs).toContain('model_reasoning_effort="low"');
    });

    it("omits --model flag when no model is configured", async () => {
      vi.stubEnv("OPENAI_MODEL", "");
      const client = new CodexLLMClient();
      const child = makeFakeChild();

      const promise = client.sendMessage([{ role: "user", content: "hi" }]);
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const [, spawnArgs] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(spawnArgs).not.toContain("--model");
    });

    it("uses model from options.model when provided", async () => {
      const client = new CodexLLMClient();
      const child = makeFakeChild();

      const promise = client.sendMessage(
        [{ role: "user", content: "hi" }],
        { model: "o3" }
      );
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const [, spawnArgs] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(spawnArgs).toContain("--model");
      const modelIdx = spawnArgs.indexOf("--model");
      expect(spawnArgs[modelIdx + 1]).toBe("o3");
    });

    it("uses per-request sandboxPolicy when provided", async () => {
      const client = new CodexLLMClient({ sandboxPolicy: "workspace-write" });
      const child = makeFakeChild();

      const promise = client.sendMessage(
        [{ role: "user", content: "inspect only" }],
        { sandboxPolicy: "read-only" },
      );
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const [, spawnArgs] = mockSpawn.mock.calls[0] as [string, string[]];
      const sandboxIdx = spawnArgs.indexOf("-s");
      expect(spawnArgs[sandboxIdx + 1]).toBe("read-only");
    });

    it("uses per-request cwd when provided", async () => {
      const client = new CodexLLMClient({ repoPath: "/default/repo" });
      const child = makeFakeChild();

      const promise = client.sendMessage(
        [{ role: "user", content: "edit task workspace" }],
        { cwd: "/task/workspace" },
      );
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const [, , spawnOpts] = mockSpawn.mock.calls[0] as [string, string[], Record<string, unknown>];
      expect(spawnOpts.cwd).toBe("/task/workspace");
    });
  });

  // ─── Prompt building ───

  describe("sendMessage: prompt building (via stdin)", () => {
    it("writes prompt to stdin from user messages", async () => {
      const client = new CodexLLMClient();
      const child = makeFakeChild();

      const promise = client.sendMessage([
        { role: "user", content: "hello world" },
      ]);
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const prompt = child.stdin.write.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("user: hello world");
      expect(child.stdin.end).toHaveBeenCalled();
    });

    it("prepends system instruction to prompt written to stdin", async () => {
      const client = new CodexLLMClient();
      const child = makeFakeChild();

      const promise = client.sendMessage(
        [{ role: "user", content: "question" }],
        { system: "You are a helpful assistant." }
      );
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const prompt = child.stdin.write.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("System instruction: You are a helpful assistant.");
      expect(prompt).toContain("user: question");
      // System should appear before user message
      expect(prompt.indexOf("System instruction")).toBeLessThan(prompt.indexOf("user:"));
    });

    it("concatenates multiple messages in order via stdin", async () => {
      const client = new CodexLLMClient();
      const child = makeFakeChild();

      const promise = client.sendMessage([
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ]);
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const prompt = child.stdin.write.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("user: first");
      expect(prompt).toContain("assistant: reply");
      expect(prompt).toContain("user: second");
      expect(prompt.indexOf("first")).toBeLessThan(prompt.indexOf("reply"));
      expect(prompt.indexOf("reply")).toBeLessThan(prompt.indexOf("second"));
    });
  });

  // ─── Response reading ───

  describe("sendMessage: reads response from output file", () => {
    it("returns content read from temp file", async () => {
      const client = new CodexLLMClient();
      const child = makeFakeChild();
      mockTmpContents.value = '{"result": "done"}';

      const promise = client.sendMessage([{ role: "user", content: "go" }]);
      await flushMicrotasks();
      child.emit("close", 0);
      const result = await promise;

      expect(result.content).toBe('{"result": "done"}');
    });

    it("returns stop_reason 'end_turn' on success", async () => {
      const client = new CodexLLMClient();
      const child = makeFakeChild();
      mockTmpContents.value = "ok";

      const promise = client.sendMessage([{ role: "user", content: "go" }]);
      await flushMicrotasks();
      child.emit("close", 0);
      const result = await promise;

      expect(result.stop_reason).toBe("end_turn");
    });

    it("returns usage stats as 0 (not available from CLI)", async () => {
      const client = new CodexLLMClient();
      const child = makeFakeChild();
      mockTmpContents.value = "response";

      const promise = client.sendMessage([{ role: "user", content: "go" }]);
      await flushMicrotasks();
      child.emit("close", 0);
      const result = await promise;

      expect(result.usage.input_tokens).toBe(0);
      expect(result.usage.output_tokens).toBe(0);
    });

    it("rejects oversized temp response files before returning content", async () => {
      const client = new CodexLLMClient();
      const child = makeFakeChild();
      mockTmpContents.value = "x".repeat(CODEX_RESPONSE_TEXT_MAX_BYTES + 1);

      const promise = client.sendMessage([{ role: "user", content: "go" }]).catch((e) => e);
      await flushMicrotasks();
      child.emit("close", 0);
      const err = await promise;

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(`output file exceeds ${CODEX_RESPONSE_TEXT_MAX_BYTES} bytes`);
    });
  });

  // ─── Error handling ───

  describe("sendMessage: spawn error", () => {
    it("retries retryable spawn errors up to the configured attempt limit", async () => {
      // Use fake timers to skip retry delays
      vi.useFakeTimers();

      const client = new CodexLLMClient({ cliPath: "codex", retryAttempts: 3 });

      // Queue children for all 3 retry attempts
      const children: FakeChildProcess[] = [];
      for (let i = 0; i < 3; i++) {
        children.push(makeFakeChild());
      }

      const promise = client.sendMessage([{ role: "user", content: "hi" }]).catch((e) => e);

      // Flush microtasks so mkdtemp resolves and spawn is called before emitting error
      await vi.advanceTimersByTimeAsync(0);
      // Immediately emit error on first child
      children[0]!.emit("error", new Error("spawn ENOENT"));
      // Advance timers to trigger retry delays, emit error on subsequent children
      await vi.advanceTimersByTimeAsync(1001);
      await vi.advanceTimersByTimeAsync(0);
      children[1]!.emit("error", new Error("spawn ENOENT"));
      await vi.advanceTimersByTimeAsync(2001);
      await vi.advanceTimersByTimeAsync(0);
      children[2]!.emit("error", new Error("spawn ENOENT"));
      await vi.runAllTimersAsync();

      vi.useRealTimers();

      const err = await promise;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("spawn ENOENT");
    });

    it("respects retryAttempts when configured lower than the default", async () => {
      vi.useFakeTimers();

      const client = new CodexLLMClient({ retryAttempts: 1 });
      const child = makeFakeChild();

      const promise = client.sendMessage([{ role: "user", content: "hi" }]).catch((e) => e);
      await vi.advanceTimersByTimeAsync(0);
      child.emit("error", new Error("spawn ENOENT"));
      await vi.runAllTimersAsync();

      vi.useRealTimers();

      const err = await promise;
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("spawn ENOENT");
    });

    it("caps retryAttempts at five total attempts", async () => {
      vi.useFakeTimers();

      const client = new CodexLLMClient({ retryAttempts: 99 });

      const children: FakeChildProcess[] = [];
      for (let i = 0; i < 5; i++) {
        children.push(makeFakeChild());
      }

      const promise = client.sendMessage([{ role: "user", content: "hi" }]).catch((e) => e);

      await vi.advanceTimersByTimeAsync(0);
      children[0]!.emit("error", new Error("spawn ENOENT"));
      await vi.advanceTimersByTimeAsync(1001);
      await vi.advanceTimersByTimeAsync(0);
      children[1]!.emit("error", new Error("spawn ENOENT"));
      await vi.advanceTimersByTimeAsync(2001);
      await vi.advanceTimersByTimeAsync(0);
      children[2]!.emit("error", new Error("spawn ENOENT"));
      await vi.advanceTimersByTimeAsync(4001);
      await vi.advanceTimersByTimeAsync(0);
      children[3]!.emit("error", new Error("spawn ENOENT"));
      await vi.advanceTimersByTimeAsync(8001);
      await vi.advanceTimersByTimeAsync(0);
      children[4]!.emit("error", new Error("spawn ENOENT"));
      await vi.runAllTimersAsync();

      vi.useRealTimers();

      const err = await promise;
      expect(mockSpawn).toHaveBeenCalledTimes(5);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("spawn ENOENT");
    });

    it("throws when process exits with non-zero code (after retries)", async () => {
      vi.useFakeTimers();

      const client = new CodexLLMClient({ retryAttempts: 3 });
      const children: FakeChildProcess[] = [];
      for (let i = 0; i < 3; i++) {
        children.push(makeFakeChild());
      }

      const promise = client.sendMessage([{ role: "user", content: "hi" }]).catch((e) => e);

      // Flush microtasks so mkdtemp resolves and spawn is called before emitting close
      await vi.advanceTimersByTimeAsync(0);
      children[0]!.emit("close", 1);
      await vi.advanceTimersByTimeAsync(1001);
      await vi.advanceTimersByTimeAsync(0);
      children[1]!.emit("close", 1);
      await vi.advanceTimersByTimeAsync(2001);
      await vi.advanceTimersByTimeAsync(0);
      children[2]!.emit("close", 1);
      await vi.runAllTimersAsync();

      vi.useRealTimers();

      const err = await promise;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("exited with code 1");
    });
  });

  // ─── Timeout ───

  describe("sendMessage: timeout", () => {
    it("kills the spawned codex process when aborted by operator stop", async () => {
      vi.useFakeTimers();

      const controller = new AbortController();
      const client = new CodexLLMClient({ timeoutMs: 1000, idleTimeoutMs: 1000 });
      const child = makeFakeChild();
      mockSpawn.mockImplementation(() => child);
      child.kill.mockImplementation((signal) => {
        if (signal === "SIGTERM") {
          setTimeout(() => child.emit("close", null), 5);
        }
        return true;
      });

      const promise = client
        .sendMessage([{ role: "user", content: "hi" }], { abortSignal: controller.signal })
        .catch((e) => e);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(5);
      await vi.runAllTimersAsync();
      const err = await promise;

      vi.useRealTimers();

      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(mockSpawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ detached: process.platform !== "win32" })
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("aborted by operator stop");
      expect((err as { code?: string }).code).toBe("ABORT_ERR");
      expect((err as { agentLoopFailureReason?: string }).agentLoopFailureReason).toBe("model_request_aborted");
    });

    it("rejects with total timeout error when timeoutMs elapses", async () => {
      vi.useFakeTimers();

      const client = new CodexLLMClient({ timeoutMs: 50, idleTimeoutMs: 1000 });

      const child = makeFakeChild();
      mockSpawn.mockImplementation(() => child);
      child.kill.mockImplementation((signal) => {
        if (signal === "SIGTERM") {
          setTimeout(() => child.emit("close", null), 5);
        }
        return true;
      });

      const promise = client.sendMessage([{ role: "user", content: "hi" }]).catch((e) => e);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(5);
      await vi.runAllTimersAsync();
      const err = await promise;

      vi.useRealTimers();

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("timed out");
      expect((err as { code?: string }).code).toBe("ETIMEDOUT");
      expect((err as { agentLoopFailureReason?: string }).agentLoopFailureReason).toBe("model_request_timeout");
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it("uses per-request timeout and idle timeout overrides for codex exec calls", async () => {
      vi.useFakeTimers();

      const client = new CodexLLMClient({ timeoutMs: 1000, idleTimeoutMs: 1000 });
      const child = makeFakeChild();
      mockSpawn.mockImplementation(() => child);
      child.kill.mockImplementation((signal) => {
        if (signal === "SIGTERM") {
          setTimeout(() => child.emit("close", null), 5);
        }
        return true;
      });

      const promise = client
        .sendMessage([{ role: "user", content: "hi" }], { timeoutMs: 50, idleTimeoutMs: 50 })
        .catch((e) => e);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(49);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(5);
      const err = await promise;

      vi.useRealTimers();

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("after 50ms");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("rejects with idle timeout error when no output is produced", async () => {
      vi.useFakeTimers();

      const client = new CodexLLMClient({ timeoutMs: 1000, idleTimeoutMs: 50 });
      const child = makeFakeChild();
      mockSpawn.mockImplementation(() => child);
      child.kill.mockImplementation((signal) => {
        if (signal === "SIGTERM") {
          setTimeout(() => child.emit("close", null), 5);
        }
        return true;
      });

      const promise = client.sendMessage([{ role: "user", content: "hi" }]).catch((e) => e);
      await vi.advanceTimersByTimeAsync(0);
      child.stderr.emit("data", Buffer.from("working\n"));
      await vi.advanceTimersByTimeAsync(49);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(5);
      await vi.runAllTimersAsync();
      const err = await promise;

      vi.useRealTimers();

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("idle timed out");
      expect((err as { agentLoopFailureReason?: string }).agentLoopFailureReason).toBe("model_request_timeout");
    });
  });

  describe("Codex Responses streaming", () => {
    it("uses Codex Responses instead of codex exec when an OAuth token is configured", async () => {
      const fetchMock = vi.fn().mockResolvedValue(sseResponse([
        { type: "response.output_text.delta", delta: "hi" },
        {
          type: "response.completed",
          response: {
            status: "completed",
            usage: { input_tokens: 2, output_tokens: 1 },
          },
        },
      ]));
      vi.stubGlobal("fetch", fetchMock);

      const client = new CodexLLMClient({ apiKey: fakeCodexOAuthToken(), model: "gpt-5.4-mini" });
      const rawDeltas: string[] = [];
      const deltas: string[] = [];
      const response = await client.sendMessageStream?.(
        [{ role: "user", content: "hi" }],
        { model_tier: "light" },
        {
          onModelTextDeltaReceived: (delta) => rawDeltas.push(delta),
          onTextDelta: (delta) => deltas.push(delta),
        },
      );

      expect(response?.content).toBe("hi");
      expect(response?.usage).toEqual({ input_tokens: 2, output_tokens: 1 });
      expect(rawDeltas).toEqual(["hi"]);
      expect(deltas).toEqual(["hi"]);
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledOnce();
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toMatchObject({
        instructions: expect.any(String),
        stream: true,
      });
    });

    it("deduplicates function call argument events by Codex call id", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
        {
          type: "response.output_item.added",
          item: {
            id: "fc_1",
            call_id: "call_1",
            type: "function_call",
            name: "check_readme",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          delta: "{}",
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc_1",
          arguments: "{}",
        },
        {
          type: "response.output_item.done",
          item: {
            id: "fc_1",
            call_id: "call_1",
            type: "function_call",
            name: "check_readme",
            arguments: "{}",
          },
        },
        { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } },
      ])));

      const client = new CodexLLMClient({ apiKey: fakeCodexOAuthToken(), model: "gpt-5.4-mini" });
      const response = await client.sendMessage(
        [{ role: "user", content: "check README" }],
        {
          tools: [{
            type: "function",
            function: {
              name: "check_readme",
              description: "Check README.",
              parameters: { type: "object", properties: {} },
            },
          }],
        },
      );

      expect(response.tool_calls).toEqual([{
        id: "call_1",
        type: "function",
        function: {
          name: "check_readme",
          arguments: "{}",
        },
      }]);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("does not send OpenAI API keys to the ChatGPT Codex Responses backend", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const client = new CodexLLMClient({ apiKey: "sk-test", model: "gpt-5.4-mini" });
      const child = makeFakeChild();
      mockTmpContents.value = "cli response";

      const promise = client.sendMessage([{ role: "user", content: "hi" }]);
      await flushMicrotasks();
      child.emit("close", 0);

      await expect(promise).resolves.toMatchObject({ content: "cli response" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalledOnce();
      expect(client.supportsToolCalling()).toBe(false);
      expect(client.usesExternalAgentRuntime()).toBe(true);
    });

    it("rejects a Codex Responses stream that ends without a terminal response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
        { type: "response.output_text.delta", delta: "partial" },
      ])));

      const client = new CodexLLMClient({ apiKey: fakeCodexOAuthToken(), model: "gpt-5.4-mini" });

      await expect(client.sendMessageStream?.(
        [{ role: "user", content: "hi" }],
        { model_tier: "light" },
        {},
      )).rejects.toThrow("ended without a terminal response");
    });

    it("rejects an incomplete Codex Responses terminal event", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
        { type: "response.output_text.delta", delta: "partial" },
        {
          type: "response.incomplete",
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          },
        },
      ])));

      const client = new CodexLLMClient({ apiKey: fakeCodexOAuthToken(), model: "gpt-5.4-mini" });
      const rawDeltas: string[] = [];
      const visibleDeltas: string[] = [];

      await expect(client.sendMessageStream?.(
        [{ role: "user", content: "hi" }],
        { model_tier: "light" },
        {
          onModelTextDeltaReceived: (delta) => rawDeltas.push(delta),
          onTextDelta: (delta) => visibleDeltas.push(delta),
        },
      )).rejects.toThrow("max_output_tokens");
      expect(rawDeltas).toEqual(["partial"]);
      expect(visibleDeltas).toEqual([]);
    });
  });

  // ─── parseJSON ───

  describe("parseJSON", () => {
    const schema = z.object({ name: z.string(), value: z.number() });

    it("parses bare JSON", () => {
      const client = new CodexLLMClient();
      const result = client.parseJSON('{"name":"test","value":42}', schema);
      expect(result).toEqual({ name: "test", value: 42 });
    });

    it("parses JSON in ```json code block", () => {
      const client = new CodexLLMClient();
      const content = '```json\n{"name":"hello","value":1}\n```';
      const result = client.parseJSON(content, schema);
      expect(result).toEqual({ name: "hello", value: 1 });
    });

    it("parses JSON in generic ``` code block", () => {
      const client = new CodexLLMClient();
      const content = '```\n{"name":"world","value":99}\n```';
      const result = client.parseJSON(content, schema);
      expect(result).toEqual({ name: "world", value: 99 });
    });

    it("throws on invalid JSON", () => {
      const client = new CodexLLMClient();
      expect(() => client.parseJSON("not json", schema)).toThrow(
        "LLM response JSON parse failed"
      );
    });

    it("includes content in error message for failed parse", () => {
      const client = new CodexLLMClient();
      const badContent = "definitely not json";
      expect(() => client.parseJSON(badContent, schema)).toThrow(badContent);
    });

    it("throws on schema validation failure", () => {
      const client = new CodexLLMClient();
      expect(() =>
        client.parseJSON('{"name":123,"value":"wrong"}', schema)
      ).toThrow();
    });
  });
});
