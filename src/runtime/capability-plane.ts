import { createHash } from "node:crypto";
import { z } from "zod/v3";
import type { ITool, ToolCallContext, ToolMetadata } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type {
  CapabilityExecutionContext,
} from "../tools/types.js";
import type { MCPServerConfig } from "../base/types/mcp.js";
import type { PluginState } from "./types/plugin.js";
import type { AgentTask, IAdapter } from "../orchestrator/execution/adapter-layer.js";
import type { ScheduleEntry } from "./types/schedule.js";
import type {
  CapabilityOperationKind,
  CapabilityRiskClass,
  CapabilitySideEffectProfile,
} from "./store/capability-verification-schemas.js";

export const CapabilityProviderKindSchema = z.enum([
  "builtin_tool",
  "tool_executor",
  "run_adapter",
  "direct_adapter",
  "native_plugin",
  "foreign_plugin",
  "mcp_tool",
  "schedule_tool",
  "file_tool",
  "gateway_channel_action",
  "runtime_control_action",
  "runtime_tool",
  "external_action",
]);
export type CapabilityProviderKind = z.infer<typeof CapabilityProviderKindSchema>;

export const CapabilityCredentialScopeKindSchema = z.enum([
  "none",
  "local_config",
  "environment",
  "external_service",
  "runtime_secret",
]);
export type CapabilityCredentialScopeKind = z.infer<typeof CapabilityCredentialScopeKindSchema>;

export const CapabilityCostRiskClassSchema = z.enum(["none", "low", "medium", "high"]);
export type CapabilityCostRiskClass = z.infer<typeof CapabilityCostRiskClassSchema>;

export const CapabilityReadinessStateSchema = z.enum([
  "proposal",
  "disabled",
  "configured",
  "verification_required",
  "executable_verified",
  "degraded",
  "blocked",
]);
export type CapabilityReadinessState = z.infer<typeof CapabilityReadinessStateSchema>;

export const CapabilityAuthorityRequirementsSchema = z.object({
  descriptor_authority_required: z.literal(true).default(true),
  approval_required: z.boolean(),
  runtime_control_required: z.boolean(),
  permission_level: z.string().min(1),
  external_action_authority: z.boolean(),
  required_refs: z.array(z.string().min(1)).default([]),
}).strict();
export type CapabilityAuthorityRequirements = z.infer<typeof CapabilityAuthorityRequirementsSchema>;

export const CapabilityApprovalFingerprintInputsSchema = z.object({
  schema_version: z.literal("capability-approval-fingerprint-inputs/v1"),
  descriptor_fields: z.array(z.string().min(1)).default([]),
  input_fields: z.array(z.string().min(1)).default([]),
  state_refs: z.array(z.string().min(1)).default([]),
  fingerprint: z.string().min(1),
}).strict();
export type CapabilityApprovalFingerprintInputs = z.infer<typeof CapabilityApprovalFingerprintInputsSchema>;

export const CapabilitySandboxRequirementSchema = z.object({
  mode: z.enum(["none", "workspace_write", "danger_full_access"]),
  network: z.boolean().default(false),
  reason: z.string().min(1),
}).strict();
export type CapabilitySandboxRequirement = z.infer<typeof CapabilitySandboxRequirementSchema>;

export const CapabilityCredentialScopeSchema = z.object({
  kind: CapabilityCredentialScopeKindSchema,
  refs: z.array(z.string().min(1)).default([]),
  normal_surface_visible: z.literal(false).default(false),
}).strict();
export type CapabilityCredentialScope = z.infer<typeof CapabilityCredentialScopeSchema>;

export const CapabilityRollbackPlanSchema = z.object({
  kind: z.enum(["none", "reversible", "append_only", "manual", "irreversible", "unknown"]),
  steps: z.array(z.string().min(1)).default([]),
  operator_visible: z.literal(true).default(true),
}).strict();
export type CapabilityRollbackPlan = z.infer<typeof CapabilityRollbackPlanSchema>;

export const CapabilityVerificationProbeSchema = z.object({
  kind: z.enum([
    "none",
    "manifest_validation",
    "configuration_validation",
    "operation_specific_smoke",
    "production_caller_path",
    "operator_review",
  ]),
  required: z.boolean(),
  refs: z.array(z.string().min(1)).default([]),
}).strict();
export type CapabilityVerificationProbe = z.infer<typeof CapabilityVerificationProbeSchema>;

export const CapabilityNormalSurfaceAffordanceSchema = z.object({
  visible: z.boolean(),
  safe_label: z.string().min(1),
  action: z.enum(["none", "show_safe_status", "ask_approval", "operator_only"]),
  raw_catalog_visible: z.literal(false).default(false),
  credential_scope_visible: z.literal(false).default(false),
  approval_fingerprint_visible: z.literal(false).default(false),
  policy_internals_visible: z.literal(false).default(false),
}).strict();
export type CapabilityNormalSurfaceAffordance = z.infer<typeof CapabilityNormalSurfaceAffordanceSchema>;

export const CapabilityOperatorDiagnosticsSchema = z.object({
  explainable: z.literal(true).default(true),
  summary: z.string().min(1),
  diagnostic_refs: z.array(z.string().min(1)).default([]),
}).strict();
export type CapabilityOperatorDiagnostics = z.infer<typeof CapabilityOperatorDiagnosticsSchema>;

export const CapabilityEventReplayRefsSchema = z.object({
  event_log_ref: z.string().min(1),
  replay_policy: z.enum(["append_only", "dedupe_by_idempotency_key", "side_effect_guard"]),
  idempotency_scope: z.string().min(1),
  runtime_graph_refs: z.array(z.string().min(1)).default([]),
}).strict();
export type CapabilityEventReplayRefs = z.infer<typeof CapabilityEventReplayRefsSchema>;

export const CapabilityRuntimeGraphRefsSchema = z.object({
  capability_ref: z.string().min(1),
  provider_ref: z.string().min(1),
  operation_ref: z.string().min(1),
}).strict();
export type CapabilityRuntimeGraphRefs = z.infer<typeof CapabilityRuntimeGraphRefsSchema>;

