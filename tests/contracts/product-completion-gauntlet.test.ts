import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { AutonomyDecision } from "../../src/runtime/control/autonomy-governor.js";
import {
  projectCompanionAction,
  toCompanionUserFacingPolicyProjection,
} from "../../src/runtime/control/companion-action-projection.js";
import { StateManager } from "../../src/base/state/state-manager.js";
import { ChatRunner } from "../../src/interface/chat/chat-runner.js";
import type { ChatRunnerDeps } from "../../src/interface/chat/chat-runner-contracts.js";
import { cmdCurrentStatus, cmdStatus } from "../../src/interface/cli/commands/goal-read.js";
import { formatRuntimeStatus } from "../../src/interface/chat/chat-runner-runtime.js";
import { formatCurrentGoalSummary } from "../../src/interface/current-goal-summary.js";
import { formatGoalStatusDetails } from "../../src/interface/goal-status-display.js";
import { BackgroundRunLedger } from "../../src/runtime/store/background-run-store.js";
import { RuntimeOperatorHandoffStore } from "../../src/runtime/store/operator-handoff-store.js";
import { makeDimension, makeGoal } from "../helpers/fixtures.js";

const NOW = "2026-05-15T00:00:00.000Z";

const RAW_INTERNAL_MARKERS = [
  "RAW_MEMORY_SLOT",
  "autonomy=approval_required",
  "readiness=degraded",
  "admission=approval_required",
  "capability:notify",
  "policy:deny",
  "evidence:raw",
  "run:coreloop:raw",
  "session:agent:raw",
  "trace:raw",
];

function expectNormalSurfaceRedacted(text: string): void {
  for (const marker of RAW_INTERNAL_MARKERS) {
    expect(text).not.toContain(marker);
  }
}

async function captureConsoleLog(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

function chatRunnerForStatus(stateManager: StateManager): ChatRunner {
  return new ChatRunner({
    stateManager,
    adapter: {
      adapterType: "product-completion-test",
      execute: vi.fn(),
    },
    llmClient: {
      sendMessage: vi.fn(),
      parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content) as unknown)),
    },
  } as unknown as ChatRunnerDeps);
}

