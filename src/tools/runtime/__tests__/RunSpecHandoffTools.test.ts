import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateManager } from "../../../base/state/state-manager.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import type { ToolCallContext } from "../../types.js";
import { ToolRegistry } from "../../registry.js";
import { ToolExecutor } from "../../executor.js";
import { ToolPermissionManager } from "../../permission.js";
import { ConcurrencyController } from "../../concurrency.js";
import { createRunSpecHandoffTools } from "../RunSpecHandoffTools.js";
import { createRunSpecStore, type RunSpecConfirmationSnapshot } from "../../../runtime/run-spec/index.js";

function makeLLMClient(overrides: Record<string, unknown> = {}): Pick<ILLMClient, "sendMessage" | "parseJSON"> {
  const draft = {
    decision: "run_spec_request",
    confidence: 0.93,
    profile: "kaggle",
    objective: "Continue Kaggle optimization until score exceeds 0.98",
    workspace: null,
    execution_target: { kind: "daemon", remote_host: null, confidence: "high" },
    metric: {
      name: "kaggle_score",
      direction: "maximize",
      target: 0.98,
      target_rank_percent: null,
      datasource: "kaggle_leaderboard",
      confidence: "high",
    },
    progress_contract: {
      kind: "metric_target",
      dimension: "kaggle_score",
      threshold: 0.98,
      semantics: "Kaggle leaderboard score exceeds 0.98.",
      confidence: "high",
    },
    deadline: {
      raw: "until score exceeds 0.98",
      iso_at: null,
      timezone: null,
      finalization_buffer_minutes: null,
      confidence: "medium",
    },
    budget: { max_trials: null, max_wall_clock_minutes: null, resident_policy: "best_effort" },
    approval_policy: {
      submit: "approval_required",
      publish: "unspecified",
      secret: "approval_required",
      external_action: "approval_required",
      irreversible_action: "approval_required",
    },
    artifact_contract: {
      expected_artifacts: ["submission.csv", "metrics report"],
      discovery_globs: ["*.csv", "reports/*.md"],
      primary_outputs: ["best submission"],
    },
    missing_fields: [],
    reason: "long-running Kaggle request",
    ...overrides,
  };
  return {
    sendMessage: vi.fn().mockResolvedValue({ content: JSON.stringify(draft) }),
    parseJSON: vi.fn((content: string, schema) => schema.parse(JSON.parse(content))),
  };
}

function makeContext(baseDir: string, pendingRef: { value: RunSpecConfirmationSnapshot | null }): ToolCallContext {
  return {
    cwd: "/repo/kaggle",
    goalId: "chat",
    trustBalance: 0,
    preApproved: true,
    approvalFn: vi.fn().mockResolvedValue(false),
    conversationSessionId: "session-1",
    runtimeReplyTarget: {
      surface: "gateway",
      channel: "plugin_gateway",
      conversation_id: "chat-1",
      response_channel: "telegram-chat-1",
      message_id: "message-1",
    },
    runSpecConfirmation: {
      get: () => pendingRef.value,
      set: (value) => {
        pendingRef.value = value as RunSpecConfirmationSnapshot | null;
      },
    },
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    sessionId: baseDir,
  };
}

function pendingRunSpecStartInput(pendingRef: { value: RunSpecConfirmationSnapshot | null }): {
  run_spec_id: string;
  observed_run_spec_epoch: string;
} {
  if (!pendingRef.value) throw new Error("expected pending RunSpec");
  return {
    run_spec_id: pendingRef.value.spec.id,
    observed_run_spec_epoch: pendingRef.value.updatedAt,
  };
}

