import { createHash } from "node:crypto";
import { z } from "zod";
import type { ApprovalRequiredEvent } from "./approval-broker.js";
import type { RuntimeSessionRegistrySnapshot } from "./session-registry/types.js";
import {
  RuntimeControlOperationKindSchema,
  type RuntimeControlOperation,
  type RuntimeControlOperationKind,
} from "./store/runtime-operation-schemas.js";
import type { RuntimeEvent } from "./types/companion-state.js";

const RuntimeInterfaceSafeNonnegativeIntSchema = z.number().int().nonnegative().safe();
const RuntimeInterfaceIsoTimestampSchema = z.string().datetime();
const RuntimeInterfaceEvidenceRefSchema = z.string().min(1);

export const ResidentRuntimeEnvironmentSchema = z.enum(["local", "dev", "test", "production"]);
export type ResidentRuntimeEnvironment = z.infer<typeof ResidentRuntimeEnvironmentSchema>;

export const ResidentRuntimeConnectionStatusSchema = z.enum(["online", "degraded", "stale", "offline"]);
export type ResidentRuntimeConnectionStatus = z.infer<typeof ResidentRuntimeConnectionStatusSchema>;

export const ResidentRuntimeCapabilityKindSchema = z.enum([
  "runtime_identity",
  "connection_status",
  "event_stream",
  "command_channel",
  "approval_channel",
  "session_registry",
  "dev_connector_projection",
]);
export type ResidentRuntimeCapabilityKind = z.infer<typeof ResidentRuntimeCapabilityKindSchema>;

export const ResidentRuntimeCapabilityChannelSchema = z.enum([
  "inspection",
  "event_stream",
  "command",
  "approval",
  "dev_connector",
]);
export type ResidentRuntimeCapabilityChannel = z.infer<typeof ResidentRuntimeCapabilityChannelSchema>;

export const ResidentRuntimeCapabilityAuthorityScopeSchema = z.enum(["none", "inspect_only"]);
export type ResidentRuntimeCapabilityAuthorityScope = z.infer<typeof ResidentRuntimeCapabilityAuthorityScopeSchema>;

export const ResidentRuntimeIdentitySchema = z.object({
  schema_version: z.literal("resident-runtime-identity-v1").default("resident-runtime-identity-v1"),
  runtime_id: z.string().min(1),
  instance_id: z.string().min(1),
  display_name: z.string().min(1),
  role: z.literal("resident_runtime").default("resident_runtime"),
  environment: ResidentRuntimeEnvironmentSchema,
  runtime_root: z.string().min(1),
  control_base_dir: z.string().min(1),
  generated_at: RuntimeInterfaceIsoTimestampSchema,
}).strict();
export type ResidentRuntimeIdentity = z.infer<typeof ResidentRuntimeIdentitySchema>;

export const RuntimeConnectionStatusSnapshotSchema = z.object({
  schema_version: z.literal("runtime-connection-status-v1").default("runtime-connection-status-v1"),
  status: ResidentRuntimeConnectionStatusSchema,
  observed_at: RuntimeInterfaceIsoTimestampSchema,
  daemon_status: z.string().min(1).nullable(),
  last_daemon_at: RuntimeInterfaceIsoTimestampSchema.nullable(),
  last_event_at: RuntimeInterfaceIsoTimestampSchema.nullable(),
  last_command_at: RuntimeInterfaceIsoTimestampSchema.nullable(),
  stale_after_ms: RuntimeInterfaceSafeNonnegativeIntSchema,
  offline_after_ms: RuntimeInterfaceSafeNonnegativeIntSchema,
  reason: z.string().min(1),
  evidence_refs: z.array(RuntimeInterfaceEvidenceRefSchema),
}).strict();
export type RuntimeConnectionStatusSnapshot = z.infer<typeof RuntimeConnectionStatusSnapshotSchema>;

export const ResidentRuntimeCapabilitySchema = z.object({
  schema_version: z.literal("resident-runtime-capability-v1").default("resident-runtime-capability-v1"),
  capability_id: z.string().min(1),
  kind: ResidentRuntimeCapabilityKindSchema,
  channel: ResidentRuntimeCapabilityChannelSchema,
  available: z.boolean(),
  requires_approval: z.boolean(),
  authority_scope: ResidentRuntimeCapabilityAuthorityScopeSchema,
  authority_granted: z.literal(false).default(false),
  can_execute: z.literal(false).default(false),
  evidence_refs: z.array(RuntimeInterfaceEvidenceRefSchema),
}).strict();
export type ResidentRuntimeCapability = z.infer<typeof ResidentRuntimeCapabilitySchema>;

