import type { DeadlineFinalizationArtifact } from "../../../platform/time/deadline-finalization.js";
import type {
  RuntimeEvidenceEntry,
  RuntimeEvidenceOutcome,
} from "../../../runtime/store/evidence-ledger.js";
import type { TaskCycleResult } from "../../execution/task/task-execution-types.js";

type PhaseExecutionStatus = "skipped" | "completed" | "low_confidence" | "failed";

export function selectLatestVerifiedArtifact(
  entriesNewestFirst: RuntimeEvidenceEntry[]
): RuntimeEvidenceEntry | undefined {
  for (const verification of entriesNewestFirst) {
    const verified =
      verification.verification?.verdict === "pass"
      || (verification.kind === "verification" && verification.outcome === "improved");
    if (!verified) continue;
    if (verification.artifacts.length > 0) return verification;

    const taskId = verification.scope.task_id;
    if (!taskId) continue;
    const matchedArtifact = entriesNewestFirst.find((entry) =>
      entry.scope.task_id === taskId
      && entry.occurred_at <= verification.occurred_at
      && entry.artifacts.length > 0
    );
    if (matchedArtifact) return matchedArtifact;
  }
  return undefined;
}

export function bestArtifactFromEvidence(entry: RuntimeEvidenceEntry): DeadlineFinalizationArtifact {
  const primaryArtifact = entry.artifacts[0];
  return {
    id: primaryArtifact?.label ?? entry.id,
    label: primaryArtifact?.label ?? entry.summary ?? entry.result?.summary ?? entry.id,
    kind: primaryArtifact?.kind ?? entry.kind,
    summary: entry.summary ?? entry.result?.summary ?? entry.verification?.summary,
    path: primaryArtifact?.path,
    state_relative_path: primaryArtifact?.state_relative_path,
    url: primaryArtifact?.url,
    occurred_at: entry.occurred_at,
    source: "runtime_evidence_ledger",
  };
}

export function phaseStatusToOutcome(status: PhaseExecutionStatus): RuntimeEvidenceOutcome {
  if (status === "completed") return "continued";
  if (status === "failed") return "failed";
  return "inconclusive";
}

export function taskActionToOutcome(action: TaskCycleResult["action"]): RuntimeEvidenceOutcome {
  if (action === "completed") return "improved";
  if (action === "approval_denied" || action === "capability_acquiring") return "blocked";
  if (action === "discard" || action === "escalate") return "failed";
  return "inconclusive";
}

export function verificationToOutcome(
  verdict: TaskCycleResult["verificationResult"]["verdict"]
): RuntimeEvidenceOutcome {
  if (verdict === "pass") return "improved";
  if (verdict === "fail") return "failed";
  return "inconclusive";
}

export function summarizeVerificationEvidence(
  evidence: TaskCycleResult["verificationResult"]["evidence"]
): string | undefined {
  const summary = evidence.map((item) => item.description).filter(Boolean).join("; ");
  return summary ? truncateOneLine(summary, 500) : undefined;
}

export function truncateOneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}
