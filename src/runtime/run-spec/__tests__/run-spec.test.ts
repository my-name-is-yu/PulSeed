import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveRunSpecFromText, understandRunSpecDraft } from "../derive.js";
import { createRunSpecStore } from "../store.js";
import { RunSpecHandoffService } from "../handoff.js";
import {
  formatRunSpecSetupProposal,
  handleRunSpecConfirmationInput,
} from "../confirmation.js";
import { StateManager } from "../../../base/state/state-manager.js";
import { createSingleMockLLMClient } from "../../../../tests/helpers/mock-llm.js";

const NOW = new Date("2026-05-02T00:00:00.000Z");

function llmDraft(overrides: Record<string, unknown> = {}) {
  return createSingleMockLLMClient(JSON.stringify({
    decision: "run_spec_request",
    confidence: 0.92,
    profile: "kaggle",
    objective: "Run Kaggle competition until review time",
    metric: {
      name: "leaderboard_rank_percentile",
      direction: "minimize",
      target: null,
      target_rank_percent: 15,
      datasource: "kaggle_leaderboard",
      confidence: "high",
    },
    progress_contract: {
      kind: "rank_percentile",
      dimension: "leaderboard_rank_percentile",
      threshold: 15,
      semantics: "Reach a leaderboard rank percentile at or below 15.",
      confidence: "high",
    },
    deadline: {
      raw: "tomorrow morning",
      iso_at: "2026-05-03T00:00:00.000Z",
      timezone: "Asia/Tokyo",
      finalization_buffer_minutes: 60,
      confidence: "medium",
    },
    budget: {
      max_trials: null,
      max_wall_clock_minutes: null,
      resident_policy: "until_deadline",
    },
    approval_policy: {
      submit: "approval_required",
      publish: "unspecified",
      secret: "approval_required",
      external_action: "approval_required",
      irreversible_action: "approval_required",
    },
    missing_fields: [],
    ...overrides,
  }));
}

function confirmationDecision(overrides: Record<string, unknown> = {}) {
  return createSingleMockLLMClient(JSON.stringify({
    decision: "approve",
    confidence: 0.94,
    ...overrides,
  }));
}

