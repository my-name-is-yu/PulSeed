import type { MCPServerConfig } from "../../base/types/mcp.js";
import type { PluginState } from "../../base/types/plugin.js";
import type { BuiltinIntegrationDescriptor } from "../../runtime/types/builtin-integration.js";
import type { AssetView } from "../../runtime/assets/types.js";
import type {
  Capability,
  CapabilityAuthorityScope,
  CapabilityCandidate,
  CapabilityDependencyEdge,
  CapabilityGraph,
  CapabilityGraphProviderKind,
  CapabilityOperationContract,
  CapabilityOperationKind,
  CapabilityPrivacyProfile,
  CapabilityReversibilityProfile,
  CapabilityRiskProfile,
  CapabilitySideEffectProfile,
} from "./types/capability.js";
import {
  CapabilityCandidateSchema,
  CapabilityGraphSchema,
  CapabilityOperationContractSchema,
} from "./types/capability.js";

export interface CapabilityGraphInput {
  assets?: AssetView[];
  legacyCapabilities?: Capability[];
  pluginStates?: PluginState[];
  mcpServers?: MCPServerConfig[];
  builtinIntegrations?: BuiltinIntegrationDescriptor[];
  generatedAt?: string;
}

export function buildCompanionCapabilityGraph(input: CapabilityGraphInput = {}): CapabilityGraph {
  const builder = new CapabilityGraphBuilder(input.generatedAt ?? new Date().toISOString());

  for (const asset of input.assets ?? []) {
    builder.addCandidates(projectAsset(asset));
  }
  for (const plugin of input.pluginStates ?? []) {
    builder.addCandidates(projectPluginState(plugin));
  }
  for (const server of input.mcpServers ?? []) {
    builder.addCandidates(projectMcpServerConfig(server));
  }
  for (const integration of input.builtinIntegrations ?? []) {
    builder.addCandidates(projectBuiltinIntegration(integration));
  }
  for (const capability of input.legacyCapabilities ?? []) {
    builder.addCandidates(projectLegacyCapability(capability));
  }

  return builder.toGraph();
}

export function listCompanionCapabilityGraphExamples(generatedAt = new Date().toISOString()): CapabilityGraph {
  const builder = new CapabilityGraphBuilder(generatedAt);
  builder.addCandidates([
    exampleCandidate("send_slack_notification", "Slack notification", "Illustrates notification provider dependencies.", "notifier", [
      requirement("asset", "asset:notifier/slack", "Slack notifier asset exists."),
      requirement("config", "notification_route:slack", "A route is configured."),
      requirement("admission", "admission:notification_route", "Notification route admission is separate from readiness."),
      requirement("permission", "permission:network", "Network access is required."),
      requirement("verification", "verification:send_slack_notification", "Send operation needs smoke or production evidence."),
    ], operation("send_slack_notification.send", "send", "send", "external_service", "medium", "irreversible", "requires_runtime_selection", true, "notification_payload", true)),
    exampleCandidate("run_browser_workflow", "Browser workflow", "Illustrates interactive automation provider dependencies.", "interactive_automation_provider", [
      requirement("asset", "asset:interactive_automation_provider/browser", "Interactive automation provider exists."),
      requirement("config", "interactive_automation:enabled", "Provider is enabled by configuration."),
      requirement("auth", "browser_session:validated", "Authenticated sessions need staleness checks."),
      requirement("admission", "runtime_control:admission", "Runtime control remains the final admission point."),
      requirement("permission", "permission:tool_runtime", "Tool permission policy is required."),
    ], operation("run_browser_workflow.run", "run", "mutate", "external_service", "high", "unknown", "requires_runtime_selection", true, "browser_workflow", true)),
    exampleCandidate("soil_query", "Soil query", "Illustrates internal Soil retrieval without external-action authority.", "soil_surface", [
      requirement("asset", "asset:soil_surface/query", "Soil surface exists."),
    ], operation("soil_query.search", "search", "read", "workspace_private", "low", "reversible", "internal_knowledge_only", false, "soil_query", false)),
    exampleCandidate("knowledge_search", "Knowledge search", "Illustrates internal Knowledge recall without external-action authority.", "knowledge_surface", [
      requirement("asset", "asset:knowledge_surface/search", "Knowledge surface exists."),
    ], operation("knowledge_search.search", "search", "read", "workspace_private", "low", "reversible", "internal_knowledge_only", false, "knowledge_query", false)),
    exampleCandidate("dream_procedural_hint_use", "Dream procedural hint use", "Illustrates verifier-gated planning hints without execution authority.", "dream_procedural_hint", [
      requirement("asset", "asset:dream_procedural_hint/playbook", "Dream procedural hint exists."),
    ], operation("dream_procedural_hint_use.hint", "hint", "none", "local_private", "low", "reversible", "planning_hint_only", false, "planning_context", false)),
  ]);
  return builder.toGraph();
}

