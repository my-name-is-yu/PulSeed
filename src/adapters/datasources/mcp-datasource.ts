// ─── MCPDataSourceAdapter ───
//
// IDataSourceAdapter implementation that delegates observation to an MCP server
// via the Model Context Protocol. Each dimension is mapped to an MCP tool call
// defined in MCPServerConfig.tool_mappings.
//
// The MCP connection is injected (IMCPConnection) so that unit tests can mock
// the protocol layer without spawning real processes.

import type { IDataSourceAdapter } from "../../platform/observation/data-source-adapter.js";
import type {
  DataSourceType,
  DataSourceConfig,
  DataSourceQuery,
  DataSourceResult,
} from "../../base/types/data-source.js";
import { coerceDataSourceObservationValue } from "../../platform/observation/observation-value.js";
import type {
  MCPServerConfig,
  MCPToolMapping,
  IMCPConnection,
} from "../../base/types/mcp.js";
import {
  admitCapabilityDescriptor,
  descriptorsFromMcpServers,
  type CapabilityAdmissionDecision,
  type CapabilityDescriptor,
} from "../../runtime/capability-plane.js";
import {
  buildPersonalAgentDecisionTrace,
  PersonalAgentRuntimeStore,
  type RuntimeGraphRef,
} from "../../runtime/personal-agent/index.js";

export interface MCPDataSourceAdapterOptions {
  baseDir?: string;
  personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">;
}

// ─── Glob pattern matcher ───

function matchesPattern(dimension: string, pattern: string): boolean {
  // Convert glob-style pattern ("test_*", "coverage") to a regex
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(dimension);
}

// ─── MCPDataSourceAdapter ───

export class MCPDataSourceAdapter implements IDataSourceAdapter {
  readonly sourceId: string;
  readonly sourceType: DataSourceType = "mcp";
  readonly config: DataSourceConfig;

  private readonly serverConfig: MCPServerConfig;
  private readonly connection: IMCPConnection;
  private readonly traceBaseDir?: string;
  private readonly personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">;
  private connected = false;

  constructor(serverConfig: MCPServerConfig, connection: IMCPConnection, options: MCPDataSourceAdapterOptions = {}) {
    this.serverConfig = serverConfig;
    this.connection = connection;
    this.traceBaseDir = options.baseDir;
    this.personalAgentRuntime = options.personalAgentRuntime;
    this.sourceId = serverConfig.id;

    // Synthesize a minimal DataSourceConfig to satisfy the interface
    this.config = {
      id: serverConfig.id,
      name: serverConfig.name,
      type: "mcp",
      connection: serverConfig.url ? { url: serverConfig.url } : {},
      enabled: serverConfig.enabled,
      created_at: new Date().toISOString(),
    };
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.connection.connect();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.connection.close();
    this.connected = false;
  }

  async healthCheck(): Promise<boolean> {
    return this.connection.isConnected();
  }

  getSupportedDimensions(): string[] {
    return this.serverConfig.tool_mappings.map((m) => m.dimension_pattern);
  }

  async query(params: DataSourceQuery): Promise<DataSourceResult> {
    const mapping = this.findMapping(params.dimension_name);

    if (!mapping) {
      return {
        value: null,
        raw: null,
        timestamp: new Date().toISOString(),
        source_id: this.sourceId,
        metadata: { reason: `No tool mapping for dimension: ${params.dimension_name}` },
      };
    }

    const args: Record<string, unknown> = {
      ...(mapping.args_template ?? {}),
      dimension_name: params.dimension_name,
    };

    let raw: unknown;
    let value: number | string | boolean | null = null;

    try {
      const descriptor = descriptorsFromMcpServers([{ ...this.serverConfig, tool_mappings: [mapping] }])[0];
      if (!descriptor) {
        throw new Error(`Capability Plane could not describe MCP datasource tool ${mapping.tool_name}`);
      }
      const admission = admitCapabilityDescriptor({
        descriptor,
        rawInput: {
          server_id: this.serverConfig.id,
          tool_name: mapping.tool_name,
          arguments: args,
        },
        context: {
          preApproved: !descriptor.authority_requirements.approval_required,
          authorityRefs: descriptor.authority_requirements.required_refs,
          callId: `mcp-datasource:${this.serverConfig.id}:${mapping.tool_name}:${params.dimension_name}`,
          stateEpoch: `${this.serverConfig.id}:${this.serverConfig.enabled ? "enabled" : "disabled"}`,
        },
      });
      if (admission.status !== "allowed") {
        throw new Error(`Capability Plane blocked MCP datasource tool ${mapping.tool_name}: ${admission.reason}`);
      }
      await this.recordCapabilityAdmissionBestEffort({
        descriptor,
        admission,
        mapping,
        dimensionName: params.dimension_name,
      });
      const result = await this.connection.callTool(mapping.tool_name, args);
      raw = result;

      // Extract text content from the first content item
      const firstContent = result.content.find((c) => c.type === "text" && c.text !== undefined);
      if (firstContent?.text !== undefined) {
        const parsed = this.parseTextValue(firstContent.text);
        value = parsed;
      }
    } catch (err) {
      return {
        value: null,
        raw: null,
        timestamp: new Date().toISOString(),
        source_id: this.sourceId,
        metadata: { error: String(err) },
      };
    }

    return {
      value,
      raw,
      timestamp: new Date().toISOString(),
      source_id: this.sourceId,
    };
  }