describe("RunSpec derivation", () => {
  it("derives a Kaggle RunSpec with separate metric and progress semantics", async () => {
    const spec = await deriveRunSpecFromText(
      "Run this Kaggle competition until tomorrow morning and aim for top 15%. Keep submissions approval-gated.",
      {
        cwd: "/work/kaggle/playground",
        now: NOW,
        timezone: "Asia/Tokyo",
        llmClient: llmDraft(),
      },
    );

    expect(spec).not.toBeNull();
    expect(spec!.profile).toBe("kaggle");
    expect(spec!.workspace).toMatchObject({ path: "/work/kaggle/playground", source: "context" });
    expect(spec!.metric).toMatchObject({
      name: "leaderboard_rank_percentile",
      direction: "minimize",
      target_rank_percent: 15,
    });
    expect(spec!.progress_contract).toMatchObject({
      kind: "rank_percentile",
      threshold: 15,
    });
    expect(spec!.deadline).toMatchObject({
      raw: "tomorrow morning",
      finalization_buffer_minutes: 60,
    });
    expect(spec!.approval_policy.submit).toBe("approval_required");
    expect(spec!.risk_flags).toContain("external_submit_requires_approval");
    expect(spec!.missing_fields).toEqual([]);
  });

  it("derives a generic long-running RunSpec", async () => {
    const spec = await deriveRunSpecFromText(
      "Please keep optimizing the model while I am away and stop at the review checkpoint.",
      {
        cwd: "/repo/app",
        now: NOW,
        llmClient: llmDraft({
          profile: "generic",
          objective: "Optimize the model until review time",
          metric: {
            name: "accuracy",
            direction: "maximize",
            target: 0.91,
            target_rank_percent: null,
            datasource: null,
            confidence: "medium",
          },
          progress_contract: {
            kind: "metric_target",
            dimension: "accuracy",
            threshold: 0.91,
            semantics: "Reach accuracy of at least 0.91.",
            confidence: "high",
          },
        }),
      },
    );

    expect(spec).not.toBeNull();
    expect(spec!.profile).toBe("generic");
    expect(spec!.metric).toMatchObject({
      name: "accuracy",
      direction: "maximize",
      target: 0.91,
    });
    expect(spec!.progress_contract).toMatchObject({
      kind: "metric_target",
      dimension: "accuracy",
      threshold: 0.91,
    });
  });

  it("preserves ambiguous metric direction as a required missing field", async () => {
    const spec = await deriveRunSpecFromText(
      "Please continue the benchmark work through tomorrow and get score 0.98 if possible.",
      {
        cwd: "/repo/app",
        now: NOW,
        llmClient: llmDraft({
          profile: "generic",
          metric: {
            name: "score",
            direction: "unknown",
            target: 0.98,
            target_rank_percent: null,
            datasource: null,
            confidence: "medium",
          },
          progress_contract: {
            kind: "metric_target",
            dimension: "score",
            threshold: 0.98,
            semantics: "Reach score 0.98.",
            confidence: "medium",
          },
        }),
      },
    );

    expect(spec).not.toBeNull();
    expect(spec!.metric).toMatchObject({
      name: "score",
      direction: "unknown",
      target: 0.98,
    });
    expect(spec!.progress_contract).toMatchObject({
      kind: "metric_target",
      threshold: 0.98,
    });
    expect(spec!.missing_fields).toContainEqual({
      field: "metric.direction",
      question: "Should score be maximized or minimized?",
      severity: "required",
    });
  });

  it("does not guess missing workspace and deadline", async () => {
    const spec = await deriveRunSpecFromText("Please take over the competition work and target the top cohort.", {
      now: NOW,
      llmClient: llmDraft({
        metric: {
          name: "leaderboard_rank_percentile",
          direction: "minimize",
          target: null,
          target_rank_percent: 20,
          datasource: "kaggle_leaderboard",
          confidence: "medium",
        },
        progress_contract: {
          kind: "rank_percentile",
          dimension: "leaderboard_rank_percentile",
          threshold: 20,
          semantics: "Reach top 20 percent leaderboard rank.",
          confidence: "medium",
        },
        deadline: null,
      }),
    });

    expect(spec).not.toBeNull();
    expect(spec!.workspace).toBeNull();
    expect(spec!.deadline).toBeNull();
    expect(spec!.missing_fields.map((field) => field.field)).toEqual(["workspace", "deadline"]);
  });

  it("does not treat explanatory long-running questions as run requests", async () => {
    const spec = await deriveRunSpecFromText("Why do long-running tasks fail?", {
      now: NOW,
      llmClient: createSingleMockLLMClient(JSON.stringify({
        decision: "not_run_spec_request",
        confidence: 0.96,
        missing_fields: [],
      })),
    });

    expect(spec).toBeNull();
  });

  it("supports Japanese request phrasing through the same structured draft path", async () => {
    const spec = await deriveRunSpecFromText("明日のレビューまでコンペの改善を進めて、提出は承認制にして", {
      cwd: "/repo/kaggle",
      now: NOW,
      llmClient: llmDraft({
        objective: "明日のレビューまでコンペ改善を進める",
      }),
    });

    expect(spec).not.toBeNull();
    expect(spec!.profile).toBe("kaggle");
    expect(spec!.approval_policy.submit).toBe("approval_required");
  });

  it("supports third-language request phrasing through the same structured draft path", async () => {
    const spec = await deriveRunSpecFromText("Sigue trabajando en la competición hasta la revisión y no envíes nada sin aprobación.", {
      cwd: "/repo/kaggle",
      now: NOW,
      llmClient: llmDraft({
        objective: "Continue competition work until review",
      }),
    });

    expect(spec).not.toBeNull();
    expect(spec!.profile).toBe("kaggle");
    expect(spec!.workspace?.path).toBe("/repo/kaggle");
  });

  it("does not use a keyword fallback when the model is unavailable", async () => {
    const spec = await deriveRunSpecFromText("Run Kaggle until tomorrow morning and aim for top 15%.", {
      cwd: "/repo/kaggle",
      now: NOW,
    });

    expect(spec).toBeNull();
  });

  it("returns null for low-confidence draft decisions", async () => {
    const draft = await understandRunSpecDraft("maybe do something overnight?", {
      llmClient: createSingleMockLLMClient(JSON.stringify({
        decision: "run_spec_request",
        confidence: 0.41,
        profile: "generic",
        missing_fields: [],
      })),
    });

    expect(draft).toBeNull();
  });
});