class CapabilityGraphBuilder {
  private readonly candidates = new Map<string, CapabilityCandidate>();
  private readonly edges = new Map<string, CapabilityDependencyEdge>();

  constructor(private readonly generatedAt: string) {}

  addCandidates(candidates: CapabilityCandidate[]): void {
    for (const candidate of candidates) {
      const parsed = CapabilityCandidateSchema.parse(candidate);
      const existing = this.candidates.get(parsed.id);
      const next = existing ? mergeCandidate(existing, parsed) : parsed;
      this.candidates.set(parsed.id, next);
      for (const operation of parsed.operations) {
        for (const req of operation.required) {
          this.addEdge({
            from: parsed.id,
            to: req.ref,
            kind: "requires",
            reason: req.reason,
          });
        }
      }
      for (const provider of parsed.providers) {
        this.addEdge({
          from: provider.provider_id,
          to: parsed.id,
          kind: "provides",
          reason: `${provider.provider_kind} provider contributes a capability candidate.`,
        });
      }
    }
  }

  toGraph(): CapabilityGraph {
    return CapabilityGraphSchema.parse({
      schema_version: "companion-capability-graph/v1",
      generated_at: this.generatedAt,
      candidates: [...this.candidates.values()].sort((a, b) => a.id.localeCompare(b.id)),
      dependency_edges: [...this.edges.values()].sort((a, b) =>
        `${a.from}\0${a.to}\0${a.kind}`.localeCompare(`${b.from}\0${b.to}\0${b.kind}`)
      ),
    });
  }

  private addEdge(edge: CapabilityDependencyEdge): void {
    this.edges.set(`${edge.from}\0${edge.to}\0${edge.kind}`, edge);
  }
}

function projectAsset(asset: AssetView): CapabilityCandidate[] {
  if (asset.kind === "soil_surface") {
    return [surfaceCandidate(asset, "soil_query", "Soil query", "search", "read", "workspace_private", "internal_knowledge_only", "soil_query")];
  }
  if (asset.kind === "knowledge_surface") {
    return [surfaceCandidate(asset, "knowledge_search", "Knowledge search", "search", "read", "workspace_private", "internal_knowledge_only", "knowledge_query")];
  }
  if (asset.kind === "dream_procedural_hint") {
    return [candidateFromContract({
      id: "capability:dream_procedural_hint_use",
      name: "Dream procedural hint use",
      description: "Verifier-gated Dream procedural hints can inform planning but cannot grant execution authority.",
      providerKind: "dream_procedural_hint",
      providerId: asset.id,
      assetId: asset.id,
      contract: withAssetRequirement(operation(
        "dream_procedural_hint_use.hint",
        "hint",
        "none",
        "local_private",
        "low",
        "reversible",
        "planning_hint_only",
        false,
        "planning_context",
        false
      ), asset.id),
      sourceRefs: [asset.id],
      metadata: {
        planning_hint_only: true,
        execution_authority: false,
        ignored_operation_contracts: parseOperationContracts(asset.metadata?.["operation_contracts"]).length,
      },
    })];
  }

  const explicitContracts = parseOperationContracts(asset.metadata?.["operation_contracts"]);
  const explicit = explicitContracts.map((contract) =>
    candidateFromContract({
      id: `capability:${contract.id}`,
      name: contract.id,
      description: `Capability candidate from ${asset.kind} asset ${asset.id}.`,
      providerKind: providerKindForAsset(asset.kind),
      providerId: asset.id,
      assetId: asset.id,
      contract: withAssetRequirement(contract, asset.id),
      sourceRefs: [asset.id],
      metadata: {
        asset_kind: asset.kind,
        asset_status: asset.status,
      },
    })
  );
  if (explicit.length > 0) return explicit;
  return [];
}