describe("RunSpec handoff tools", () => {
  it("keeps model-facing descriptions on the DurableLoop surface", () => {
    const tools = createRunSpecHandoffTools({
      stateManager: {} as StateManager,
      llmClient: makeLLMClient(),
      daemonClient: { startGoal: vi.fn() },
    });
    const descriptions = [
      tools[0].description({ cwd: "/repo/kaggle" }),
      tools[3].description(),
    ].join("\n");

    expect(descriptions).toContain("daemon-backed DurableLoop handoff requests");
    expect(descriptions).toContain("daemon-backed DurableLoop run");
    expect(descriptions).not.toContain("CoreLoop");
  });

  it("drafts and persists a pending RunSpec without starting the daemon", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runspec-tools-draft-"));
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    const daemonClient = { startGoal: vi.fn() };
    const pendingRef: { value: RunSpecConfirmationSnapshot | null } = { value: null };
    const [draftTool] = createRunSpecHandoffTools({
      stateManager,
      llmClient: makeLLMClient(),
      daemonClient,
    });

    const result = await draftTool.call({
      request: "DurableloopのほうでKaggleのタスクに取り組んで",
    }, makeContext(baseDir, pendingRef));

    expect(result.success).toBe(true);
    expect(result.summary).toContain("Proposed long-running work");
    expect(result.summary).not.toContain("run-spec:");
    expect(pendingRef.value?.state).toBe("pending");
    expect(daemonClient.startGoal).not.toHaveBeenCalled();
    const specs = await createRunSpecStore(stateManager).list();
    expect(specs).toHaveLength(1);
    expect(fs.existsSync(path.join(baseDir, "run-specs"))).toBe(false);
    const stored = specs[0]!;
    expect(stored.status).toBe("draft");
    expect(stored.origin.reply_target).toMatchObject({
      conversation_id: "chat-1",
      response_channel: "telegram-chat-1",
    });
  });

  it("updates, starts, and rejects stale reuse of the pending draft", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runspec-tools-start-"));
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    const daemonClient = { startGoal: vi.fn().mockResolvedValue({ ok: true }) };
    const pendingRef: { value: RunSpecConfirmationSnapshot | null } = { value: null };
    const [draftTool, updateTool, cancelTool, startTool] = createRunSpecHandoffTools({
      stateManager,
      llmClient: makeLLMClient({
        metric: {
          name: "kaggle_score",
          direction: "unknown",
          target: 0.98,
          target_rank_percent: null,
          datasource: "kaggle_leaderboard",
          confidence: "medium",
        },
      }),
      daemonClient,
    });
    const context = makeContext(baseDir, pendingRef);

    await draftTool.call({ request: "Kaggle score 0.98を超えるまで長期で回して" }, context);
    const pendingId = pendingRef.value?.spec.id;
    expect(pendingId).toBeTruthy();

    const blocked = await startTool.call(pendingRunSpecStartInput(pendingRef), context);
    expect(blocked.success).toBe(false);
    expect(blocked.summary).toContain("Run cannot start until required fields are resolved");
    expect(daemonClient.startGoal).not.toHaveBeenCalled();

    const updated = await updateTool.call({ run_spec_id: pendingId, metric_direction: "maximize" }, context);
    expect(updated.success).toBe(true);
    context.runtimeReplyTarget = {
      surface: "gateway",
      channel: "plugin_gateway",
      conversation_id: "other-chat",
      response_channel: "other-telegram-chat",
      message_id: "later-message",
    };
    const started = await startTool.call(pendingRunSpecStartInput(pendingRef), context);
    expect(started.success).toBe(true);
    expect(started.summary).toContain("Started background work for:");
    expect(started.summary).not.toContain("goal-runspec-");
    expect(started.summary).not.toContain("run:coreloop:");
    expect(daemonClient.startGoal).toHaveBeenCalledOnce();
    expect(daemonClient.startGoal).toHaveBeenCalledWith(
      expect.stringMatching(/^goal-runspec-/),
      expect.objectContaining({
        backgroundRun: expect.objectContaining({
          backgroundRunId: expect.stringMatching(/^run:coreloop:/),
          replyTargetSource: "pinned_run",
          pinnedReplyTarget: expect.objectContaining({
            target_id: "chat-1",
            metadata: expect.objectContaining({
              response_channel: "telegram-chat-1",
            }),
          }),
        }),
      }),
    );

    const staleCancel = await cancelTool.call({ run_spec_id: pendingId }, context);
    expect(staleCancel.success).toBe(false);
    expect(staleCancel.summary).toContain("There is no pending long-running work draft");
  });

  it("exposes runspec_propose and rejects run_start when the observed RunSpec epoch changed", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runspec-tools-observed-"));
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    const daemonClient = { startGoal: vi.fn().mockResolvedValue({ ok: true }) };
    const pendingRef: { value: RunSpecConfirmationSnapshot | null } = { value: null };
    const tools = new Map(createRunSpecHandoffTools({
      stateManager,
      llmClient: makeLLMClient(),
      daemonClient,
    }).map((tool) => [tool.metadata.name, tool]));
    const propose = tools.get("runspec_propose")!;
    const runStart = tools.get("run_start")!;
    const context = makeContext(baseDir, pendingRef);

    const proposed = await propose.call({
      request: "Run Kaggle optimization until score exceeds 0.98",
    }, context);
    const proposedEpoch = (proposed.data as { observed_run_spec_epoch: string }).observed_run_spec_epoch;
    expect(proposed.success).toBe(true);
    expect(proposed.data).toMatchObject({
      run_spec_id: pendingRef.value?.spec.id,
      observed_run_spec_epoch: pendingRef.value?.updatedAt,
    });

    pendingRef.value = {
      ...pendingRef.value!,
      updatedAt: "2026-05-06T00:02:00.000Z",
      spec: {
        ...pendingRef.value!.spec,
        updated_at: "2026-05-06T00:02:00.000Z",
      },
    };

    const staleStart = await runStart.call({
      run_spec_id: pendingRef.value.spec.id,
      observed_run_spec_epoch: proposedEpoch,
    }, context);

    expect(staleStart.success).toBe(false);
    expect(staleStart.execution).toMatchObject({ status: "not_executed", reason: "stale_state" });
    expect(staleStart.data).toMatchObject({
      status: "stale_state",
      current_run_spec_epoch: "2026-05-06T00:02:00.000Z",
      observed_run_spec_epoch: proposedEpoch,
    });
    expect(daemonClient.startGoal).not.toHaveBeenCalled();
  });

  it("blocks disallowed policies and low-confidence workspaces before daemon start", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runspec-tools-safety-"));
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    const daemonClient = { startGoal: vi.fn().mockResolvedValue({ ok: true }) };
    const pendingRef: { value: RunSpecConfirmationSnapshot | null } = { value: null };
    const [draftTool, , , startTool] = createRunSpecHandoffTools({
      stateManager,
      llmClient: makeLLMClient({
        workspace: { path: "/repo/maybe", source: "context", confidence: "low" },
        approval_policy: {
          submit: "disallowed",
          publish: "unspecified",
          secret: "approval_required",
          external_action: "disallowed",
          irreversible_action: "disallowed",
        },
      }),
      daemonClient,
    });
    const context = makeContext(baseDir, pendingRef);

    await draftTool.call({ request: "本番に不可逆な変更を入れる長期実行を開始して" }, context);
    const result = await startTool.call(pendingRunSpecStartInput(pendingRef), context);

    expect(result.success).toBe(false);
    expect(result.summary).toContain("Workspace is missing or ambiguous");
    expect(daemonClient.startGoal).not.toHaveBeenCalled();
  });

  it("does not allow drafting and starting a DurableLoop run in the same AgentLoop turn", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runspec-tools-same-turn-"));
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    const daemonClient = { startGoal: vi.fn().mockResolvedValue({ ok: true }) };
    const pendingRef: { value: RunSpecConfirmationSnapshot | null } = { value: null };
    const [draftTool, , , startTool] = createRunSpecHandoffTools({
      stateManager,
      llmClient: makeLLMClient(),
      daemonClient,
    });
    const context = makeContext(baseDir, pendingRef);
    context.runSpecConfirmation!.currentTurnStartedAt = new Date(Date.now() - 1000).toISOString();

    await draftTool.call({ request: "Kaggle score 0.98を超えるまで長期で回して" }, context);
    const result = await startTool.call(pendingRunSpecStartInput(pendingRef), context);

    expect(result.success).toBe(false);
    expect(result.summary).toContain("created in this same turn");
    expect(daemonClient.startGoal).not.toHaveBeenCalled();
  });

  it("blocks same-turn start through the real tool executor pipeline", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runspec-tools-executor-"));
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    const daemonClient = { startGoal: vi.fn().mockResolvedValue({ ok: true }) };
    const pendingRef: { value: RunSpecConfirmationSnapshot | null } = { value: null };
    const registry = new ToolRegistry();
    for (const tool of createRunSpecHandoffTools({
      stateManager,
      llmClient: makeLLMClient(),
      daemonClient,
    })) {
      registry.register(tool);
    }
    const executor = new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });
    const context = makeContext(baseDir, pendingRef);
    context.runSpecConfirmation!.currentTurnStartedAt = new Date(Date.now() - 1000).toISOString();

    const draftResult = await executor.execute("draft_run_spec", {
      request: "DurableloopのほうでKaggleのタスクに取り組んで",
    }, context);
    const startResult = await executor.execute("start_durable_run", {
      ...pendingRunSpecStartInput(pendingRef),
    }, context);

    expect(draftResult.success).toBe(true);
    expect(startResult.success).toBe(false);
    expect(startResult.summary).toContain("created in this same turn");
    expect(daemonClient.startGoal).not.toHaveBeenCalled();
  });

  it("rejects non-finite deadline buffers through the real tool executor pipeline", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runspec-tools-deadline-buffer-"));
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    const daemonClient = { startGoal: vi.fn().mockResolvedValue({ ok: true }) };
    const pendingRef: { value: RunSpecConfirmationSnapshot | null } = { value: null };
    const registry = new ToolRegistry();
    for (const tool of createRunSpecHandoffTools({
      stateManager,
      llmClient: makeLLMClient(),
      daemonClient,
    })) {
      registry.register(tool);
    }
    const executor = new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });
    const context = makeContext(baseDir, pendingRef);

    const draftResult = await executor.execute("draft_run_spec", {
      request: "DurableloopのほうでKaggleのタスクに取り組んで",
    }, context);
    expect(draftResult.success).toBe(true);
    const originalUpdatedAt = pendingRef.value?.updatedAt;

    const updateResult = await executor.execute("update_run_spec_draft", {
      run_spec_id: pendingRef.value?.spec.id,
      deadline: {
        raw: "review later",
        finalization_buffer_minutes: Number.POSITIVE_INFINITY,
      },
    }, context);

    expect(updateResult.success).toBe(false);
    expect(updateResult.summary).toContain("Input validation failed");
    expect(updateResult.summary).toContain("deadline.finalization_buffer_minutes");
    expect(pendingRef.value?.updatedAt).toBe(originalUpdatedAt);
  });
});