export const RuntimeCapabilityDiscoverySchema = z.object({
  schema_version: z.literal("runtime-capability-discovery-v1").default("runtime-capability-discovery-v1"),
  generated_at: RuntimeInterfaceIsoTimestampSchema,
  discovery_ref: z.string().min(1),
  authority_granted: z.literal(false).default(false),
  capabilities: z.array(ResidentRuntimeCapabilitySchema),
}).strict().superRefine((discovery, ctx) => {
  for (const [index, capability] of discovery.capabilities.entries()) {
    if (capability.authority_granted !== false || capability.can_execute !== false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "capability discovery must not grant execution authority",
        path: ["capabilities", index],
      });
    }
  }
});
export type RuntimeCapabilityDiscovery = z.infer<typeof RuntimeCapabilityDiscoverySchema>;

export const RuntimeEventStreamEventRefSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  item_ref: z.string().min(1),
  occurred_at: RuntimeInterfaceIsoTimestampSchema,
}).strict();
export type RuntimeEventStreamEventRef = z.infer<typeof RuntimeEventStreamEventRefSchema>;

export const RuntimeEventStreamContractSchema = z.object({
  schema_version: z.literal("runtime-event-stream-contract-v1").default("runtime-event-stream-contract-v1"),
  stream_id: z.string().min(1),
  source: z.literal("runtime_control_db").default("runtime_control_db"),
  high_watermark: z.string().min(1),
  supports_backfill: z.boolean(),
  replay_policy: z.enum(["high_watermark", "latest_only"]),
  last_event_at: RuntimeInterfaceIsoTimestampSchema.nullable(),
  event_refs: z.array(RuntimeEventStreamEventRefSchema),
}).strict();
export type RuntimeEventStreamContract = z.infer<typeof RuntimeEventStreamContractSchema>;

export const RuntimeCommandDispatchStateSchema = z.enum([
  "accepting_admitted_commands",
  "requires_fresh_runtime_evidence",
  "inspection_only_until_online",
]);
export type RuntimeCommandDispatchState = z.infer<typeof RuntimeCommandDispatchStateSchema>;

export const RuntimeCommandChannelContractSchema = z.object({
  schema_version: z.literal("runtime-command-channel-contract-v1").default("runtime-command-channel-contract-v1"),
  channel_id: z.string().min(1),
  accepted_operation_kinds: z.array(RuntimeControlOperationKindSchema),
  enqueue_mode: z.literal("durable_command_envelope").default("durable_command_envelope"),
  idempotency_key_required: z.literal(true).default(true),
  requires_admission: z.literal(true).default(true),
  capability_discovery_grants_authority: z.literal(false).default(false),
  dispatch_state: RuntimeCommandDispatchStateSchema,
  last_command_at: RuntimeInterfaceIsoTimestampSchema.nullable(),
  pending_operation_refs: z.array(z.string().min(1)),
}).strict();
export type RuntimeCommandChannelContract = z.infer<typeof RuntimeCommandChannelContractSchema>;

export const RuntimeApprovalChannelContractSchema = z.object({
  schema_version: z.literal("runtime-approval-channel-contract-v1").default("runtime-approval-channel-contract-v1"),
  channel_id: z.string().min(1),
  pending_count: RuntimeInterfaceSafeNonnegativeIntSchema,
  pending_approval_refs: z.array(z.string().min(1)),
  response_requires_active_approval: z.literal(true).default(true),
  capability_discovery_grants_authority: z.literal(false).default(false),
  reply_surfaces: z.array(z.string().min(1)),
}).strict();
export type RuntimeApprovalChannelContract = z.infer<typeof RuntimeApprovalChannelContractSchema>;

