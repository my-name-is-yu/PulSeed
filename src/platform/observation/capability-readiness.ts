import type { CapabilityVerificationEvidenceSummary } from "../../runtime/store/capability-verification-schemas.js";
import type {
  CapabilityCandidate,
  CapabilityGraph,
  CapabilityOperationContract,
  CapabilityProviderRef,
  CapabilityReadinessGate,
  CapabilityReadinessSnapshot,
  CapabilityReadinessState,
  CapabilitySafeUserVisibleLabel,
} from "./types/capability.js";
import { CapabilityReadinessSnapshotSchema } from "./types/capability.js";

export interface CapabilityReadinessInput {
  graph: CapabilityGraph;
  verificationEvidence?: CapabilityVerificationEvidenceSummary[];
  evaluatedAt?: string;
}

const READINESS_GATE_ORDER: CapabilityReadinessGate[] = [
  "stored",
  "discoverable",
  "loadable",
  "compatible",
  "configured",
  "authenticated",
  "executable_verified",
];

export function buildCapabilityReadinessSnapshots(input: CapabilityReadinessInput): CapabilityReadinessSnapshot[] {
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
  const evidence = input.verificationEvidence ?? [];
  const snapshots: CapabilityReadinessSnapshot[] = [];

  for (const candidate of input.graph.candidates) {
    for (const provider of candidate.providers) {
      for (const operation of candidate.operations) {
        snapshots.push(evaluateOperationReadiness(candidate, provider, operation, evidence, evaluatedAt));
      }
    }
  }

  return snapshots.sort((a, b) => a.snapshot_id.localeCompare(b.snapshot_id));
}

export function safeUserVisibleLabelForReadiness(
  state: CapabilityReadinessState,
  input: {
    missingConfigRefs?: string[];
    missingAuthRefs?: string[];
  } = {}
): CapabilitySafeUserVisibleLabel {
  if (state === "blocked") return "Blocked";
  if (state === "degraded") return "Degraded";
  if (state === "executable_verified") return "Execution substrate verified";
  if ((input.missingConfigRefs ?? []).length > 0) return "Setup required";
  if ((input.missingAuthRefs ?? []).length > 0) return "Auth required";
  if (state === "configured" || state === "authenticated") return "Configured, verification required";
  return "Recorded, not executable";
}

function evaluateOperationReadiness(
  candidate: CapabilityCandidate,
  provider: CapabilityProviderRef,
  operation: CapabilityOperationContract,
  allEvidence: CapabilityVerificationEvidenceSummary[],
  evaluatedAt: string
): CapabilityReadinessSnapshot {
  const assetRef = provider.asset_id ?? provider.provider_id;
  const toolName = toolNameForOperation(candidate, provider, operation);
  const matchingEvidence = allEvidence.filter((summary) =>
    summary.capability_id === candidate.id
    && summary.provider_ref === provider.provider_id
    && summary.asset_ref === assetRef
    && summary.operation_kind === operation.operation_kind
    && summary.tool_name === toolName
    && summary.payload_class === operation.payload_class
    && summary.risk_class === operation.risk_profile
    && summary.side_effect_profile === operation.side_effect_profile
  );
  const staleEvidence = matchingEvidence.filter((summary) =>
    summary.expires_at !== undefined && summary.expires_at <= evaluatedAt
  );
  const activeEvidence = matchingEvidence.filter((summary) =>
    summary.expires_at === undefined || summary.expires_at > evaluatedAt
  );

  const passed = new Set<CapabilityReadinessGate>([
    "stored",
    "discoverable",
    "loadable",
    "compatible",
  ]);
  const failed = new Set<CapabilityReadinessGate>();
  const degraded = new Set<CapabilityReadinessGate>();
  const metadata: Record<string, unknown> = {};

  const configRefs = operation.required
    .filter((ref) => ref.kind === "config")
    .map((ref) => ref.ref);
  const authRefs = operation.required
    .filter((ref) => ref.kind === "auth")
    .map((ref) => ref.ref);

  const statusProjection = projectLegacyStatus(provider.status_ref);
  if (statusProjection) {
    metadata.legacy_status_projection = statusProjection.metadata;
    for (const gate of statusProjection.failed) failed.add(gate);
    for (const gate of statusProjection.degraded) degraded.add(gate);
  }

  const configEvidence = hasSupportingEvidence(activeEvidence, ["configuration_validation"]);
  const authEvidence = hasSupportingEvidence(activeEvidence, ["auth_probe"]);
  const executableEvidence = hasExecutableEvidence(activeEvidence);
  const degradingEvidence = activeEvidence.filter((summary) =>
    summary.readiness_effect === "degrades_readiness"
  );
  const revokedEvidence = activeEvidence.filter((summary) =>
    summary.readiness_effect === "revokes_readiness"
  );

  const missingConfigRefs = configRefs.length > 0 && !configEvidence ? configRefs : [];
  const missingAuthRefs = authRefs.length > 0 && !authEvidence ? authRefs : [];

  if (missingConfigRefs.length > 0) {
    failed.add("configured");
  } else {
    passed.add("configured");
  }

  if (missingAuthRefs.length > 0) {
    failed.add("authenticated");
  } else if (passed.has("configured")) {
    passed.add("authenticated");
  }

  if (operation.verification.required) {
    if (executableEvidence) {
      passed.add("executable_verified");
    } else {
      failed.add("executable_verified");
    }
  }

  if (degradingEvidence.length > 0) {
    degraded.add("degraded");
  }
  if (revokedEvidence.length > 0) {
    failed.add("blocked");
  }

  const state = deriveReadinessState(passed, failed, degraded);
  return CapabilityReadinessSnapshotSchema.parse({
    schema_version: "capability-readiness-snapshot/v1",
    snapshot_id: readinessSnapshotId(candidate.id, provider.provider_id, operation.id),
    capability_id: candidate.id,
    provider_ref: provider.provider_id,
    asset_ref: assetRef,
    operation_id: operation.id,
    operation_kind: operation.operation_kind,
    tool_name: toolName,
    payload_class: operation.payload_class,
    risk_class: operation.risk_profile,
    side_effect_profile: operation.side_effect_profile,
    evaluated_at: evaluatedAt,
    state,
    passed_gates: sortedGates(passed),
    failed_gates: sortedGates(failed),
    degraded_gates: sortedGates(degraded),
    missing_config_refs: missingConfigRefs,
    missing_auth_refs: missingAuthRefs,
    verification_refs: activeEvidence.map((summary) => summary.verification_id).sort(),
    evidence_refs: activeEvidence.flatMap((summary) => [summary.verification_id]).sort(),
    stale_refs: staleEvidence.map((summary) => summary.verification_id).sort(),
    safe_user_visible_label: safeUserVisibleLabelForReadiness(state, {
      missingConfigRefs,
      missingAuthRefs,
    }),
    metadata,
  });
}

