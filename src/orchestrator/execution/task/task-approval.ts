import { VerificationResultSchema } from "../../../base/types/task.js";
import type { Task, VerificationResult } from "../../../base/types/task.js";
import type { EthicsGate } from "../../../platform/traits/ethics-gate.js";
import type { CapabilityDetector } from "../../../platform/observation/capability-detector.js";
import type { CapabilityAcquisitionTask } from "../../../base/types/capability.js";
import type { TaskCycleResult } from "./task-execution-types.js";
import type { TaskPreExecutionPolicyRecorder } from "./task-pre-execution-policy-trace.js";

// ─── PreExecutionCheckDeps ───

export interface PreExecutionCheckDeps {
  ethicsGate?: EthicsGate;
  capabilityDetector?: CapabilityDetector;
  approvalFn: (task: Task) => Promise<boolean>;
  checkIrreversibleApproval: (task: Task) => Promise<boolean>;
  recordPolicyDecision?: TaskPreExecutionPolicyRecorder;
}

// ─── PreExecutionCheckResult ───

export type PreExecutionCheckResult =
  | { passed: true }
  | { passed: false; result: TaskCycleResult };

// ─── runEthicsCheck ───

/**
 * Run ethics gate check on a task.
 * Returns null if passed, or a TaskCycleResult to return early.
 */
async function runEthicsCheck(
  ethicsGate: EthicsGate,
  approvalFn: (task: Task) => Promise<boolean>,
  task: Task,
  recordPolicyDecision?: TaskPreExecutionPolicyRecorder,
): Promise<TaskCycleResult | null> {
  const ethicsVerdict = await ethicsGate.checkMeans(
    task.id,
    task.work_description,
    task.approach
  );

  if (ethicsVerdict.verdict === "reject") {
    await recordPolicyDecision?.(task, {
      gate: "ethics_reject",
      replayStage: "rejected",
      decision: "block",
      capabilityDecision: "blocked",
      reason: `Ethics gate rejected task: ${ethicsVerdict.reasoning}`,
      permissionRequired: false,
      targetEffect: "execute_tool",
      policyRef: { kind: "intervention_policy", ref: "policy:task-ethics-gate-v1" },
      currentRefs: [{ kind: "ethics_verdict", ref: "reject" }],
      outcomeSummary: "Task execution was blocked by the ethics gate before execution.",
    });
    const rejectedResult = VerificationResultSchema.parse({
      task_id: task.id,
      verdict: "fail",
      confidence: 1.0,
      evidence: [
        {
          layer: "mechanical",
          description: `Ethics gate rejected task: ${ethicsVerdict.reasoning}`,
          confidence: 1.0,
        },
      ],
      dimension_updates: [],
      timestamp: new Date().toISOString(),
    });
    return { task, verificationResult: rejectedResult, action: "discard" };
  }

  if (ethicsVerdict.verdict === "flag") {
    // Treat flag as requiring human approval via the existing approvalFn
    await recordPolicyDecision?.(task, {
      gate: "ethics_flag",
      replayStage: "confirm_required",
      decision: "confirm_required",
      capabilityDecision: "permission_required",
      reason: `Ethics gate flagged task for approval: ${ethicsVerdict.reasoning}`,
      permissionRequired: true,
      targetEffect: "execute_tool",
      policyRef: { kind: "intervention_policy", ref: "policy:task-ethics-gate-v1" },
      currentRefs: [{ kind: "ethics_verdict", ref: "flag" }],
    });
    const approved = await approvalFn(task);
    if (!approved) {
      await recordPolicyDecision?.(task, {
        gate: "ethics_flag",
        replayStage: "approval_denied",
        decision: "block",
        capabilityDecision: "blocked",
        reason: `Ethics flag approval was denied: ${ethicsVerdict.reasoning}`,
        permissionRequired: true,
        targetEffect: "execute_tool",
        policyRef: { kind: "intervention_policy", ref: "policy:task-ethics-gate-v1" },
        currentRefs: [{ kind: "ethics_verdict", ref: "flag" }],
        outcomeSummary: "Task execution was blocked because ethics approval was denied.",
      });
      const flagDeniedResult = VerificationResultSchema.parse({
        task_id: task.id,
        verdict: "fail",
        confidence: 1.0,
        evidence: [
          {
            layer: "mechanical",
            description: `Ethics flag: approval denied. Reasoning: ${ethicsVerdict.reasoning}`,
            confidence: 1.0,
          },
        ],
        dimension_updates: [],
        timestamp: new Date().toISOString(),
      });
      return { task, verificationResult: flagDeniedResult, action: "approval_denied" };
    }
    await recordPolicyDecision?.(task, {
      gate: "ethics_flag",
      replayStage: "approval_granted",
      decision: "allow",
      capabilityDecision: "available",
      reason: `Ethics flag approval was granted: ${ethicsVerdict.reasoning}`,
      permissionRequired: true,
      targetEffect: "execute_tool",
      policyRef: { kind: "intervention_policy", ref: "policy:task-ethics-gate-v1" },
      currentRefs: [{ kind: "ethics_verdict", ref: "flag" }],
    });
  }

  // verdict === "pass" → passed
  return null;
}