export const RuntimeStaleOfflineHandlingSchema = z.object({
  schema_version: z.literal("runtime-stale-offline-handling-v1").default("runtime-stale-offline-handling-v1"),
  connection_status: ResidentRuntimeConnectionStatusSchema,
  command_policy: z.enum([
    "allow_admitted_commands",
    "require_fresh_runtime_evidence",
    "reject_or_hold_until_online",
  ]),
  approval_policy: z.enum(["accept_active_approval_only", "read_only_until_online"]),
  event_stream_policy: z.enum(["read_current_watermark", "read_only_stale_watermark"]),
  stale_after_ms: RuntimeInterfaceSafeNonnegativeIntSchema,
  offline_after_ms: RuntimeInterfaceSafeNonnegativeIntSchema,
}).strict();
export type RuntimeStaleOfflineHandling = z.infer<typeof RuntimeStaleOfflineHandlingSchema>;

export const RuntimeDevConnectorProjectionSchema = z.object({
  schema_version: z.literal("runtime-dev-connector-projection-v1").default("runtime-dev-connector-projection-v1"),
  connector_id: z.string().min(1),
  runtime_id: z.string().min(1),
  connection_status: ResidentRuntimeConnectionStatusSchema,
  backend_contract_only: z.literal(true).default(true),
  gui_surface_included: z.literal(false).default(false),
  capability_authority_granted: z.literal(false).default(false),
  event_stream_ref: z.string().min(1),
  command_channel_ref: z.string().min(1),
  approval_channel_ref: z.string().min(1),
  capability_refs: z.array(z.string().min(1)),
}).strict();
export type RuntimeDevConnectorProjection = z.infer<typeof RuntimeDevConnectorProjectionSchema>;

export const ResidentRuntimeInterfaceSnapshotSchema = z.object({
  schema_version: z.literal("resident-runtime-interface-v1").default("resident-runtime-interface-v1"),
  generated_at: RuntimeInterfaceIsoTimestampSchema,
  identity: ResidentRuntimeIdentitySchema,
  connection: RuntimeConnectionStatusSnapshotSchema,
  capability_discovery: RuntimeCapabilityDiscoverySchema,
  event_stream: RuntimeEventStreamContractSchema,
  command_channel: RuntimeCommandChannelContractSchema,
  approval_channel: RuntimeApprovalChannelContractSchema,
  stale_offline_handling: RuntimeStaleOfflineHandlingSchema,
  dev_connector_projection: RuntimeDevConnectorProjectionSchema,
  evidence_refs: z.array(RuntimeInterfaceEvidenceRefSchema),
}).strict();
export type ResidentRuntimeInterfaceSnapshot = z.infer<typeof ResidentRuntimeInterfaceSnapshotSchema>;

export interface DeriveRuntimeConnectionStatusInput {
  observedAt: string;
  daemonState?: Record<string, unknown> | null;
  runtimeEvents?: RuntimeEvent[];
  pendingOperations?: RuntimeControlOperation[];
  staleAfterMs?: number;
  offlineAfterMs?: number;
}

export interface BuildResidentRuntimeIdentityInput {
  runtimeRoot: string;
  controlBaseDir: string;
  generatedAt?: string;
  runtimeId?: string;
  instanceId?: string;
  displayName?: string;
  environment?: ResidentRuntimeEnvironment;
}

export interface BuildResidentRuntimeInterfaceSnapshotInput extends BuildResidentRuntimeIdentityInput {
  daemonState?: Record<string, unknown> | null;
  runtimeSessions?: RuntimeSessionRegistrySnapshot | null;
  runtimeEvents?: RuntimeEvent[];
  pendingOperations?: RuntimeControlOperation[];
  pendingApprovals?: ApprovalRequiredEvent[];
  lastOutboxSeq?: number;
  activeWorkers?: Array<Record<string, unknown>>;
  operatorHandoffRefs?: string[];
  staleAfterMs?: number;
  offlineAfterMs?: number;
}

const DEFAULT_STALE_AFTER_MS = 2 * 60 * 1000;
const DEFAULT_OFFLINE_AFTER_MS = 15 * 60 * 1000;

export function buildResidentRuntimeIdentity(input: BuildResidentRuntimeIdentityInput): ResidentRuntimeIdentity {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const runtimeId = input.runtimeId ?? stableRuntimeId("resident-runtime", input.runtimeRoot, input.controlBaseDir);
  return ResidentRuntimeIdentitySchema.parse({
    runtime_id: runtimeId,
    instance_id: input.instanceId ?? stableRuntimeId("resident-runtime-instance", runtimeId, input.runtimeRoot),
    display_name: input.displayName ?? "Seedy Resident Runtime",
    environment: input.environment ?? "local",
    runtime_root: input.runtimeRoot,
    control_base_dir: input.controlBaseDir,
    generated_at: generatedAt,
  });
}

