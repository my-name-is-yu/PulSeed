import { describe, expect, it } from "vitest";
import { resolveRuntimeTarget } from "../runtime-target-resolver.js";
import type { RuntimeSessionRegistrySnapshot } from "../../session-registry/index.js";

function run(overrides: Partial<RuntimeSessionRegistrySnapshot["background_runs"][number]> = {}): RuntimeSessionRegistrySnapshot["background_runs"][number] {
  return {
    schema_version: "background-run-v1",
    id: "run:coreloop:active",
    kind: "coreloop_run",
    parent_session_id: null,
    child_session_id: "session:coreloop:active",
    process_session_id: null,
    goal_id: "goal-1",
    status: "running",
    notify_policy: "done_only",
    reply_target_source: "none",
    pinned_reply_target: null,
    title: "DurableLoop goal goal-1",
    workspace: "/repo",
    created_at: "2026-05-02T00:00:00.000Z",
    started_at: "2026-05-02T00:00:00.000Z",
    updated_at: "2026-05-02T00:00:00.000Z",
    completed_at: null,
    summary: null,
    error: null,
    artifacts: [],
    source_refs: [],
    ...overrides,
  };
}

function snapshot(runs: RuntimeSessionRegistrySnapshot["background_runs"]): RuntimeSessionRegistrySnapshot {
  return {
    schema_version: "runtime-session-registry-v1",
    generated_at: "2026-05-02T01:00:00.000Z",
    sessions: [],
    background_runs: runs,
    warnings: [],
  };
}

describe("resolveRuntimeTarget", () => {
  it("resolves current run by conversation scope with typed evidence", () => {
    const result = resolveRuntimeTarget({
      snapshot: snapshot([
        run({ id: "run:coreloop:other", parent_session_id: "session:conversation:other" }),
        run({ id: "run:coreloop:current", parent_session_id: "session:conversation:chat-1" }),
      ]),
      operation: "pause_run",
      selector: { scope: "run", reference: "current", sourceText: "この実行" },
      conversationId: "chat-1",
    });

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.run.id).toBe("run:coreloop:current");
      expect(result.evidence.selector).toMatchObject({ reference: "current" });
    }
  });

  it("selects latest and previous by runtime timestamps without title matching", () => {
    const runs = [
      run({ id: "run:older", updated_at: "2026-05-02T00:00:00.000Z" }),
      run({ id: "run:newer", updated_at: "2026-05-02T00:10:00.000Z" }),
    ];

    const latest = resolveRuntimeTarget({
      snapshot: snapshot(runs),
      operation: "inspect_run",
      selector: { scope: "run", reference: "latest", sourceText: "latest session" },
    });
    const previous = resolveRuntimeTarget({
      snapshot: snapshot(runs),
      operation: "inspect_run",
      selector: { scope: "run", reference: "previous", sourceText: "previous background job" },
    });

    expect(latest.status).toBe("resolved");
    expect(previous.status).toBe("resolved");
    if (latest.status === "resolved") expect(latest.run.id).toBe("run:newer");
    if (previous.status === "resolved") expect(previous.run.id).toBe("run:older");
  });

  it("returns ambiguous for multiple current candidates instead of guessing", () => {
    const result = resolveRuntimeTarget({
      snapshot: snapshot([
        run({ id: "run:a", parent_session_id: "session:conversation:chat-1" }),
        run({ id: "run:b", parent_session_id: "session:conversation:chat-1" }),
      ]),
      operation: "resume_run",
      selector: { scope: "run", reference: "current", sourceText: "that run" },
      conversationId: "chat-1",
    });

    expect(result.status).toBe("ambiguous");
    expect(result.evidence.candidates.map((candidate) => candidate.run_id)).toEqual(["run:a", "run:b"]);
  });

  it("does not reuse another conversation's run for current references", () => {
    const result = resolveRuntimeTarget({
      snapshot: snapshot([
        run({ id: "run:other-conversation", parent_session_id: "session:conversation:other" }),
      ]),
      operation: "pause_run",
      selector: { scope: "run", reference: "current", sourceText: "この実行" },
      conversationId: "chat-1",
    });

    expect(result.status).toBe("unknown");
    expect(result.evidence.reason).toContain("refusing to reuse another conversation");
    expect(result.evidence.candidates.map((candidate) => candidate.run_id)).toEqual(["run:other-conversation"]);
  });

  it("does not reuse another conversation's run for latest references", () => {
    const result = resolveRuntimeTarget({
      snapshot: snapshot([
        run({ id: "run:other-conversation", parent_session_id: "session:conversation:other" }),
      ]),
      operation: "pause_run",
      selector: { scope: "run", reference: "latest", sourceText: "latest run" },
      conversationId: "chat-1",
    });

    expect(result.status).toBe("unknown");
    expect(result.evidence.reason).toContain("refusing to reuse another conversation");
    expect(result.evidence.candidates.map((candidate) => candidate.run_id)).toEqual(["run:other-conversation"]);
  });

  it("does not reuse another conversation's run for previous references", () => {
    const result = resolveRuntimeTarget({
      snapshot: snapshot([
        run({
          id: "run:other-newer",
          parent_session_id: "session:conversation:other",
          updated_at: "2026-05-02T00:10:00.000Z",
        }),
        run({
          id: "run:other-older",
          parent_session_id: "session:conversation:other",
          updated_at: "2026-05-02T00:00:00.000Z",
        }),
      ]),
      operation: "inspect_run",
      selector: { scope: "run", reference: "previous", sourceText: "previous background job" },
      conversationId: "chat-1",
    });

    expect(result.status).toBe("unknown");
    expect(result.evidence.reason).toContain("refusing to reuse another conversation");
    expect(result.evidence.candidates.map((candidate) => candidate.run_id)).toEqual(["run:other-newer", "run:other-older"]);
  });

  it("returns stale for terminal exact targets", () => {
    const result = resolveRuntimeTarget({
      snapshot: snapshot([run({ id: "run:done", status: "succeeded" })]),
      operation: "pause_run",
      target: { runId: "run:done" },
    });

    expect(result.status).toBe("stale");
  });
});
