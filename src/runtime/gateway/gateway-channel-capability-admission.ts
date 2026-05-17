import type { NotificationEvent } from "../../base/types/plugin.js";
import {
  admitCapabilityDescriptor,
  descriptorFromGatewayChannelAction,
  type CapabilityAdmissionDecision,
  type CapabilityDescriptor,
} from "../capability-plane.js";
import {
  recordExplicitCommandDecision,
  type PersonalAgentRuntimeStore,
  type RuntimeGraphRef,
} from "../personal-agent/index.js";

type GatewayCapabilityTraceSink = Pick<PersonalAgentRuntimeStore, "recordTrace">;

export interface GatewayChannelCapabilityAdmissionRecord {
  readonly channelType: string;
  readonly reportType: string;
  readonly reportId: string;
  readonly routeRef?: string | null;
  readonly descriptor: CapabilityDescriptor;
  readonly admission: CapabilityAdmissionDecision;
}

export type GatewayCapabilityDecisionRecorder = (
  record: GatewayChannelCapabilityAdmissionRecord
) => Promise<void> | void;

export function admitGatewayNotificationCapability(input: {
  channelType: string;
  event: NotificationEvent;
  callId?: string;
}): CapabilityAdmissionDecision {
  return admitGatewayNotificationCapabilityRecord(input).admission;
}

export function admitGatewayNotificationCapabilityRecord(input: {
  channelType: string;
  event: NotificationEvent;
  callId?: string;
}): GatewayChannelCapabilityAdmissionRecord {
  const reportId = [
    input.event.type,
    input.event.goal_id,
    input.event.timestamp,
  ].join(":");
  return admitGatewayChannelActionCapabilityRecord({
    channelType: input.channelType,
    reportType: input.event.type,
    reportId,
    routeRef: `${input.channelType}:${input.event.goal_id}`,
    callId: input.callId ?? `gateway-notification:${input.channelType}:${reportId}`,
  });
}

export function admitGatewayChannelActionCapability(input: {
  channelType: string;
  reportType: string;
  reportId: string;
  routeRef?: string;
  textLength?: number;
  callId?: string;
}): CapabilityAdmissionDecision {
  return admitGatewayChannelActionCapabilityRecord(input).admission;
}

export function admitGatewayChannelActionCapabilityRecord(input: {
  channelType: string;
  reportType: string;
  reportId: string;
  routeRef?: string;
  textLength?: number;
  callId?: string;
}): GatewayChannelCapabilityAdmissionRecord {
  const descriptor = descriptorFromGatewayChannelAction({
    channelType: input.channelType,
    reportType: input.reportType,
    routeRef: input.routeRef,
  });
  const admission = admitCapabilityDescriptor({
    descriptor,
    rawInput: {
      report_id: input.reportId,
      report_type: input.reportType,
      channel_type: input.channelType,
      text_length: input.textLength ?? null,
    },
    context: {
      preApproved: true,
      authorityRefs: descriptor.authority_requirements.required_refs,
      callId: input.callId ?? `gateway-channel-action:${input.channelType}:${input.reportType}:${input.reportId}`,
    },
  });
  if (admission.status !== "allowed") {
    throw new Error(`Capability Plane blocked ${input.channelType} ${input.reportType}: ${admission.reason}`);
  }
  return {
    channelType: input.channelType,
    reportType: input.reportType,
    reportId: input.reportId,
    routeRef: input.routeRef ?? null,
    descriptor,
    admission,
  };
}

export function createGatewayCapabilityDecisionRecorder(input: {
  baseDir: string;
  personalAgentRuntime?: GatewayCapabilityTraceSink;
}): GatewayCapabilityDecisionRecorder {
  return async (record) => {
    await recordGatewayCapabilityDecision({
      ...record,
      baseDir: input.baseDir,
      personalAgentRuntime: input.personalAgentRuntime,
    });
  };
}

export async function recordGatewayCapabilityDecision(input: GatewayChannelCapabilityAdmissionRecord & {
  baseDir: string;
  personalAgentRuntime?: GatewayCapabilityTraceSink;
}): Promise<void> {
  const capabilityRefs = gatewayCapabilityRuntimeGraphRefs(input);
  const sourceEpoch = input.admission.capability_fingerprint ?? input.admission.admission_id;
  await recordExplicitCommandDecision({
    baseDir: input.baseDir,
    personalAgentRuntime: input.personalAgentRuntime,
    surface: "daemon",
    command: `gateway:${input.channelType}:${input.reportType}`,
    sourceId: `gateway:${input.channelType}:${input.reportType}:${input.reportId}`,
    sourceEpoch,
    highWatermark: sourceEpoch,
    replayKey: [
      "gateway_capability",
      input.channelType,
      input.reportType,
      input.reportId,
      sourceEpoch,
    ].join(":"),
    summary: `Gateway ${input.channelType} requested ${input.reportType} delivery through Capability Plane.`,
    target: {
      kind: "notification",
      ref: { kind: "gateway_message", ref: `${input.channelType}:${input.reportId}` },
      effect: "send_notification",
      summary: `Send ${input.reportType} through ${input.channelType}.`,
    },
    decision: "allow",
    capabilityDecision: "available",
    decisionReason: input.admission.reason,
    capabilityRefs,
    currentRefs: [
      { kind: "gateway_channel", ref: input.channelType },
      { kind: "gateway_report", ref: input.reportType },
      ...(input.routeRef ? [{ kind: "gateway_route", ref: input.routeRef }] : []),
      ...capabilityRefs,
    ],
    auditRefs: input.admission.audit_refs.map((ref) => ({ kind: "capability_audit", ref })),
    outcomeSummary: `Capability Plane admitted gateway ${input.channelType} ${input.reportType} delivery.`,
  });
}

function gatewayCapabilityRuntimeGraphRefs(
  input: GatewayChannelCapabilityAdmissionRecord,
): RuntimeGraphRef[] {
  return [
    { kind: "capability", ref: input.descriptor.capability_id },
    { kind: "capability_provider", ref: input.descriptor.provider_ref },
    { kind: "capability_operation", ref: input.descriptor.runtime_graph_refs.operation_ref },
    { kind: "capability_admission", ref: input.admission.admission_id },
    ...(input.admission.capability_fingerprint
      ? [{ kind: "capability_fingerprint", ref: input.admission.capability_fingerprint }]
      : []),
  ];
}