export function deriveRuntimeConnectionStatus(input: DeriveRuntimeConnectionStatusInput): RuntimeConnectionStatusSnapshot {
  const observedAtMs = Date.parse(input.observedAt);
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const offlineAfterMs = input.offlineAfterMs ?? DEFAULT_OFFLINE_AFTER_MS;
  const daemonStatus = stringField(input.daemonState, "status");
  const lastDaemonAt = latestTimestamp([
    stringField(input.daemonState, "last_loop_at"),
    stringField(input.daemonState, "last_resident_at"),
    stringField(input.daemonState, "started_at"),
  ]);
  const lastEventAt = latestTimestamp((input.runtimeEvents ?? []).map((event) => event.occurred_at));
  const lastCommandAt = latestTimestamp((input.pendingOperations ?? []).map((operation) => operation.updated_at));
  const evidenceRefs = [
    ...(input.daemonState ? ["daemon-state:current"] : []),
    ...(lastEventAt ? [`runtime-event:${lastEventAt}`] : []),
    ...(lastCommandAt ? [`runtime-command:${lastCommandAt}`] : []),
  ];

  const status = deriveConnectionStatus({
    daemonStatus,
    lastDaemonAt,
    observedAtMs,
    staleAfterMs,
    offlineAfterMs,
  });

  return RuntimeConnectionStatusSnapshotSchema.parse({
    status: status.status,
    observed_at: input.observedAt,
    daemon_status: daemonStatus,
    last_daemon_at: lastDaemonAt,
    last_event_at: lastEventAt,
    last_command_at: lastCommandAt,
    stale_after_ms: staleAfterMs,
    offline_after_ms: offlineAfterMs,
    reason: status.reason,
    evidence_refs: evidenceRefs,
  });
}

export function buildResidentRuntimeInterfaceSnapshot(
  input: BuildResidentRuntimeInterfaceSnapshotInput
): ResidentRuntimeInterfaceSnapshot {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const identity = buildResidentRuntimeIdentity({ ...input, generatedAt });
  const pendingOperations = input.pendingOperations ?? [];
  const runtimeEvents = input.runtimeEvents ?? [];
  const pendingApprovals = input.pendingApprovals ?? [];
  const connection = deriveRuntimeConnectionStatus({
    observedAt: generatedAt,
    daemonState: input.daemonState,
    runtimeEvents,
    pendingOperations,
    staleAfterMs: input.staleAfterMs,
    offlineAfterMs: input.offlineAfterMs,
  });
  const eventStream = buildRuntimeEventStreamContract(runtimeEvents);
  const commandChannel = buildRuntimeCommandChannelContract(pendingOperations, connection);
  const approvalChannel = buildRuntimeApprovalChannelContract(pendingApprovals);
  const capabilityDiscovery = buildRuntimeCapabilityDiscovery({
    generatedAt,
    connection,
    eventStream,
    commandChannel,
    approvalChannel,
    runtimeSessions: input.runtimeSessions ?? null,
  });
  const staleOfflineHandling = buildRuntimeStaleOfflineHandling(connection);
  const devConnectorProjection = projectDevConnectorRuntimeInterface({
    identity,
    connection,
    eventStream,
    commandChannel,
    approvalChannel,
    capabilityDiscovery,
  });
  const evidenceRefs = [
    "resident-runtime-interface:snapshot",
    ...connection.evidence_refs,
    ...eventStream.event_refs.map((event) => `runtime-event:${event.event_id}`),
    ...pendingOperations.map((operation) => `runtime-operation:${operation.operation_id}`),
    ...pendingApprovals.map((approval) => `approval:${approval.requestId}`),
    ...(input.runtimeSessions ? ["runtime-session-registry:snapshot"] : []),
    ...(input.lastOutboxSeq && input.lastOutboxSeq > 0 ? [`outbox:seq:${input.lastOutboxSeq}`] : []),
    ...(input.activeWorkers ?? []).map((_, index) => `active-worker:${index}`),
    ...(input.operatorHandoffRefs ?? []).map((ref) => `operator-handoff:${ref}`),
  ];

  return ResidentRuntimeInterfaceSnapshotSchema.parse({
    generated_at: generatedAt,
    identity,
    connection,
    capability_discovery: capabilityDiscovery,
    event_stream: eventStream,
    command_channel: commandChannel,
    approval_channel: approvalChannel,
    stale_offline_handling: staleOfflineHandling,
    dev_connector_projection: devConnectorProjection,
    evidence_refs: [...new Set(evidenceRefs)],
  });
}