function readinessSnapshotId(capabilityId: string, providerRef: string, operationId: string): string {
  return `readiness:${capabilityId}:${providerRef}:${operationId}`;
}

function toolNameForOperation(
  candidate: CapabilityCandidate,
  provider: CapabilityProviderRef,
  operation: CapabilityOperationContract
): string {
  if (provider.provider_kind === "mcp_server") return candidate.name;
  return operation.id;
}

function hasSupportingEvidence(
  evidence: CapabilityVerificationEvidenceSummary[],
  verificationClasses: CapabilityVerificationEvidenceSummary["verification_class"][]
): boolean {
  return evidence.some((summary) =>
    verificationClasses.includes(summary.verification_class)
    && summary.readiness_effect === "supports_readiness"
  );
}

function hasExecutableEvidence(evidence: CapabilityVerificationEvidenceSummary[]): boolean {
  return evidence.some((summary) =>
    summary.readiness_effect === "supports_readiness"
    && (
      summary.evidence_stage === "smoke_verified"
      || summary.evidence_stage === "production_succeeded"
    )
    && (
      summary.verification_class === "smoke_execution"
      || summary.verification_class === "production_caller_path"
      || summary.verification_class === "post_execution_verification"
    )
  );
}

function projectLegacyStatus(status: string | undefined): {
  failed: CapabilityReadinessGate[];
  degraded: CapabilityReadinessGate[];
  metadata: string;
} | null {
  if (status === undefined) return null;
  if (status === "missing" || status === "requested") {
    return { failed: ["blocked"], degraded: [], metadata: status };
  }
  if (status === "acquiring") {
    return { failed: [], degraded: ["degraded"], metadata: status };
  }
  if (status === "verification_failed") {
    return { failed: ["executable_verified"], degraded: ["degraded"], metadata: status };
  }
  return { failed: [], degraded: [], metadata: status };
}

function deriveReadinessState(
  passed: Set<CapabilityReadinessGate>,
  failed: Set<CapabilityReadinessGate>,
  degraded: Set<CapabilityReadinessGate>
): CapabilityReadinessState {
  if (failed.has("blocked")) return "blocked";
  if (degraded.has("degraded")) return "degraded";
  if (passed.has("executable_verified")) return "executable_verified";
  for (let index = READINESS_GATE_ORDER.length - 1; index >= 0; index -= 1) {
    const gate = READINESS_GATE_ORDER[index];
    if (gate && passed.has(gate)) return gate;
  }
  return "blocked";
}

function sortedGates(gates: Set<CapabilityReadinessGate>): CapabilityReadinessGate[] {
  return READINESS_GATE_ORDER
    .filter((gate) => gates.has(gate))
    .concat(gates.has("degraded") ? ["degraded"] : [])
    .concat(gates.has("blocked") ? ["blocked"] : []);
}