function projectPluginState(plugin: PluginState): CapabilityCandidate[] {
  if (plugin.status !== "loaded") return [];
  return plugin.manifest.capabilities.map((capability) => {
    const providerKind: CapabilityGraphProviderKind = "native_plugin";
    const operationKind = operationKindForPluginType(plugin.manifest.type);
    const sideEffect = sideEffectForPluginType(plugin.manifest.type);
    return candidateFromContract({
      id: `capability:${capability}`,
      name: capability,
      description: `Capability candidate declared by loaded native plugin ${plugin.name}.`,
      providerKind,
      providerId: `plugin:${plugin.name}`,
      runtimeRef: `plugin_loader:${plugin.name}`,
      contract: operation(
        `${capability}.${operationKind}`,
        operationKind,
        sideEffect,
        sideEffect === "read" ? "workspace_private" : "external_service",
        sideEffect === "read" ? "low" : "medium",
        sideEffect === "read" ? "reversible" : "unknown",
        "requires_runtime_selection",
        sideEffect !== "read",
        plugin.manifest.type,
        true,
        pluginRequirements(plugin.name, plugin.manifest.type, sideEffect)
      ),
      sourceRefs: [`plugin:${plugin.name}`],
      metadata: {
        plugin_type: plugin.manifest.type,
        legacy_status: plugin.status,
      },
    });
  });
}

function pluginRequirements(
  pluginName: string,
  pluginType: PluginState["manifest"]["type"],
  sideEffect: CapabilitySideEffectProfile
): CapabilityOperationContract["required"] {
  const refs: CapabilityOperationContract["required"] = [
    requirement("runtime_state", `plugin_loader:${pluginName}:loaded`, "Native plugin loader must report the plugin as loaded."),
    requirement("config", `plugin:${pluginName}:config`, "Plugin configuration must be present and valid for the selected operation."),
    requirement("verification", `plugin:${pluginName}:${pluginType}`, "Operation-specific plugin smoke or production evidence is required before readiness can be projected."),
  ];
  if (sideEffect !== "read") {
    refs.push(
      requirement("admission", "runtime_control:admission", "Runtime control remains the final admission point for side-effecting plugin operations."),
      requirement("permission", `plugin:${pluginName}:permissions`, "Declared plugin permissions must be admitted for the selected operation.")
    );
  }
  return refs;
}

function projectMcpServerConfig(server: MCPServerConfig): CapabilityCandidate[] {
  return server.tool_mappings.map((mapping) => candidateFromContract({
    id: `capability:mcp:${server.id}:${mapping.tool_name}`,
    name: mapping.tool_name,
    description: `MCP tool mapping candidate for server ${server.id}.`,
    providerKind: "mcp_server",
    providerId: `mcp:${server.id}`,
    runtimeRef: `mcp_server:${server.id}`,
    contract: operation(
      `mcp.${server.id}.${mapping.tool_name}.read`,
      "read",
      "read",
      "workspace_private",
      "low",
      "reversible",
      "requires_runtime_selection",
      false,
      "mcp_tool_call",
      true,
      [
        requirement("config", `mcp_server:${server.id}:enabled`, "MCP server must be enabled by operator configuration."),
        requirement("auth", `mcp_server:${server.id}:auth_or_env`, "MCP auth/env must be valid."),
        requirement("verification", `mcp:${server.id}:${mapping.tool_name}:read`, "Read operation needs operation-specific verification."),
      ]
    ),
    sourceRefs: [`mcp:${server.id}`],
    metadata: {
      dimension_pattern: mapping.dimension_pattern,
      server_enabled: server.enabled,
    },
  }));
}