export const CapabilityDescriptorSchema = z.object({
  schema_version: z.literal("capability-descriptor/v1"),
  capability_id: z.string().min(1),
  provider_kind: CapabilityProviderKindSchema,
  provider_ref: z.string().min(1),
  operation_kind: z.enum(["read", "search", "hint", "prepare", "send", "write", "publish", "delete", "mutate", "run"]),
  authority_requirements: CapabilityAuthorityRequirementsSchema,
  approval_fingerprint_inputs: CapabilityApprovalFingerprintInputsSchema,
  sandbox_requirement: CapabilitySandboxRequirementSchema,
  credential_scope: CapabilityCredentialScopeSchema,
  cost_risk_class: CapabilityCostRiskClassSchema,
  side_effect_profile: z.enum(["none", "read", "send", "write", "publish", "delete", "mutate"]),
  rollback_plan: CapabilityRollbackPlanSchema,
  verification_probe: CapabilityVerificationProbeSchema,
  readiness_state: CapabilityReadinessStateSchema,
  normal_surface_affordance: CapabilityNormalSurfaceAffordanceSchema,
  operator_diagnostics: CapabilityOperatorDiagnosticsSchema,
  event_replay_refs: CapabilityEventReplayRefsSchema,
  runtime_graph_refs: CapabilityRuntimeGraphRefsSchema,
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;
export type CapabilityDescriptorInput = z.input<typeof CapabilityDescriptorSchema>;

export type CapabilityAdmissionStatus = "allowed" | "requires_approval" | "blocked";

export interface CapabilityAdmissionDecision {
  schema_version: "capability-admission-decision/v1";
  admission_id: string;
  status: CapabilityAdmissionStatus;
  reason: string;
  descriptor: CapabilityDescriptor | null;
  capability_fingerprint: string | null;
  audit_refs: string[];
}

export interface CapabilityAdmissionExecutionContext {
  preApproved?: boolean;
  approvalFingerprint?: string | null;
  authorityRefs?: readonly string[];
  allowMissingAuthorityRefs?: boolean;
  cwd?: string;
  goalId?: string;
  runId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  callId?: string | null;
  stateEpoch?: string | null;
}

export interface CapabilityNormalSurfaceProjection {
  schema_version: "capability-normal-surface-projection/v1";
  capability_id: string;
  readiness_state: CapabilityReadinessState;
  safe_label: string;
  action: CapabilityNormalSurfaceAffordance["action"];
  visible: boolean;
}

export class CapabilityRegistry {
  private readonly descriptors = new Map<string, CapabilityDescriptor>();
  private readonly toolNameIndex = new Map<string, string>();

  static fromTools(tools: readonly ITool[]): CapabilityRegistry {
    const registry = new CapabilityRegistry();
    for (const tool of tools) {
      registry.register(descriptorFromTool(tool));
    }
    return registry;
  }

  register(input: CapabilityDescriptorInput): CapabilityDescriptor {
    const descriptor = CapabilityDescriptorSchema.parse(input);
    this.descriptors.set(descriptor.capability_id, descriptor);
    const toolName = descriptor.metadata["tool_name"];
    if (typeof toolName === "string" && toolName.length > 0) {
      this.toolNameIndex.set(toolName, descriptor.capability_id);
    }
    return descriptor;
  }

  get(capabilityId: string): CapabilityDescriptor | null {
    return this.descriptors.get(capabilityId) ?? null;
  }

  getByToolName(toolName: string): CapabilityDescriptor | null {
    const id = this.toolNameIndex.get(toolName);
    return id ? this.get(id) : null;
  }

  list(): CapabilityDescriptor[] {
    return [...this.descriptors.values()].sort((a, b) => a.capability_id.localeCompare(b.capability_id));
  }
}

export class CapabilityPlane {
  constructor(private readonly registry: CapabilityRegistry) {}

  static fromToolRegistry(toolRegistry: Pick<ToolRegistry, "listAll">): CapabilityPlane {
    return new CapabilityPlane(CapabilityRegistry.fromTools(toolRegistry.listAll()));
  }

  static fromDescriptors(descriptors: readonly CapabilityDescriptorInput[]): CapabilityPlane {
    const registry = new CapabilityRegistry();
    for (const descriptor of descriptors) registry.register(descriptor);
    return new CapabilityPlane(registry);
  }

  register(input: CapabilityDescriptorInput): CapabilityDescriptor {
    return this.registry.register(input);
  }

  list(): CapabilityDescriptor[] {
    return this.registry.list();
  }

  explain(capabilityId: string): CapabilityDescriptor | null {
    return this.registry.get(capabilityId);
  }

  resolveToolDescriptor(toolName: string): CapabilityDescriptor | null {
    return this.registry.getByToolName(toolName);
  }

  admitToolExecution(input: {
    tool: ITool;
    rawInput: unknown;
    context: ToolCallContext;
  }): CapabilityAdmissionDecision {
    const descriptor = this.resolveToolDescriptor(input.tool.metadata.name);
    if (!descriptor) {
      return capabilityAdmission({
        status: "blocked",
        reason: `Capability Plane has no descriptor for tool ${input.tool.metadata.name}.`,
        descriptor: null,
        fingerprint: null,
      });
    }

    return admitCapabilityDescriptor({
      descriptor,
      rawInput: input.rawInput,
      context: {
        preApproved: input.context.preApproved,
        cwd: input.context.cwd,
        goalId: input.context.goalId,
        runId: input.context.runId ?? null,
        sessionId: input.context.sessionId ?? null,
        turnId: input.context.turnId ?? null,
        callId: input.context.callId ?? null,
        stateEpoch: input.context.hostToolState?.currentEpoch ?? input.context.hostToolState?.observedEpoch ?? null,
        allowMissingAuthorityRefs: true,
      },
    });
  }
}

export function admitCapabilityDescriptor(input: {
  descriptor: CapabilityDescriptor;
  rawInput: unknown;
  context?: CapabilityAdmissionExecutionContext;
}): CapabilityAdmissionDecision {
  const descriptor = CapabilityDescriptorSchema.parse(input.descriptor);
  const context = input.context ?? {};
  const fingerprint = fingerprintCapabilityDescriptor(descriptor, input.rawInput, context);
  if (descriptor.readiness_state === "blocked" || descriptor.readiness_state === "disabled" || descriptor.readiness_state === "proposal") {
    return capabilityAdmission({
      status: "blocked",
      reason: `${descriptor.capability_id} is ${descriptor.readiness_state}; it cannot execute until descriptor readiness is enabled and verified.`,
      descriptor,
      fingerprint,
    });
  }
  if (descriptor.readiness_state === "verification_required" || descriptor.readiness_state === "degraded") {
    return capabilityAdmission({
      status: "blocked",
      reason: `${descriptor.capability_id} requires verification before execution.`,
      descriptor,
      fingerprint,
    });
  }
  if (context.approvalFingerprint && context.approvalFingerprint !== fingerprint) {
    return capabilityAdmission({
      status: "blocked",
      reason: `${descriptor.capability_id} approval fingerprint mismatch; refusing to execute stale or changed inputs.`,
      descriptor,
      fingerprint,
    });
  }
  const requiredRefs = descriptor.authority_requirements.required_refs;
  if (requiredRefs.length > 0 && context.allowMissingAuthorityRefs !== true) {
    const provided = new Set(context.authorityRefs ?? []);
    const missing = requiredRefs.filter((ref) => !provided.has(ref));
    if (missing.length > 0) {
      if (
        descriptor.authority_requirements.approval_required
        && context.preApproved !== true
        && missing.every((ref) => ref.startsWith("approval:"))
      ) {
        return capabilityAdmission({
          status: "requires_approval",
          reason: `${descriptor.capability_id} requires approval authority refs before ${descriptor.operation_kind}: ${missing.join(", ")}.`,
          descriptor,
          fingerprint,
        });
      }
      return capabilityAdmission({
        status: "blocked",
        reason: `${descriptor.capability_id} missing descriptor authority refs: ${missing.join(", ")}.`,
        descriptor,
        fingerprint,
      });
    }
  }
  if (descriptor.authority_requirements.approval_required && context.preApproved !== true) {
    return capabilityAdmission({
      status: "requires_approval",
      reason: `${descriptor.capability_id} requires approval before ${descriptor.operation_kind}.`,
      descriptor,
      fingerprint,
    });
  }
  return capabilityAdmission({
    status: "allowed",
    reason: `${descriptor.capability_id} admitted by descriptor readiness and authority requirements.`,
    descriptor,
    fingerprint,
  });
}

export function projectCapabilityNormalSurface(descriptor: CapabilityDescriptor): CapabilityNormalSurfaceProjection {
  const parsed = CapabilityDescriptorSchema.parse(descriptor);
  return {
    schema_version: "capability-normal-surface-projection/v1",
    capability_id: parsed.capability_id,
    readiness_state: parsed.readiness_state,
    safe_label: parsed.normal_surface_affordance.safe_label,
    action: parsed.normal_surface_affordance.action,
    visible: parsed.normal_surface_affordance.visible,
  };
}

export function descriptorFromTool(tool: ITool): CapabilityDescriptor {
  const metadata = tool.metadata;
  const providerKind = providerKindForTool(metadata);
  const operationKind = inferOperationKind(metadata);
  const sideEffectProfile = inferSideEffectProfile(metadata, operationKind);
  const riskClass = inferRiskClass(metadata);
  const capabilityId = `capability:${providerKind}:${metadata.name}`;
  const readinessState = readinessStateForTool(metadata, providerKind);
  const approvalRequired = approvalRequiredForTool(metadata, sideEffectProfile, riskClass);
  const credentialScope = credentialScopeForTool(metadata, providerKind);
  const rollbackPlan = rollbackPlanForSideEffect(sideEffectProfile, metadata);
  const descriptorSeed = {
    capability_id: capabilityId,
    provider_kind: providerKind,
    provider_ref: providerRefForTool(metadata, providerKind),
    operation_kind: operationKind,
    permission_level: metadata.permissionLevel,
    side_effect_profile: sideEffectProfile,
    risk_class: riskClass,
    readiness_state: readinessState,
  };

  return CapabilityDescriptorSchema.parse({
    schema_version: "capability-descriptor/v1",
    capability_id: capabilityId,
    provider_kind: providerKind,
    provider_ref: providerRefForTool(metadata, providerKind),
    operation_kind: operationKind,
    authority_requirements: {
      descriptor_authority_required: true,
      approval_required: approvalRequired,
      runtime_control_required: providerKind === "runtime_control_action" || providerKind === "gateway_channel_action",
      permission_level: metadata.permissionLevel,
      external_action_authority: sideEffectProfile === "send" || sideEffectProfile === "publish" || metadata.permissionLevel === "write_remote",
      required_refs: authorityRefsForTool(metadata, providerKind),
    },
    approval_fingerprint_inputs: {
      schema_version: "capability-approval-fingerprint-inputs/v1",
      descriptor_fields: [
        "capability_id",
        "provider_kind",
        "provider_ref",
        "operation_kind",
        "permission_level",
        "side_effect_profile",
        "risk_class",
        "readiness_state",
      ],
      input_fields: ["input", "cwd", "goal_id", "run_id", "session_id", "turn_id", "call_id"],
      state_refs: [],
      fingerprint: stableId(descriptorSeed),
    },
    sandbox_requirement: sandboxRequirementForTool(metadata),
    credential_scope: credentialScope,
    cost_risk_class: riskClass,
    side_effect_profile: sideEffectProfile,
    rollback_plan: rollbackPlan,
    verification_probe: verificationProbeForTool(metadata, sideEffectProfile, readinessState),
    readiness_state: readinessState,
    normal_surface_affordance: normalSurfaceAffordanceForTool(metadata, readinessState, approvalRequired),
    operator_diagnostics: {
      explainable: true,
      summary: operatorSummaryForTool(metadata, providerKind, readinessState),
      diagnostic_refs: [
        `tool:${metadata.name}`,
        `provider:${providerKind}`,
        `permission:${metadata.permissionLevel}`,
      ],
    },
    event_replay_refs: {
      event_log_ref: `runtime-event:capability:${stableId(descriptorSeed)}`,
      replay_policy: sideEffectProfile === "none" || sideEffectProfile === "read" ? "dedupe_by_idempotency_key" : "side_effect_guard",
      idempotency_scope: `${providerKind}:${metadata.name}`,
      runtime_graph_refs: [
        `capability:${capabilityId}`,
        `provider:${providerRefForTool(metadata, providerKind)}`,
        `operation:${metadata.name}:${operationKind}`,
      ],
    },
    runtime_graph_refs: {
      capability_ref: capabilityId,
      provider_ref: providerRefForTool(metadata, providerKind),
      operation_ref: `operation:${metadata.name}:${operationKind}`,
    },
    metadata: {
      tool_name: metadata.name,
      aliases: metadata.aliases,
      tool_tags: metadata.tags,
      tool_is_read_only: metadata.isReadOnly,
      tool_is_destructive: metadata.isDestructive,
      tool_should_defer: metadata.shouldDefer,
      tool_gateway_exposure: metadata.gatewayExposure ?? null,
      tool_activity_category: metadata.activityCategory ?? null,
      requires_network: metadata.requiresNetwork ?? false,
    },
  });
}

export function descriptorsFromMcpServers(servers: readonly MCPServerConfig[]): CapabilityDescriptor[] {
  return servers.flatMap((server) =>
    server.tool_mappings.map((mapping) => {
      const readinessState = server.enabled ? mapping.capability_readiness ?? "disabled" : "disabled";
      const operationKind = mapping.capability_operation_kind ?? "mutate";
      const sideEffectProfile = mapping.capability_side_effect_profile
        ?? (operationKind === "read" ? "read" : "mutate");
      const mutates = sideEffectProfile !== "none" && sideEffectProfile !== "read";
      const capabilityId = `capability:mcp:${server.id}:${mapping.tool_name}`;
      const providerRef = `mcp:${server.id}`;
      const descriptorSeed = {
        capability_id: capabilityId,
        provider_kind: "mcp_tool",
        provider_ref: providerRef,
        operation_kind: operationKind,
        side_effect_profile: sideEffectProfile,
        tool_name: mapping.tool_name,
        enabled: server.enabled,
        readiness_state: readinessState,
      };
      return CapabilityDescriptorSchema.parse({
        schema_version: "capability-descriptor/v1",
        capability_id: capabilityId,
        provider_kind: "mcp_tool",
        provider_ref: providerRef,
        operation_kind: operationKind,
        authority_requirements: {
          descriptor_authority_required: true,
          approval_required: mutates,
          runtime_control_required: mutates,
          permission_level: mutates ? "write_remote" : "read_remote",
          external_action_authority: mutates,
          required_refs: [
            `mcp_server:${server.id}:enabled`,
            `mcp_server:${server.id}:auth_or_env`,
            `mcp:${server.id}:${mapping.tool_name}:operation_contract`,
            `mcp:${server.id}:${mapping.tool_name}:operation_specific_verification`,
          ],
        },
        approval_fingerprint_inputs: {
          schema_version: "capability-approval-fingerprint-inputs/v1",
          descriptor_fields: ["capability_id", "provider_kind", "provider_ref", "operation_kind", "readiness_state"],
          input_fields: ["tool_name", "arguments", "server_id"],
          state_refs: [`mcp_server:${server.id}`],
          fingerprint: stableId(descriptorSeed),
        },
        sandbox_requirement: {
          mode: "danger_full_access",
          network: true,
          reason: "MCP tools run external server code and may mutate external state.",
        },
        credential_scope: {
          kind: "external_service",
          refs: [`mcp_server:${server.id}:env_or_remote_auth`],
          normal_surface_visible: false,
        },
        cost_risk_class: mutates ? "high" : "medium",
        side_effect_profile: sideEffectProfile,
        rollback_plan: {
          kind: mutates ? "manual" : "none",
          steps: mutates
            ? [
                "Inspect the MCP operation-specific event and RuntimeGraph refs.",
                "Use the MCP provider's compensating operation if one exists.",
              ]
            : ["No mutation is expected for a verified read-only MCP datasource mapping."],
          operator_visible: true,
        },
        verification_probe: {
          kind: "operation_specific_smoke",
          required: true,
          refs: [`mcp:${server.id}:${mapping.tool_name}:verification`],
        },
        readiness_state: readinessState,
        normal_surface_affordance: {
          visible: false,
          safe_label: "MCP operation disabled pending mapping and verification",
          action: "operator_only",
          raw_catalog_visible: false,
          credential_scope_visible: false,
          approval_fingerprint_visible: false,
          policy_internals_visible: false,
        },
        operator_diagnostics: {
          explainable: true,
          summary: `Imported MCP tool ${mapping.tool_name} is descriptor-proposed but disabled until mapped, enabled, authorized, and verified.`,
          diagnostic_refs: [`mcp:${server.id}`, `mcp_tool:${mapping.tool_name}`],
        },
        event_replay_refs: {
          event_log_ref: `runtime-event:capability:${stableId(descriptorSeed)}`,
          replay_policy: "side_effect_guard",
          idempotency_scope: `mcp:${server.id}:${mapping.tool_name}`,
          runtime_graph_refs: [capabilityId, providerRef, `operation:mcp:${server.id}:${mapping.tool_name}`],
        },
        runtime_graph_refs: {
          capability_ref: capabilityId,
          provider_ref: providerRef,
          operation_ref: `operation:mcp:${server.id}:${mapping.tool_name}`,
        },
        metadata: {
          server_id: server.id,
          server_enabled: server.enabled,
          tool_name: mapping.tool_name,
          dimension_pattern: mapping.dimension_pattern,
          capability_readiness: readinessState,
          imported_descriptor_proposal: true,
          operation_kind: operationKind,
          side_effect_profile: sideEffectProfile,
        },
      });
    })
  );
}

export function descriptorFromMcpServerTool(input: {
  toolName: string;
  operationKind: CapabilityOperationKind;
  sideEffectProfile: CapabilitySideEffectProfile;
  readinessState?: CapabilityReadinessState;
}): CapabilityDescriptor {
  const providerRef = "mcp_server:pulseed";
  const capabilityId = `capability:mcp_server:pulseed:${input.toolName}`;
  const mutates = input.sideEffectProfile !== "none" && input.sideEffectProfile !== "read";
  const descriptorSeed = {
    capability_id: capabilityId,
    provider_kind: "mcp_tool",
    provider_ref: providerRef,
    operation_kind: input.operationKind,
    tool_name: input.toolName,
  };
  return capabilityDescriptor({
    capabilityId,
    providerKind: "mcp_tool",
    providerRef,
    operationKind: input.operationKind,
    permissionLevel: mutates ? "write_local" : "read_only",
    approvalRequired: mutates,
    runtimeControlRequired: mutates,
    externalActionAuthority: mutates,
    requiredRefs: [
      `mcp_server:pulseed:${input.toolName}:descriptor`,
      `mcp_server:pulseed:${input.toolName}:authority`,
    ],
    fingerprintDescriptorFields: ["capability_id", "provider_kind", "provider_ref", "operation_kind", "readiness_state"],
    fingerprintInputFields: ["tool_name", "arguments"],
    fingerprintStateRefs: [`mcp_server:pulseed:${input.toolName}:state`],
    fingerprintSeed: descriptorSeed,
    sandboxRequirement: {
      mode: mutates ? "workspace_write" : "none",
      network: false,
      reason: mutates
        ? "PulSeed MCP server tool mutates local runtime state."
        : "PulSeed MCP server tool reads local runtime state.",
    },
    credentialScope: {
      kind: "none",
      refs: [],
      normal_surface_visible: false,
    },
    costRiskClass: mutates ? "medium" : "low",
    sideEffectProfile: input.sideEffectProfile,
    rollbackPlan: {
      kind: mutates ? "append_only" : "none",
      steps: mutates
        ? ["Inspect the MCP server tool event and append a compensating runtime operation if needed."]
        : ["No mutation is expected."],
      operator_visible: true,
    },
    verificationProbe: {
      kind: "production_caller_path",
      required: mutates,
      refs: [`mcp_server:pulseed:${input.toolName}:caller-path`],
    },
    readinessState: input.readinessState ?? (mutates ? "disabled" : "executable_verified"),
    normalSurfaceAffordance: {
      visible: false,
      safe_label: mutates ? "MCP mutation disabled pending operator capability enablement" : "MCP read is descriptor-backed",
      action: "operator_only",
      raw_catalog_visible: false,
      credential_scope_visible: false,
      approval_fingerprint_visible: false,
      policy_internals_visible: false,
    },
    operatorDiagnostics: {
      explainable: true,
      summary: `PulSeed MCP server tool ${input.toolName} is represented by a CapabilityDescriptor before execution.`,
      diagnostic_refs: [providerRef, `mcp_server_tool:${input.toolName}`],
    },
    metadata: {
      tool_name: input.toolName,
      internal_mcp_server_tool: true,
    },
  });
}

export function descriptorsFromPluginStates(pluginStates: readonly PluginState[]): CapabilityDescriptor[] {
  return pluginStates.flatMap((state) => state.manifest.capabilities.map((capabilityName) => {
    const providerKind = state.manifest.type === "adapter" ? "direct_adapter" : "native_plugin";
    const operationKind = pluginOperationKind(state.manifest.type);
    const sideEffectProfile = pluginSideEffectProfile(state.manifest.type);
    const riskClass: CapabilityCostRiskClass = sideEffectProfile === "read" ? "low" : "medium";
    const capabilityId = `capability:plugin:${state.name}:${capabilityName}`;
    const providerRef = `plugin:${state.name}`;
    const descriptorSeed = {
      capability_id: capabilityId,
      provider_kind: providerKind,
      provider_ref: providerRef,
      operation_kind: operationKind,
      plugin_status: state.status,
    };
    return CapabilityDescriptorSchema.parse({
      schema_version: "capability-descriptor/v1",
      capability_id: capabilityId,
      provider_kind: providerKind,
      provider_ref: providerRef,
      operation_kind: operationKind,
      authority_requirements: {
        descriptor_authority_required: true,
        approval_required: sideEffectProfile !== "read",
        runtime_control_required: sideEffectProfile !== "read",
        permission_level: sideEffectProfile === "read" ? "read_only" : "write_remote",
        external_action_authority: sideEffectProfile !== "read",
        required_refs: [
          `plugin:${state.name}:proposal`,
          `plugin:${state.name}:manifest`,
          `plugin:${state.name}:operator_review`,
          `plugin:${state.name}:verification`,
        ],
      },
      approval_fingerprint_inputs: {
        schema_version: "capability-approval-fingerprint-inputs/v1",
        descriptor_fields: ["capability_id", "provider_kind", "provider_ref", "operation_kind", "readiness_state"],
        input_fields: ["plugin_name", "operation_input"],
        state_refs: [`plugin:${state.name}:state`],
        fingerprint: stableId(descriptorSeed),
      },
      sandbox_requirement: sideEffectProfile === "read"
        ? { mode: "none", network: state.manifest.permissions.network, reason: "Read-only plugin operation." }
        : { mode: "danger_full_access", network: true, reason: "Plugin operation may mutate external or local state." },
      credential_scope: {
        kind: state.manifest.permissions.network || sideEffectProfile !== "read" ? "external_service" : "local_config",
        refs: [`plugin:${state.name}:permissions`],
        normal_surface_visible: false,
      },
      cost_risk_class: riskClass,
      side_effect_profile: sideEffectProfile,
      rollback_plan: rollbackPlanForSideEffect(sideEffectProfile, {
        ...pluginMetadataStub(state.name),
        isDestructive: false,
      }),
      verification_probe: {
        kind: "operator_review",
        required: true,
        refs: [`plugin:${state.name}:${capabilityName}:verification`],
      },
      readiness_state: state.status === "loaded" ? "verification_required" : "proposal",
      normal_surface_affordance: {
        visible: false,
        safe_label: "Plugin proposal pending operator review",
        action: "operator_only",
        raw_catalog_visible: false,
        credential_scope_visible: false,
        approval_fingerprint_visible: false,
        policy_internals_visible: false,
      },
      operator_diagnostics: {
        explainable: true,
        summary: `Plugin capability ${capabilityName} is descriptor-backed and requires proposal review before executable runtime use.`,
        diagnostic_refs: [`plugin:${state.name}`, `plugin-capability:${capabilityName}`],
      },
      event_replay_refs: {
        event_log_ref: `runtime-event:capability:${stableId(descriptorSeed)}`,
        replay_policy: sideEffectProfile === "read" ? "dedupe_by_idempotency_key" : "side_effect_guard",
        idempotency_scope: `plugin:${state.name}:${capabilityName}`,
        runtime_graph_refs: [capabilityId, providerRef, `operation:plugin:${state.name}:${capabilityName}`],
      },
      runtime_graph_refs: {
        capability_ref: capabilityId,
        provider_ref: providerRef,
        operation_ref: `operation:plugin:${state.name}:${capabilityName}`,
      },
      metadata: {
        plugin_name: state.name,
        plugin_status: state.status,
        plugin_type: state.manifest.type,
        capability_name: capabilityName,
      },
    });
  }));
}

export function descriptorFromAdapter(adapter: IAdapter, task?: Pick<AgentTask, "adapter_type" | "allowed_tools" | "cwd">): CapabilityDescriptor {
  const providerRef = `adapter:${adapter.adapterType}`;
  const capabilityId = `capability:direct_adapter:${adapter.adapterType}`;
  const descriptorSeed = {
    capability_id: capabilityId,
    provider_kind: "direct_adapter",
    provider_ref: providerRef,
    operation_kind: "run",
    adapter_type: adapter.adapterType,
    task_adapter_type: task?.adapter_type ?? adapter.adapterType,
  };
  return capabilityDescriptor({
    capabilityId,
    providerKind: "direct_adapter",
    providerRef,
    operationKind: "run",
    permissionLevel: "execute",
    approvalRequired: true,
    runtimeControlRequired: true,
    externalActionAuthority: true,
    requiredRefs: [
      `adapter:${adapter.adapterType}:descriptor`,
      "run_adapter_tool:admission",
      "adapter:operation_specific_verification",
    ],
    fingerprintDescriptorFields: ["capability_id", "provider_kind", "provider_ref", "operation_kind", "readiness_state"],
    fingerprintInputFields: ["adapter_type", "prompt", "cwd", "allowed_tools"],
    fingerprintStateRefs: [`adapter:${adapter.adapterType}:state`],
    fingerprintSeed: descriptorSeed,
    sandboxRequirement: {
      mode: "danger_full_access",
      network: true,
      reason: "Direct adapter execution can run external agent processes and mutate local or remote state.",
    },
    credentialScope: {
      kind: "external_service",
      refs: [`adapter:${adapter.adapterType}:provider_credentials`],
      normal_surface_visible: false,
    },
    costRiskClass: "high",
    sideEffectProfile: "mutate",
    rollbackPlan: {
      kind: "manual",
      steps: [
        "Inspect the adapter execution event and RuntimeGraph refs.",
        "Use captured file diffs, provider logs, or compensating commits to revert side effects.",
      ],
      operator_visible: true,
    },
    verificationProbe: {
      kind: "production_caller_path",
      required: true,
      refs: [`adapter:${adapter.adapterType}:run-adapter-tool-path`],
    },
    readinessState: "verification_required",
    normalSurfaceAffordance: {
      visible: false,
      safe_label: "Adapter execution requires operator review",
      action: "operator_only",
      raw_catalog_visible: false,
      credential_scope_visible: false,
      approval_fingerprint_visible: false,
      policy_internals_visible: false,
    },
    operatorDiagnostics: {
      explainable: true,
      summary: `Adapter ${adapter.adapterType} is a direct execution provider and must enter through run-adapter or another explicit Capability Plane boundary.`,
      diagnostic_refs: [
        providerRef,
        ...(adapter.capabilities ?? []).map((capability) => `adapter-capability:${capability}`),
      ],
    },
    metadata: {
      adapter_type: adapter.adapterType,
      adapter_capabilities: adapter.capabilities ?? [],
      task_allowed_tools: task?.allowed_tools ?? [],
      task_cwd: task?.cwd ?? null,
    },
  });
}

export type ScheduleCapabilityDescriptorEntry = Pick<ScheduleEntry, "id" | "name" | "metadata"> & {
  layer: ScheduleEntry["layer"] | "escalation";
  updated_at?: string | null;
};

export function descriptorFromScheduleEntry(
  entry: ScheduleCapabilityDescriptorEntry,
  actionKind: string,
): CapabilityDescriptor {
  const providerRef = `schedule:${entry.id}`;
  const operationKind: CapabilityOperationKind =
    entry.layer === "heartbeat" ? "hint"
      : entry.layer === "goal_trigger" ? "run"
        : entry.layer === "escalation" ? "run"
        : actionKind.includes("notification") || actionKind.includes("report") ? "send"
          : "mutate";
  const sideEffectProfile: CapabilitySideEffectProfile =
    operationKind === "hint" ? "none"
      : operationKind === "send" ? "send"
        : operationKind === "run" ? "mutate"
          : "mutate";
  const riskClass: CapabilityCostRiskClass = sideEffectProfile === "none" ? "low" : "medium";
  const capabilityId = `capability:schedule_tool:${entry.layer}:${actionKind}`;
  const descriptorSeed = {
    capability_id: capabilityId,
    provider_kind: "schedule_tool",
    provider_ref: providerRef,
    operation_kind: operationKind,
    entry_id: entry.id,
    action_kind: actionKind,
    entry_updated_at: entry.updated_at ?? "unknown",
  };
  return capabilityDescriptor({
    capabilityId,
    providerKind: "schedule_tool",
    providerRef,
    operationKind,
    permissionLevel: sideEffectProfile === "none" ? "read_only" : "write_local",
    approvalRequired: false,
    runtimeControlRequired: sideEffectProfile !== "none",
    externalActionAuthority: sideEffectProfile === "send",
    requiredRefs: [
      `schedule:${entry.id}:entry`,
      `schedule:${entry.layer}:policy`,
      `schedule:${entry.id}:replay_key`,
    ],
    fingerprintDescriptorFields: ["capability_id", "provider_kind", "provider_ref", "operation_kind", "readiness_state"],
    fingerprintInputFields: ["entry_id", "scheduled_for", "action_kind"],
    fingerprintStateRefs: [`schedule:${entry.id}:updated_at:${entry.updated_at ?? "unknown"}`],
    fingerprintSeed: descriptorSeed,
    sandboxRequirement: {
      mode: sideEffectProfile === "none" ? "none" : "workspace_write",
      network: sideEffectProfile === "send",
      reason: sideEffectProfile === "none"
        ? "Schedule hinting does not mutate external state."
        : "Schedule execution can update runtime state and may dispatch reports.",
    },
    credentialScope: {
      kind: sideEffectProfile === "send" ? "external_service" : "none",
      refs: sideEffectProfile === "send" ? [`schedule:${entry.id}:notification_route`] : [],
      normal_surface_visible: false,
    },
    costRiskClass: riskClass,
    sideEffectProfile,
    rollbackPlan: {
      kind: sideEffectProfile === "none" ? "none" : "append_only",
      steps: sideEffectProfile === "none"
        ? ["No mutation is expected."]
        : ["Use schedule history and runtime event refs to suppress duplicates or append a correcting schedule action."],
      operator_visible: true,
    },
    verificationProbe: {
      kind: "production_caller_path",
      required: sideEffectProfile !== "none",
      refs: [`schedule:${entry.id}:${actionKind}:caller-path`],
    },
    readinessState: "executable_verified",
    normalSurfaceAffordance: {
      visible: false,
      safe_label: "Schedule action is managed by runtime policy",
      action: "operator_only",
      raw_catalog_visible: false,
      credential_scope_visible: false,
      approval_fingerprint_visible: false,
      policy_internals_visible: false,
    },
    operatorDiagnostics: {
      explainable: true,
      summary: `Schedule ${entry.layer} action ${actionKind} is represented by a CapabilityDescriptor and replay-keyed runtime trace.`,
      diagnostic_refs: [providerRef, `schedule-layer:${entry.layer}`, `schedule-action:${actionKind}`],
    },
    metadata: {
      entry_id: entry.id,
      entry_name: entry.name,
      layer: entry.layer,
      action_kind: actionKind,
      activation_kind: entry.metadata?.activation_kind ?? null,
    },
  });
}

export function descriptorFromGatewayChannelAction(input: {
  channelType: string;
  reportType: string;
  routeRef?: string | null;
}): CapabilityDescriptor {
  const providerRef = `gateway_channel:${input.channelType}`;
  const capabilityId = `capability:gateway_channel_action:${input.channelType}:${input.reportType}`;
  const descriptorSeed = {
    capability_id: capabilityId,
    provider_kind: "gateway_channel_action",
    provider_ref: providerRef,
    operation_kind: "send",
    report_type: input.reportType,
    route_ref: input.routeRef ?? null,
  };
  return capabilityDescriptor({
    capabilityId,
    providerKind: "gateway_channel_action",
    providerRef,
    operationKind: "send",
    permissionLevel: "write_remote",
    approvalRequired: false,
    runtimeControlRequired: true,
    externalActionAuthority: true,
    requiredRefs: [
      `notification:${input.reportType}:policy`,
      `gateway_channel:${input.channelType}:configured`,
    ],
    fingerprintDescriptorFields: ["capability_id", "provider_kind", "provider_ref", "operation_kind", "readiness_state"],
    fingerprintInputFields: ["report_id", "report_type", "channel_type"],
    fingerprintStateRefs: [input.routeRef ?? `gateway_channel:${input.channelType}`],
    fingerprintSeed: descriptorSeed,
    sandboxRequirement: {
      mode: "none",
      network: true,
      reason: "Gateway channel action sends to an external configured destination.",
    },
    credentialScope: {
      kind: "runtime_secret",
      refs: [`gateway_channel:${input.channelType}:credentials`],
      normal_surface_visible: false,
    },
    costRiskClass: "medium",
    sideEffectProfile: "send",
    rollbackPlan: {
      kind: "manual",
      steps: [
        "Inspect delivery/outbox RuntimeGraph refs.",
        "Send a correcting follow-up or provider-specific revocation if available.",
      ],
      operator_visible: true,
    },
    verificationProbe: {
      kind: "production_caller_path",
      required: true,
      refs: [`gateway_channel:${input.channelType}:${input.reportType}:dispatch`],
    },
    readinessState: "executable_verified",
    normalSurfaceAffordance: {
      visible: false,
      safe_label: "External delivery is operator-managed",
      action: "operator_only",
      raw_catalog_visible: false,
      credential_scope_visible: false,
      approval_fingerprint_visible: false,
      policy_internals_visible: false,
    },
    operatorDiagnostics: {
      explainable: true,
      summary: `Gateway channel ${input.channelType} can send ${input.reportType} only through descriptor-backed notification policy.`,
      diagnostic_refs: [providerRef, `notification-report:${input.reportType}`],
    },
    metadata: {
      channel_type: input.channelType,
      report_type: input.reportType,
      route_ref: input.routeRef ?? null,
    },
  });
}

export function descriptorFromRuntimeControlAction(action: string): CapabilityDescriptor {
  const providerRef = "runtime_control:operator";
  const capabilityId = `capability:runtime_control_action:${action}`;
  const operationKind = runtimeControlCapabilityOperationKind(action);
  const sideEffectProfile = runtimeControlCapabilitySideEffectProfile(action);
  const approvalRequired = runtimeControlCapabilityRequiresApproval(action);
  const descriptorSeed = {
    capability_id: capabilityId,
    provider_kind: "runtime_control_action",
    provider_ref: providerRef,
    operation_kind: operationKind,
    action,
  };
  return capabilityDescriptor({
    capabilityId,
    providerKind: "runtime_control_action",
    providerRef,
    operationKind,
    permissionLevel: sideEffectProfile === "read" ? "read_only" : "write_local",
    approvalRequired,
    runtimeControlRequired: sideEffectProfile !== "read",
    externalActionAuthority: false,
    requiredRefs: [`runtime_control:${action}:actor`, `runtime_control:${action}:target`],
    fingerprintDescriptorFields: ["capability_id", "provider_kind", "provider_ref", "operation_kind", "readiness_state"],
    fingerprintInputFields: ["actor", "target", "request"],
    fingerprintStateRefs: [`runtime_control:${action}:state`],
    fingerprintSeed: descriptorSeed,
    sandboxRequirement: {
      mode: sideEffectProfile === "read" ? "none" : "workspace_write",
      network: false,
      reason: sideEffectProfile === "read"
        ? "Runtime-control inspection reads local runtime state."
        : "Runtime-control actions mutate local runtime state.",
    },
    credentialScope: {
      kind: "none",
      refs: [],
      normal_surface_visible: false,
    },
    costRiskClass: sideEffectProfile === "read" ? "low" : "medium",
    sideEffectProfile,
    rollbackPlan: {
      kind: sideEffectProfile === "read" ? "none" : "append_only",
      steps: sideEffectProfile === "read"
        ? ["No mutation is expected."]
        : ["Append a compensating runtime-control operation or restore from event-log projection."],
      operator_visible: true,
    },
    verificationProbe: {
      kind: "production_caller_path",
      required: true,
      refs: [`runtime_control:${action}:service`],
    },
    readinessState: "executable_verified",
    normalSurfaceAffordance: {
      visible: false,
      safe_label: "Runtime control requires operator authority",
      action: "operator_only",
      raw_catalog_visible: false,
      credential_scope_visible: false,
      approval_fingerprint_visible: false,
      policy_internals_visible: false,
    },
    operatorDiagnostics: {
      explainable: true,
      summary: `Runtime-control action ${action} is descriptor-backed and approval fingerprinted for operator use.`,
      diagnostic_refs: [providerRef, `runtime-control-action:${action}`],
    },
    metadata: { action },
  });
}

function runtimeControlCapabilityRequiresApproval(action: string): boolean {
  return runtimeControlCapabilityOperationKind(action) !== "read";
}

function runtimeControlCapabilityOperationKind(action: string): CapabilityOperationKind {
  if (action.startsWith("inspect_")
    || action.endsWith(":inspect")
    || action === "summarize_session_without_resuming") {
    return "read";
  }
  return "mutate";
}

function runtimeControlCapabilitySideEffectProfile(action: string): CapabilitySideEffectProfile {
  return runtimeControlCapabilityOperationKind(action) === "read" ? "read" : "mutate";
}

function capabilityDescriptor(input: {
  capabilityId: string;
  providerKind: CapabilityProviderKind;
  providerRef: string;
  operationKind: CapabilityOperationKind;
  permissionLevel: string;
  approvalRequired: boolean;
  runtimeControlRequired: boolean;
  externalActionAuthority: boolean;
  requiredRefs: string[];
  fingerprintDescriptorFields: string[];
  fingerprintInputFields: string[];
  fingerprintStateRefs: string[];
  fingerprintSeed: unknown;
  sandboxRequirement: CapabilitySandboxRequirement;
  credentialScope: CapabilityCredentialScope;
  costRiskClass: CapabilityCostRiskClass;
  sideEffectProfile: CapabilitySideEffectProfile;
  rollbackPlan: CapabilityRollbackPlan;
  verificationProbe: CapabilityVerificationProbe;
  readinessState: CapabilityReadinessState;
  normalSurfaceAffordance: CapabilityNormalSurfaceAffordance;
  operatorDiagnostics: CapabilityOperatorDiagnostics;
  metadata?: Record<string, unknown>;
}): CapabilityDescriptor {
  return CapabilityDescriptorSchema.parse({
    schema_version: "capability-descriptor/v1",
    capability_id: input.capabilityId,
    provider_kind: input.providerKind,
    provider_ref: input.providerRef,
    operation_kind: input.operationKind,
    authority_requirements: {
      descriptor_authority_required: true,
      approval_required: input.approvalRequired,
      runtime_control_required: input.runtimeControlRequired,
      permission_level: input.permissionLevel,
      external_action_authority: input.externalActionAuthority,
      required_refs: input.requiredRefs,
    },
    approval_fingerprint_inputs: {
      schema_version: "capability-approval-fingerprint-inputs/v1",
      descriptor_fields: input.fingerprintDescriptorFields,
      input_fields: input.fingerprintInputFields,
      state_refs: input.fingerprintStateRefs,
      fingerprint: stableId(input.fingerprintSeed),
    },
    sandbox_requirement: input.sandboxRequirement,
    credential_scope: input.credentialScope,
    cost_risk_class: input.costRiskClass,
    side_effect_profile: input.sideEffectProfile,
    rollback_plan: input.rollbackPlan,
    verification_probe: input.verificationProbe,
    readiness_state: input.readinessState,
    normal_surface_affordance: input.normalSurfaceAffordance,
    operator_diagnostics: input.operatorDiagnostics,
    event_replay_refs: {
      event_log_ref: `runtime-event:capability:${stableId(input.fingerprintSeed)}`,
      replay_policy: input.sideEffectProfile === "none" || input.sideEffectProfile === "read"
        ? "dedupe_by_idempotency_key"
        : "side_effect_guard",
      idempotency_scope: `${input.providerKind}:${input.providerRef}:${input.operationKind}`,
      runtime_graph_refs: [
        input.capabilityId,
        input.providerRef,
        `operation:${input.providerRef}:${input.operationKind}`,
      ],
    },
    runtime_graph_refs: {
      capability_ref: input.capabilityId,
      provider_ref: input.providerRef,
      operation_ref: `operation:${input.providerRef}:${input.operationKind}`,
    },
    metadata: input.metadata ?? {},
  });
}

export function descriptorCapabilityExecutionContext(
  descriptor: CapabilityDescriptor,
  toolName: string,
  callId: string | undefined,
): CapabilityExecutionContext {
  return {
    operationId: descriptor.runtime_graph_refs.operation_ref,
    providerRef: descriptor.provider_ref,
    assetRef: descriptor.provider_ref,
    capabilityId: descriptor.capability_id,
    operationKind: descriptor.operation_kind as CapabilityOperationKind,
    toolName,
    payloadClass: `tool-input:${toolName}`,
    riskClass: descriptor.cost_risk_class === "none" ? "low" : descriptor.cost_risk_class as CapabilityRiskClass,
    sideEffectProfile: descriptor.side_effect_profile as CapabilitySideEffectProfile,
    readinessSnapshotRefs: [`readiness:${descriptor.capability_id}:${descriptor.provider_ref}:${descriptor.operation_kind}`],
    executionRefs: [`tool-call:${toolName}:${callId ?? descriptor.approval_fingerprint_inputs.fingerprint}`],
    sideEffectSummary: `${descriptor.operation_kind} through ${descriptor.capability_id} has ${descriptor.side_effect_profile} side-effect profile.`,
    userVisibleEffect: descriptor.normal_surface_affordance.safe_label,
  };
}

export function fingerprintCapabilityApproval(
  descriptor: CapabilityDescriptor,
  rawInput: unknown,
  context: Pick<ToolCallContext, "cwd" | "goalId" | "runId" | "sessionId" | "turnId" | "callId" | "hostToolState">,
): string {
  return fingerprintCapabilityDescriptor(descriptor, rawInput, {
    cwd: context.cwd,
    goalId: context.goalId,
    runId: context.runId ?? null,
    sessionId: context.sessionId ?? null,
    turnId: context.turnId ?? null,
    callId: context.callId ?? null,
    stateEpoch: context.hostToolState?.currentEpoch ?? context.hostToolState?.observedEpoch ?? null,
  });
}

export function fingerprintCapabilityDescriptor(
  descriptor: CapabilityDescriptor,
  rawInput: unknown,
  context: CapabilityAdmissionExecutionContext = {},
): string {
  return stableId({
    descriptor: {
      capability_id: descriptor.capability_id,
      provider_kind: descriptor.provider_kind,
      provider_ref: descriptor.provider_ref,
      operation_kind: descriptor.operation_kind,
      side_effect_profile: descriptor.side_effect_profile,
      readiness_state: descriptor.readiness_state,
      authority_requirements: descriptor.authority_requirements,
      rollback_plan: descriptor.rollback_plan,
      verification_probe: descriptor.verification_probe,
    },
    input: rawInput,
    context: {
      cwd: context.cwd,
      goal_id: context.goalId,
      run_id: context.runId ?? null,
      session_id: context.sessionId ?? null,
      turn_id: context.turnId ?? null,
      call_id: context.callId ?? null,
      state_epoch: context.stateEpoch ?? null,
    },
  });
}

function capabilityAdmission(input: {
  status: CapabilityAdmissionStatus;
  reason: string;
  descriptor: CapabilityDescriptor | null;
  fingerprint: string | null;
}): CapabilityAdmissionDecision {
  return {
    schema_version: "capability-admission-decision/v1",
    admission_id: `capability-admission:${stableId({
      status: input.status,
      reason: input.reason,
      capability_id: input.descriptor?.capability_id ?? "missing",
      fingerprint: input.fingerprint,
    })}`,
    status: input.status,
    reason: input.reason,
    descriptor: input.descriptor,
    capability_fingerprint: input.fingerprint,
    audit_refs: [
      ...(input.descriptor ? [
        input.descriptor.capability_id,
        input.descriptor.provider_ref,
        input.descriptor.runtime_graph_refs.operation_ref,
      ] : ["capability:missing"]),
      ...(input.fingerprint ? [`capability-fingerprint:${input.fingerprint}`] : []),
    ],
  };
}

function providerKindForTool(metadata: ToolMetadata): CapabilityProviderKind {
  if (metadata.name === "run-adapter") return "run_adapter";
  if (metadata.name === "mcp_call_tool" || metadata.name === "mcp_list_tools" || metadata.tags.includes("mcp")) return "mcp_tool";
  if (metadata.tags.includes("schedule")) return "schedule_tool";
  if (
    metadata.permissionLevel === "write_local"
    || metadata.tags.includes("file")
    || metadata.name.includes("file")
    || metadata.name === "read"
    || metadata.name === "grep"
    || metadata.name === "glob"
  ) return "file_tool";
  if (metadata.tags.includes("runtime") || metadata.tags.includes("runtime-control") || metadata.name.includes("runtime_control")) {
    return "runtime_control_action";
  }
  if (metadata.tags.includes("gateway") || metadata.name.includes("notification") || metadata.name.includes("notify")) {
    return "gateway_channel_action";
  }
  if (metadata.tags.includes("plugin") || metadata.name.includes("plugin")) return "native_plugin";
  return "builtin_tool";
}

function providerRefForTool(metadata: ToolMetadata, providerKind: CapabilityProviderKind): string {
  return `${providerKind}:${metadata.name}`;
}

function inferOperationKind(metadata: ToolMetadata): CapabilityOperationKind {
  if (metadata.activityCategory === "search") return "search";
  if (metadata.activityCategory === "read") return "read";
  if (metadata.activityCategory === "planning" || metadata.activityCategory === "approval") return "prepare";
  if (metadata.activityCategory === "file_create" || metadata.activityCategory === "file_modify") return "write";
  if (metadata.activityCategory === "command" || metadata.activityCategory === "test") return "run";
  if (metadata.tags.includes("schedule") && metadata.name.startsWith("run_")) return "run";
  if (metadata.tags.includes("schedule") && metadata.permissionLevel !== "read_only") return "mutate";
  switch (metadata.permissionLevel) {
    case "read_only":
    case "read_metrics":
      return "read";
    case "write_local":
      return "write";
    case "execute":
      return "run";
    case "write_remote":
      return metadata.tags.includes("notifier") ? "send" : "mutate";
  }
}

function inferRiskClass(metadata: ToolMetadata): CapabilityCostRiskClass {
  if (metadata.isDestructive || metadata.permissionLevel === "execute" || metadata.permissionLevel === "write_remote") {
    return "high";
  }
  if (metadata.permissionLevel === "write_local" || metadata.permissionLevel === "read_metrics") {
    return "medium";
  }
  return "low";
}

function inferSideEffectProfile(
  metadata: ToolMetadata,
  operationKind: CapabilityOperationKind,
): CapabilitySideEffectProfile {
  if (operationKind === "hint" || operationKind === "prepare") return "none";
  if (operationKind === "read" || operationKind === "search") return "read";
  if (operationKind === "send") return "send";
  if (operationKind === "write") return "write";
  if (operationKind === "publish") return "publish";
  if (operationKind === "delete") return "delete";
  if (metadata.permissionLevel === "write_local") return "write";
  return "mutate";
}

function readinessStateForTool(metadata: ToolMetadata, providerKind: CapabilityProviderKind): CapabilityReadinessState {
  if (metadata.name === "mcp_call_tool") return "disabled";
  if (metadata.name === "toggle_plugin") return "proposal";
  if (providerKind === "native_plugin" && metadata.name !== "get_plugins") return "proposal";
  return "executable_verified";
}

function approvalRequiredForTool(
  metadata: ToolMetadata,
  sideEffectProfile: CapabilitySideEffectProfile,
  riskClass: CapabilityCostRiskClass,
): boolean {
  if (metadata.isDestructive) return true;
  if (riskClass === "high") return true;
  if (metadata.permissionLevel === "read_metrics") return true;
  return sideEffectProfile !== "none" && sideEffectProfile !== "read";
}

function authorityRefsForTool(metadata: ToolMetadata, providerKind: CapabilityProviderKind): string[] {
  const refs = [
    `descriptor:${providerKind}:${metadata.name}`,
    `permission:${metadata.permissionLevel}`,
  ];
  if (metadata.requiresNetwork) refs.push("permission:network");
  if (metadata.isDestructive) refs.push("approval:destructive-action");
  return refs;
}

function sandboxRequirementForTool(metadata: ToolMetadata): CapabilitySandboxRequirement {
  if (metadata.permissionLevel === "execute" || metadata.permissionLevel === "write_remote") {
    return { mode: "danger_full_access", network: metadata.requiresNetwork === true || metadata.permissionLevel === "write_remote", reason: "Capability can execute commands or mutate external state." };
  }
  if (metadata.permissionLevel === "write_local") {
    return { mode: "workspace_write", network: metadata.requiresNetwork === true, reason: "Capability can write local workspace state." };
  }
  return { mode: "none", network: metadata.requiresNetwork === true, reason: "Capability does not require a write sandbox." };
}

function credentialScopeForTool(metadata: ToolMetadata, providerKind: CapabilityProviderKind): CapabilityCredentialScope {
  if (providerKind === "mcp_tool") {
    return { kind: "external_service", refs: [`mcp:${metadata.name}:env_or_stdio`], normal_surface_visible: false };
  }
  if (metadata.permissionLevel === "write_remote" || metadata.requiresNetwork) {
    return { kind: "external_service", refs: [`tool:${metadata.name}:network_or_remote_credentials`], normal_surface_visible: false };
  }
  if (providerKind === "gateway_channel_action") {
    return { kind: "runtime_secret", refs: [`gateway:${metadata.name}:runtime_config`], normal_surface_visible: false };
  }
  return { kind: "none", refs: [], normal_surface_visible: false };
}

function rollbackPlanForSideEffect(
  sideEffectProfile: CapabilitySideEffectProfile,
  metadata: ToolMetadata,
): CapabilityRollbackPlan {
  if (sideEffectProfile === "none" || sideEffectProfile === "read") {
    return { kind: "none", steps: ["No mutation is expected."], operator_visible: true };
  }
  if (metadata.isDestructive || sideEffectProfile === "delete" || sideEffectProfile === "publish" || sideEffectProfile === "send") {
    return {
      kind: metadata.isDestructive || sideEffectProfile === "delete" ? "irreversible" : "manual",
      steps: [
        "Inspect the runtime event and RuntimeGraph refs for the exact side effect.",
        "Use provider-specific recovery or manual compensation if available.",
      ],
      operator_visible: true,
    };
  }
  return {
    kind: "append_only",
    steps: [
      "Use the event-log idempotency key to identify the mutation.",
      "Apply the provider-specific reverse operation or create a correcting follow-up.",
    ],
    operator_visible: true,
  };
}

function verificationProbeForTool(
  metadata: ToolMetadata,
  sideEffectProfile: CapabilitySideEffectProfile,
  readinessState: CapabilityReadinessState,
): CapabilityVerificationProbe {
  if (readinessState === "proposal" || readinessState === "disabled") {
    return {
      kind: "operator_review",
      required: true,
      refs: [`verification:${metadata.name}:operator-review-required`],
    };
  }
  if (sideEffectProfile === "none" || sideEffectProfile === "read") {
    return {
      kind: "production_caller_path",
      required: false,
      refs: [`verification:${metadata.name}:read-path`],
    };
  }
  return {
    kind: "production_caller_path",
    required: true,
    refs: [`verification:${metadata.name}:side-effect-path`],
  };
}

function normalSurfaceAffordanceForTool(
  metadata: ToolMetadata,
  readinessState: CapabilityReadinessState,
  approvalRequired: boolean,
): CapabilityNormalSurfaceAffordance {
  return {
    visible: metadata.gatewayExposure !== "never",
    safe_label: readinessState === "executable_verified"
      ? approvalRequired
        ? "Available with approval"
        : "Available"
      : readinessState === "proposal"
        ? "Setup proposal pending"
        : "Unavailable",
    action: readinessState === "executable_verified"
      ? approvalRequired ? "ask_approval" : "show_safe_status"
      : "operator_only",
    raw_catalog_visible: false,
    credential_scope_visible: false,
    approval_fingerprint_visible: false,
    policy_internals_visible: false,
  };
}

function operatorSummaryForTool(
  metadata: ToolMetadata,
  providerKind: CapabilityProviderKind,
  readinessState: CapabilityReadinessState,
): string {
  if (metadata.name === "mcp_call_tool") {
    return "Generic MCP calls are disabled until an imported MCP operation is mapped to a PulSeed CapabilityDescriptor and verified.";
  }
  if (metadata.name === "toggle_plugin") {
    return "Plugin enablement is proposal-first; runtime loading requires descriptor-backed review before executable state.";
  }
  return `${metadata.name} is represented as a ${providerKind} descriptor with ${readinessState} readiness.`;
}

function pluginOperationKind(type: PluginState["manifest"]["type"]): CapabilityOperationKind {
  if (type === "data_source" || type === "schedule_source") return "read";
  if (type === "notifier") return "send";
  return "run";
}

function pluginSideEffectProfile(type: PluginState["manifest"]["type"]): CapabilitySideEffectProfile {
  if (type === "data_source" || type === "schedule_source") return "read";
  if (type === "notifier") return "send";
  return "mutate";
}

function pluginMetadataStub(name: string): ToolMetadata {
  return {
    name,
    aliases: [],
    permissionLevel: "write_remote",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: ["plugin"],
  };
}

function stableId(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex").slice(0, 24);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJson((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
