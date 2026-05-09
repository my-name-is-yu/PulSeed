import type { StateManager } from "../base/state/state-manager.js";
import { MCPServersConfigSchema, type MCPServerConfig } from "../base/types/mcp.js";
import { buildCompanionCapabilityGraph } from "../platform/observation/capability-graph.js";
import { loadRegistry } from "../platform/observation/capability-registry.js";
import type {
  CapabilityCandidate,
  CapabilityGraph,
  CapabilityOperationContract,
  CapabilityProviderRef,
} from "../platform/observation/types/capability.js";
import { AssetRegistry } from "./assets/registry.js";
import { listBuiltinIntegrations } from "./builtin-integrations.js";
import type {
  CapabilityExecutionContext,
  CapabilityExecutionResolutionInput,
  CapabilityExecutionResolver,
} from "../tools/types.js";

export function createCapabilityExecutionResolver(input: {
  stateManager: StateManager;
  generatedAt?: () => string;
}): CapabilityExecutionResolver {
  return async (resolutionInput) => {
    const graph = await loadCapabilityGraphForExecutionResolution(
      input.stateManager,
      input.generatedAt?.() ?? new Date().toISOString()
    );
    return resolveCapabilityExecutionFromGraph(graph, resolutionInput);
  };
}

export function resolveCapabilityExecutionFromGraph(
  graph: CapabilityGraph,
  input: CapabilityExecutionResolutionInput
): CapabilityExecutionContext | null {
  const matches: Array<{
    score: number;
    candidate: CapabilityCandidate;
    provider: CapabilityProviderRef;
    operation: CapabilityOperationContract;
    toolName: string;
  }> = [];

  for (const candidate of graph.candidates) {
    for (const provider of candidate.providers) {
      for (const operation of candidate.operations) {
        const toolName = toolNameForOperation(candidate, provider, operation);
        if (toolName !== input.toolName) continue;
        matches.push({
          score: operationMatchScore(operation, input),
          candidate,
          provider,
          operation,
          toolName,
        });
      }
    }
  }

  const match = matches.sort((a, b) =>
    b.score - a.score
    || `${a.candidate.id}\0${a.provider.provider_id}\0${a.operation.id}`.localeCompare(
      `${b.candidate.id}\0${b.provider.provider_id}\0${b.operation.id}`
    )
  )[0];
  if (!match) return null;

  const assetRef = match.provider.asset_id ?? match.provider.provider_id;
  return {
    operationId: match.operation.id,
    providerRef: match.provider.provider_id,
    assetRef,
    capabilityId: match.candidate.id,
    operationKind: match.operation.operation_kind,
    toolName: match.toolName,
    payloadClass: match.operation.payload_class,
    riskClass: match.operation.risk_profile,
    sideEffectProfile: match.operation.side_effect_profile,
    readinessSnapshotRefs: [readinessSnapshotId(match.candidate.id, match.provider.provider_id, match.operation.id)],
  };
}

async function loadCapabilityGraphForExecutionResolution(
  stateManager: StateManager,
  generatedAt: string
): Promise<CapabilityGraph> {
  const [assets, legacyCapabilities, mcpServers] = await Promise.all([
    new AssetRegistry({ baseDir: stateManager.getBaseDir() }).list().catch(() => []),
    loadRegistry({ stateManager }).then((registry) => registry.capabilities).catch(() => []),
    loadMcpServers(stateManager),
  ]);
  return buildCompanionCapabilityGraph({
    assets,
    legacyCapabilities,
    mcpServers,
    builtinIntegrations: listBuiltinIntegrations(),
    generatedAt,
  });
}

async function loadMcpServers(stateManager: StateManager): Promise<MCPServerConfig[]> {
  for (const fileName of ["mcp-servers.json", "mcpServers.json"]) {
    const raw = await stateManager.readRaw(fileName);
    if (raw === null) continue;
    const parsed = MCPServersConfigSchema.safeParse(raw);
    return parsed.success ? parsed.data.servers : [];
  }
  return [];
}

function operationMatchScore(
  operation: CapabilityOperationContract,
  input: CapabilityExecutionResolutionInput
): number {
  let score = 0;
  if (operation.operation_kind === input.operationKind) score += 4;
  if (operation.payload_class === input.payloadClass) score += 3;
  if (operation.risk_profile === input.riskClass) score += 2;
  if (operation.side_effect_profile === input.sideEffectProfile) score += 2;
  return score;
}

function toolNameForOperation(
  candidate: CapabilityCandidate,
  provider: CapabilityProviderRef,
  operation: CapabilityOperationContract
): string {
  if (provider.provider_kind === "mcp_server") return candidate.name;
  return operation.id;
}

function readinessSnapshotId(capabilityId: string, providerRef: string, operationId: string): string {
  return `readiness:${capabilityId}:${providerRef}:${operationId}`;
}