function projectBuiltinIntegration(integration: BuiltinIntegrationDescriptor): CapabilityCandidate[] {
  if (integration.id === "interactive-automation") {
    return [exampleCandidate("run_browser_workflow", "Browser workflow", integration.description, "builtin_integration", [
      requirement("asset", "builtin:interactive-automation", "Interactive automation integration exists."),
      requirement("config", "interactive_automation:enabled", "Interactive automation must be enabled by configuration."),
      requirement("admission", "runtime_control:admission", "Runtime control remains the final admission point."),
      requirement("permission", "permission:tool_runtime", "Tool permission policy is required."),
    ], operation("run_browser_workflow.run", "run", "mutate", "external_service", "high", "unknown", "requires_runtime_selection", true, "browser_workflow", true))];
  }
  if (integration.id === "mcp-bridge") {
    return [exampleCandidate("mcp_server_import", "MCP server import", integration.description, "builtin_integration", [
      requirement("asset", "builtin:mcp-bridge", "MCP bridge integration exists."),
    ], operation("mcp_server_import.prepare", "prepare", "none", "local_private", "low", "append_only", "requires_runtime_selection", false, "mcp_server_config", false))];
  }
  if (integration.id === "foreign-plugin-bridge") {
    return [exampleCandidate("foreign_plugin_import_review", "Foreign plugin import review", integration.description, "builtin_integration", [
      requirement("asset", "builtin:foreign-plugin-bridge", "Foreign plugin bridge integration exists."),
    ], operation("foreign_plugin_import_review.prepare", "prepare", "none", "local_private", "low", "append_only", "requires_runtime_selection", false, "foreign_plugin_manifest", false))];
  }
  if (integration.id === "soil-display") {
    return [exampleCandidate("soil_projection_materialize", "Soil projection materialize", integration.description, "builtin_integration", [
      requirement("asset", "builtin:soil-display", "Soil display integration exists."),
    ], operation("soil_projection_materialize.write", "write", "write", "workspace_private", "low", "append_only", "requires_runtime_selection", false, "soil_projection", true))];
  }
  return [];
}

function projectLegacyCapability(capability: Capability): CapabilityCandidate[] {
  const contract = parseOperationContracts((capability as Capability & { operation_contracts?: unknown }).operation_contracts);
  return contract.map((operationContract) => candidateFromContract({
    id: `capability:${operationContract.id}`,
    name: capability.name,
    description: capability.description,
    providerKind: "legacy_capability",
    providerId: `legacy:${capability.id}`,
    statusRef: capability.status,
    contract: operationContract,
    sourceRefs: [`legacy:${capability.id}`],
    metadata: {
      legacy_status: capability.status,
      legacy_type: capability.type,
    },
  }));
}

function candidateFromContract(input: {
  id: string;
  name: string;
  description: string;
  providerKind: CapabilityGraphProviderKind;
  providerId: string;
  assetId?: string;
  runtimeRef?: string;
  statusRef?: string;
  contract: CapabilityOperationContract;
  sourceRefs: string[];
  metadata?: Record<string, unknown>;
}): CapabilityCandidate {
  return CapabilityCandidateSchema.parse({
    id: input.id,
    name: input.name,
    description: input.description,
    providers: [{
      provider_id: input.providerId,
      provider_kind: input.providerKind,
      ...(input.assetId ? { asset_id: input.assetId } : {}),
      ...(input.runtimeRef ? { runtime_ref: input.runtimeRef } : {}),
      ...(input.statusRef ? { status_ref: input.statusRef } : {}),
    }],
    operations: [input.contract],
    source_refs: input.sourceRefs,
    metadata: input.metadata ?? {},
  });
}

function surfaceCandidate(
  asset: AssetView,
  id: string,
  name: string,
  operationKind: CapabilityOperationKind,
  sideEffect: CapabilitySideEffectProfile,
  privacy: CapabilityPrivacyProfile,
  authorityScope: CapabilityAuthorityScope,
  payloadClass: string
): CapabilityCandidate {
  return candidateFromContract({
    id: `capability:${id}`,
    name,
    description: `${asset.label} is projected as an internal knowledge capability candidate without external-action authority.`,
    providerKind: providerKindForAsset(asset.kind),
    providerId: asset.id,
    assetId: asset.id,
    contract: withAssetRequirement(operation(
      `${id}.${operationKind}`,
      operationKind,
      sideEffect,
      privacy,
      "low",
      "reversible",
      authorityScope,
      false,
      payloadClass,
      false
    ), asset.id),
    sourceRefs: [asset.id],
    metadata: {
      external_action_authority: false,
    },
  });
}