async function createRuntimeCallerFixture(baseDir: string): Promise<StateManager> {
  const stateManager = new StateManager(baseDir);
  await stateManager.init();
  await stateManager.saveGoal(makeGoal({
    id: "goal-product-completion",
    title: "Finish product boundary",
    loop_status: "running",
    dimensions: [makeDimension({
      name: "claim_truth",
      label: "Claim truth",
      current_value: 0.5,
      threshold: { type: "min", value: 1 },
      confidence: 0.42,
    })],
  }));

  const ledger = new BackgroundRunLedger(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
  await ledger.create({
    id: "run:coreloop:raw",
    kind: "coreloop_run",
    status: "running",
    notify_policy: "silent",
    goal_id: "goal-product-completion",
    child_session_id: "session:agent:raw",
    title: "Product completion run",
    summary: "RAW_MEMORY_SLOT autonomy=approval_required readiness=degraded",
    error: "policy:deny evidence:raw admission=approval_required capability:notify trace:raw",
    source_refs: [{
      kind: "task_ledger",
      id: "trace:raw",
      path: null,
      relative_path: "state/pulseed-control.sqlite",
      updated_at: NOW,
    }],
  });
  await ledger.terminal("run:coreloop:raw", {
    status: "failed",
    summary: "RAW_MEMORY_SLOT autonomy=approval_required readiness=degraded",
    error: "policy:deny evidence:raw admission=approval_required capability:notify trace:raw",
    completed_at: NOW,
  });

  await new RuntimeOperatorHandoffStore(path.join(baseDir, "runtime"), {
    controlBaseDir: baseDir,
    now: () => new Date(NOW),
  }).create({
    handoff_id: "handoff-product-completion",
    goal_id: "goal-product-completion",
    run_id: "run:coreloop:raw",
    triggers: ["policy", "external_action"],
    title: "Operator approval needed",
    summary: "RAW_MEMORY_SLOT autonomy=approval_required readiness=degraded admission=approval_required",
    current_status: "policy:deny capability:notify evidence:raw",
    recommended_action: "Review the prepared operation before continuing.",
    next_action: {
      label: "Review the prepared operation before continuing.",
      approval_required: true,
    },
    evidence_refs: [{ kind: "audit_trace", ref: "evidence:raw", observed_at: NOW }],
  });

  await stateManager.writeRaw("reports/goal-product-completion/report-raw.json", {
    id: "report-product-completion-raw",
    report_type: "execution_summary",
    goal_id: "goal-product-completion",
    title: "Execution Summary - Product boundary",
    content: "RAW_MEMORY_SLOT autonomy=approval_required readiness=degraded admission=approval_required capability:notify policy:deny evidence:raw trace:raw session:agent:raw",
    verbosity: "standard",
    generated_at: NOW,
    delivered_at: null,
    read: false,
  });

  return stateManager;
}

function decision(): AutonomyDecision {
  return {
    schema_version: "autonomy-decision/v1",
    decision_id: "autonomy:approval-required",
    operation_id: "notify.send",
    capability_id: "capability:notify",
    evaluated_at: NOW,
    level: "approval_required",
    rationale: [
      "RAW_MEMORY_SLOT autonomy=approval_required readiness=degraded admission=approval_required capability:notify policy:deny evidence:raw",
    ],
    allowed_steps: ["prepare", "request_user_approval"],
    blocked_steps: ["execute_without_approval"],
    required_user_approval: true,
    audit_refs: ["trace:raw", "evidence:raw"],
    expires_at: "2026-05-15T00:05:00.000Z",
    invalidation_bindings: [{ kind: "policy", ref: "policy:deny" }],
    cache_key: "cache:raw",
    metadata: {
      admission_evaluation_ref: "admission:approval_required",
      readiness_refs: ["readiness:degraded"],
      user_directed: false,
      external_side_effect: true,
      blast_radius: "external",
      privacy_sensitivity: "medium",
      context_authority_evidence_refs: ["evidence:raw"],
    },
  };
}

function runtimeSnapshotWithRawInternals() {
  return {
    generated_at: NOW,
    sessions: [{
      id: "session:agent:raw",
      kind: "agent",
      status: "active",
      title: "Bounded background work",
      workspace: "/workspace",
      created_at: NOW,
      updated_at: NOW,
      last_event_at: NOW,
      parent_session_id: "session:conversation:raw",
      resumable: true,
      attachable: true,
    }],
    background_runs: [{
      id: "run:coreloop:raw",
      kind: "core_loop",
      status: "failed",
      title: "Product completion run",
      goal_id: "goal-product-completion",
      parent_session_id: "session:conversation:raw",
      notify_policy: "done_only",
      created_at: NOW,
      started_at: NOW,
      updated_at: NOW,
      summary: "RAW_MEMORY_SLOT autonomy=approval_required readiness=degraded",
      error: "policy:deny evidence:raw admission=approval_required capability:notify trace:raw",
    }],
    warnings: [{
      code: "raw_policy_detail",
      message: "evidence:raw should stay operator-only",
    }],
  } as never;
}

describe("product completion gauntlet", () => {
  it("keeps normal chat/gateway runtime status projections free of raw internal state", () => {
    const snapshot = runtimeSnapshotWithRawInternals();

    const normal = formatRuntimeStatus(snapshot);
    const diagnostic = formatRuntimeStatus(snapshot, { diagnostic: true });

    expect(normal).toContain("Active work:");
    expect(normal).toContain("Background work is blocked");
    expectNormalSurfaceRedacted(normal);
    expect(diagnostic).toContain("session:agent:raw");
    expect(diagnostic).toContain("run:coreloop:raw");
    expect(diagnostic).toContain("policy:deny");
  });

  it("keeps normal CLI/status/report projections concise while preserving diagnostics", () => {
    const goal = makeGoal({
      id: "goal-product-completion",
      title: "Finish product boundary",
      loop_status: "running",
      dimensions: [makeDimension({
        name: "claim_truth",
        label: "Claim truth",
        current_value: 0.5,
        threshold: { type: "min", value: 1 },
        confidence: 0.42,
      })],
    });
    const snapshot = runtimeSnapshotWithRawInternals();

    const goalDetails = formatGoalStatusDetails(goal);
    const diagnosticGoalDetails = formatGoalStatusDetails(goal, { diagnostic: true });
    const currentGoal = formatCurrentGoalSummary(goal, { runtimeSnapshot: snapshot });
    const diagnosticCurrentGoal = formatCurrentGoalSummary(goal, {
      detail: "diagnostic",
      runtimeSnapshot: snapshot,
    });

    expect(goalDetails).toContain("Goal details: Finish product boundary");
    expect(goalDetails).not.toContain("goal-product-completion");
    expect(goalDetails).not.toContain("confidence=0.42");
    expect(diagnosticGoalDetails).toContain("ID: goal-product-completion");
    expect(diagnosticGoalDetails).toContain("confidence=0.42");

    expect(currentGoal).toContain("Next safe action:");
    expect(currentGoal).toContain("Background work needs attention.");
    expectNormalSurfaceRedacted(currentGoal);
    expect(diagnosticCurrentGoal).toContain("run:coreloop:raw");
    expect(diagnosticCurrentGoal).toContain("policy:deny");
  });

  it("keeps ChatRunner and CLI status/report caller paths redacted while preserving diagnostic access", async () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "pulseed-product-completion-caller-"));
    try {
      const stateManager = await createRuntimeCallerFixture(baseDir);
      const runner = chatRunnerForStatus(stateManager);

      const chatStatus = await runner.execute("/status", baseDir);
      const chatDiagnosticStatus = await runner.execute("/status --details", baseDir);
      const cliCurrent = await captureConsoleLog(() => cmdCurrentStatus(stateManager));
      const cliFocused = await captureConsoleLog(() => cmdStatus(stateManager, "goal-product-completion"));
      const cliDiagnostic = await captureConsoleLog(() =>
        cmdStatus(stateManager, "goal-product-completion", undefined, { diagnostic: true }));

      expect(chatStatus.success).toBe(true);
      expect(chatStatus.output).toContain("Current goal");
      expect(chatStatus.output).toContain("Operator approval needed");
      expect(chatStatus.output).toContain("Background work is blocked");
      expect(chatStatus.output).not.toContain("report-product-completion-raw");
      expectNormalSurfaceRedacted(chatStatus.output);

      expect(cliCurrent).toContain("Current goal");
      expect(cliCurrent).toContain("Operator approval needed");
      expectNormalSurfaceRedacted(cliCurrent);

      expect(cliFocused).toContain("# Status: Finish product boundary");
      expect(cliFocused).toContain("Latest Execution Summary");
      expect(cliFocused).toContain("Use detailed status when you need exact IDs and full report content.");
      expectNormalSurfaceRedacted(cliFocused);

      expect(chatDiagnosticStatus.output).toContain("run:coreloop:raw");
      expect(chatDiagnosticStatus.output).toContain("policy:deny");
      expect(cliDiagnostic).toContain("RAW_MEMORY_SLOT");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("derives normal companion policy surfaces without raw memory, readiness, admission, autonomy, policy, or evidence refs", () => {
    const projection = projectCompanionAction({
      decision: decision(),
      context: {
        surface_ref: "surface:gateway:normal",
        surface_kind: "normal_companion",
      },
      approval_request_ref: "approval:notify",
      prepared_artifact_refs: ["draft:notify"],
      evaluated_at: NOW,
    });

    const userFacing = toCompanionUserFacingPolicyProjection(projection);

    expect(userFacing).toEqual({
      schema_version: "companion-user-facing-policy-projection/v1",
      evaluated_at: NOW,
      user_visible_action_kind: "ask_for_approval",
      ordinary_action_policy: "ask",
      next_best_safe_action: "Ask for explicit approval before executing the prepared operation.",
      brief_reason: "Approval is needed before this can run.",
      executes_operation: false,
    });
    expectNormalSurfaceRedacted(JSON.stringify(userFacing));
    expect(JSON.stringify(userFacing)).not.toContain("source_refs");
  });

  it("keeps the product-completion matrix and existing gauntlet fixtures aligned with acceptance coverage", () => {
    const matrix = readFileSync(path.resolve("docs/product/completion-matrix.md"), "utf8");
    for (const required of [
      "DB-first runtime-state ownership",
      "normal-surface redaction",
      "restart/replay equivalence",
      "stale target rejection",
      "duplicate queue/schedule prevention",
      "first-run/package smoke",
    ]) {
      expect(matrix).toContain(required);
    }

    const golden = JSON.parse(readFileSync("tests/golden-traces/p0/fixtures.json", "utf8")) as Array<{ contract_name: string }>;
    const replay = JSON.parse(readFileSync("tests/replay/p0/fixtures.json", "utf8")) as Array<{ contract_name: string }>;
    const goldenNames = golden.map((fixture) => fixture.contract_name);
    const replayNames = replay.map((fixture) => fixture.contract_name);

    expect(goldenNames).toEqual(expect.arrayContaining([
      "gateway_runspec_epoch_changed_rejects_start",
      "runtime_control_latest_other_conversation_blocked",
      "approval_origin_bound_stale_reply_rejected",
      "schedule_side_effect_crash_replay_no_duplicate_execution",
      "schedule_wait_resume_retry_same_due_idempotent",
      "queue_dedupe_inflight_rejects_replacement",
    ]));
    expect(replayNames).toEqual(expect.arrayContaining([
      "gateway_routed_ingress_preserves_reply_target_after_restart",
      "schedule_side_effect_crash_replay_no_duplicate_execution",
      "queue_expired_claim_rejects_late_ack_and_reclaims",
    ]));
  });
});
