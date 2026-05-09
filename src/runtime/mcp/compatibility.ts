import type { MCPServerConfig } from "../../base/types/mcp.js";

export type McpCompatibilityState =
  | "config_imported"
  | "config_enabled"
  | "server_spawnable"
  | "tool_list_available"
  | "tool_alias_mapped"
  | "auth_or_env_valid"
  | "operation_contract_mapped"
  | "operation_specific_verified"
  | "blocked";

export type McpOperationKind = "read" | "send" | "write" | "publish" | "delete" | "mutate";
export type McpRiskClass = "low" | "medium" | "high";
export type McpSideEffectProfile = "read" | "send" | "write" | "publish" | "delete" | "mutate";
export type McpVerificationStatus = "verified" | "failed";

export interface McpOperationVerificationKey {
  provider: "mcp";
  server_id: string;
  tool_name: string;
  operation_kind: McpOperationKind;
  payload_class: string;
  risk_class: McpRiskClass;
  side_effect_profile: McpSideEffectProfile;
}

export interface McpOperationVerificationRecord {
  key: McpOperationVerificationKey;
  status: McpVerificationStatus;
  verified_at: string;
  evidence_ref?: string;
}

export interface McpCompatibilityEvidence {
  server_spawnable?: boolean;
  listed_tools?: string[];
  auth_or_env_valid?: boolean;
  operation_contract_mapped?: boolean;
  operation_verifications?: McpOperationVerificationRecord[];
}

export interface McpOperationCompatibilitySnapshot {
  schema_version: "mcp-operation-compatibility/v1";
  server_id: string;
  tool_name: string;
  states: Record<McpCompatibilityState, boolean>;
  blockers: string[];
  verification_key: McpOperationVerificationKey;
  execution: {
    executable: boolean;
    reason: string;
  };
}

export interface McpImportCompatibilitySummary {
  schema_version: "mcp-import-compatibility/v1";
  server_id: string;
  states: Record<McpCompatibilityState, boolean>;
  operation_verification_key_fields: Array<keyof McpOperationVerificationKey>;
  execution: {
    executable: false;
    reason: "mcp_operation_specific_verification_required";
  };
}

export function summarizeMcpImportCompatibility(
  server: MCPServerConfig
): McpImportCompatibilitySummary {
  return {
    schema_version: "mcp-import-compatibility/v1",
    server_id: server.id,
    states: {
      config_imported: true,
      config_enabled: server.enabled === true,
      server_spawnable: false,
      tool_list_available: false,
      tool_alias_mapped: server.tool_mappings.length > 0,
      auth_or_env_valid: false,
      operation_contract_mapped: false,
      operation_specific_verified: false,
      blocked: true,
    },
    operation_verification_key_fields: [
      "provider",
      "server_id",
      "tool_name",
      "operation_kind",
      "payload_class",
      "risk_class",
      "side_effect_profile",
    ],
    execution: {
      executable: false,
      reason: "mcp_operation_specific_verification_required",
    },
  };
}

export function evaluateMcpOperationCompatibility(
  server: MCPServerConfig,
  operation: Omit<McpOperationVerificationKey, "provider" | "server_id">,
  evidence: McpCompatibilityEvidence = {}
): McpOperationCompatibilitySnapshot {
  const key: McpOperationVerificationKey = {
    provider: "mcp",
    server_id: server.id,
    ...operation,
  };
  const toolListAvailable = evidence.listed_tools !== undefined;
  const toolListed = evidence.listed_tools?.some((toolName) => toolName === operation.tool_name) === true;
  const toolAliasMapped = server.tool_mappings.some((mapping) => mapping.tool_name === operation.tool_name);
  const operationSpecificVerified =
    evidence.operation_verifications?.some((record) =>
      record.status === "verified" && verificationKeysEqual(record.key, key)
    ) === true;
  const states: Record<McpCompatibilityState, boolean> = {
    config_imported: true,
    config_enabled: server.enabled === true,
    server_spawnable: evidence.server_spawnable === true,
    tool_list_available: toolListAvailable && toolListed,
    tool_alias_mapped: toolAliasMapped,
    auth_or_env_valid: evidence.auth_or_env_valid === true,
    operation_contract_mapped: evidence.operation_contract_mapped === true,
    operation_specific_verified: operationSpecificVerified,
    blocked: false,
  };
  const blockers = blockersForStates(states);
  states.blocked = blockers.length > 0;
  return {
    schema_version: "mcp-operation-compatibility/v1",
    server_id: server.id,
    tool_name: operation.tool_name,
    states,
    blockers,
    verification_key: key,
    execution: {
      executable: blockers.length === 0,
      reason: blockers.length === 0 ? "mcp_operation_verified" : blockers[0]!,
    },
  };
}

function verificationKeysEqual(a: McpOperationVerificationKey, b: McpOperationVerificationKey): boolean {
  return a.provider === b.provider
    && a.server_id === b.server_id
    && a.tool_name === b.tool_name
    && a.operation_kind === b.operation_kind
    && a.payload_class === b.payload_class
    && a.risk_class === b.risk_class
    && a.side_effect_profile === b.side_effect_profile;
}

function blockersForStates(states: Record<McpCompatibilityState, boolean>): string[] {
  const blockers: string[] = [];
  if (!states.config_enabled) blockers.push("mcp_config_disabled");
  if (!states.server_spawnable) blockers.push("mcp_server_not_spawnable");
  if (!states.tool_list_available) blockers.push("mcp_tool_not_listed");
  if (!states.tool_alias_mapped) blockers.push("mcp_tool_alias_not_mapped");
  if (!states.auth_or_env_valid) blockers.push("mcp_auth_or_env_not_validated");
  if (!states.operation_contract_mapped) blockers.push("mcp_operation_contract_not_mapped");
  if (!states.operation_specific_verified) blockers.push("mcp_operation_specific_verification_missing");
  return blockers;
}