// ─── runCapabilityCheck ───

/**
 * Run capability deficiency check on a task.
 * Returns null if passed, or a TaskCycleResult to return early.
 */
async function runCapabilityCheck(
  capabilityDetector: CapabilityDetector,
  task: Task,
  recordPolicyDecision?: TaskPreExecutionPolicyRecorder,
): Promise<TaskCycleResult | null> {
  // Skip for capability_acquisition tasks to prevent infinite delegation loops.
  if (task.task_category === "capability_acquisition") {
    return null;
  }

  const gap = await capabilityDetector.detectDeficiency(task);
  if (gap === null) {
    return null;
  }

  const capabilityResult = VerificationResultSchema.parse({
    task_id: task.id,
    verdict: "fail",
    confidence: 1.0,
    evidence: [
      {
        layer: "mechanical",
        description: `Capability deficiency: ${gap.missing_capability.name} — ${gap.reason}`,
        confidence: 1.0,
      },
    ],
    dimension_updates: [],
    timestamp: new Date().toISOString(),
  });

  // Determine acquisition method. Permissions always require human approval.
  const acquisitionTask = capabilityDetector.planAcquisition(gap);

  if (acquisitionTask.method === "permission_request") {
    // Permissions cannot be autonomously acquired — escalate to human.
    await recordPolicyDecision?.(task, {
      gate: "capability_check",
      replayStage: "permission_required",
      decision: "hold",
      capabilityDecision: "permission_required",
      reason: `Capability permission is required before task execution: ${gap.missing_capability.name} — ${gap.reason}`,
      permissionRequired: true,
      targetEffect: "hold_concern",
      capabilityRefs: [
        { kind: "capability", ref: gap.missing_capability.name },
        { kind: "capability_type", ref: gap.missing_capability.type },
      ],
      policyRef: { kind: "intervention_policy", ref: "policy:task-capability-gate-v1" },
      outcomeSummary: "Task execution was held because the missing capability requires permission.",
    });
    return { task, verificationResult: capabilityResult, action: "escalate" };
  }

  // For tool_creation and service_setup: mark as acquiring and delegate.
  await recordPolicyDecision?.(task, {
    gate: "capability_check",
    replayStage: "capability_acquiring",
    decision: "hold",
    capabilityDecision: "missing",
    reason: `Capability acquisition is required before task execution: ${gap.missing_capability.name} — ${gap.reason}`,
    permissionRequired: false,
    targetEffect: "hold_concern",
    capabilityRefs: [
      { kind: "capability", ref: gap.missing_capability.name },
      { kind: "capability_type", ref: gap.missing_capability.type },
      { kind: "capability_acquisition_method", ref: acquisitionTask.method },
    ],
    policyRef: { kind: "intervention_policy", ref: "policy:task-capability-gate-v1" },
    outcomeSummary: "Task execution was held while PulSeed acquires the missing capability.",
  });
  await capabilityDetector.setCapabilityStatus(
    gap.missing_capability.name,
    gap.missing_capability.type,
    "acquiring"
  );

  return {
    action: "capability_acquiring" as const,
    task,
    verificationResult: capabilityResult,
    acquisition_task: acquisitionTask,
  };
}

// ─── runIrreversibleApprovalCheck ───

/**
 * Run irreversible approval check on a task.
 * Returns null if approved, or a TaskCycleResult to return early.
 */
async function runIrreversibleApprovalCheck(
  checkIrreversibleApproval: (task: Task) => Promise<boolean>,
  task: Task
): Promise<TaskCycleResult | null> {
  const approved = await checkIrreversibleApproval(task);
  if (approved) {
    return null;
  }

  const deniedResult = VerificationResultSchema.parse({
    task_id: task.id,
    verdict: "fail",
    confidence: 1.0,
    evidence: [
      {
        layer: "mechanical",
        description: "Approval denied by human",
        confidence: 1.0,
      },
    ],
    dimension_updates: [],
    timestamp: new Date().toISOString(),
  });

  return {
    task,
    verificationResult: deniedResult,
    action: "approval_denied",
  };
}

// ─── runPreExecutionChecks ───

/**
 * Run all pre-execution checks: ethics, capability, irreversible approval.
 * Returns null if all passed, or a TaskCycleResult to return early.
 */
export async function runPreExecutionChecks(
  deps: PreExecutionCheckDeps,
  task: Task
): Promise<TaskCycleResult | null> {
  // 3a. Ethics means check
  if (deps.ethicsGate) {
    const ethicsResult = await runEthicsCheck(deps.ethicsGate, deps.approvalFn, task, deps.recordPolicyDecision);
    if (ethicsResult !== null) return ethicsResult;
  }

  // 3b. Capability check
  if (deps.capabilityDetector) {
    const capabilityResult = await runCapabilityCheck(deps.capabilityDetector, task, deps.recordPolicyDecision);
    if (capabilityResult !== null) return capabilityResult;
  }

  // 3c. Check irreversible approval
  const approvalResult = await runIrreversibleApprovalCheck(deps.checkIrreversibleApproval, task);
  if (approvalResult !== null) return approvalResult;

  return null;
}