export function projectDevConnectorRuntimeInterface(input: {
  identity: ResidentRuntimeIdentity;
  connection: RuntimeConnectionStatusSnapshot;
  eventStream: RuntimeEventStreamContract;
  commandChannel: RuntimeCommandChannelContract;
  approvalChannel: RuntimeApprovalChannelContract;
  capabilityDiscovery: RuntimeCapabilityDiscovery;
}): RuntimeDevConnectorProjection {
  return RuntimeDevConnectorProjectionSchema.parse({
    connector_id: `dev-connector:${input.identity.runtime_id}`,
    runtime_id: input.identity.runtime_id,
    connection_status: input.connection.status,
    event_stream_ref: input.eventStream.stream_id,
    command_channel_ref: input.commandChannel.channel_id,
    approval_channel_ref: input.approvalChannel.channel_id,
    capability_refs: input.capabilityDiscovery.capabilities.map((capability) => capability.capability_id),
  });
}

function buildRuntimeCapabilityDiscovery(input: {
  generatedAt: string;
  connection: RuntimeConnectionStatusSnapshot;
  eventStream: RuntimeEventStreamContract;
  commandChannel: RuntimeCommandChannelContract;
  approvalChannel: RuntimeApprovalChannelContract;
  runtimeSessions: RuntimeSessionRegistrySnapshot | null;
}): RuntimeCapabilityDiscovery {
  const capabilities: ResidentRuntimeCapability[] = [
    capability("runtime.identity", "runtime_identity", "inspection", true, false, "inspect_only", ["resident-runtime:identity"]),
    capability(
      "runtime.connection_status",
      "connection_status",
      "inspection",
      true,
      false,
      "inspect_only",
      input.connection.evidence_refs
    ),
    capability(
      "runtime.event_stream",
      "event_stream",
      "event_stream",
      true,
      false,
      "inspect_only",
      [input.eventStream.stream_id]
    ),
    capability(
      "runtime.command_channel",
      "command_channel",
      "command",
      input.commandChannel.dispatch_state !== "inspection_only_until_online",
      true,
      "none",
      [input.commandChannel.channel_id]
    ),
    capability(
      "runtime.approval_channel",
      "approval_channel",
      "approval",
      true,
      false,
      "none",
      [input.approvalChannel.channel_id]
    ),
    capability(
      "runtime.session_registry",
      "session_registry",
      "inspection",
      input.runtimeSessions !== null,
      false,
      "inspect_only",
      input.runtimeSessions ? ["runtime-session-registry:snapshot"] : []
    ),
    capability(
      "runtime.dev_connector_projection",
      "dev_connector_projection",
      "dev_connector",
      true,
      false,
      "none",
      ["runtime-dev-connector:projection"]
    ),
  ];

  return RuntimeCapabilityDiscoverySchema.parse({
    generated_at: input.generatedAt,
    discovery_ref: `runtime-capability-discovery:${input.generatedAt}`,
    capabilities,
  });
}

function buildRuntimeEventStreamContract(events: RuntimeEvent[]): RuntimeEventStreamContract {
  const eventRefs = events
    .slice(-50)
    .map((event) => RuntimeEventStreamEventRefSchema.parse({
      event_id: event.event_id,
      event_type: event.event_type,
      item_ref: event.item_ref,
      occurred_at: event.occurred_at,
    }));
  const lastEvent = eventRefs.at(-1) ?? null;
  return RuntimeEventStreamContractSchema.parse({
    stream_id: "runtime-event-stream:runtime-control-db",
    high_watermark: lastEvent?.event_id ?? "runtime-event-stream:empty",
    supports_backfill: true,
    replay_policy: "high_watermark",
    last_event_at: lastEvent?.occurred_at ?? null,
    event_refs: eventRefs,
  });
}

