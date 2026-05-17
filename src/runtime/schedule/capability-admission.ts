import {
  admitCapabilityDescriptor,
  descriptorFromScheduleEntry,
  type CapabilityAdmissionDecision,
  type CapabilityDescriptor,
  type ScheduleCapabilityDescriptorEntry,
} from "../capability-plane.js";
import type { RuntimeGraphRef } from "../personal-agent/index.js";

export type ScheduleCapabilityAdmission = {
  descriptor: CapabilityDescriptor;
  admission: CapabilityAdmissionDecision;
};

export function admitScheduleCapability(
  entry: ScheduleCapabilityDescriptorEntry,
  actionKind: string,
  rawInput: Record<string, unknown>,
): ScheduleCapabilityAdmission {
  const descriptor = descriptorFromScheduleEntry(entry, actionKind);
  const admission = admitCapabilityDescriptor({
    descriptor,
    rawInput,
    context: {
      preApproved: true,
      authorityRefs: descriptor.authority_requirements.required_refs,
      callId: `schedule:${entry.id}:${actionKind}`,
      stateEpoch: entry.updated_at ?? null,
    },
  });
  return { descriptor, admission };
}

export function scheduleCapabilityAdmissionRefs(input: ScheduleCapabilityAdmission): RuntimeGraphRef[] {
  return [
    { kind: "capability_admission", ref: input.admission.admission_id },
    ...(input.admission.capability_fingerprint
      ? [{ kind: "capability_fingerprint", ref: input.admission.capability_fingerprint }]
      : []),
  ];
}

export function scheduleEscalationCapabilityEntry(
  entry: ScheduleCapabilityDescriptorEntry,
): ScheduleCapabilityDescriptorEntry {
  return {
    id: entry.id,
    name: entry.name,
    layer: "escalation",
    updated_at: entry.updated_at ?? null,
    metadata: entry.metadata,
  };
}