  // ─── Private helpers ───

  private findMapping(dimensionName: string): MCPToolMapping | undefined {
    return this.serverConfig.tool_mappings.find((m) =>
      matchesPattern(dimensionName, m.dimension_pattern)
    );
  }

  private parseTextValue(text: string): number | string | boolean | null {
    const trimmed = text.trim();
    if (trimmed === "null") return null;
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    return coerceDataSourceObservationValue(trimmed);
  }

  private async recordCapabilityAdmission(input: {
    descriptor: CapabilityDescriptor;
    admission: CapabilityAdmissionDecision;
    mapping: MCPToolMapping;
    dimensionName: string;
  }): Promise<void> {
    const store = this.personalAgentRuntime
      ?? (this.traceBaseDir ? new PersonalAgentRuntimeStore(this.traceBaseDir, { controlBaseDir: this.traceBaseDir }) : null);
    if (!store) return;
    const toolRef = `${this.serverConfig.id}:${input.mapping.tool_name}:${input.dimensionName}`;
    const emittedAt = new Date().toISOString();
    await store.recordTrace(buildPersonalAgentDecisionTrace({
      callerPath: "external_signal",
      source: {
        sourceKind: "external_signal",
        sourceId: `mcp-datasource:${toolRef}`,
        emittedAt,
        sourceEpoch: `${this.serverConfig.id}:${this.serverConfig.enabled ? "enabled" : "disabled"}`,
        highWatermark: input.dimensionName,
        replayKey: [
          "mcp_datasource",
          this.serverConfig.id,
          input.mapping.tool_name,
          input.dimensionName,
          input.admission.admission_id,
        ].join(":"),
        summary: `MCP datasource tool ${input.mapping.tool_name} was admitted before execution.`,
        sourceRef: { kind: "mcp_tool", ref: toolRef },
      },
      target: {
        kind: "tool_call",
        ref: { kind: "mcp_tool", ref: toolRef },
        effect: "execute_tool",
        summary: `Execute verified read-only MCP datasource mapping ${input.mapping.tool_name}.`,
      },
      decision: "allow",
      decisionReason: input.admission.reason,
      capabilityDecision: "available",
      capabilityRefs: this.capabilityRefs(input.descriptor, input.admission, input.mapping),
      policyRef: { kind: "intervention_policy", ref: "policy:capability-plane-mcp-datasource-v1" },
      currentRefs: [
        { kind: "mcp_server", ref: this.serverConfig.id },
        { kind: "mcp_tool", ref: toolRef },
      ],
    }));
  }

  private async recordCapabilityAdmissionBestEffort(input: {
    descriptor: CapabilityDescriptor;
    admission: CapabilityAdmissionDecision;
    mapping: MCPToolMapping;
    dimensionName: string;
  }): Promise<void> {
    try {
      await this.recordCapabilityAdmission(input);
    } catch (err) {
      console.warn("MCPDataSourceAdapter: capability admission trace failed", err);
    }
  }

  private capabilityRefs(
    descriptor: CapabilityDescriptor,
    admission: CapabilityAdmissionDecision,
    mapping: MCPToolMapping,
  ): RuntimeGraphRef[] {
    return [
      { kind: "capability", ref: descriptor.capability_id },
      { kind: "capability_provider", ref: descriptor.provider_ref },
      { kind: "capability_operation", ref: descriptor.runtime_graph_refs.operation_ref },
      { kind: "capability_readiness", ref: descriptor.readiness_state },
      { kind: "capability_admission", ref: admission.admission_id },
      ...(admission.capability_fingerprint
        ? [{ kind: "capability_fingerprint", ref: admission.capability_fingerprint }]
        : []),
      { kind: "mcp_server", ref: this.serverConfig.id },
      { kind: "mcp_tool", ref: mapping.tool_name },
    ];
  }
}
