import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { AutonomyDecision } from "../../src/runtime/control/autonomy-governor.js";
import {
  projectCompanionAction,
  toCompanionUserFacingPolicyProjection,
} from "../../src/runtime/control/companion-action-projection.js";
import { formatRuntimeStatus } from "../../src/interface/chat/chat-runner-runtime.js";
import { formatCurrentGoalSummary } from "../../src/interface/current-goal-summary.js";
import { formatGoalStatusDetails } from "../../src/interface/goal-status-display.js";
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