function buildRuntimeCommandChannelContract(
  pendingOperations: RuntimeControlOperation[],
  connection: RuntimeConnectionStatusSnapshot,
): RuntimeCommandChannelContract {
  const dispatchState = commandDispatchState(connection.status);
  return RuntimeCommandChannelContractSchema.parse({
    channel_id: "runtime-command-channel:runtime-control",
    accepted_operation_kinds: RuntimeControlOperationKindSchema.options as RuntimeControlOperationKind[],
    dispatch_state: dispatchState,
    last_command_at: connection.last_command_at,
    pending_operation_refs: pendingOperations.map((operation) => operation.operation_id),
  });
}

function buildRuntimeApprovalChannelContract(approvals: ApprovalRequiredEvent[]): RuntimeApprovalChannelContract {
  const replySurfaces = new Set<string>();
  for (const approval of approvals) {
    const channel = approval.origin?.channel;
    if (channel) replySurfaces.add(channel);
  }

  return RuntimeApprovalChannelContractSchema.parse({
    channel_id: "runtime-approval-channel:approval-broker",
    pending_count: approvals.length,
    pending_approval_refs: approvals.map((approval) => approval.requestId),
    reply_surfaces: [...replySurfaces].sort(),
  });
}

function buildRuntimeStaleOfflineHandling(connection: RuntimeConnectionStatusSnapshot): RuntimeStaleOfflineHandling {
  return RuntimeStaleOfflineHandlingSchema.parse({
    connection_status: connection.status,
    command_policy: connection.status === "online"
      ? "allow_admitted_commands"
      : connection.status === "offline"
        ? "reject_or_hold_until_online"
        : "require_fresh_runtime_evidence",
    approval_policy: connection.status === "offline" ? "read_only_until_online" : "accept_active_approval_only",
    event_stream_policy: connection.status === "online" ? "read_current_watermark" : "read_only_stale_watermark",
    stale_after_ms: connection.stale_after_ms,
    offline_after_ms: connection.offline_after_ms,
  });
}

function capability(
  capabilityId: string,
  kind: ResidentRuntimeCapabilityKind,
  channel: ResidentRuntimeCapabilityChannel,
  available: boolean,
  requiresApproval: boolean,
  authorityScope: ResidentRuntimeCapabilityAuthorityScope,
  evidenceRefs: string[],
): ResidentRuntimeCapability {
  return ResidentRuntimeCapabilitySchema.parse({
    capability_id: capabilityId,
    kind,
    channel,
    available,
    requires_approval: requiresApproval,
    authority_scope: authorityScope,
    evidence_refs: evidenceRefs,
  });
}

function commandDispatchState(status: ResidentRuntimeConnectionStatus): RuntimeCommandDispatchState {
  if (status === "online") return "accepting_admitted_commands";
  if (status === "offline") return "inspection_only_until_online";
  return "requires_fresh_runtime_evidence";
}

function deriveConnectionStatus(input: {
  daemonStatus: string | null;
  lastDaemonAt: string | null;
  observedAtMs: number;
  staleAfterMs: number;
  offlineAfterMs: number;
}): { status: ResidentRuntimeConnectionStatus; reason: string } {
  if (!input.daemonStatus) {
    return { status: "offline", reason: "missing_daemon_state" };
  }
  if (input.daemonStatus === "crashed" || input.daemonStatus === "stopped" || input.daemonStatus === "stopping") {
    return { status: "offline", reason: `daemon_${input.daemonStatus}` };
  }
  if (!input.lastDaemonAt) {
    return { status: "stale", reason: "daemon_timestamp_missing" };
  }

  const ageMs = input.observedAtMs - Date.parse(input.lastDaemonAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return { status: "degraded", reason: "daemon_timestamp_ambiguous" };
  }
  if (ageMs >= input.offlineAfterMs) {
    return { status: "offline", reason: "daemon_evidence_offline" };
  }
  if (ageMs >= input.staleAfterMs) {
    return { status: "stale", reason: "daemon_evidence_stale" };
  }
  if (input.daemonStatus !== "running" && input.daemonStatus !== "idle") {
    return { status: "degraded", reason: `daemon_${input.daemonStatus}` };
  }
  return { status: "online", reason: "daemon_evidence_fresh" };
}

function latestTimestamp(values: Array<string | null | undefined>): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) continue;
    if (parsed > latestMs) {
      latest = value;
      latestMs = parsed;
    }
  }
  return latest;
}

function stringField(record: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stableRuntimeId(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
  return `${prefix}:${hash}`;
}