function exampleCandidate(
  id: string,
  name: string,
  description: string,
  providerKind: CapabilityGraphProviderKind,
  required: CapabilityOperationContract["required"],
  contract: CapabilityOperationContract
): CapabilityCandidate {
  return candidateFromContract({
    id: `capability:${id}`,
    name,
    description,
    providerKind,
    providerId: `example:${id}`,
    contract: {
      ...contract,
      required,
    },
    sourceRefs: [`example:${id}`],
    metadata: {
      design_example: true,
    },
  });
}

function operation(
  id: string,
  operationKind: CapabilityOperationKind,
  sideEffect: CapabilitySideEffectProfile,
  privacy: CapabilityPrivacyProfile,
  risk: CapabilityRiskProfile,
  reversibility: CapabilityReversibilityProfile,
  authorityScope: CapabilityAuthorityScope,
  externalActionAuthority: boolean,
  payloadClass: string,
  verificationRequired: boolean,
  required: CapabilityOperationContract["required"] = []
): CapabilityOperationContract {
  return CapabilityOperationContractSchema.parse({
    id,
    operation_kind: operationKind,
    side_effect_profile: sideEffect,
    privacy_profile: privacy,
    risk_profile: risk,
    reversibility,
    authority_scope: authorityScope,
    external_action_authority: externalActionAuthority,
    payload_class: payloadClass,
    required,
    verification: {
      required: verificationRequired,
      profile: verificationRequired ? "operation_specific_smoke" : "none",
    },
  });
}

function requirement(
  kind: CapabilityOperationContract["required"][number]["kind"],
  ref: string,
  reason: string
): CapabilityOperationContract["required"][number] {
  return { kind, ref, reason };
}

function withAssetRequirement(contract: CapabilityOperationContract, assetId: string): CapabilityOperationContract {
  return CapabilityOperationContractSchema.parse({
    ...contract,
    required: [
      requirement("asset", assetId, "Capability candidate is derived from this asset record."),
      ...contract.required,
    ],
  });
}

function parseOperationContracts(value: unknown): CapabilityOperationContract[] {
  const values = Array.isArray(value) ? value : [];
  return values.flatMap((candidate) => {
    const parsed = CapabilityOperationContractSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}

function mergeCandidate(left: CapabilityCandidate, right: CapabilityCandidate): CapabilityCandidate {
  return CapabilityCandidateSchema.parse({
    ...left,
    providers: uniqueBy([...left.providers, ...right.providers], (provider) => provider.provider_id),
    operations: uniqueBy([...left.operations, ...right.operations], (contract) => contract.id),
    source_refs: uniqueStrings([...left.source_refs, ...right.source_refs]),
    metadata: {
      ...left.metadata,
      ...right.metadata,
    },
  });
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}

function providerKindForAsset(kind: AssetView["kind"]): CapabilityGraphProviderKind {
  if (kind === "builtin_integration") return "builtin_integration";
  if (kind === "native_plugin") return "native_plugin";
  if (kind === "foreign_plugin") return "foreign_plugin";
  if (kind === "mcp_server") return "mcp_server";
  if (kind === "interactive_automation_provider") return "interactive_automation_provider";
  if (kind === "notifier") return "notifier";
  if (kind === "soil_surface") return "soil_surface";
  if (kind === "knowledge_surface") return "knowledge_surface";
  if (kind === "dream_procedural_hint") return "dream_procedural_hint";
  if (kind === "runtime_tool") return "runtime_tool";
  return "asset";
}

function operationKindForPluginType(type: PluginState["manifest"]["type"]): CapabilityOperationKind {
  if (type === "data_source") return "read";
  if (type === "notifier") return "send";
  if (type === "schedule_source") return "read";
  return "run";
}

function sideEffectForPluginType(type: PluginState["manifest"]["type"]): CapabilitySideEffectProfile {
  if (type === "data_source" || type === "schedule_source") return "read";
  if (type === "notifier") return "send";
  return "mutate";
}