describe("RunSpecStore", () => {
  it("persists and reloads a RunSpec under the state root", async () => {
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-runspec-"));
    const spec = await deriveRunSpecFromText("Run Kaggle until tomorrow morning and aim for top 15%.", {
      cwd: "/repo/kaggle",
      now: NOW,
      llmClient: llmDraft(),
    });
    expect(spec).not.toBeNull();

    const store = createRunSpecStore({ getBaseDir: () => baseDir });
    await store.save(spec!);

    await expect(store.load(spec!.id)).resolves.toMatchObject({
      id: spec!.id,
      profile: "kaggle",
      schema_version: "run-spec-v1",
    });
  });

  it("returns null for malformed or stale persisted RunSpec JSON", async () => {
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-runspec-"));
    const malformedId = "runspec-00000000-0000-4000-8000-000000000001";
    const staleId = "runspec-00000000-0000-4000-8000-000000000002";
    const dir = path.join(baseDir, "run-specs");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${malformedId}.json`), "{bad", "utf8");
    await fsp.writeFile(path.join(dir, `${staleId}.json`), JSON.stringify({
      schema_version: "run-spec-v1",
      id: staleId,
    }), "utf8");

    const store = createRunSpecStore({ getBaseDir: () => baseDir });

    await expect(store.load(malformedId)).resolves.toBeNull();
    await expect(store.load(staleId)).resolves.toBeNull();
  });

  it("still surfaces unexpected RunSpec storage read failures", async () => {
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-runspec-"));
    const directoryId = "runspec-00000000-0000-4000-8000-000000000003";
    const dir = path.join(baseDir, "run-specs");
    await fsp.mkdir(path.join(dir, `${directoryId}.json`), { recursive: true });

    const store = createRunSpecStore({ getBaseDir: () => baseDir });

    await expect(store.load(directoryId)).rejects.toThrow();
  });

  it("rejects path-like ids before RunSpec store file I/O", async () => {
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-runspec-"));
    const spec = await deriveRunSpecFromText("Run Kaggle until tomorrow morning and aim for top 15%.", {
      cwd: "/repo/kaggle",
      now: NOW,
      llmClient: llmDraft(),
    });
    expect(spec).not.toBeNull();
    const store = createRunSpecStore({ getBaseDir: () => baseDir });

    await expect(store.save({ ...spec!, id: "../sessions/foo" })).rejects.toThrow();
    await expect(store.load("../sessions/foo")).rejects.toThrow();
  });
});

describe("RunSpec confirmation", () => {
  it("confirms a complete RunSpec", async () => {
    const spec = await deriveRunSpecFromText(
      "Run this Kaggle competition until tomorrow morning and aim for top 15%. Keep submissions approval-gated.",
      {
        cwd: "/repo/kaggle",
        now: NOW,
        llmClient: llmDraft(),
      },
    );
    expect(spec).not.toBeNull();

    const result = await handleRunSpecConfirmationInput(spec!, "Bitte starten", {
      now: NOW,
      llmClient: confirmationDecision(),
    });

    expect(result.kind).toBe("confirmed");
    expect(result.spec.status).toBe("confirmed");
  });

  it("revises missing required fields before confirmation", async () => {
    const spec = await deriveRunSpecFromText("Run a long-running Kaggle experiment for top 20%.", {
      now: NOW,
      llmClient: llmDraft({
        metric: {
          name: "leaderboard_rank_percentile",
          direction: "minimize",
          target: null,
          target_rank_percent: 20,
          datasource: "kaggle_leaderboard",
          confidence: "medium",
        },
        progress_contract: {
          kind: "rank_percentile",
          dimension: "leaderboard_rank_percentile",
          threshold: 20,
          semantics: "Reach top 20 percent leaderboard rank.",
          confidence: "medium",
        },
        deadline: null,
      }),
    });
    expect(spec).not.toBeNull();

    const revisedWorkspace = await handleRunSpecConfirmationInput(spec!, "Use /repo/kaggle and review tomorrow morning", {
      now: NOW,
      llmClient: confirmationDecision({
        decision: "revise",
        confidence: 0.91,
        revision: {
          workspace_path: "/repo/kaggle",
          deadline: {
            raw: "tomorrow morning",
            iso_at: "2026-05-03T09:00:00.000Z",
            timezone: "Asia/Tokyo",
            finalization_buffer_minutes: 60,
            confidence: "medium",
          },
        },
      }),
    });
    expect(revisedWorkspace.kind).toBe("revised");
    expect(revisedWorkspace.spec.workspace).toMatchObject({ path: "/repo/kaggle", source: "user" });
    expect(revisedWorkspace.spec.deadline).toMatchObject({ raw: "tomorrow morning" });

    const confirmed = await handleRunSpecConfirmationInput(revisedWorkspace.spec, "adelante", {
      now: NOW,
      llmClient: confirmationDecision(),
    });
    expect(confirmed.kind).toBe("confirmed");
  });

  it("cancels a pending RunSpec with multilingual freeform text", async () => {
    const spec = await deriveRunSpecFromText("Run Kaggle until tomorrow morning and aim for top 15%.", {
      cwd: "/repo/kaggle",
      now: NOW,
      llmClient: llmDraft(),
    });
    expect(spec).not.toBeNull();

    const result = await handleRunSpecConfirmationInput(spec!, "annule cette exécution", {
      now: NOW,
      llmClient: confirmationDecision({ decision: "cancel", confidence: 0.93 }),
    });

    expect(result.kind).toBe("cancelled");
    expect(result.spec.status).toBe("cancelled");
  });

  it("blocks confirmation while required fields remain unresolved", async () => {
    const spec = await deriveRunSpecFromText("Run a long-running Kaggle experiment for top 20%.", {
      now: NOW,
      llmClient: llmDraft({
        metric: {
          name: "leaderboard_rank_percentile",
          direction: "minimize",
          target: null,
          target_rank_percent: 20,
          datasource: "kaggle_leaderboard",
          confidence: "medium",
        },
        progress_contract: {
          kind: "rank_percentile",
          dimension: "leaderboard_rank_percentile",
          threshold: 20,
          semantics: "Reach top 20 percent leaderboard rank.",
          confidence: "medium",
        },
        deadline: null,
      }),
    });
    expect(spec).not.toBeNull();

    const result = await handleRunSpecConfirmationInput(spec!, "start it", {
      now: NOW,
      llmClient: confirmationDecision(),
    });

    expect(result.kind).toBe("blocked");
    expect(result.message).toContain("Which local or remote workspace");
    expect(result.message).toContain("What deadline or review time");
  });

  it("does not execute a pending RunSpec on ambiguous confirmation text", async () => {
    const spec = await deriveRunSpecFromText("Run Kaggle until tomorrow morning and aim for top 15%.", {
      cwd: "/repo/kaggle",
      now: NOW,
      llmClient: llmDraft(),
    });
    expect(spec).not.toBeNull();

    const result = await handleRunSpecConfirmationInput(spec!, "looks interesting", {
      now: NOW,
      llmClient: confirmationDecision({
        decision: "unknown",
        confidence: 0.42,
        clarification: "Please explicitly approve or cancel.",
      }),
    });

    expect(result.kind).toBe("unrecognized");
    expect(result.spec.status).toBe("draft");
  });

  it("does not use a phrase fallback when confirmation classifier is unavailable", async () => {
    const spec = await deriveRunSpecFromText("Run Kaggle until tomorrow morning and aim for top 15%.", {
      cwd: "/repo/kaggle",
      now: NOW,
      llmClient: llmDraft(),
    });
    expect(spec).not.toBeNull();

    const result = await handleRunSpecConfirmationInput(spec!, "confirm", { now: NOW });

    expect(result.kind).toBe("unrecognized");
    expect(result.spec.status).toBe("draft");
  });

  it("shows risky external actions as approval-gated in the proposal", async () => {
    const spec = await deriveRunSpecFromText(
      "Run this Kaggle competition until tomorrow morning and aim for top 15%. Keep submissions approval-gated.",
      {
        cwd: "/repo/kaggle",
        now: NOW,
        llmClient: llmDraft(),
      },
    );
    expect(spec).not.toBeNull();

    const proposal = formatRunSpecSetupProposal(spec!);

    expect(proposal).toContain("Submit policy: approval_required");
    expect(proposal).toContain("Publish policy: unspecified");
    expect(proposal).toContain("External actions: approval_required");
    expect(proposal).toContain("Secret policy: approval_required");
    expect(proposal).toContain("Irreversible actions: approval_required");
  });
});

describe("RunSpec handoff", () => {
  it("creates Kaggle goals with typed artifact-required constraints", async () => {
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-runspec-handoff-"));
    const stateManager = new StateManager(baseDir);
    const spec = await deriveRunSpecFromText(
      "Run this Kaggle competition until tomorrow morning and aim for top 15%. Keep submissions approval-gated.",
      {
        cwd: "/repo/kaggle",
        now: NOW,
        llmClient: llmDraft(),
      },
    );
    expect(spec).not.toBeNull();

    const result = await new RunSpecHandoffService({
      stateManager,
      daemonClient: { startGoal: async () => ({ ok: true }) } as never,
    }).startConfirmed({ ...spec!, status: "confirmed" });

    expect(result.success).toBe(true);
    const goal = await stateManager.loadGoal(result.goalId!);
    expect(goal?.constraints).toContain("run_spec_profile:kaggle");
    expect(goal?.constraints).toContain("artifact_contract:required");
  });
});
